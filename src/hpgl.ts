/**
 * HP-GL output for plotters that plan their own motion, such as the HP 7475A.
 *
 * Plans for these plotters are made in HP plotter units (see `HPGL_UNITS_PER_MM`) in saxi's paper coordinates:
 * origin at the top left of the paper, y pointing down. HP-GL puts its origin near the lower left of the plotting
 * area with y pointing up, and lays every paper size out landscape, so the encoder flips y, centres the paper on
 * the plotter's paper frame and turns portrait drawings a quarter turn.
 *
 * Shared by the server (which streams the instructions) and the UI (which offers the program as a file).
 */

import type { PlotterPaper } from "./plotter-types.js";
import { HPGL_UNITS_PER_MM, type Motion, PenMotion, type Plan, XYMotion } from "./planning.js";
import type { Vec2 } from "./vec.js";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where a paper size lies in plotter units: the area the pen can reach and the centre of the paper. */
export interface HpglFrame {
  paper: PlotterPaper;
  /** Hard-clip limits: the pen cannot go outside. */
  clip: Rect;
  /** Centre of the paper. */
  center: Vec2;
}

interface StandardFrame {
  paper: PlotterPaper;
  clip: Rect;
  /** Default scaling points P1 and P2, which HP places symmetrically on the paper. */
  p1p2: Rect;
}

/**
 * The paper sizes of the HP 7475A, from its Interfacing and Programming Manual (chapter 2): maximum plotting ranges
 * and default scaling points in plotter units. The rear US/MET switch picks the family, the front-panel SIZE key
 * the size.
 */
export const HP7475A_FRAMES: StandardFrame[] = [
  {
    paper: { name: "A4", size: { x: 297, y: 210 } },
    clip: { x0: 0, y0: 0, x1: 11040, y1: 7721 },
    p1p2: { x0: 603, y0: 521, x1: 10603, y1: 7721 },
  },
  {
    paper: { name: "A3", size: { x: 420, y: 297 } },
    clip: { x0: 0, y0: 0, x1: 16158, y1: 11040 },
    p1p2: { x0: 170, y0: 602, x1: 15370, y1: 10602 },
  },
  {
    paper: { name: "A", size: { x: 279.4, y: 215.9 } },
    clip: { x0: 0, y0: 0, x1: 10365, y1: 7962 },
    p1p2: { x0: 250, y0: 596, x1: 10250, y1: 7796 },
  },
  {
    paper: { name: "B", size: { x: 431.8, y: 279.4 } },
    clip: { x0: 0, y0: 0, x1: 16640, y1: 10365 },
    p1p2: { x0: 522, y0: 259, x1: 15722, y1: 10259 },
  },
];

function toFrame(f: StandardFrame): HpglFrame {
  return {
    paper: f.paper,
    clip: f.clip,
    center: { x: (f.p1p2.x0 + f.p1p2.x1) / 2, y: (f.p1p2.y0 + f.p1p2.y1) / 2 },
  };
}

/** Parses an HP-GL output of four integers, such as the response to OH or OP. */
export function parseRect(line: string): Rect | null {
  const parts = line.trim().split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x0, y0, x1, y1] = parts;
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/**
 * The frame for the hard-clip limits a plotter reports (OH). Known sizes use HP's paper layout; anything else is
 * taken to be paper centred on the plotting area.
 */
export function frameFromClip(clip: Rect): HpglFrame {
  const known = HP7475A_FRAMES.find(
    (f) => f.clip.x0 === clip.x0 && f.clip.y0 === clip.y0 && f.clip.x1 === clip.x1 && f.clip.y1 === clip.y1,
  );
  if (known) return toFrame(known);
  const size = { x: (clip.x1 - clip.x0) / HPGL_UNITS_PER_MM, y: (clip.y1 - clip.y0) / HPGL_UNITS_PER_MM };
  return {
    paper: { name: `${Math.round(size.x)}×${Math.round(size.y)} mm`, size },
    clip,
    center: { x: (clip.x0 + clip.x1) / 2, y: (clip.y0 + clip.y1) / 2 },
  };
}

/** The 7475A frame for a paper name the plotter reported (`A4`, `A3`, `A`, `B`), if it is one. */
export function frameForName(name: string): HpglFrame | null {
  const known = HP7475A_FRAMES.find((f) => f.paper.name === name);
  return known ? toFrame(known) : null;
}

/**
 * The 7475A paper frame to use for a drawing laid out on `paperSize` (mm), when the plotter can't be asked: the
 * same size if there is one, otherwise the smallest that fits it.
 */
