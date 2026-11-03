/**
 * Driver for HP-GL plotters on a serial port, written for the HP 7475A (RS-232-C, Option 001).
 *
 * The plotter buffers 1024 bytes of HP-GL and executes it in order; device-control instructions (ESC . x) are
 * answered right away. Its hardware handshake is on its DTR line, which most null-modem cables bring to the
 * adapter's DSR, where serial ports can't use it for flow control. So saxi paces the data itself: every chunk it
 * sends ends with an output instruction (OA or OC), whose answer comes once the plotter has parsed everything
 * before it, and no more than `windowBytes` may be unanswered. The answers also tell how far the plotter has
 * got, for the progress display and the timelapse triggers.
 */

import type { EBBPort } from "./ebb.js";
import {
  frameFromClip,
  HpglEncoder,
  type HpglFrame,
  parseRect,
  plotterTransform,
  velocityInstruction,
} from "./hpgl.js";
import { type Motion, PenMotion, type Plan, XYMotion } from "./planning.js";
import type { PlotterDriver } from "./plotter-driver.js";
import type { PlotJobInfo, PlotterPaper } from "./plotter-types.js";

const ESC = "\x1b";

/** HP-GL bytes allowed in flight without an answer. The 7475A buffers 1024. */
const DEFAULT_WINDOW = 900;
/** With a hardware handshake the port stops by itself; the window then only bounds how long a cancel takes. */
const HANDSHAKE_WINDOW = 4096;
/** Instructions are sent in chunks of about this many bytes, each followed by an output instruction. */
const CHUNK_BYTES = 192;

const POSITION = /^-?\d+,-?\d+,\d$/; // OA / OC: x,y,pen
const RECT = /^-?\d+,-?\d+,-?\d+,-?\d+$/; // OH / OP
const NUMBER = /^\d+$/; // ESC . O, ESC . B, ESC . E
const TEXT = /[A-Za-z]/; // OI

interface Pending {
  /** Answers to device-control instructions come right away, the others in order. */
  immediate: boolean;
  matches: RegExp;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HpglPlotterOptions {
  /** The cable carries the plotter's handshake to the adapter's CTS (see PlotterConfig.rtscts). */
  rtscts?: boolean;
  /** Override the number of unanswered bytes allowed. */
  windowBytes?: number;
  /** How long to wait for the plotter to identify itself. */
  timeoutMs?: number;
  /** How often to check the plotter's status (ESC . O), in ms. 0 turns it off. */
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the extended status (ESC . O) says needs doing, if anything. */
export function attentionFromStatus(status: number): string | null {
  if (status & 32) return "Paper lever is raised: lower it to plot";
  if (status & 16) return "VIEW is pressed: press VIEW again to continue";
  return null;
}

export class HpglPlotter implements PlotterDriver {
  /**
   * Opens communication with the plotter on an open port: it must identify itself (OI) within `timeoutMs`.
   * Rejects (and closes the port) otherwise.
   */
  public static async connect(port: EBBPort, path: string, opts: HpglPlotterOptions = {}): Promise<HpglPlotter> {
    const plotter = new HpglPlotter(port, path, opts);
    try {
      // plotter on (needed with the Y/D switch at Y), then drop anything half received
      await plotter.write(`${ESC}.(${ESC}.K`);
      const id = await plotter.request("OI;", { matches: TEXT, timeoutMs: opts.timeoutMs ?? 3000 });
      plotter.model = `HP ${id.trim()}`;
      await plotter.readPaper();
    } catch (e) {
      await plotter.close().catch(() => {});
      throw e instanceof Error && /timed out/.test(e.message)
        ? new Error(
            "the plotter did not answer: check the baud rate, that the cable is a null-modem one, and that the plotter is on",
          )
        : e;
    }
    plotter.startPolling(opts.pollMs ?? 2000);
    return plotter;
  }

  public model = "HP-GL plotter";
  public attention: string | null = null;
  public readonly reportsProgress = true;
  public readonly startDelayMs = 0;
  public onReached: (motionIdx: number) => void = () => {};
  public onChange: () => void = () => {};
  public readonly closed: Promise<void>;

  private frame: HpglFrame | null = null;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private writes: Promise<void> = Promise.resolve();
  private pending: Pending[] = [];
  private readonly window: number;
  private sent = 0;
  private acked = 0;
  private waiters: Array<() => void> = [];
  private cancelled = false;
  private plotting = false;
  private encoder: HpglEncoder | null = null;
  private pen = 1;
  private poll: ReturnType<typeof setInterval> | null = null;
  private missedPolls = 0;
  private isClosed = false;
  private markClosed: () => void = () => {};

  private constructor(
    private readonly port: EBBPort,
    public readonly path: string,
    opts: HpglPlotterOptions,
  ) {
    this.window = opts.windowBytes ?? (opts.rtscts ? HANDSHAKE_WINDOW : DEFAULT_WINDOW);
    this.writer = port.writable.getWriter();
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
    void this.readLoop();
  }

  public get paper(): PlotterPaper | null {
    return this.frame?.paper ?? null;
  }

  // ----- serial I/O

  private async readLoop(): Promise<void> {
    const reader = this.port.readable.getReader();
    let line = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        for (const byte of value) {
          const c = byte & 0x7f; // with parity off the plotter may set the eighth bit
          if (c === 13 || c === 10) {
            if (line) this.received(line);
            line = "";
          } else if (c >= 32) {
            line += String.fromCharCode(c);
          }
        }
      }
    } catch {
      // port closed
    } finally {
      this.lost("connection closed");
    }
  }

