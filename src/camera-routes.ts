/**
 * HTTP API for cameras and timelapses, mounted on the saxi express app.
 *
 *   GET    /cameras                         list cameras with live status
 *   POST   /cameras                         add a camera
 *   PUT    /cameras/:id                     update a camera
 *   DELETE /cameras/:id                     remove a camera
 *   GET    /cameras/:id/snapshot.jpg        latest frame (?fresh=1 waits for a new one)
 *   GET    /cameras/:id/stream.mjpeg        multipart MJPEG live stream
 *
 *   GET    /timelapse/status                settings, active recording, render jobs, capabilities
 *   PUT    /timelapse/settings              update settings
 *   POST   /timelapse/start                 start a manual recording
 *   POST   /timelapse/snap                  capture a frame set into the active recording
 *   POST   /timelapse/stop                  stop the active recording
 *
 *   GET    /timelapses                      list recordings
 *   GET    /timelapses/:id                  one recording
 *   DELETE /timelapses/:id                  delete a recording and its files
 *   POST   /timelapses/:id/render           render videos ({ fps, crf, preset, postRollSeconds, composite, cameras })
 *   GET    /timelapses/:id/frames/:camera/:n.jpg   a stored frame (n is 1-based or "last")
 *   GET    /timelapses/:id/renders/:file    a rendered video
 */

import type { Express, Request, Response } from "express";
import type { TimelapseStatusResponse } from "./camera-types.js";
import { CameraConfigError, type CameraManager } from "./camera.js";
import { TimelapseError, type TimelapseRecorder } from "./timelapse.js";

function sendError(res: Response, e: unknown): void {
  if (e instanceof TimelapseError) {
    res.status(e.status).json({ error: e.message });
  } else if (e instanceof CameraConfigError) {
    res.status(400).json({ error: e.message });
  } else {
    console.error(e);
    res.status(500).json({ error: (e as Error).message ?? "internal error" });
  }
}

/** Wraps an async handler so rejections become JSON error responses. */
function handler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
    }
  };
}

export function mountCameraRoutes(
  app: Express,
  cameras: CameraManager,
  recorder: TimelapseRecorder,
  isPlotting: () => boolean,
): void {
  // ----- cameras

  app.get("/cameras", (_req, res) => {
    res.json({ cameras: cameras.list() });
  });

  app.post(
    "/cameras",
    handler((req, res) => {
      res.status(201).json(cameras.add(req.body));
    }),
  );

  app.put(
    "/cameras/:id",
    handler((req, res) => {
      const camera = cameras.update(String(req.params.id), req.body);
      if (!camera) res.status(404).json({ error: "no such camera" });
      else res.json(camera);
    }),
  );

  app.delete(
    "/cameras/:id",
    handler((req, res) => {
      if (!cameras.remove(String(req.params.id))) res.status(404).json({ error: "no such camera" });
      else res.status(204).end();
    }),
  );

  app.get(
    "/cameras/:id/snapshot.jpg",
    handler(async (req, res) => {
      const camera = cameras.get(String(req.params.id));
      if (!camera) {
        res.status(404).json({ error: "no such camera" });
        return;
      }
      if (!camera.config.enabled) {
        res.status(409).json({ error: "camera is disabled" });
        return;
      }
      try {
        const frame = await camera.getFrame({ fresh: req.query.fresh === "1", timeoutMs: 10000 });
        res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Content-Length": String(frame.length) });
        res.end(frame);
      } catch (e) {
        res.status(503).json({ error: (e as Error).message });
      }
    }),
  );

  app.get("/cameras/:id/stream.mjpeg", (req, res) => {
    const camera = cameras.get(String(req.params.id));
    if (!camera?.config.enabled) {
      res.status(404).json({ error: "no such camera" });
      return;
    }
    const boundary = "saxiframe";
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-store",
      Connection: "close",
      Pragma: "no-cache",
    });
    const release = camera.retain();
    const onFrame = (frame: Buffer) => {
      if (res.writableEnded) return;
      res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write("\r\n");
    };
    camera.on("frame", onFrame);
    const latest = camera.latestFrame();
    if (latest) onFrame(latest);
    req.on("close", () => {
      camera.off("frame", onFrame);
      release();
    });
  });

  // ----- timelapse control

  app.get(
    "/timelapse/status",
    handler(async (_req, res) => {
      const body: TimelapseStatusResponse = {
        settings: recorder.settings,
        active: recorder.activeSession(),
        renderJobs: recorder.renderJobs(),
        capabilities: await cameras.getCapabilities(),
        dataDir: recorder.dataDir,
        plotting: isPlotting(),
      };
      res.json(body);
    }),
  );

  app.put(
    "/timelapse/settings",
    handler((req, res) => {
      res.json(recorder.updateSettings(req.body));
    }),
  );

  app.post(
    "/timelapse/start",
    handler(async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name : undefined;
      res.status(201).json(await recorder.start({ source: "manual", name }));
    }),
  );

  app.post(
    "/timelapse/snap",
    handler(async (_req, res) => {
      res.json({ frameCount: await recorder.snap() });
    }),
  );

  app.post(
    "/timelapse/stop",
    handler(async (_req, res) => {
      res.json(await recorder.stop("finished"));
    }),
  );

  // ----- recordings

  app.get("/timelapses", (_req, res) => {
    res.json({ timelapses: recorder.listSessions() });
  });

  app.get(
    "/timelapses/:id",
    handler((req, res) => {
      const session = recorder.getSession(String(req.params.id));
      if (!session) res.status(404).json({ error: "no such timelapse" });
      else res.json(session);
    }),
  );

  app.delete(
    "/timelapses/:id",
    handler(async (req, res) => {
      if (!(await recorder.deleteSession(String(req.params.id)))) res.status(404).json({ error: "no such timelapse" });
      else res.status(204).end();
    }),
  );

  app.post(
    "/timelapses/:id/render",
    handler((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const camerasWanted = Array.isArray(body.cameras) ? body.cameras.map(String) : undefined;
      const jobs = recorder.render(String(req.params.id), { ...body, cameras: camerasWanted });
      res.status(202).json({ jobs });
    }),
  );

  app.get(
    "/timelapses/:id/frames/:camera/:n.jpg",
    handler((req, res) => {
      const n = req.params.n === "last" ? "last" : Number(req.params.n);
      const file = recorder.framePath(String(req.params.id), String(req.params.camera), n);
      if (!file) {
        res.status(404).json({ error: "no such frame" });
        return;
      }
      res.sendFile(file, { headers: { "Cache-Control": n === "last" ? "no-store" : "private, max-age=3600" } });
    }),
  );

  app.get(
    "/timelapses/:id/renders/:file",
    handler((req, res) => {
      const file = recorder.renderPath(String(req.params.id), String(req.params.file));
      if (!file) {
        res.status(404).json({ error: "no such render" });
        return;
      }
      res.sendFile(file, { headers: { "Content-Type": "video/mp4" } });
    }),
  );
}
