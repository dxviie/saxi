/**
 * The interface between saxi's plot loop (see plotter.ts) and a connected machine.
 */

import type { Motion, Plan } from "./planning.js";
import type { PlotJobInfo, PlotterPaper } from "./plotter-types.js";

export interface PlotterDriver {
  /** Serial port in use. */
  readonly path: string;
  /** What answered, e.g. `EBB 2.8.1` or `HP 7475A`. */
  readonly model: string;
  /** Paper the plotter is set up for, when it can tell. */
  readonly paper: PlotterPaper | null;
  /** Something for a person to fix right now, e.g. "paper lever raised". */
  readonly attention: string | null;
  /**
   * When true the driver reports, through `onReached`, when the plotter really gets to the motions it was sent.
   * Otherwise progress is reported as motions are sent (the EBB runs them very soon after).
   */
  readonly reportsProgress: boolean;
  /** How long the plotter is busy after `prePlot` before it gets to the first motion, in ms. */
  readonly startDelayMs: number;
  /** The plotter has done every motion before `motionIdx` (and is working on that one). */
  onReached: (motionIdx: number) => void;
  /** Something in the status (attention, paper) changed. */
  onChange: () => void;
  /** Resolves when the connection is gone. */
  readonly closed: Promise<void>;

  prePlot(plan: Plan, job: PlotJobInfo): Promise<void>;
  /** Sends one motion. May wait for the plotter to make room. */
  executeMotion(motion: Motion, index: number, plan: Plan): Promise<void>;
  /** Called when a plot pauses (with the pen up) and when it resumes. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Called after the last motion was sent: resolves once the plotter has done everything. */
  finish(): Promise<void>;
  /** Drops everything queued, right away. The plot loop then calls `postCancel`. */
  cancel(): void;
  postCancel(plan: Plan): Promise<void>;
  /** Always called at the end of a plot, finished or not. */
  postPlot(): Promise<void>;

  /** Manual pen control. `height` is a servo position, or 1 (up) / 0 (down) for HP-GL plotters. */
  setPenHeight(height: number, rate: number): Promise<void>;
  /** HP-GL: pick up a pen from the carousel (0 stores it). */
  selectPen?(pen: number): Promise<void>;
  /** Motors off (EBB), or pen away (HP-GL). */
  limp(): Promise<void>;
  close(): Promise<void>;
}