export function frameForPaper(paperSize: Vec2): HpglFrame {
  const long = Math.max(paperSize.x, paperSize.y);
  const short = Math.min(paperSize.x, paperSize.y);
  const exact = HP7475A_FRAMES.find((f) => Math.abs(f.paper.size.x - long) < 2 && Math.abs(f.paper.size.y - short) < 2);
  if (exact) return toFrame(exact);
  // US paper for sizes in (half) inches such as 5×7 in, ISO paper for the rest
  const inches = [long, short].every((mm) => Math.abs(mm / 12.7 - Math.round(mm / 12.7)) < 0.04);
  const fits = (f: StandardFrame) => f.paper.size.x >= long && f.paper.size.y >= short;
  const area = (f: StandardFrame) => f.paper.size.x * f.paper.size.y;
  const us = (f: StandardFrame) => f.paper.name === "A" || f.paper.name === "B";
  const fitting = HP7475A_FRAMES.filter(fits).sort(
    (a, b) => Number(us(a) !== inches) - Number(us(b) !== inches) || area(a) - area(b),
  );
  return toFrame(fitting[0] ?? HP7475A_FRAMES[1]);
}

/** Whether a drawing laid out on `paperSize` (mm) fits the plotter's paper. */
export function paperFits(paperSize: Vec2, paper: PlotterPaper): boolean {
  const long = Math.max(paperSize.x, paperSize.y);
  const short = Math.min(paperSize.x, paperSize.y);
  return long <= paper.size.x + 1 && short <= paper.size.y + 1;
}

/**
 * Maps plan coordinates (plotter units, saxi paper frame: y down) to HP-GL coordinates, with the paper centred on
 * the frame. Portrait paper is turned a quarter turn: the top of the drawing ends up at the left of the plot.
 */
export function plotterTransform(paperSize: Vec2, frame: HpglFrame, unitsPerMm = HPGL_UNITS_PER_MM): (p: Vec2) => Vec2 {
  const w = paperSize.x * unitsPerMm;
  const h = paperSize.y * unitsPerMm;
  const { x: cx, y: cy } = frame.center;
  if (paperSize.x >= paperSize.y) {
    return (p) => ({ x: cx + p.x - w / 2, y: cy - (p.y - h / 2) });
  }
  return (p) => ({ x: cx + p.y - h / 2, y: cy + p.x - w / 2 });
}

/** HP-GL velocity instruction for a pen-down speed in mm/s (VS takes cm/s, 0.38 to 38.1). */
export function velocityInstruction(mmPerSecond: number): string {
  const cm = mmPerSecond / 10;
  if (!Number.isFinite(cm) || cm >= 38.1) return "VS;"; // full speed, at the full 2 g acceleration
  return `VS${Math.max(0.38, Math.round(cm * 100) / 100)};`;
}

/** Clips the segment a-b to `r`. Returns the parameters [t0, t1] of the part inside, or null. (Liang-Barsky) */
function clipSegment(a: Vec2, b: Vec2, r: Rect): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

function inside(p: Vec2, r: Rect): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

