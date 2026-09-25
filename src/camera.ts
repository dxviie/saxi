/**
 * Server-side camera support.
 *
 * A camera is a source of JPEG frames. Sources are only running while
 * something needs frames (a live preview client or a timelapse recording),
 * and are stopped again after an idle period, so an unused webcam doesn't
 * keep a Raspberry Pi busy.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CameraConfig,
  type CameraKind,
  type CameraRotation,
  type CameraStatus,
  type CameraWithStatus,
  type Capabilities,
  defaultCameraConfig,
} from "./camera-types.js";

// ---------------------------------------------------------------------------
// JPEG helpers

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

/** Returns the width/height encoded in a JPEG's start-of-frame segment, or null. */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === SOS || marker === EOI) return null;
    const len = buf.readUInt16BE(pos + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

/**
 * Splits a byte stream (raw MJPEG, or a multipart/x-mixed-replace body) into
 * complete JPEG frames. Segments are walked properly, so an EOI marker inside
 * an embedded EXIF thumbnail does not end a frame prematurely.
 */
export class JpegStreamParser {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns any complete frames it completed. */
  public push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    let from = 0;
    for (;;) {
      const start = this.findSoi(from);
      if (start < 0) {
        // keep a trailing 0xFF in case the SOI is split across chunks
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
        return frames;
      }
      const end = this.findFrameEnd(start);
      if (end === "incomplete") {
        this.buf = this.buf.subarray(start);
        return frames;
      }
      if (end === "invalid") {
        from = start + 2;
        continue;
      }
      frames.push(this.buf.subarray(start, end));
      from = end;
    }
  }

  private findSoi(from: number): number {
    for (let i = from; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 0xff && this.buf[i + 1] === SOI) return i;
    }
    return -1;
  }

  /** Returns the index just past the EOI marker, or a status. */
  private findFrameEnd(start: number): number | "incomplete" | "invalid" {
    const buf = this.buf;
    let pos = start + 2;
    for (;;) {
      if (pos + 1 >= buf.length) return "incomplete";
      if (buf[pos] !== 0xff) return "invalid";
      const marker = buf[pos + 1];
      if (marker === 0xff) {
        pos += 1;
        continue;
      }
      if (marker === EOI) return pos + 2;
      if (marker === SOI) return "invalid";
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2; // standalone markers
        continue;
      }
      if (pos + 3 >= buf.length) return "incomplete";
      const len = buf.readUInt16BE(pos + 2);
      if (len < 2) return "invalid";
      pos += 2 + len;
      if (marker !== SOS) continue;
      // Entropy-coded data: skip until the next real marker (0xFF followed by
      // anything other than 0x00 stuffing or an RSTn marker).
      for (;;) {
        if (pos + 1 >= buf.length) return "incomplete";
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
          pos += next === 0xff ? 1 : 2;
          continue;
        }
        pos += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Frame sources

/**
 * Something that emits `frame` events with a JPEG Buffer while started, and
 * `error` events (with an Error) when things go wrong. Sources keep trying to
 * recover on their own until stopped.
 */
export abstract class FrameSource extends EventEmitter {
  protected started = false;
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.run();
  }
  public stop(): void {
    this.started = false;
    this.halt();
  }
  protected abstract run(): void;
  protected abstract halt(): void;
}

const RESTART_DELAY_MS = 3000;

/** Runs a child process that writes an MJPEG stream to stdout, restarting it if it dies. */
export class ProcessSource extends FrameSource {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";

  private command: string;

  constructor(
    command: string,
    private readonly args: string[],
    private readonly fallbackCommand?: string,
  ) {
    super();
    this.command = command;
  }

  protected run(): void {
    this.stderrTail = "";
    const parser = new JpegStreamParser();
    let child: ChildProcess;
    try {
      child = spawn(this.command, this.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) this.emit("frame", frame);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null; // "exit" may or may not follow an error; don't report twice
      if (err.code === "ENOENT" && this.fallbackCommand && this.command !== this.fallbackCommand) {
        // e.g. rpicam-vid missing on an older Pi OS: try libcamera-vid
        this.command = this.fallbackCommand;
        this.scheduleRestart(0);
        return;
      }
      this.fail(err.code === "ENOENT" ? new Error(`${this.command} not found. Is it installed?`) : err);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.started) return;
      const detail = this.stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      this.fail(new Error(`${this.command} exited (${signal ?? code})${detail ? `: ${detail}` : ""}`));
    });
  }

  private fail(err: Error): void {
    this.emit("error", err);
    if (this.started) this.scheduleRestart(RESTART_DELAY_MS);
  }

  private scheduleRestart(delayMs: number): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.started && !this.child) this.run();
    }, delayMs);
  }

  protected halt(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => clearTimeout(killer));
    }
  }
}

