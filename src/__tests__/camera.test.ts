import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  Camera,
  CameraConfigError,
  CameraManager,
  FrameSource,
  JpegStreamParser,
  jpegDimensions,
  ProcessSource,
  UrlSource,
  validateCameraConfig,
} from "../camera.js";
import type { CameraConfig } from "../camera-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JPEG = readFileSync(path.join(__dirname, "fixtures", "frame.jpg"));

/** A JPEG whose APP1 segment embeds a thumbnail containing an EOI marker. */
function jpegWithThumbnail(): Buffer {
  const thumb = JPEG; // any complete JPEG; it ends with FF D9
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), thumb]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), payload]);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([JPEG.subarray(0, 2), app1, JPEG.subarray(2)]);
}

/** Start an HTTP server serving `JPEG` as a snapshot at / and as an MJPEG stream at /stream. */
function startImageServer(): Promise<{ server: http.Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
      const send = () => {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
        res.write(JPEG);
        res.write("\r\n");
      };
      const timer = setInterval(send, 20);
      send();
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not an image");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(JPEG);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    });
  });
}

function collectFrames(source: FrameSource, count: number, timeoutMs = 5000): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const frames: Buffer[] = [];
    const timer = setTimeout(() => {
      source.stop();
      reject(new Error(`only got ${frames.length}/${count} frames`));
    }, timeoutMs);
    source.on("frame", (f: Buffer) => {
      frames.push(f);
      if (frames.length === count) {
        clearTimeout(timer);
        source.stop();
        resolve(frames);
      }
    });
    source.start();
  });
}

describe("JPEG helpers", () => {
  test("jpegDimensions reads the SOF segment", () => {
    expect(jpegDimensions(JPEG)).toEqual({ width: 64, height: 48 });
    expect(jpegDimensions(Buffer.from("nope"))).toBeNull();
  });

  test("parser splits a concatenated stream into frames", () => {
    const parser = new JpegStreamParser();
    const frames = parser.push(Buffer.concat([JPEG, JPEG, JPEG]));
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.equals(JPEG)).toBe(true);
  });

  test("parser handles frames split across arbitrary chunk boundaries", () => {
    const stream = Buffer.concat([
      Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"),
      JPEG,
      Buffer.from("\r\n--frame\r\n"),
      JPEG,
    ]);
    for (const chunkSize of [1, 7, 100, 1000]) {
      const parser = new JpegStreamParser();
      const frames: Buffer[] = [];
      for (let i = 0; i < stream.length; i += chunkSize) {
        frames.push(...parser.push(stream.subarray(i, i + chunkSize)));
      }
      expect(frames, `chunk size ${chunkSize}`).toHaveLength(2);
      expect(frames[1].equals(JPEG)).toBe(true);
    }
  });

  test("parser is not fooled by an EOI inside an embedded thumbnail", () => {
    const withThumb = jpegWithThumbnail();
    const frames = new JpegStreamParser().push(Buffer.concat([withThumb, JPEG]));
    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(withThumb.length);
    expect(jpegDimensions(withThumb)).toEqual({ width: 64, height: 48 });
  });
});

describe("camera configuration", () => {
  test("fills defaults and validates", () => {
    const cfg = validateCameraConfig(
      { name: " Top ", kind: "url", source: "http://cam.local/shot.jpg", fps: "1" },
      "abc",
    );
    expect(cfg).toMatchObject({
      id: "abc",
      name: "Top",
      kind: "url",
      fps: 1,
      rotate: 0,
      enabled: true,
      resolution: "",
    });
    const link = "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_8A4F3C6F-video-index0";
    expect(validateCameraConfig({ kind: "device", source: link }, "abc").source).toBe(link);
  });

  test("rejects bad input", () => {
    const bad = (input: object) => expect(() => validateCameraConfig(input, "x")).toThrow(CameraConfigError);
    bad({ kind: "webcam", source: "/dev/video0" });
    bad({ kind: "url", source: "ftp://x" });
    bad({ kind: "url", source: "" });
    bad({ kind: "rtsp", source: "http://x" });
    bad({ kind: "url", source: "http://x", fps: 99 });
    bad({ kind: "url", source: "http://x", rotate: 45 });
    bad({ kind: "url", source: "http://x", resolution: "big" });
    if (process.platform === "linux") {
      bad({ kind: "device", source: "/etc/passwd" });
      bad({ kind: "device", source: "/dev/v4l/by-id/../../../etc/passwd" });
    }
  });
});