function round(p: Vec2): Vec2 {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function same(a: Vec2 | null, b: Vec2): boolean {
  return a !== null && a.x === b.x && a.y === b.y;
}

/**
 * Drops repeated points, and points on the straight line between their neighbours, such as where the motion
 * planner splits a line into accelerating, cruising and braking parts. The plotter could slow down at each.
 */
export function simplifyPolyline(points: Vec2[], tolerance = 0.5): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (same(out.at(-1) ?? null, p)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = p.x - a.x;
      const apy = p.y - a.y;
      const len = Math.hypot(apx, apy);
      const cross = Math.abs(abx * apy - aby * apx);
      // b lies on a-p, between a and p
      if (len > 0 && cross / len <= tolerance && abx * apx + aby * apy >= 0 && Math.hypot(abx, aby) <= len) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

export interface EncoderOptions {
  /** Plan coordinates to plotter coordinates. */
  transform: (p: Vec2) => Vec2;
  /** The pen is kept inside this area: lines are cut at its edges. */
  clip: Rect;
  /** Coordinate pairs per PD instruction, which keeps instructions short enough to pace the data between them. */
  maxPointsPerInstruction?: number;
}

/**
 * Turns plan motions into HP-GL instructions (each a complete instruction ending in `;`), keeping track of the pen.
 * Pen-up moves go straight to their end point; the plotter plans its own acceleration.
 */
export class HpglEncoder {
  private readonly transform: (p: Vec2) => Vec2;
  private readonly clip: Rect;
  private readonly maxPoints: number;
  /** Whether the plan has the pen down. */
  private penDown = false;
  /** Whether the pen is really on the paper (it stays up outside the clip area). */
  private drawing = false;
  /** Where the plan has the pen (may be outside the clip area). */
  private planned: Vec2 | null = null;
  /** Where the pen really is. */
  private at: Vec2 | null = null;

  constructor(opts: EncoderOptions) {
    this.transform = opts.transform;
    this.clip = opts.clip;
    this.maxPoints = opts.maxPointsPerInstruction ?? 16;
  }

  public encode(motion: Motion): string[] {
    if (motion instanceof PenMotion) return this.pen(motion.initialPos > motion.finalPos);
    if (motion instanceof XYMotion) return this.penDown ? this.draw(motion) : this.travel(motion);
    return [];
  }

  private pen(down: boolean): string[] {
    this.penDown = down;
    if (!down) {
      if (!this.drawing) return [];
      this.drawing = false;
      return ["PU;"];
    }
    // lower the pen only where it can reach; otherwise when the line comes into reach
    if (this.planned && this.at && same(this.planned, this.at) && inside(this.at, this.clip)) {
      this.drawing = true;
      return ["PD;"];
    }
    return [];
  }

  private travel(motion: XYMotion): string[] {
    if (motion.length === 0) return [];
    const target = round(this.transform(motion.p2));
    this.planned = target;
    const reachable = {
      x: Math.min(this.clip.x1, Math.max(this.clip.x0, target.x)),
      y: Math.min(this.clip.y1, Math.max(this.clip.y0, target.y)),
    };
    if (same(this.at, reachable)) return [];
    this.at = reachable;
    return [`PU${reachable.x},${reachable.y};`];
  }

  private draw(motion: XYMotion): string[] {
    // merge before rounding: the points the planner adds lie exactly on the line only before
    const points = simplifyPolyline(
      simplifyPolyline(
        motion.points().map((p) => this.transform(p)),
        0.05,
      ).map(round),
      0,
    );
    const out: string[] = [];
    let run: Vec2[] = [];
    const flush = () => {
      for (let i = 0; i < run.length; i += this.maxPoints) {
        out.push(
          `PD${run
            .slice(i, i + this.maxPoints)
            .map((p) => `${p.x},${p.y}`)
            .join(",")};`,
        );
      }
      run = [];
    };
    let from = this.planned ?? points[0];
    for (const to of points) {
      if (same(from, to)) continue;
      const span = clipSegment(from, to, this.clip);
      if (!span) {
        if (this.drawing) {
          flush();
          out.push("PU;");
          this.drawing = false;
        }
      } else {
        const [t0, t1] = span;
        const enter = round({ x: from.x + (to.x - from.x) * t0, y: from.y + (to.y - from.y) * t0 });
        const exit = round({ x: from.x + (to.x - from.x) * t1, y: from.y + (to.y - from.y) * t1 });
        if (!this.drawing || !same(this.at, enter)) {
          flush();
          if (this.drawing) out.push("PU;");
          if (!same(this.at, enter)) out.push(`PU${enter.x},${enter.y};`);
          out.push("PD;");
          this.at = enter;
          this.drawing = true;
        }
        if (!same(this.at, exit)) {
          run.push(exit);
          this.at = exit;
        }
        if (t1 < 1) {
          flush();
          out.push("PU;");
          this.drawing = false;
        }
      }
      from = to;
    }
    flush();
    this.planned = from;
    return out;
  }
}

export interface HpglProgramOptions {
  /** Paper the drawing was laid out on, in mm. */
  paperSize: Vec2;
  frame?: HpglFrame;
  /** Carousel pen, 1-6. */
  pen?: number;
  /** Pen-down speed in mm/s. */
  penSpeed?: number;
}

/** A complete HP-GL program for a plan, as a plotter or another tool would read it from a file. */
export function hpglProgram(plan: Plan, opts: HpglProgramOptions): string {
  const frame = opts.frame ?? frameForPaper(opts.paperSize);
  const encoder = new HpglEncoder({ transform: plotterTransform(opts.paperSize, frame), clip: frame.clip });
  const lines = ["IN;", `SP${opts.pen ?? 1};`, velocityInstruction(opts.penSpeed ?? 381)];
  const last = plan.motions.length - 1;
  plan.motions.forEach((motion, i) => {
    // the plan ends by travelling back to the pen's home, which an HP plotter doesn't need: it stows the pen
    if (i === last && motion instanceof XYMotion) return;
    lines.push(...encoder.encode(motion));
  });
  lines.push("PU;", "SP0;");
  return `${lines.join("\n")}\n`;
}