/**
 * Polls an HTTP URL for JPEG snapshots, or consumes an MJPEG multipart stream
 * from it (detected from the response content type).
 */
export class UrlSource extends FrameSource {
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly fps: number,
  ) {
    super();
  }

  protected run(): void {
    void this.fetchLoop();
  }

  private async fetchLoop(): Promise<void> {
    while (this.started) {
      const began = Date.now();
      const controller = new AbortController();
      this.controller = controller;
      try {
        const res = await fetch(this.url, { signal: controller.signal, headers: { accept: "image/jpeg, */*" } });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}`);
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (type.startsWith("multipart/x-mixed-replace")) {
          await this.consumeStream(res);
        } else {
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length < 4 || body[0] !== 0xff || body[1] !== SOI) {
            throw new Error(`${this.url} did not return a JPEG (content-type ${type || "unknown"})`);
          }
          this.emit("frame", body);
        }
      } catch (e) {
        if (!this.started) return;
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
        await this.sleep(RESTART_DELAY_MS);
        continue;
      } finally {
        this.controller = null;
      }
      const wait = Math.max(0, 1000 / this.fps - (Date.now() - began));
      await this.sleep(wait);
    }
  }

  private async consumeStream(res: Response): Promise<void> {
    if (!res.body) throw new Error("empty response body");
    const parser = new JpegStreamParser();
    const reader = res.body.getReader();
    let last = 0;
    const minGap = 1000 / this.fps;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !this.started) return;
      for (const frame of parser.push(Buffer.from(value))) {
        const now = Date.now();
        if (now - last >= minGap) {
          last = now;
          this.emit("frame", frame);
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        resolve();
      }, ms);
    });
  }

  protected halt(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function ffmpegInputArgs(config: CameraConfig): string[] {
  const size = config.resolution ? ["-video_size", config.resolution] : [];
  switch (config.kind) {
    case "device":
      switch (process.platform) {
        case "darwin":
          return ["-f", "avfoundation", "-framerate", "30", ...size, "-i", config.source];
        case "win32":
          return ["-f", "dshow", ...size, "-i", `video=${config.source}`];
        default: {
          const format = config.inputFormat ? ["-input_format", config.inputFormat] : [];
          return ["-f", "v4l2", ...format, ...size, "-i", config.source];
        }
      }
    case "rtsp":
      return ["-rtsp_transport", "tcp", "-i", config.source];
    default:
      return ["-i", config.source];
  }
}

/** Builds the frame source for a camera configuration. */
export function createFrameSource(config: CameraConfig): FrameSource {
  switch (config.kind) {
    case "url":
      return new UrlSource(config.source, config.fps);
    case "libcamera": {
      const [w, h] = config.resolution ? config.resolution.split("x") : [];
      const args = [
        "--codec", "mjpeg", "--quality", "92", "-t", "0", "-n",
        "--framerate", String(Math.max(1, Math.round(config.fps))),
        ...(w && h ? ["--width", w, "--height", h] : []),
        "-o", "-",
      ]; // biome-ignore format: readability
      return new ProcessSource("rpicam-vid", args, "libcamera-vid");
    }
    default: {
      const args = [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        ...ffmpegInputArgs(config),
        "-vf", `fps=${config.fps}`,
        "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg", "pipe:1",
      ]; // biome-ignore format: readability
      return new ProcessSource("ffmpeg", args);
    }
  }
}

// ---------------------------------------------------------------------------
// Camera: a source plus its latest frame, kept alive while there is demand

/** How long a camera keeps streaming after the last preview request. */
const IDLE_TIMEOUT_MS = 15000;

export class Camera extends EventEmitter {
  public config: CameraConfig;
  public status: CameraStatus = { state: "idle", error: null, lastFrameAt: null, width: null, height: null, frames: 0 };
  private source: FrameSource | null = null;
  private latest: Buffer | null = null;
  private retains = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private waiters: Array<{ resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private readonly makeSource: (config: CameraConfig) => FrameSource;

  constructor(config: CameraConfig, makeSource: (config: CameraConfig) => FrameSource = createFrameSource) {
    super();
    this.config = config;
    this.makeSource = makeSource;
  }

  /** Keep the camera streaming until the returned function is called. */
  public retain(): () => void {
    this.retains += 1;
    this.ensureRunning();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retains -= 1;
      this.scheduleIdleStop();
    };
  }

  /** Keep the camera streaming for a little while (used by preview polling). */
  public touch(idleMs = IDLE_TIMEOUT_MS): void {
    this.ensureRunning();
    this.scheduleIdleStop(idleMs);
  }

  /** The most recent frame, if any. */
  public latestFrame(): Buffer | null {
    return this.latest;
  }

  /**
   * Resolve with a frame. With `fresh`, waits for the next frame captured
   * after the call; otherwise returns the latest frame if there is one.
   */
  public getFrame(opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    this.touch();
    if (!opts.fresh && this.latest) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(this.status.error ?? `timed out waiting for a frame from ${this.config.name}`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  public updateConfig(config: CameraConfig): void {
    const wasRunning = this.source !== null;
    this.stopSource();
    this.config = config;
    this.latest = null;
    if (wasRunning && config.enabled) this.ensureRunning();
  }

  public close(): void {
    this.retains = 0;
    this.stopSource();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("camera closed"));
    }
    this.waiters = [];
  }

  private ensureRunning(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.source || !this.config.enabled) return;
    const source = this.makeSource(this.config);
    this.source = source;
    this.status = { ...this.status, state: "starting", error: null, frames: 0 };
    source.on("frame", (frame: Buffer) => {
      if (this.source !== source) return;
      this.latest = frame;
      const dims = jpegDimensions(frame);
      this.status = {
        state: "live",
        error: null,
        lastFrameAt: Date.now(),
        width: dims?.width ?? this.status.width,
        height: dims?.height ?? this.status.height,
        frames: this.status.frames + 1,
      };
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(frame);
      }
      this.emit("frame", frame);
    });
    source.on("error", (err: Error) => {
      if (this.source !== source) return;
      // Sources retry on their own, so log once when a camera starts failing rather than on every retry.
      // Don't emit "error" here: nobody listens for it, and an unhandled "error" event would crash the server.
      if (this.status.state !== "error") console.warn(`Camera "${this.config.name}": ${err.message}`);
      this.status = { ...this.status, state: "error", error: err.message };
    });
    source.start();
  }

  private scheduleIdleStop(idleMs = IDLE_TIMEOUT_MS): void {
    if (this.retains > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.retains === 0) this.stopSource();
    }, idleMs);
  }

  private stopSource(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const source = this.source;
    this.source = null;
    if (source) {
      source.removeAllListeners();
      source.stop();
    }
    this.status = { ...this.status, state: "idle", error: null };
  }
}

// ---------------------------------------------------------------------------
// Configuration validation

const KINDS: CameraKind[] = ["device", "libcamera", "url", "rtsp"];
const ROTATIONS: CameraRotation[] = [0, 90, 180, 270];

export class CameraConfigError extends Error {}

function bad(message: string): never {
  throw new CameraConfigError(message);
}

/** Validate user-supplied camera settings, filling defaults. Throws CameraConfigError. */
export function validateCameraConfig(input: unknown, id: string): CameraConfig {
  if (typeof input !== "object" || input === null) bad("camera config must be an object");
  const o = { ...defaultCameraConfig, ...(input as Record<string, unknown>) };
  const kind = o.kind as CameraKind;
  if (!KINDS.includes(kind)) bad(`kind must be one of ${KINDS.join(", ")}`);
  const source = typeof o.source === "string" ? o.source.trim() : "";
  if (kind === "libcamera") {
    // rpicam-vid picks the camera itself; source may be empty
  } else if (!source) {
    bad("source is required");
  } else if (kind === "url" || kind === "rtsp") {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      bad("source must be a valid URL");
    }
    const ok = kind === "url" ? ["http:", "https:"] : ["rtsp:", "rtsps:"];
    if (!ok.includes(url.protocol)) bad(`source must be a ${ok.join(" or ")} URL`);
  } else if (kind === "device" && process.platform === "linux" && !/^\/dev\/video\d+$/.test(source)) {
    bad("source must be a video device such as /dev/video0");
  } else if (source.startsWith("-")) {
    bad("source must not start with '-'");
  }
  const resolution = typeof o.resolution === "string" ? o.resolution.trim().toLowerCase() : "";
  if (resolution && !/^\d{2,5}x\d{2,5}$/.test(resolution)) bad("resolution must look like 1920x1080");
  const inputFormat = typeof o.inputFormat === "string" ? o.inputFormat.trim() : "";
  if (inputFormat && !/^[a-z0-9_]+$/i.test(inputFormat)) bad("inputFormat must be a pixel format or codec name");
  const fps = Number(o.fps);
  if (!Number.isFinite(fps) || fps < 0.2 || fps > 30) bad("fps must be between 0.2 and 30");
  const rotate = Number(o.rotate) as CameraRotation;
  if (!ROTATIONS.includes(rotate)) bad("rotate must be 0, 90, 180 or 270");
  const name = (typeof o.name === "string" ? o.name.trim() : "").slice(0, 60) || `Camera ${id.slice(0, 4)}`;
  return { id, name, kind, source, resolution, inputFormat, fps, rotate, enabled: Boolean(o.enabled) };
}

// ---------------------------------------------------------------------------
// Manager: the set of configured cameras, persisted to disk

export function newId(): string {
  return randomBytes(6).toString("hex");
}

function runVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : String(stdout).split("\n")[0].trim());
      });
    } catch {
      resolve(null);
    }
  });
}

export async function detectCapabilities(): Promise<Capabilities> {
  const ffmpeg = await runVersion("ffmpeg", ["-version"]);
  let libcamera = false;
  if (process.platform === "linux") {
    libcamera =
      (await runVersion("rpicam-vid", ["--version"])) !== null ||
      (await runVersion("libcamera-vid", ["--version"])) !== null;
  }
  return {
    ffmpeg: ffmpeg !== null,
    ffmpegVersion: ffmpeg ? ffmpeg.replace(/^ffmpeg version\s+/, "").split(" ")[0] : null,
    libcamera,
    platform: process.platform,
  };
}

export class CameraManager {
  private cameras = new Map<string, Camera>();
  private readonly configPath: string;
  private capabilities: Capabilities | null = null;
  private capabilitiesPromise: Promise<Capabilities> | null = null;

  constructor(
    public readonly dataDir: string,
    private readonly makeSource: (config: CameraConfig) => FrameSource = createFrameSource,
  ) {
    this.configPath = path.join(dataDir, "cameras.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as { cameras?: unknown[] };
      for (const entry of raw.cameras ?? []) {
        const id = (entry as { id?: string }).id;
        if (typeof id !== "string" || !id) continue;
        try {
          const config = validateCameraConfig(entry, id);
          this.cameras.set(id, new Camera(config, this.makeSource));
        } catch (e) {
          console.warn(`Ignoring invalid camera ${id} in ${this.configPath}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`Could not read ${this.configPath}: ${(e as Error).message}`);
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const cameras = [...this.cameras.values()].map((c) => c.config);
    writeFileSync(this.configPath, `${JSON.stringify({ cameras }, null, 2)}\n`);
  }

  public getCapabilities(): Promise<Capabilities> {
    if (this.capabilities) return Promise.resolve(this.capabilities);
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = detectCapabilities().then((c) => {
        this.capabilities = c;
        return c;
      });
    }
    return this.capabilitiesPromise;
  }

  public list(): CameraWithStatus[] {
    return [...this.cameras.values()].map((c) => ({ ...c.config, status: c.status }));
  }

  public get(id: string): Camera | undefined {
    return this.cameras.get(id);
  }

  public add(input: unknown): CameraWithStatus {
    const id = newId();
    const config = validateCameraConfig(input, id);
    const camera = new Camera(config, this.makeSource);
    this.cameras.set(id, camera);
    this.save();
    return { ...config, status: camera.status };
  }

  public update(id: string, input: unknown): CameraWithStatus | undefined {
    const camera = this.cameras.get(id);
    if (!camera) return undefined;
    const config = validateCameraConfig({ ...camera.config, ...(input as object) }, id);
    camera.updateConfig(config);
    this.save();
    return { ...config, status: camera.status };
  }

  public remove(id: string): boolean {
    const camera = this.cameras.get(id);
    if (!camera) return false;
    camera.close();
    this.cameras.delete(id);
    this.save();
    return true;
  }

  /** Enabled cameras, in configuration order. */
  public enabled(): Camera[] {
    return [...this.cameras.values()].filter((c) => c.config.enabled);
  }

  public close(): void {
    for (const camera of this.cameras.values()) camera.close();
  }
}
