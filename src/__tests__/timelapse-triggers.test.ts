import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CameraManager, detectCapabilities, FrameSource } from "../camera.js";
import type { TimelapseCameraInfo } from "../camera-types.js";
import { type Motion, PenMotion } from "../planning.js";
import { alignMoments, PlotClock, TimelapseRecorder } from "../timelapse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JPEG = readFileSync(path.join(__dirname, "fixtures", "frame.jpg"));
const exec = promisify(execFile);
const { ffmpeg } = await detectCapabilities();

// servo positions: a higher one is further up
const UP = 20000;
const DOWN = 16000;
const lower = (seconds: number) => new PenMotion(UP, DOWN, seconds);
const lift = (seconds: number) => new PenMotion(DOWN, UP, seconds);
const move = (seconds: number): Motion => ({ duration: () => seconds });

describe("plot clock", () => {
  test("runs motions one after another, from when they are sent", () => {
    const clock = new PlotClock();
    expect(clock.motion(move(2), 1000)).toEqual({ start: 1000, end: 3000 });
    // sent while the plotter is still busy: it gets to it after the previous one
    expect(clock.motion(move(1), 1100)).toEqual({ start: 3000, end: 4000 });
    // sent once the queue ran dry: right away
    expect(clock.motion(move(1), 9000)).toEqual({ start: 9000, end: 10000 });
    clock.wait(500, 20000);
    expect(clock.motion(move(1), 20000).start).toBe(20500);
  });

  test("knows when the pen is on the paper", () => {
    const clock = new PlotClock();
    clock.motion(lower(0.5), 0); // 0–500
    clock.motion(move(2), 0); // drawing 500–2500
    clock.motion(lift(0.5), 0); // 2500–3000
    clock.motion(move(1), 0); // travelling 3000–4000
    expect(clock.drawing(400, 600)).toBe(false); // still lowering
    expect(clock.drawing(600, 2400)).toBe(true);
    expect(clock.drawing(2300, 2600)).toBe(false); // lifting
    expect(clock.drawing(3100, 3200)).toBe(false);
  });

  test("counts on nothing beyond the motions it was sent", () => {
    const clock = new PlotClock();
    clock.motion(lower(0.5), 0);
    clock.motion(move(2), 0); // the lift hasn't been sent yet
    expect(clock.drawing(1000, 2000)).toBe(true);
    expect(clock.drawing(2000, 3000)).toBe(false); // e.g. cancelled: nothing after 2500
  });
});

describe("composite alignment", () => {
  const camera = (id: string, frameCount: number) => ({ id, frameCount }) as TimelapseCameraInfo;

  test("each camera shows its latest frame at every moment, and its first before that", () => {
    const timeline = "top:1\nhead:1\nhead:2\ntop:2\nhead:3\ntop:3\n";
    expect(alignMoments(timeline, [camera("top", 3), camera("head", 3)])).toEqual([
      [1, 1],
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 3],
      [3, 3],
    ]);
  });

  test("skips moments of cameras that are not in the composite", () => {
    expect(alignMoments("top:1\nhead:1\ntop:2 side:1\n", [camera("top", 2)])).toEqual([[1], [2]]);
  });

  test("older recordings had a frame from every camera at every moment", () => {
    expect(alignMoments(null, [camera("a", 3), camera("b", 2)])).toEqual([
      [1, 1],
      [2, 2],
      [3, 2],
    ]);
  });
});

describe("per-camera triggers", () => {
  class StreamingSource extends FrameSource {
    private timer: NodeJS.Timeout | null = null;
    protected run() {
      this.timer = setInterval(() => this.emit("frame", JPEG), 40);
    }
    protected halt() {
      if (this.timer) clearInterval(this.timer);
      return Promise.resolve();
    }
  }

  test("a pen-down camera only captures while drawing; pen lifts are captured once the pen is up", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "saxi-triggers-"));
    const cameras = new CameraManager(dataDir, () => new StreamingSource());
    const top = cameras.add({ name: "Top", kind: "url", source: "http://top/", fps: 25 });
    const head = cameras.add({ name: "Head", kind: "url", source: "http://head/", fps: 25, trigger: "penDown" });
    const recorder = new TimelapseRecorder(cameras, dataDir);
    recorder.updateSettings({
      enabled: true,
      trigger: "penLift",
      minIntervalSeconds: 0,
      captureDelayMs: 0,
      autoRender: false,
    });

    await recorder.plotStarted(2); // the blank page, from Top only
    // The plot is sent all at once, as the EBB's queue allows; the plotter takes its time.
    recorder.plotMotion(lower(0.1)); // pen down 100 ms from now
    recorder.plotMotion(move(1)); // drawing until 1.1 s
    recorder.plotMotion(lift(0.1)); // up at 1.2 s
    recorder.plotMotion(move(0.5)); // travelling until 1.7 s
    await new Promise((resolve) => setTimeout(resolve, 1900));
    await recorder.plotEnded(false); // the finished drawing, from Top only

    const session = recorder.listSessions()[0];
    expect(session).toMatchObject({ status: "finished", trigger: "penLift" });
    const info = Object.fromEntries(session.cameras.map((c) => [c.name, c]));
    expect(info.Top).toMatchObject({ trigger: "penLift", frameCount: 3 });
    expect(info.Head.trigger).toBe("penDown");
    // frames arrive every 40 ms; they count once the pen has been down for 300 ms, until it lifts
    expect(info.Head.frameCount).toBeGreaterThanOrEqual(5);
    expect(info.Head.frameCount).toBeLessThanOrEqual(20);

    const timeline = readFileSync(path.join(dataDir, "timelapses", session.id, "timeline.txt"), "utf8");
    const moments = timeline.trim().split("\n");
    // blank page, then drawing, then the pen lift once it has happened, then the finished drawing
    expect(moments).toEqual([
      `${top.id}:1`,
      ...Array.from({ length: info.Head.frameCount }, (_, i) => `${head.id}:${i + 1}`),
      `${top.id}:2`,
      `${top.id}:3`,
    ]);
    expect(session.frameCount).toBe(moments.length);

    if (ffmpeg) {
      // the composite has a frame for every moment, whichever camera captured then
      const [job] = recorder.render(session.id, {
        fps: 10,
        postRollSeconds: 0,
        preset: "ultrafast",
        compositeOnly: true,
      });
      for (let i = 0; i < 600 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
      expect(job).toMatchObject({ status: "done", camera: "composite" });
      const video = path.join(dataDir, "timelapses", session.id, "renders", job.output ?? "");
      const { stdout } = await exec("ffprobe", [
        "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", video,
      ]); // biome-ignore format: readability
      expect(Number(stdout.trim())).toBe(moments.length);
      expect(existsSync(path.join(dataDir, "timelapses", session.id, "composite-frames"))).toBe(false);
    }
    cameras.close();
  });
});
