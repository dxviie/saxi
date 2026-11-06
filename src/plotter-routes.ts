/**
 * HTTP API for plotters, mounted on the saxi express app.
 *
 *   GET    /plotters                      list plotters with their status
 *   GET    /plotters/ports                serial ports of the server, for the plotter form
 *   POST   /plotters                      add a plotter
 *   GET    /plotters/:id                  one plotter
 *   PUT    /plotters/:id                  update a plotter (settings are merged)
 *   DELETE /plotters/:id                  remove a plotter
 *   POST   /plotters/:id/plot             plot { plan: SerializedMotion[], job: PlotJobInfo }
 *   POST   /plotters/:id/pause|resume|cancel
 *   GET    /plotters/:id/preview.svg      the drawing being plotted
 *
 * The single-plotter API (/plot, /plot/status, /pause, /resume, /cancel) drives the first plotter.
 */

import type { Express, Request, Response } from "express";
import { Device, type PlanHardware, PenMotion, Plan, XYMotion } from "./planning.js";
import { type Plotter, PlotterError } from "./plotter.js";
import { PlotterConfigError, type PlotterManager } from "./plotter-manager.js";
import type { PlotJobInfo } from "./plotter-types.js";
import type { Vec2 } from "./vec.js";

const PLAN_HARDWARE: PlanHardware[] = ["v3", "brushless", "nextdraw-2234", "idraw-h-se", "hp7475a"];

function sendError(res: Response, e: unknown): void {
  if (e instanceof PlotterError) {
    res.status(e.status).send(e.message);
  } else if (e instanceof PlotterConfigError) {
    res.status(400).json({ error: e.message });
  } else {
    console.error(e);
    res.status(500).json({ error: (e as Error).message ?? "internal error" });
  }
}

function handler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
    }
  };
}

/** Plot metadata from a request, with anything unusable dropped. */
export function validateJob(input: unknown): PlotJobInfo {
  const o = (typeof input === "object" && input ? input : {}) as Record<string, unknown>;
  const job: PlotJobInfo = { name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : "plot" };
  const paper = o.paperSize as { x?: unknown; y?: unknown } | undefined;
  const x = Number(paper?.x);
  const y = Number(paper?.y);
  if (x > 0 && y > 0 && x < 10000 && y < 10000) job.paperSize = { x, y };
  if (PLAN_HARDWARE.includes(o.hardware as PlanHardware)) job.hardware = o.hardware as PlanHardware;
  const pen = Number(o.pen);
  if (Number.isInteger(pen) && pen >= 1 && pen <= 6) job.pen = pen;
  const speed = Number(o.penSpeed);
  if (speed > 0 && speed < 10000) job.penSpeed = speed;
  return job;
}

/**
 * Starts a plot from a request body: `{ plan, job }`, or just the plan (the motions array) as older clients send.
 * Responds once the plot has started.
 */
export function startPlot(plotter: Plotter, body: unknown, res: Response): void {
  const isLegacy = Array.isArray(body);
  // a malformed plan throws here, which express turns into a 500
  const plan = Plan.deserialize(isLegacy ? body : (body as { plan: never }).plan);
  const job = isLegacy ? { name: "plot" } : validateJob((body as { job?: unknown }).job);
  plotter.plot(plan, job).catch(() => {}); // the plotter logs what went wrong
  res.status(200).end();
}

/** An SVG of the pen-down lines of a plan, light enough for a thumbnail. */
export function planPreviewSvg(plan: Plan, job: PlotJobInfo | null, maxPoints = 20000): string {
  const device = Device(job?.hardware);
  const scale = 1 / device.stepsPerMm;
  const strokes: Vec2[][] = [];
  let down = false;
  let total = 0;
  for (const motion of plan.motions) {
    if (motion instanceof PenMotion) down = motion.initialPos > motion.finalPos;
    else if (motion instanceof XYMotion && down) {
      const points = motion.points();
      strokes.push(points);
      total += points.length;
    }
  }
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const fmt = (n: number) => (n * scale).toFixed(2);
  const d = strokes
    .map((points) => {
      const kept = points.filter((_, i) => i === 0 || i === points.length - 1 || i % step === 0);
      return kept.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`).join("");
    })
    .join("");
  let size = job?.paperSize;
  if (!size) {
    let maxX = 10;
    let maxY = 10;
    for (const points of strokes) {
      for (const p of points) {
        maxX = Math.max(maxX, p.x * scale);
        maxY = Math.max(maxY, p.y * scale);
      }
    }
    size = { x: maxX + 10, y: maxY + 10 };
  }
  const width = (Math.max(size.x, size.y) / 300).toFixed(2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.x} ${size.y}">` +
    `<rect width="${size.x}" height="${size.y}" fill="#fff"/>` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>` +
    "</svg>"
  );
}

export function mountPlotterRoutes(app: Express, manager: PlotterManager): void {
  const plotterFor = (req: Request, res: Response): Plotter | null => {
    const plotter = manager.get(String(req.params.id));
    if (!plotter) res.status(404).json({ error: "no such plotter" });
    return plotter ?? null;
  };

  app.get("/plotters", (_req, res) => {
    res.json({ plotters: manager.list() });
  });

  app.get(
    "/plotters/ports",
    handler(async (_req, res) => {
      res.json({ ports: await manager.ports(), platform: process.platform });
    }),
  );

  app.post(
    "/plotters",
    handler((req, res) => {
      res.status(201).json(manager.add(req.body));
    }),
  );

  app.get("/plotters/:id", (req, res) => {
    const plotter = plotterFor(req, res);
    if (plotter) res.json(plotter.withStatus());
  });

  app.put(
    "/plotters/:id",
    handler((req, res) => {
      const plotter = manager.update(String(req.params.id), req.body);
      if (!plotter) res.status(404).json({ error: "no such plotter" });
      else res.json(plotter);
    }),
  );

  app.delete(
    "/plotters/:id",
    handler(async (req, res) => {
      if (!(await manager.remove(String(req.params.id)))) res.status(404).json({ error: "no such plotter" });
      else res.status(204).end();
    }),
  );

  app.post("/plotters/:id/plot", (req, res) => {
    const plotter = plotterFor(req, res);
    if (!plotter) return;
    try {
      startPlot(plotter, req.body, res);
    } catch (e) {
      sendError(res, e);
    }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/plotters/:id/${action}`, (req, res) => {
      const plotter = plotterFor(req, res);
      if (!plotter) return;
      plotter[action]();
      res.status(200).end();
    });
  }

  app.get("/plotters/:id/preview.svg", (req, res) => {
    const plotter = plotterFor(req, res);
    if (!plotter) return;
    const current = plotter.currentPlot();
    if (!current) {
      res.status(404).json({ error: "not plotting" });
      return;
    }
    res.set({ "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=5" });
    res.send(planPreviewSvg(current.plan, current.job));
  });

  // ----- the single-plotter API, for the first plotter

  app.post("/plot", (req, res) => {
    const plotter = manager.default();
    if (plotter.isPlotting) console.log("Received plot request, but a plot is already in progress!");
    try {
      startPlot(plotter, req.body, res);
    } catch (e) {
      if (e instanceof PlotterError) sendError(res, e);
      else throw e;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting: manager.default().isPlotting });
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/${action}`, (_req, res) => {
      manager.default()[action]();
      res.status(200).end();
    });
  }
}
