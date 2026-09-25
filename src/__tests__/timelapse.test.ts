import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { TimelapseSession, TimelapseStatusResponse } from "../camera-types.js";
import { AxidrawFast, plan } from "../planning.js";
import { buildFfmpegArgs, validateTimelapseSettings } from "../timelapse.js";
import { createMockSerialPort } from "./mocks/serialport.js";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

vi.mock("../server", async () => {
  const original = (await vi.importActual("../server")) as any;
  return {
    ...original,
    startServer: (port: number, hardware: string, _com: string, ...args: any[]) =>
      original.startServer(port, hardware, "/dev/ttyMOCK", ...args),
    waitForEbb: vi.fn().mockResolvedValue("/dev/ttyMOCK"),
  };
});

import { startServer } from "../server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JPEG = readFileSync(path.join(__dirname, "fixtures", "frame.jpg"));

const PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
]; // biome-ignore format: compactness
const PLAN = plan(PATHS, AxidrawFast).serialize();

function startImageServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(JPEG);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

describe("settings validation", () => {
  test("clamps and falls back to defaults", () => {
    const s = validateTimelapseSettings({
      trigger: "bogus",
      intervalSeconds: -5,
      targetFrames: "12",
      render: { crf: 99 },
    });
    expect(s.trigger).toBe("penLift");
    expect(s.intervalSeconds).toBe(0.5);
    expect(s.targetFrames).toBe(12);
    expect(s.render.crf).toBe(51);
    expect(s.render.preset).toBe("medium");
  });
});

describe("ffmpeg command", () => {
  const cam = (id: string, rotate: 0 | 90 | 180 | 270 = 0) => ({
    id,
    name: id,
    rotate,
    frameCount: 10,
    width: 640,
    height: 480,
  });
  const settings = { fps: 24, crf: 18, preset: "medium", postRollSeconds: 2, composite: true };

  test("single camera render applies rotation and post-roll", () => {
    const args = buildFfmpegArgs("/data/s1", [cam("a", 90)], settings, "/data/s1/renders/out.mp4");
    expect(args).toContain("-framerate");
    expect(args[args.indexOf("-i") + 1]).toBe(path.join("/data/s1", "a", "frame-%06d.jpg"));
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "transpose=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=2",
    );
    expect(args.at(-1)).toBe("/data/s1/renders/out.mp4");
  });

  test("composite render stacks cameras side by side", () => {
    const args = buildFfmpegArgs("/data/s1", [cam("a"), cam("b")], settings, "/data/s1/renders/out.mp4");
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("hstack=inputs=2:shortest=1");
    expect(filter).toContain("scale=640:480:force_original_aspect_ratio=decrease");
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
  });

  test("four or more cameras use a grid", () => {
    const cams = [cam("a"), cam("b"), cam("c"), cam("d"), cam("e")];
    const args = buildFfmpegArgs("/data/s1", cams, { ...settings, postRollSeconds: 0 }, "/out.mp4");
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("xstack=inputs=5:layout=0_0|640_0|1280_0|0_480|640_480");
    expect(filter).not.toContain("tpad");
  });
});

