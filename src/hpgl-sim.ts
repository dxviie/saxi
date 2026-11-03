/**
 * A simulated HP 7475A on a fake serial port: it buffers HP-GL like the real plotter (1024 bytes, executed in
 * order with the time the moves would take), answers the output and device-control instructions saxi uses, and
 * records what it drew. Used for the "simulated" port and in tests.
 */

import { HP7475A_FRAMES } from "./hpgl.js";
import type { EBBPort } from "./ebb.js";
import type { Vec2 } from "./vec.js";

const BUFFER_BYTES = 1024;
/** Plotter units per second at 38.1 cm/s. */
const MAX_SPEED = 381 / 0.02488;

export interface SimulatedHpglOptions {
  /** Paper selected on the plotter. */
  paper?: "A4" | "A3" | "A" | "B";
  /** Multiplies every duration; 0 runs instantly (but still in order). */
  timeScale?: number;
  /** What OI answers. */
  model?: string;
  /** Never answer anything, like a plotter at another baud rate or a straight-through cable. */
  silent?: boolean;
}

export interface SimulatedHpgl extends EBBPort {
  /** Every HP-GL instruction executed, in order, e.g. `PD100,200`. */
  readonly executed: string[];
  /** Device-control instructions received, e.g. `.K`. */
  readonly escapes: string[];
  /** Lines drawn with the pen down, per pen. */
  readonly strokes: Array<{ pen: number; from: Vec2; to: Vec2 }>;
  /** The most bytes ever waiting in the buffer: more than 1024 is an overflow. */
  readonly maxBuffered: number;
  /** Set the extended-status bits: 16 for VIEW pressed, 32 for the paper lever raised. */
  setStatusBits(bits: number): void;
  readonly closedByHost: boolean;
}

export function createSimulatedHpgl(opts: SimulatedHpglOptions = {}): SimulatedHpgl {
  const frame = HP7475A_FRAMES.find((f) => f.paper.name === (opts.paper ?? "A4")) ?? HP7475A_FRAMES[0];
  const scale = opts.timeScale ?? 1;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let buffer = ""; // received HP-GL, waiting to be executed
  let control: string | null = null; // device-control instruction being received
  let statusBits = 0;
  let busy = false;
  let closed = false;
  const state = { x: 0, y: 0, down: false, pen: 0, speed: MAX_SPEED };

  const sim = {
    executed: [] as string[],
    escapes: [] as string[],
    strokes: [] as Array<{ pen: number; from: Vec2; to: Vec2 }>,
    maxBuffered: 0,
    closedByHost: false,
  };

  function respond(text: string): void {
    if (opts.silent || closed) return;
    setTimeout(() => controller?.enqueue(encoder.encode(`${text}\r`)), 1);
  }

  function wait(seconds: number): Promise<void> {
    const ms = seconds * 1000 * scale;
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  async function moveTo(x: number, y: number): Promise<void> {
    const clipped = {
      x: Math.min(frame.clip.x1, Math.max(frame.clip.x0, x)),
      y: Math.min(frame.clip.y1, Math.max(frame.clip.y0, y)),
    };
    const distance = Math.hypot(clipped.x - state.x, clipped.y - state.y);
    if (state.down && state.pen > 0 && distance > 0) {
      sim.strokes.push({ pen: state.pen, from: { x: state.x, y: state.y }, to: clipped });
    }
    state.x = clipped.x;
    state.y = clipped.y;
    await wait(distance / (state.down ? state.speed : MAX_SPEED));
  }

  async function execute(instruction: string): Promise<void> {
    const mnemonic = instruction.slice(0, 2).toUpperCase();
    const params = instruction
      .slice(2)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map(Number);
    sim.executed.push(instruction);
    switch (mnemonic) {
      case "IN":
      case "DF":
        state.speed = MAX_SPEED;
        if (mnemonic === "IN") state.down = false;
        return;
      case "SP": {
        const pen = params[0] ?? 0;
        if (pen !== state.pen) {
          state.down = false;
          state.pen = pen;
          await wait(1.5);
        }
        return;
      }
      case "VS":
        state.speed = params.length ? (Math.min(38.1, Math.max(0.38, params[0])) * 10) / 0.02488 : MAX_SPEED;
        return;
      case "PU":
      case "PD": {
        const down = mnemonic === "PD";
        if (down !== state.down) {
          state.down = down;
          await wait(0.05);
        }
        for (let i = 0; i + 1 < params.length; i += 2) await moveTo(params[i], params[i + 1]);
        return;
      }
      case "OA":
      case "OC":
        respond(`${state.x},${state.y},${state.down ? 1 : 0}`);
        return;
      case "OI":
        respond(opts.model ?? "7475A");
        return;
      case "OH":
        respond(`${frame.clip.x0},${frame.clip.y0},${frame.clip.x1},${frame.clip.y1}`);
        return;
      case "OP":
        respond(`${frame.p1p2.x0},${frame.p1p2.y0},${frame.p1p2.x1},${frame.p1p2.y1}`);
        return;
      case "OS":
        respond("24");
        return;
      case "OE":
        respond("0");
        return;
      default:
        return;
    }
  }

  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (!closed) {
        if (statusBits & 48) {
          await new Promise((resolve) => setTimeout(resolve, 20)); // VIEW pressed or lever raised: suspended
          continue;
        }
        const end = buffer.indexOf(";");
        if (end < 0) break;
        const instruction = buffer.slice(0, end).replace(/^[\s\r\n]+/, "");
        buffer = buffer.slice(end + 1);
        if (instruction) await execute(instruction);
      }
    } finally {
      busy = false;
    }
  }

  function deviceControl(sequence: string): void {
    sim.escapes.push(sequence);
    switch (sequence[1]) {
      case "B":
        respond(String(Math.max(0, BUFFER_BYTES - buffer.length)));
        break;
      case "O":
        respond(String((buffer.length === 0 && !busy ? 8 : 0) | statusBits));
        break;
      case "E":
        respond("0");
        break;
      case "L":
        respond(String(BUFFER_BYTES));
        break;
      case "K":
        buffer = "";
        break;
      default:
        break;
    }
  }

  function receive(text: string): void {
    for (const ch of text) {
      if (control !== null) {
        control += ch;
        // ESC . @, H, I, M and N take parameters up to a colon; the others are a single letter
        if (control.length === 2 && !"@HIMN".includes(ch)) {
          deviceControl(control);
          control = null;
        } else if (control.length > 2 && ch === ":") {
          deviceControl(control);
          control = null;
        }
        continue;
      }
      if (ch === "\x1b") {
        control = ""; // then ".", the letter and any parameters
        continue;
      }
      buffer += ch;
    }
    sim.maxBuffered = Math.max(sim.maxBuffered, buffer.length);
    void run();
  }

  const decoder = new TextDecoder();
  const port: SimulatedHpgl = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        receive(decoder.decode(chunk));
      },
    }),
    async close() {
      if (closed) return;
      closed = true;
      sim.closedByHost = true;
      try {
        controller?.close();
      } catch {
        // already closed
      }
    },
    get executed() {
      return sim.executed;
    },
    get escapes() {
      return sim.escapes;
    },
    get strokes() {
      return sim.strokes;
    },
    get maxBuffered() {
      return sim.maxBuffered;
    },
    get closedByHost() {
      return sim.closedByHost;
    },
    setStatusBits(bits: number) {
      statusBits = bits;
      void run();
    },
  };
  return port;
}
