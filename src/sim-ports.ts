/**
 * A simulated EiBotBoard on a fake serial port: it answers the queries saxi makes and takes as long over the moves
 * as a real board would (scaled by `timeScale`), accepting motion commands a little ahead like the board's motion
 * FIFO. Used for the "simulated" port, and to run through a plot when no AxiDraw is connected.
 */

import type { EBBPort } from "./ebb.js";

/** How far ahead of the motors the simulated board accepts motion commands. */
const LEAD_MS = 200;

/** Seconds an LM axis takes: `steps` from a start rate with a per-tick rate change (EBB units). */
function lmAxisSeconds(rate: number, steps: number, deltaR: number): number {
  const s = Math.abs(steps);
  if (s === 0) return 0;
  const v0 = (rate * 25000) / 0x80000000; // steps per second
  const a = (deltaR * 25000 * 25000) / 0x80000000; // steps per second²
  if (Math.abs(a) < 1e-9) return v0 > 0 ? s / v0 : 0;
  const disc = v0 * v0 + 2 * a * s;
  return disc > 0 ? (-v0 + Math.sqrt(disc)) / a : v0 > 0 ? s / v0 : 0;
}

/** How long a command keeps the motors busy, in seconds. */
export function ebbCommandSeconds(command: string): number {
  const [name, ...args] = command.split(",");
  const n = args.map(Number);
  switch (name.toUpperCase()) {
    case "LM":
      return Math.max(lmAxisSeconds(n[0], n[1], n[2]), lmAxisSeconds(n[3], n[4], n[5]));
    case "XM":
    case "SM":
      return (n[0] || 0) / 1000;
    case "S2":
      return (n[3] || 0) / 1000; // the delay after a pen move
    case "HM":
      return 0.5;
    default:
      return 0;
  }
}

function answer(command: string, busy: boolean): string {
  if (command.startsWith("V") || command.startsWith("v")) return "EBBv13_and_above EB Firmware Version 2.5.3";
  if (command.startsWith("QM")) return busy ? "QM,1,1,1,1" : "QM,0,0,0,0";
  if (command.startsWith("QB")) return "0";
  if (command.startsWith("QT")) return "simulated";
  return "OK";
}

export interface SimulatedEbb extends EBBPort {
  open(options?: unknown): Promise<void>;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  readonly commands: string[];
}

export interface SimulatedEbbOptions {
  /** Multiplies every duration; 0 (the default) answers at once. */
  timeScale?: number;
  onCommand?: (command: string) => void;
}

export function createSimulatedEbb(opts: SimulatedEbbOptions = {}): SimulatedEbb {
  const scale = opts.timeScale ?? 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const commands: string[] = [];
  let pending = "";
  /** When the motors are done with everything accepted so far. */
  let busyUntil = 0;
  /** Answers go out in order: none before this. */
  let answerAt = 0;

  function receive(command: string): void {
    commands.push(command);
    opts.onCommand?.(command);
    const now = Date.now();
    const seconds = ebbCommandSeconds(command) * scale;
    let at = now;
    if (seconds > 0) {
      // accepted once less than LEAD_MS of motion is queued before it
      at = Math.max(now, busyUntil - LEAD_MS);
      busyUntil = Math.max(at, busyUntil) + seconds * 1000;
    } else if (command.startsWith("QM") && busyUntil > now) {
      at = now + Math.min(50, busyUntil - now); // don't make the host spin
    }
    answerAt = Math.max(answerAt, at);
    const when = answerAt;
    setTimeout(
      () => controller?.enqueue(encoder.encode(`${answer(command, Date.now() < busyUntil)}\r\n`)),
      Math.max(1, when - now),
    );
  }

  return {
    commands,
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        pending += decoder.decode(chunk);
        const parts = pending.split("\r");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          const command = part.trim();
          if (command) receive(command);
        }
      },
    }),
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    addEventListener: () => {},
  };
}