describe("camera & timelapse API", () => {
  let server: http.Server;
  let images: Awaited<ReturnType<typeof startImageServer>>;
  let dataDir: string;
  const cameraIds: string[] = [];

  beforeAll(async () => {
    images = await startImageServer();
    // the default data dir is ~/.saxi: make sure files under a dot-directory are served
    dataDir = mkdtempSync(path.join(tmpdir(), ".saxi-data-"));
    server = await startServer(0, "v3", "", false, "200mb", dataDir);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    images.server.close();
  });

  test("cameras can be added, listed, previewed and updated", async () => {
    for (const name of ["Overhead", "Side"]) {
      const res = await request(server)
        .post("/cameras")
        .send({ name, kind: "url", source: `${images.url}/${name}.jpg`, fps: 20 });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(name);
      cameraIds.push(res.body.id);
    }
    const bad = await request(server).post("/cameras").send({ kind: "url", source: "not a url" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/URL/);

    const list = await request(server).get("/cameras");
    expect(list.body.cameras.map((c: { name: string }) => c.name)).toEqual(["Overhead", "Side"]);
    expect(list.body.cameras[0].status.state).toBe("idle");

    const snap = await request(server)
      .get(`/cameras/${cameraIds[0]}/snapshot.jpg?fresh=1`)
      .buffer()
      .parse(binaryParser);
    expect(snap.status).toBe(200);
    expect(snap.headers["content-type"]).toBe("image/jpeg");
    expect((snap.body as Buffer).equals(JPEG)).toBe(true);

    const after = await request(server).get("/cameras");
    expect(after.body.cameras[0].status).toMatchObject({ state: "live", width: 64, height: 48 });

    const updated = await request(server).put(`/cameras/${cameraIds[1]}`).send({ rotate: 180 });
    expect(updated.status).toBe(200);
    expect(updated.body.rotate).toBe(180);
    expect((await request(server).get("/cameras/nope/snapshot.jpg")).status).toBe(404);
  });

  test("lists the capture devices connected to the server", async () => {
    const res = await request(server).get("/cameras/devices");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.devices)).toBe(true);
    expect(res.body.supported).toBe(process.platform === "linux");
  });

  test("settings are validated and reported in status", async () => {
    const res = await request(server)
      .put("/timelapse/settings")
      .send({ enabled: true, trigger: "penLift", minIntervalSeconds: 0, captureDelayMs: 0, autoRender: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    const status = await request(server).get("/timelapse/status");
    const body = status.body as TimelapseStatusResponse;
    expect(body.settings.trigger).toBe("penLift");
    expect(body.active).toBeNull();
    expect(body.dataDir).toBe(dataDir);
    expect(typeof body.capabilities.ffmpeg).toBe("boolean");
  });

  test("manual recording captures synchronized frame sets", async () => {
    expect((await request(server).post("/timelapse/snap")).status).toBe(409);
    const started = await request(server).post("/timelapse/start").send({ name: "Test shoot" });
    expect(started.status).toBe(201);
    const id: string = started.body.id;
    expect(started.body.cameras).toHaveLength(2);
    expect((await request(server).post("/timelapse/start")).status).toBe(409);

    expect((await request(server).post("/timelapse/snap")).body.frameCount).toBe(1);
    expect((await request(server).post("/timelapse/snap")).body.frameCount).toBe(2);
    expect((await request(server).delete(`/timelapses/${id}`)).status).toBe(409);

    const stopped = await request(server).post("/timelapse/stop");
    expect(stopped.status).toBe(200);
    const session = stopped.body as TimelapseSession;
    expect(session).toMatchObject({ id, name: "Test shoot", status: "finished", source: "manual", frameCount: 2 });
    expect(session.cameras.map((c) => c.frameCount)).toEqual([2, 2]);
    expect(session.cameras[0]).toMatchObject({ width: 64, height: 48 });

    const frame = await request(server)
      .get(`/timelapses/${id}/frames/${cameraIds[0]}/1.jpg`)
      .buffer()
      .parse(binaryParser);
    expect(frame.status).toBe(200);
    expect((frame.body as Buffer).equals(JPEG)).toBe(true);
    expect((await request(server).get(`/timelapses/${id}/frames/${cameraIds[1]}/last.jpg`)).status).toBe(200);
    expect((await request(server).get(`/timelapses/${id}/frames/${cameraIds[1]}/3.jpg`)).status).toBe(404);
    expect((await request(server).get(`/timelapses/${id}/frames/..%2F..%2Fx/1.jpg`)).status).toBe(404);
    expect((await request(server).get("/timelapses/..%2F..%2Fetc/renders/passwd")).status).toBe(404);

    const list = await request(server).get("/timelapses");
    expect(list.body.timelapses.map((t: TimelapseSession) => t.id)).toEqual([id]);
  });

  test("a plot records a timelapse automatically", async () => {
    const res = await request(server).post("/plot").send(PLAN);
    expect(res.status).toBe(200);
    const session = await waitFor<TimelapseSession>(async () => {
      const list = (await request(server).get("/timelapses")).body.timelapses as TimelapseSession[];
      return list.find((t) => t.source === "plot" && t.status !== "recording");
    });
    expect(session.status).toBe("finished");
    expect(session.trigger).toBe("penLift");
    // at least the blank page before plotting and the finished drawing afterwards
    expect(session.frameCount).toBeGreaterThanOrEqual(2);
    expect(session.cameras.map((c) => c.frameCount)).toEqual([session.frameCount, session.frameCount]);
    await waitFor(async () => !(await request(server).get("/plot/status")).body.plotting);
  });

  test("a plot does not record when timelapse is disabled", async () => {
    await request(server).put("/timelapse/settings").send({ enabled: false });
    const before = (await request(server).get("/timelapses")).body.timelapses.length;
    await request(server).post("/plot").send(PLAN);
    await waitFor(async () => !(await request(server).get("/plot/status")).body.plotting);
    await new Promise((r) => setTimeout(r, 100));
    expect((await request(server).get("/timelapses")).body.timelapses.length).toBe(before);
  });

  test("renders videos with ffmpeg and serves them", async () => {
    const caps = (await request(server).get("/timelapse/status")).body.capabilities;
    const id: string = (await request(server).get("/timelapses")).body.timelapses.find(
      (t: TimelapseSession) => t.source === "manual",
    ).id;
    const res = await request(server)
      .post(`/timelapses/${id}/render`)
      .send({ fps: 10, postRollSeconds: 0.5, preset: "ultrafast", composite: true });
    expect(res.status).toBe(202);
    expect(res.body.jobs.map((j: { camera: string }) => j.camera)).toEqual([...cameraIds, "composite"]);
    expect((await request(server).post(`/timelapses/${id}/render`)).status).toBe(409);

    const jobs = await waitFor<TimelapseStatusResponse["renderJobs"]>(async () => {
      const status = (await request(server).get("/timelapse/status")).body as TimelapseStatusResponse;
      return status.renderJobs.every((j) => j.status !== "running") ? status.renderJobs : null;
    }, 60000);
    if (!caps.ffmpeg) {
      expect(jobs.every((j) => j.status === "error" && /ffmpeg/.test(j.error ?? ""))).toBe(true);
      return;
    }
    expect(jobs.map((j) => j.status)).toEqual(["done", "done", "done"]);
    const session = (await request(server).get(`/timelapses/${id}`)).body as TimelapseSession;
    expect(session.renders).toHaveLength(3);
    expect(session.renders.every((r) => r.sizeBytes > 0)).toBe(true);
    const download = await request(server).get(`/timelapses/${id}/renders/${session.renders[2].file}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="${session.renders[2].file}"`);
    const video = await request(server)
      .get(`/timelapses/${id}/renders/${session.renders[2].file}`)
      .buffer()
      .parse(binaryParser);
    expect(video.status).toBe(200);
    expect(video.headers["content-type"]).toBe("video/mp4");
    expect((video.body as Buffer).length).toBe(session.renders[2].sizeBytes);
  });

  test("timelapses can be deleted", async () => {
    const ids = (await request(server).get("/timelapses")).body.timelapses.map((t: TimelapseSession) => t.id);
    for (const id of ids) expect((await request(server).delete(`/timelapses/${id}`)).status).toBe(204);
    expect((await request(server).get("/timelapses")).body.timelapses).toEqual([]);
    expect((await request(server).delete(`/timelapses/${ids[0]}`)).status).toBe(404);
  });
});

function binaryParser(res: NodeJS.ReadableStream, callback: (err: Error | null, data: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}