describe("sources", () => {
  let images: Awaited<ReturnType<typeof startImageServer>>;
  beforeAll(async () => {
    images = await startImageServer();
  });
  afterAll(() => {
    images.server.close();
  });

  test("UrlSource polls a snapshot URL at the configured rate", async () => {
    const frames = await collectFrames(new UrlSource(`${images.url}/snap.jpg`, 20), 3);
    expect(frames.every((f) => f.equals(JPEG))).toBe(true);
  });

  test("UrlSource consumes an MJPEG stream", async () => {
    const frames = await collectFrames(new UrlSource(`${images.url}/stream`, 30), 3);
    expect(frames.every((f) => f.equals(JPEG))).toBe(true);
  });

  test("UrlSource reports non-image responses as errors", async () => {
    const source = new UrlSource(`${images.url}/text`, 10);
    const error = await new Promise<Error>((resolve) => {
      source.on("error", resolve);
      source.start();
    });
    source.stop();
    expect(error.message).toMatch(/did not return a JPEG/);
  });

  test("Camera starts its source on demand and stops it when released", async () => {
    let starts = 0;
    let stops = 0;
    class FakeSource extends FrameSource {
      private timer: NodeJS.Timeout | null = null;
      protected run() {
        starts += 1;
        this.timer = setInterval(() => this.emit("frame", JPEG), 5);
      }
      protected halt() {
        stops += 1;
        if (this.timer) clearInterval(this.timer);
        return Promise.resolve();
      }
    }
    const config: CameraConfig = validateCameraConfig({ kind: "url", source: "http://x/", name: "fake" }, "fake");
    const camera = new Camera(config, () => new FakeSource());
    expect(camera.status.state).toBe("idle");
    const release = camera.retain();
    const frame = await camera.getFrame({ fresh: true });
    expect(frame.equals(JPEG)).toBe(true);
    expect(camera.status).toMatchObject({ state: "live", width: 64, height: 48 });
    expect(starts).toBe(1);
    release();
    // still running until the idle timeout, but a close stops it immediately
    expect(stops).toBe(0);
    camera.close();
    expect(stops).toBe(1);
    expect(camera.status.state).toBe("idle");
  });

  test("Camera reports source errors in its status instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const busy = (address: string) =>
      `ffmpeg exited (240): [in#0 @ ${address}] Error opening input: Device or resource busy`;
    const bandwidth = "ffmpeg exited (228): [in#0 @ 0x62b2] Error opening input: No space left on device";
    class FailingSource extends FrameSource {
      protected run() {
        // Sources keep retrying, so the same error arrives again, with other addresses in ffmpeg's output,
        // until the camera fails for another reason.
        this.emit("error", new Error(busy("0x5e40")));
        this.emit("error", new Error(busy("0x636d")));
        this.emit("error", new Error(bandwidth));
      }
      protected halt() {
        return Promise.resolve();
      }
    }
    const config = validateCameraConfig({ kind: "device", source: "/dev/video2", name: "Side" }, "side");
    const camera = new Camera(config, () => new FailingSource());
    expect(() => camera.retain()).not.toThrow();
    const hinted = `Not enough USB bandwidth: use mjpeg or a lower resolution, or move a camera to another USB port. ${bandwidth}`;
    expect(camera.status).toMatchObject({ state: "error", error: hinted });
    // logged when the camera starts failing and when it fails differently, not on every retry
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      `Camera "Side": Another program, or another camera in saxi, is using this device. ${busy("0x5e40")}`,
      `Camera "Side": ${hinted}`,
    ]);
    camera.close();
    warn.mockRestore();
  });

  test("Camera waits for a stopped source to let go of the device before starting the next", async () => {
    const events: string[] = [];
    const exits: Array<() => void> = [];
    class ExitingSource extends FrameSource {
      constructor(private readonly n: number) {
        super();
      }
      protected run() {
        events.push(`start ${this.n}`);
      }
      protected halt() {
        events.push(`stop ${this.n}`);
        return new Promise<void>((resolve) => exits.push(resolve));
      }
    }
    let n = 0;
    const config = validateCameraConfig({ kind: "device", source: "/dev/video2", name: "Side" }, "side");
    const camera = new Camera(config, () => new ExitingSource(++n));
    camera.retain();
    camera.updateConfig({ ...config, fps: 5 }); // restarts the running camera, like saving the camera form
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["start 1", "stop 1"]);
    exits[0](); // the first process exits
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["start 1", "stop 1", "start 2"]);
    camera.close();
  });

  test("ProcessSource reports the line saying what went wrong, not ffmpeg's closing lines", async () => {
    const stderr = [
      "[video4linux2,v4l2 @ 0x55d0c8a1e2c0] ioctl(VIDIOC_STREAMON): No space left on device",
      "[in#0 @ 0x62b29b18ae00] Error opening input: No space left on device",
      "Error opening input file /dev/video2.",
      "Error opening input files: No space left on device",
    ].join("\n");
    const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 228;`;
    const source = new ProcessSource(process.execPath, ["-e", script]);
    const error = await new Promise<Error>((resolve) => {
      source.on("error", resolve);
      source.start();
    });
    await source.stop();
    expect(error.message).toBe(
      `${process.execPath} exited (228): [video4linux2,v4l2 @ 0x55d0c8a1e2c0] ioctl(VIDIOC_STREAMON): No space left on device | [in#0 @ 0x62b29b18ae00] Error opening input: No space left on device`,
    );
  });

  // Windows has no SIGTERM to handle: the process is ended right away.
  test.skipIf(process.platform === "win32")("ProcessSource.stop resolves once the process has exited", async () => {
    const script = [
      "process.stdout.write(require('fs').readFileSync(process.argv[1]));",
      // like ffmpeg, which only exits once the camera delivers its next frame
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const source = new ProcessSource(process.execPath, ["-e", script, path.join(__dirname, "fixtures", "frame.jpg")]);
    const frame = new Promise((resolve) => source.once("frame", resolve));
    source.start();
    await frame;
    const began = Date.now();
    await source.stop();
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
  });

  test("CameraManager persists cameras to disk", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "saxi-cams-"));
    const manager = new CameraManager(dir);
    const added = manager.add({ name: "Left", kind: "url", source: `${images.url}/snap.jpg`, fps: 5 });
    expect(manager.list()).toHaveLength(1);
    manager.close();

    const reloaded = new CameraManager(dir);
    expect(reloaded.list().map((c) => c.id)).toEqual([added.id]);
    expect(reloaded.update(added.id, { name: "Right" })?.name).toBe("Right");
    expect(reloaded.remove(added.id)).toBe(true);
    expect(reloaded.list()).toHaveLength(0);
    reloaded.close();
  });
});
