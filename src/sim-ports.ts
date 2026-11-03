/**
 * A simulated EiBotBoard on a fake serial port: it acknowledges every command at once and answers the queries
 * saxi makes. Used for the "simulated" port, and to run through a plot when no AxiDraw is connected.
 */

import type { EBBPort } from "./ebb.js";

function answer(command: string): string {
  if (command.startsWith("V") || command.startsWith("v")) return "EBBv13_and_above EB Firmware Version 2.5.3";
  if (command.startsWith("QM")) return "QM,0,0,0,0";
  if (command.startsWith("QB")) return "0";
  if (command.startsWith("QT")) return "simulated";
  return "OK";
}

export interface SimulatedEbb extends EBBPort {
  open(options?: unknown): Promise<void>;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  readonly commands: string[];
}

export function createSimulatedEbb(onCommand?: (command: string) => void): SimulatedEbb {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const commands: string[] = [];
  let pending = "";
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
          if (!command) continue;
          commands.push(command);
          onCommand?.(command);
          setTimeout(() => controller?.enqueue(encoder.encode(`${answer(command)}\r\n`)), 1);
        }
      },
    }),
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    addEventListener: () => {},
  };
}
