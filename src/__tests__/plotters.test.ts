import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { TimelapseSession } from "../camera-types.js";
import { replan } from "../massager.js";
import { AxidrawFast, defaultPlanOptions, plan } from "../planning.js";
import type { PlotterWithStatus } from "../plotter-types.js";
import { PaperSize } from "../paper-size.js";
import { createMockSerialPort } from "./mocks/serialport.js";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

import { startServer } from "../server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JPEG = readFileSync(path.join(__dirname, "fixtures", "frame.jpg"));

const EBB_PLAN = plan(
  [
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  ],
  AxidrawFast,
).serialize();

/** A drawing planned for the HP 7475A on A4. */
function hpPlan() {
  const paths = Array.from({ length: 5 }, (_, r) => ({
    points: Array.from({ length: 12 }, (_, i) => ({ x: 120 + i * 40, y: 120 + r * 80 + (i % 2) * 30 })),
    stroke: "black",
    groupId: "",
  }));
  return replan(paths as never, {
    ...defaultPlanOptions,
    hardware: "hp7475a",
    layerMode: "all",
    fitPage: false,
    paperSize: PaperSize.standard.A4.landscape,
  }).serialize();
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

describe("several plotters", () => {
  let server: http.Server;
  let dataDir: string;
  let hpId: string;
  let images: http.Server;
  let imageUrl: string;
  const get = async (id: string) => (await request(server).get(`/plotters/${id}`)).body as PlotterWithStatus;

  beforeAll(async () => {
    process.env.SAXI_SIMULATION_SPEED = "200";
    images = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(JPEG);
    });
    await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", () => resolve()));
    imageUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/`;
    dataDir = mkdtempSync(path.join(tmpdir(), "saxi-plotters-"));
    server = await startServer(0, "v3", "/dev/ttyMOCK", false, "200mb", dataDir);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    images.close();
    delete process.env.SAXI_SIMULATION_SPEED;
  });

  test("starts with the AxiDraw from the command line, without writing a config", async () => {
    const { plotters } = (await request(server).get("/plotters").expect(200)).body as { plotters: PlotterWithStatus[] };
    expect(plotters).toHaveLength(1);
    expect(plotters[0]).toMatchObject({ id: "default", kind: "ebb", hardware: "v3", name: "AxiDraw" });
    expect(plotters[0].status).toMatchObject({ connected: true, path: "/dev/ttyMOCK", plotting: false });
    expect(existsSync(path.join(dataDir, "plotters.json"))).toBe(false);
  });

  test("adds an HP-GL plotter, which connects and reports its paper", async () => {
    const res = await request(server).post("/plotters").send({ name: "HP 7475A", kind: "hpgl", port: "simulated" });
    expect(res.status).toBe(201);
    hpId = res.body.id;
    expect(res.body.settings).toMatchObject({ pen: 1, penDownMaxVelocity: 100 });
    const hp = await waitFor(async () => {
      const p = await get(hpId);
      return p.status.connected && p;
    });
    expect(hp.status).toMatchObject({ model: "HP 7475A", paper: { name: "A4" } });
    const saved = JSON.parse(readFileSync(path.join(dataDir, "plotters.json"), "utf8"));
    expect(saved.plotters.map((p: { id: string }) => p.id)).toEqual(["default", hpId]);
  });

  test("validates plotter settings", async () => {
    await request(server).post("/plotters").send({ kind: "hpgl" }).expect(400); // needs a port
    await request(server).post("/plotters").send({ kind: "laser", port: "/dev/x" }).expect(400);
    await request(server).post("/plotters").send({ kind: "ebb", port: "/dev/ttyMOCK" }).expect(400); // taken
    const res = await request(server)
      .put(`/plotters/${hpId}`)
      .send({ settings: { pen: 3, penUpHeight: "nope" } })
      .expect(200);
    expect(res.body.settings).toEqual({ pen: 3, penDownMaxVelocity: 100 });
  });

  test("refuses a plan made for another kind of plotter", async () => {
    const res = await request(server)
      .post(`/plotters/${hpId}/plot`)
      .send({ plan: EBB_PLAN, job: { name: "x", hardware: "v3" } });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/plan it again/);
  });

  test("plots on two plotters at once, each with its own status", async () => {
    await request(server)
      .post(`/plotters/${hpId}/plot`)
      .send({ plan: hpPlan(), job: { name: "zigzag.svg", hardware: "hp7475a", paperSize: { x: 297, y: 210 } } })
      .expect(200);
    await request(server)
      .post("/plotters/default/plot")
      .send({ plan: EBB_PLAN, job: { name: "lines.svg", hardware: "v3" } })
      .expect(200);

    const hp = await get(hpId);
    expect(hp.status.plotting).toBe(true);
    expect(hp.status.job).toMatchObject({ name: "zigzag.svg", hardware: "hp7475a" });
    expect(hp.status.job?.estimatedSeconds).toBeGreaterThan(0);
    // the single-plotter API is about the first plotter
    await request(server).post("/plot").send(EBB_PLAN).expect(400);

    const svg = await request(server)
      .get(`/plotters/${hpId}/preview.svg`)
      .buffer(true)
      .parse((res, done) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => done(null, text));
      })
      .expect(200);
    expect(svg.headers["content-type"]).toMatch(/svg/);
    expect(svg.body).toContain('viewBox="0 0 297 210"');

    await waitFor(async () => !(await get(hpId)).status.plotting && !(await get("default")).status.plotting);
    await request(server).get(`/plotters/${hpId}/preview.svg`).expect(404);
    expect((await request(server).get("/plot/status")).body.plotting).toBe(false);
  });

  test("a websocket client follows the plotter it subscribed to", async () => {
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages: Array<{ c: string; plotter?: string; p?: Record<string, unknown> }> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.on("open", resolve));
    await waitFor(async () => messages.some((m) => m.c === "dev"));
    expect(messages[0]).toMatchObject({ c: "dev", plotter: "default", p: { kind: "ebb", path: "/dev/ttyMOCK" } });

    ws.send(JSON.stringify({ c: "subscribe", p: { plotter: hpId } }));
    await waitFor(async () => messages.some((m) => m.c === "dev" && m.plotter === hpId));
    expect(messages.find((m) => m.plotter === hpId)?.p).toMatchObject({ kind: "hpgl", model: "HP 7475A" });

    const before = messages.length;
    await request(server).post("/plotters/default/plot").send({ plan: EBB_PLAN }).expect(200);
    await request(server)
      .post(`/plotters/${hpId}/plot`)
      .send({ plan: hpPlan(), job: { name: "a", hardware: "hp7475a" } })
      .expect(200);
    await waitFor(async () => messages.slice(before).some((m) => m.c === "finished"));
    const later = messages.slice(before);
    expect(later.some((m) => m.c === "progress")).toBe(true);
    expect(later.every((m) => m.plotter === hpId)).toBe(true); // nothing about the AxiDraw
    ws.close();
    await waitFor(async () => !(await get("default")).status.plotting && !(await get(hpId)).status.plotting);
  });

  test("cameras record the plotters they are assigned to", async () => {
    const camera = (
      await request(server)
        .post("/cameras")
        .send({ name: "HP cam", kind: "url", source: imageUrl, fps: 5, plotters: [hpId] })
        .expect(201)
    ).body;
    expect(camera.plotters).toEqual([hpId]);
    await request(server).put("/timelapse/settings").send({ enabled: true, autoRender: false, minIntervalSeconds: 0 });

    // the AxiDraw has no camera of its own: no recording
    await request(server).post("/plotters/default/plot").send({ plan: EBB_PLAN }).expect(200);
    await waitFor(async () => !(await get("default")).status.plotting);
    expect((await request(server).get("/timelapses")).body.timelapses).toHaveLength(0);

    await request(server)
      .post(`/plotters/${hpId}/plot`)
      .send({ plan: hpPlan(), job: { name: "zigzag.svg", hardware: "hp7475a" } })
      .expect(200);
    const status = await waitFor(async () => {
      const s = (await request(server).get("/timelapse/status")).body;
      return s.actives.length > 0 && s;
    });
    expect(status.plottingPlotters).toEqual([hpId]);
    expect(status.actives[0]).toMatchObject({ plotterId: hpId, plotterName: "HP 7475A", name: "zigzag.svg" });
    const session = await waitFor<TimelapseSession>(async () => {
      const list = (await request(server).get("/timelapses")).body.timelapses as TimelapseSession[];
      return list.find((t) => t.status !== "recording");
    });
    expect(session).toMatchObject({ status: "finished", source: "plot", plotterId: hpId });
    expect(session.frameCount).toBeGreaterThanOrEqual(2);

    // a manual recording for a plotter uses that plotter's cameras
    await request(server).post("/timelapse/start").send({ plotter: "default" }).expect(400); // no cameras
    await request(server).post("/timelapse/start").send({ plotter: hpId, name: "by hand" }).expect(201);
    await request(server).post("/timelapse/snap").send({ plotter: hpId }).expect(200);
    const stopped = (await request(server).post("/timelapse/stop").send({}).expect(200)).body;
    expect(stopped).toMatchObject({ name: "by hand", plotterId: hpId });
    await request(server).put("/timelapse/settings").send({ enabled: false });
  });

  test("removes plotters, but not the last one", async () => {
    await request(server).delete(`/plotters/${hpId}`).expect(204);
    await request(server).delete("/plotters/default").expect(400);
    await request(server).get(`/plotters/${hpId}`).expect(404);
  });
});