  private received(line: string): void {
    if (process.env.DEBUG_SAXI_COMMANDS) console.log(`hpgl read: ${line}`);
    const immediate = NUMBER.test(line);
    let i = this.pending.findIndex((p) => p.immediate === immediate && p.matches.test(line));
    if (i < 0) i = this.pending.findIndex((p) => p.matches.test(line));
    if (i < 0) return; // e.g. an answer to an instruction that ESC . K discarded
    const [p] = this.pending.splice(i, 1);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(line);
  }

  private write(text: string): Promise<void> {
    if (process.env.DEBUG_SAXI_COMMANDS) console.log(`hpgl write: ${JSON.stringify(text)}`);
    const bytes = new TextEncoder().encode(text);
    const write = this.writes.then(() => this.writer.write(bytes));
    this.writes = write.catch(() => {});
    return write;
  }

  /** Sends `command` and resolves with the answer that matches. */
  private request(
    command: string,
    opts: { matches: RegExp; immediate?: boolean; timeoutMs?: number },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const p: Pending = { immediate: opts.immediate ?? false, matches: opts.matches, resolve, reject, timer: null };
      p.timer = setTimeout(() => {
        this.pending = this.pending.filter((q) => q !== p);
        reject(new Error(`timed out waiting for an answer to ${JSON.stringify(command)}`));
      }, opts.timeoutMs ?? 5000);
      this.pending.push(p);
      this.write(command).catch((e) => {
        this.pending = this.pending.filter((q) => q !== p);
        if (p.timer) clearTimeout(p.timer);
        reject(e);
      });
    });
  }

  private lost(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.poll) clearInterval(this.poll);
    for (const p of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending = [];
    this.cancelled = true;
    this.wake();
    this.markClosed();
  }

  /** Reads the paper size the plotter is set to (it resets the plotter: only between plots). */
  private async readPaper(): Promise<HpglFrame> {
    const clip = parseRect(await this.request("IN;OH;", { matches: RECT }));
    if (!clip) throw new Error("the plotter sent no plotting area");
    const frame = frameFromClip(clip);
    if (frame.paper.name !== this.frame?.paper.name) {
      this.frame = frame;
      this.onChange();
    }
    return frame;
  }

  private startPolling(ms: number): void {
    if (ms <= 0) return;
    this.poll = setInterval(() => {
      if (this.pending.some((p) => p.immediate)) return; // previous check still waiting
      this.request(`${ESC}.O`, { immediate: true, matches: NUMBER, timeoutMs: ms * 1.5 })
        .then((line) => {
          this.missedPolls = 0;
          this.setAttention(attentionFromStatus(Number(line)));
        })
        .catch(() => {
          if (this.isClosed) return;
          this.missedPolls += 1;
          if (this.missedPolls < 3) return;
          if (this.plotting) this.setAttention("The plotter is not answering: is it on?");
          else this.lost("the plotter stopped answering");
        });
    }, ms);
  }

  private setAttention(attention: string | null): void {
    if (attention === this.attention) return;
    this.attention = attention;
    this.onChange();
  }

  // ----- pacing

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private async room(bytes: number): Promise<void> {
    while (!this.cancelled && this.sent + bytes - this.acked > this.window) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.cancelled) throw this.stopped();
  }

  private stopped(): Error {
    return new Error(this.isClosed ? "lost the connection to the plotter" : "Cancelled");
  }

  /**
   * Sends instructions followed by an output instruction, once there is room. `reached` is reported when the
   * plotter answers. OA (actual position) is used after pen lifts, where waiting for the plotter to arrive costs
   * nothing; OC (commanded position) elsewhere.
   */
  private async send(instructions: string, reached: number | null, actual = false): Promise<void> {
    const text = `${instructions}${actual ? "OA;" : "OC;"}`;
    await this.room(text.length);
    this.sent += text.length;
    const end = this.sent;
    const p: Pending = {
      immediate: false,
      matches: POSITION,
      resolve: () => {
        this.acked = Math.max(this.acked, end);
        this.wake();
        if (reached !== null && !this.cancelled) this.onReached(reached);
      },
      reject: () => {},
      timer: null,
    };
    this.pending.push(p);
    await this.write(text);
  }

  private async drained(): Promise<void> {
    while (!this.cancelled && this.acked < this.sent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.cancelled) throw this.stopped();
  }

  // ----- PlotterDriver

  public async prePlot(_plan: Plan, job: PlotJobInfo): Promise<void> {
    this.cancelled = false;
    this.sent = this.acked = 0;
    this.pending = this.pending.filter((p) => p.immediate);
    await this.write(`${ESC}.K`);
    const frame = await this.readPaper(); // the SIZE key may have been pressed since
    this.encoder = new HpglEncoder({
      transform: plotterTransform(job.paperSize ?? frame.paper.size, frame),
      clip: frame.clip,
    });
    this.pen = Math.min(6, Math.max(1, Math.round(job.pen ?? 1)));
    this.plotting = true;
    await this.send(`SP${this.pen};${velocityInstruction(job.penSpeed ?? 381)}`, null);
  }

  public async executeMotion(motion: Motion, index: number, plan: Plan): Promise<void> {
    if (!this.encoder) throw new Error("prePlot was not called");
    // the plan ends by travelling back to the pen's home; the HP stows the pen instead
    if (index === plan.motions.length - 1 && motion instanceof XYMotion) return;
    const instructions = this.encoder.encode(motion);
    let chunk = "";
    for (const instruction of instructions) {
      if (chunk && chunk.length + instruction.length > CHUNK_BYTES) {
        await this.send(chunk, index);
        chunk = "";
      }
      chunk += instruction;
    }
    const lift = motion instanceof PenMotion && motion.initialPos < motion.finalPos;
    await this.send(chunk, index + 1, lift);
  }

  public async pause(): Promise<void> {
    // put the pen away while paused, so it doesn't sit uncapped above the paper
    await this.send("SP0;", null, true);
  }

  public async resume(): Promise<void> {
    await this.send(`SP${this.pen};`, null);
  }

  public async finish(): Promise<void> {
    await this.send("PU;SP0;", null, true);
    await this.drained();
  }

  public cancel(): void {
    if (!this.plotting) return;
    this.cancelled = true;
    this.pending = this.pending.filter((p) => p.immediate); // ESC . K discards what they answer
    this.acked = this.sent;
    this.wake();
    void this.write(`${ESC}.K`).catch(() => {});
  }

  public async postCancel(_plan: Plan): Promise<void> {
    await sleep(300); // answers already on their way are ignored
    this.pending = this.pending.filter((p) => p.immediate);
    this.cancelled = false;
    this.sent = this.acked = 0;
    await this.request("PU;SP0;OA;", { matches: POSITION, timeoutMs: 30000 });
  }

  public async postPlot(): Promise<void> {
    this.plotting = false;
    this.encoder = null;
  }

  public async setPenHeight(height: number): Promise<void> {
    if (this.plotting) return;
    await this.write(height >= 1 ? "PU;" : "PD;");
  }

  public async selectPen(pen: number): Promise<void> {
    if (this.plotting) return;
    await this.write(`PU;SP${Math.min(6, Math.max(0, Math.round(pen)))};`);
  }

  public async limp(): Promise<void> {
    if (this.plotting) return;
    await this.write("PU;SP0;");
  }

  public async close(): Promise<void> {
    this.lost("closed");
    try {
      this.writer.releaseLock();
    } catch {
      // still writing
    }
    await this.port.close();
  }
}

/** The baud rates the 7475A's rear switches offer, most likely first. */
export const HPGL_BAUD_RATES = [9600, 4800, 2400, 1200, 600, 300, 150, 110, 75];

/**
 * Asks whatever is on `port` to identify itself as an HP-GL plotter. Resolves with its model and paper, or null
 * if nothing answered within `timeoutMs`.
 */
export async function identifyHpgl(
  port: EBBPort,
  timeoutMs = 1500,
): Promise<{ model: string; paper: PlotterPaper | null } | null> {
  try {
    const plotter = await HpglPlotter.connect(port, "", { timeoutMs, pollMs: 0 });
    const result = { model: plotter.model, paper: plotter.paper };
    await plotter.close().catch(() => {});
    return result;
  } catch {
    return null;
  }
}
