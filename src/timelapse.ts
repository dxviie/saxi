/**
 * Timelapse recording and rendering.
 *
 * A recording ("session") captures frames from every enabled camera into
 * `<dataDir>/timelapses/<session>/<cameraId>/frame-000001.jpg`, either
 * automatically while a plot runs or manually. Each camera captures on its own
 * trigger (pen lifts, while the pen is down, or on an interval), or the one of
 * the timelapse settings; cameras sharing a trigger capture together. The
 * moments frames were captured at are kept in `timeline.txt`, so that a
 * composite can show every camera's latest frame at each of them. Finished
 * sessions can be rendered to MP4 with ffmpeg, one video per camera plus an
 * optional multi-camera composite.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, copyFile, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Camera, type CameraManager, jpegDimensions, newId } from "./camera.js";
import {
  type CameraRotation,
  defaultRenderSettings,
  defaultTimelapseSettings,
  type RenderJob,
  type RenderSettings,
  type TimelapseCameraInfo,
  type TimelapseSession,
  type TimelapseSettings,
  TIMELAPSE_TRIGGERS,
  type TimelapseStatus,
  type TimelapseTrigger,
} from "./camera-types.js";
import { PenMotion, type Motion } from "./planning.js";

const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class TimelapseError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function validateRenderSettings(input: unknown, base: RenderSettings = defaultRenderSettings): RenderSettings {
  const o = { ...base, ...((typeof input === "object" && input) || {}) } as Record<string, unknown>;
  const preset = PRESETS.includes(String(o.preset)) ? String(o.preset) : base.preset;
  return {
    fps: clampNumber(o.fps, base.fps, 1, 120),
    crf: Math.round(clampNumber(o.crf, base.crf, 0, 51)),
    preset,
    postRollSeconds: clampNumber(o.postRollSeconds, base.postRollSeconds, 0, 60),
    composite: Boolean(o.composite),
  };
}

export function validateTimelapseSettings(
  input: unknown,
  base: TimelapseSettings = defaultTimelapseSettings,
): TimelapseSettings {
  const o = { ...base, ...((typeof input === "object" && input) || {}) } as Record<string, unknown>;
  const trigger = TIMELAPSE_TRIGGERS.includes(o.trigger as TimelapseTrigger)
    ? (o.trigger as TimelapseTrigger)
    : base.trigger;
  return {
    enabled: Boolean(o.enabled),
    trigger,
    intervalSeconds: clampNumber(o.intervalSeconds, base.intervalSeconds, 0.5, 3600),
    targetFrames: Math.round(clampNumber(o.targetFrames, base.targetFrames, 2, 100000)),
    minIntervalSeconds: clampNumber(o.minIntervalSeconds, base.minIntervalSeconds, 0, 3600),
    captureDelayMs: Math.round(clampNumber(o.captureDelayMs, base.captureDelayMs, 0, 10000)),
    autoRender: Boolean(o.autoRender),
    render: validateRenderSettings(o.render, base.render),
  };
}

function pad6(n: number): string {
  return String(n).padStart(6, "0");
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "camera"
  );
}

function timestampSlug(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve with the promise's value, or undefined once `ms` has elapsed. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, sleep(ms).then(() => undefined)]);
}

function rotationFilter(rotate: CameraRotation): string[] {
  switch (rotate) {
    case 90:
      return ["transpose=1"];
    case 180:
      return ["hflip", "vflip"];
    case 270:
      return ["transpose=2"];
    default:
      return [];
  }
}

/**
 * When the plotter really gets to the motions it is sent. saxi keeps the EBB's motion queue full, so a motion
 * can run seconds after it was sent; the plan's durations tell when. The estimate catches up whenever the
 * queue runs dry, e.g. while paused.
 */
export class PlotClock {
  /** When the plotter will be done with everything sent so far. */
  private busyUntil = 0;
  /** Recent spans [from, until) with the pen on the paper; `until` is Infinity until the pen is lifted. */
  private down: Array<[number, number]> = [];

  /** The plotter is busy for `ms` before it gets to the next motion. */
  public wait(ms: number, now = Date.now()): void {
    this.busyUntil = Math.max(now, this.busyUntil) + ms;
  }

  /** Reports a motion as it is sent. Returns when the plotter will run it. */
  public motion(motion: Motion, now = Date.now()): { start: number; end: number } {
    const start = Math.max(now, this.busyUntil);
    const end = start + motion.duration() * 1000;
    this.busyUntil = end;
    if (motion instanceof PenMotion) {
      const last = this.down.at(-1);
      if (motion.initialPos > motion.finalPos) {
        // lowering: on the paper once the move is done
        if (last?.[1] !== Infinity) this.down.push([end, Infinity]);
      } else if (motion.initialPos < motion.finalPos && last && last[1] === Infinity) {
        last[1] = start; // lifting: off the paper as soon as it starts
      }
      this.down = this.down.filter(([, until]) => until > now - 60_000);
    }
    return { start, end };
  }

  /** Whether the pen was on the paper, with the plotter drawing, all the way from `from` to `to`. */
  public drawing(from: number, to: number): boolean {
    return to <= this.busyUntil && this.down.some(([a, b]) => a <= from && to < b);
  }
}

/**
 * How long before it arrives a frame may have been taken (camera, USB and ffmpeg all add latency). A pen-down
 * camera only keeps a frame if the pen was down for this long before it arrived.
 */
const FRAME_LATENCY_MS = 300;

/** Per recording, one line per moment at which frames were captured: `<camera>:<frame number>` for each camera. */
const TIMELINE = "timeline.txt";

/** Where a composite render finds each camera's frame for every moment, linked in step. */
const COMPOSITE_FRAMES = "composite-frames";

/** The cameras of a recording that share a trigger. */
interface TriggerGroup {
  trigger: TimelapseTrigger;
  cameras: Camera[];
  /** When the group last captured, or is about to (pen lifts are captured once the pen is up). */
  lastCaptureAt: number;
  /** Seconds between frames for the timed triggers. */
  intervalSeconds: number;
  timer: NodeJS.Timeout | null;
}

interface ActiveSession {
  session: TimelapseSession;
  dir: string;
  cameras: Camera[];
  groups: TriggerGroup[];
  releases: Array<() => void>;
  lastFrames: Map<string, Buffer>;
  /** Cameras with a capture in flight, which triggers skip. */
  busy: Set<string>;
  /** Frames are written one moment at a time, in order. */
  writes: Promise<void>;
  /** Captures waiting for the plotter to get to a pen lift. */
  pending: Set<NodeJS.Timeout>;
  /** Set while a plot is attached. */
  clock: PlotClock | null;
  stopListening: () => void;
}

/**
 * For a composite of `cameras`, the frame each camera shows at every moment of a recording: its latest one,
 * or its first before it has any. `timeline` is null for recordings from before cameras had their own
 * triggers, in which every moment had a frame from every camera.
 */
export function alignMoments(timeline: string | null, cameras: TimelapseCameraInfo[]): number[][] {
  const moments: Array<Map<string, number>> =
    timeline === null
      ? Array.from(
          { length: Math.max(0, ...cameras.map((c) => c.frameCount)) },
          (_, i) => new Map(cameras.map((c) => [c.id, Math.min(i + 1, c.frameCount)])),
        )
      : timeline
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              new Map(
                line.split(" ").map((entry): [string, number] => {
                  const [id, n] = entry.split(":");
                  return [id, Number(n)];
                }),
              ),
          );
  const current = cameras.map(() => 0);
  const aligned: number[][] = [];
  for (const moment of moments) {
    let changed = false;
    cameras.forEach((camera, i) => {
      const n = moment.get(camera.id);
      if (n !== undefined && n >= 1 && n <= camera.frameCount) {
        current[i] = n;
        changed = true;
      }
    });
    if (changed) aligned.push(current.map((n) => Math.max(n, 1)));
  }
  return aligned;
}

export class TimelapseRecorder {
  public settings: TimelapseSettings;
  private readonly settingsPath: string;
  private readonly sessionsDir: string;
  private active: ActiveSession | null = null;
  private jobs: RenderJob[] = [];
  private renderQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly cameras: CameraManager,
    public readonly dataDir: string,
  ) {
    this.settingsPath = path.join(dataDir, "timelapse.json");
    this.sessionsDir = path.join(dataDir, "timelapses");
    this.settings = defaultTimelapseSettings;
    if (existsSync(this.settingsPath)) {
      try {
        this.settings = validateTimelapseSettings(JSON.parse(readFileSync(this.settingsPath, "utf8")));
      } catch (e) {
        console.warn(`Could not read ${this.settingsPath}: ${(e as Error).message}`);
      }
    }
  }

  // ----- settings

  public updateSettings(input: unknown): TimelapseSettings {
    this.settings = validateTimelapseSettings(input, this.settings);
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`);
    return this.settings;
  }

  // ----- sessions on disk

  private sessionDir(id: string): string {
    if (!SAFE_NAME.test(id)) throw new TimelapseError("invalid timelapse id", 404);
    return path.join(this.sessionsDir, id);
  }

  private readSessionFile(id: string): TimelapseSession | null {
    try {
      const file = path.join(this.sessionDir(id), "timelapse.json");
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, "utf8")) as TimelapseSession;
    } catch {
      return null;
    }
  }

  private async writeSession(session: TimelapseSession): Promise<void> {
    const dir = this.sessionDir(session.id);
    mkdirSync(dir, { recursive: true });
    await writeFile(path.join(dir, "timelapse.json"), `${JSON.stringify(session, null, 2)}\n`);
  }

  public listSessions(): TimelapseSession[] {
    if (!existsSync(this.sessionsDir)) return [];
    const sessions: TimelapseSession[] = [];
    for (const entry of readdirSync(this.sessionsDir)) {
      if (!SAFE_NAME.test(entry)) continue;
      const session = this.active?.session.id === entry ? this.active.session : this.readSessionFile(entry);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  public getSession(id: string): TimelapseSession | null {
    if (this.active?.session.id === id) return this.active.session;
    return this.readSessionFile(id);
  }

  public async deleteSession(id: string): Promise<boolean> {
    if (this.active?.session.id === id) throw new TimelapseError("cannot delete a recording in progress", 409);
    if (this.jobs.some((j) => j.sessionId === id && j.status === "running")) {
      throw new TimelapseError("cannot delete a timelapse while it is rendering", 409);
    }
    const dir = this.sessionDir(id);
    if (!existsSync(path.join(dir, "timelapse.json"))) return false;
    await rm(dir, { recursive: true, force: true });
    this.jobs = this.jobs.filter((j) => j.sessionId !== id);
    return true;
  }

  /** Absolute path of a stored frame, `n` being 1-based or "last". */
  public framePath(sessionId: string, cameraId: string, n: number | "last"): string | null {
    const session = this.getSession(sessionId);
    if (!session || !SAFE_NAME.test(cameraId)) return null;
    const info = session.cameras.find((c) => c.id === cameraId);
    if (!info || info.frameCount === 0) return null;
    const index = n === "last" ? info.frameCount : n;
    if (!Number.isInteger(index) || index < 1 || index > info.frameCount) return null;
    return path.join(this.sessionDir(sessionId), cameraId, `frame-${pad6(index)}.jpg`);
  }

  /** Absolute path of a rendered video. */
  public renderPath(sessionId: string, file: string): string | null {
    const session = this.getSession(sessionId);
    if (!session || !SAFE_NAME.test(file)) return null;
    if (!session.renders.some((r) => r.file === file)) return null;
    return path.join(this.sessionDir(sessionId), "renders", file);
  }

  // ----- recording

  public activeSession(): TimelapseSession | null {
    return this.active?.session ?? null;
  }

  /**
   * Start a recording with all enabled cameras.
   * @param planDurationSeconds estimated plot duration, used by the targetFrames trigger.
   */
  public async start(
    opts: { source: "plot" | "manual"; name?: string; planDurationSeconds?: number } = { source: "manual" },
  ): Promise<TimelapseSession> {
    if (this.closed) throw new TimelapseError("server is shutting down", 503);
    if (this.active) throw new TimelapseError("a recording is already in progress", 409);
    const cameras = this.cameras.enabled();
    if (cameras.length === 0) throw new TimelapseError("no enabled cameras", 400);

    const now = new Date();
    const stamp = timestampSlug(now);
    const rawName = (opts.name ?? "").trim();
    const name = rawName || `${opts.source} ${now.toLocaleString()}`;
    const id = `${stamp}-${slug(rawName || opts.source)}-${newId().slice(0, 4)}`;
    const triggerOf = (camera: Camera) => camera.config.trigger || this.settings.trigger;
    const session: TimelapseSession = {
      id,
      name,
      startedAt: now.toISOString(),
      finishedAt: null,
      status: "recording",
      source: opts.source,
      trigger: this.settings.trigger,
      frameCount: 0,
      cameras: cameras.map((c) => ({
        id: c.config.id,
        name: c.config.name,
        rotate: c.config.rotate,
        trigger: triggerOf(c),
        frameCount: 0,
        width: null,
        height: null,
      })),
      renders: [],
    };
    const dir = this.sessionDir(id);
    for (const camera of cameras) mkdirSync(path.join(dir, camera.config.id), { recursive: true });
    await this.writeSession(session);

    const groups: TriggerGroup[] = [];
    for (const camera of cameras) {
      const trigger = triggerOf(camera);
      const group = groups.find((g) => g.trigger === trigger);
      if (group) group.cameras.push(camera);
      else {
        groups.push({ trigger, cameras: [camera], lastCaptureAt: 0, intervalSeconds: 0, timer: null });
      }
    }
    const active: ActiveSession = {
      session,
      dir,
      cameras,
      groups,
      releases: cameras.map((c) => c.retain()),
      lastFrames: new Map(),
      busy: new Set(),
      writes: Promise.resolve(),
      pending: new Set(),
      clock: null,
      stopListening: () => {},
    };
    active.stopListening = this.listenWhileDrawing(active);
    this.active = active;
    console.log(`Timelapse ${id}: recording with ${cameras.map((c) => c.config.name).join(", ")}`);

    if (opts.source === "plot") {
      this.attachPlot(active, opts.planDurationSeconds);
    } else {
      for (const group of groups) group.intervalSeconds = this.settings.intervalSeconds;
      this.startTimers(active);
    }
    return session;
  }

  /** Capture a frame from every camera into the active recording. Resolves with the new frame count. */
  public async snap(): Promise<number> {
    const active = this.active;
    if (!active) throw new TimelapseError("no recording in progress", 409);
    // Unlike automatic triggers, a manual snapshot waits for captures in flight instead of skipping those cameras.
    await this.idle(active, active.cameras);
    if (this.active !== active) throw new TimelapseError("recording stopped", 409);
    const captured = await this.captureSet(active, active.cameras, 0);
    if (!captured) throw new TimelapseError("a capture is already in progress, try again", 429);
    return active.session.frameCount;
  }

  public async stop(status: Exclude<TimelapseStatus, "recording"> = "finished"): Promise<TimelapseSession> {
    const active = this.active;
    if (!active) throw new TimelapseError("no recording in progress", 409);
    this.active = null;
    this.detach(active, true);
    // let captures in flight land before releasing the cameras
    await this.idle(active, active.cameras);
    await active.writes;
    for (const release of active.releases) release();
    const session = active.session;
    session.status = session.frameCount === 0 && status === "finished" ? "failed" : status;
    session.finishedAt = new Date().toISOString();
    await this.writeSession(session);
    const counts = session.cameras.map((c) => `${c.name} ${c.frameCount}`).join(", ");
    console.log(`Timelapse ${session.id}: ${session.status} with ${session.frameCount} frame sets (${counts})`);
    if (session.status !== "failed" && this.settings.autoRender && (await this.cameras.getCapabilities()).ffmpeg) {
      this.render(session.id, {});
    }
    return session;
  }

  /** Stops what a plot drives, or with `everything`, all of a recording's triggers. */
  private detach(active: ActiveSession, everything: boolean): void {
    active.clock = null;
    for (const timer of active.pending) clearTimeout(timer);
    active.pending.clear();
    if (everything || active.session.source === "plot") {
      for (const group of active.groups) {
        if (group.timer) clearInterval(group.timer);
        group.timer = null;
      }
    }
    if (everything) active.stopListening();
  }

  /** Waits (up to five seconds) until none of `cameras` has a capture in flight. */
  private async idle(active: ActiveSession, cameras: Camera[]): Promise<void> {
    for (let i = 0; i < 100 && cameras.some((c) => active.busy.has(c.config.id)); i++) await sleep(50);
  }

  private startTimers(active: ActiveSession): void {
    for (const group of active.groups) {
      if (group.trigger !== "interval" && group.trigger !== "targetFrames") continue;
      if (group.timer) clearInterval(group.timer);
      group.timer = setInterval(
        () => void this.captureSet(active, group.cameras, this.settings.captureDelayMs),
        Math.max(500, group.intervalSeconds * 1000),
      );
    }
  }

  private attachPlot(active: ActiveSession, planDurationSeconds?: number): void {
    active.clock = new PlotClock();
    const s = this.settings;
    for (const group of active.groups) {
      group.intervalSeconds =
        group.trigger === "targetFrames" && planDurationSeconds && planDurationSeconds > 0
          ? Math.max(s.minIntervalSeconds, planDurationSeconds / s.targetFrames)
          : s.intervalSeconds;
    }
    this.startTimers(active);
  }

  /** Cameras that capture the blank page and the finished drawing: all but the pen-down ones. */
  private pageCameras(active: ActiveSession): Camera[] {
    return active.groups.filter((g) => g.trigger !== "penDown").flatMap((g) => g.cameras);
  }

  /**
   * Pen-down cameras keep the frames that arrive while the plotter is drawing, at most one per minimum gap.
   * Returns a function that stops listening.
   */
  private listenWhileDrawing(active: ActiveSession): () => void {
    const stops: Array<() => void> = [];
    for (const camera of active.groups.find((g) => g.trigger === "penDown")?.cameras ?? []) {
      let lastAt = 0;
      const onFrame = (frame: Buffer) => {
        const now = Date.now();
        if (this.active !== active || !active.clock) return;
        if (now - lastAt < this.settings.minIntervalSeconds * 1000) return;
        // the frame was taken a little before it arrived: the pen must have been down all along
        if (!active.clock.drawing(now - FRAME_LATENCY_MS, now)) return;
        lastAt = now;
        this.record(active, [[camera, frame]]).catch((e) => console.error(e));
      };
      camera.on("frame", onFrame);
      stops.push(() => camera.off("frame", onFrame));
    }
    return () => {
      for (const stop of stops) stop();
    };
  }

  /**
   * Capture a frame from each of `cameras` into the active recording, as one moment. Cameras still busy with
   * an earlier capture are skipped. Returns false when there was nothing to capture.
   */
  private async captureSet(active: ActiveSession, cameras: Camera[], delayMs: number): Promise<boolean> {
    const free = cameras.filter((c) => !active.busy.has(c.config.id));
    if (free.length === 0) return false;
    for (const camera of free) active.busy.add(camera.config.id);
    try {
      if (delayMs > 0) await sleep(delayMs);
      if (this.active !== active) return false;
      const results = await Promise.all(
        free.map((camera) =>
          camera
            .getFrame({ fresh: true, timeoutMs: Math.max(5000, (2 * 1000) / camera.config.fps + 1000) })
            .then((frame) => ({ camera, frame, error: null as Error | null }))
            .catch((error: Error) => ({ camera, frame: null as Buffer | null, error })),
        ),
      );
      const frames: Array<[Camera, Buffer]> = [];
      for (const { camera, frame, error } of results) {
        const data = frame ?? active.lastFrames.get(camera.config.id) ?? null;
        if (!frame) {
          console.warn(
            `Timelapse ${active.session.id}: ${camera.config.name}: ${error?.message ?? "no frame"}${data ? " (repeating previous frame)" : ""}`,
          );
        }
        if (data) frames.push([camera, data]);
      }
      await this.record(active, frames);
      const now = Date.now();
      for (const group of active.groups) {
        if (group.cameras.some((c) => free.includes(c))) group.lastCaptureAt = Math.max(group.lastCaptureAt, now);
      }
      return true;
    } finally {
      for (const camera of free) active.busy.delete(camera.config.id);
    }
  }

  /** Stores a frame per camera as one moment of the recording. Moments are written one at a time, in order. */
  private record(active: ActiveSession, frames: Array<[Camera, Buffer]>): Promise<void> {
    const write = active.writes.then(() => this.writeFrames(active, frames));
    active.writes = write.catch(() => {});
    return write;
  }

  private async writeFrames(active: ActiveSession, frames: Array<[Camera, Buffer]>): Promise<void> {
    const moment: string[] = [];
    for (const [camera, data] of frames) {
      const id = camera.config.id;
      const info = active.session.cameras.find((c) => c.id === id);
      if (!info) continue;
      const file = path.join(active.dir, id, `frame-${pad6(info.frameCount + 1)}.jpg`);
      try {
        await writeFile(file, data);
      } catch (e) {
        console.error(`Timelapse ${active.session.id}: could not write ${file}: ${(e as Error).message}`);
        continue;
      }
      info.frameCount += 1;
      active.lastFrames.set(id, data);
      if (info.width === null) {
        const dims = jpegDimensions(data);
        info.width = dims?.width ?? null;
        info.height = dims?.height ?? null;
      }
      moment.push(`${id}:${info.frameCount}`);
    }
    if (moment.length === 0) return;
    active.session.frameCount += 1;
    await appendFile(path.join(active.dir, TIMELINE), `${moment.join(" ")}\n`);
    await this.writeSession(active.session);
  }

  // ----- plot hooks (never throw; plotting must not fail because of a camera)

  /** Called just before a plot starts moving. Captures the "blank page" frame when recording. */
  public async plotStarted(planDurationSeconds: number): Promise<void> {
    try {
      let active = this.active;
      if (!active) {
        if (!this.settings.enabled || this.cameras.enabled().length === 0) return;
        await this.start({ source: "plot", planDurationSeconds });
        active = this.active;
        if (!active) return;
      } else {
        this.attachPlot(active, planDurationSeconds);
      }
      await bounded(this.captureSet(active, this.pageCameras(active), 0), 10000);
    } catch (e) {
      console.error(`Timelapse: could not start recording: ${(e as Error).message}`);
    }
  }

  /** Called when the plotter is busy for `ms` before its first motion, e.g. moving the pen to its start height. */
  public plotterBusy(ms: number): void {
    this.active?.clock?.wait(ms);
  }

  /** Called for every motion as it is sent to the plotter. */
  public plotMotion(motion: Motion): void {
    const active = this.active;
    if (!active?.clock) return;
    const { end } = active.clock.motion(motion);
    if (!(motion instanceof PenMotion) || !(motion.initialPos < motion.finalPos)) return; // only pen lifts
    // The plotter gets to this lift after what is queued before it: capture once the pen is actually up.
    const at = end + this.settings.captureDelayMs;
    for (const group of active.groups) {
      if (group.trigger !== "penLift" || at - group.lastCaptureAt < this.settings.minIntervalSeconds * 1000) continue;
      group.lastCaptureAt = at;
      const timer = setTimeout(() => {
        active.pending.delete(timer);
        this.captureSet(active, group.cameras, 0).catch((e) => console.error(e));
      }, at - Date.now());
      active.pending.add(timer);
    }
  }

  /** Called once the plot has finished or was cancelled and the machine is idle. */
  public async plotEnded(cancelled: boolean): Promise<void> {
    const active = this.active;
    if (!active?.clock) return;
    try {
      this.detach(active, false);
      // final frame: the finished drawing (wait for captures in flight first)
      const cameras = this.pageCameras(active);
      await this.idle(active, cameras);
      await bounded(this.captureSet(active, cameras, this.settings.captureDelayMs), 10000);
      if (active.session.source === "plot") {
        await this.stop(cancelled ? "cancelled" : "finished");
      }
    } catch (e) {
      console.error(`Timelapse: error finishing recording: ${(e as Error).message}`);
    }
  }

  // ----- rendering

  public renderJobs(): RenderJob[] {
    return this.jobs;
  }

  /**
   * Queue renders for a session: one per camera (or the given cameras) and,
   * when enabled, a composite of all of them. Returns the queued jobs.
   */
  public render(
    sessionId: string,
    opts: Partial<RenderSettings> & { cameras?: string[]; compositeOnly?: boolean } = {},
  ): RenderJob[] {
    const session = this.getSession(sessionId);
    if (!session) throw new TimelapseError("no such timelapse", 404);
    if (session.status === "recording") throw new TimelapseError("timelapse is still recording", 409);
    if (this.jobs.some((j) => j.sessionId === sessionId && j.status === "running")) {
      throw new TimelapseError("this timelapse is already rendering", 409);
    }
    const settings = validateRenderSettings(opts, this.settings.render);
    const wanted = opts.cameras?.length ? new Set(opts.cameras) : null;
    const cameras = session.cameras.filter((c) => c.frameCount > 0 && (!wanted || wanted.has(c.id)));
    if (cameras.length === 0) throw new TimelapseError("no frames to render", 400);

    const targets: string[] = opts.compositeOnly ? [] : cameras.map((c) => c.id);
    if (settings.composite && cameras.length > 1) targets.push("composite");
    const started = new Date().toISOString();
    const jobs = targets.map<RenderJob>((camera) => ({
      id: newId(),
      sessionId,
      camera,
      status: "running",
      progress: 0,
      error: null,
      output: null,
      startedAt: started,
    }));
    // keep only recent finished jobs around
    this.jobs = [...this.jobs.filter((j) => j.status === "running").slice(-20), ...jobs];
    for (const job of jobs) {
      this.renderQueue = this.renderQueue.then(() => this.runRender(job, session, cameras, settings)).catch(() => {});
    }
    return jobs;
  }

  private async runRender(
    job: RenderJob,
    session: TimelapseSession,
    cameras: TimelapseCameraInfo[],
    settings: RenderSettings,
  ): Promise<void> {
    if (this.closed) {
      job.status = "error";
      job.error = "server shut down";
      return;
    }
    const dir = this.sessionDir(session.id);
    const rendersDir = path.join(dir, "renders");
    mkdirSync(rendersDir, { recursive: true });
    const stamp = timestampSlug(new Date());
    const label = job.camera === "composite" ? "composite" : slug(cameras.find((c) => c.id === job.camera)?.name ?? "");
    const file = `${label}-${settings.fps}fps-${stamp}.mp4`;
    const output = path.join(rendersDir, file);
    const subject = job.camera === "composite" ? cameras : cameras.filter((c) => c.id === job.camera);
    let inputDir = dir;

    console.log(`Timelapse ${session.id}: rendering ${file}`);
    try {
      let frames = Math.min(...subject.map((c) => c.frameCount));
      if (job.camera === "composite") ({ inputDir, frames } = await this.linkComposite(dir, subject));
      const totalFrames = frames + Math.ceil(settings.postRollSeconds * settings.fps);
      const args = buildFfmpegArgs(inputDir, subject, settings, output);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          const m = /frame=\s*(\d+)/g;
          let last: RegExpExecArray | null = null;
          let match: RegExpExecArray | null = m.exec(chunk.toString());
          while (match !== null) {
            last = match;
            match = m.exec(chunk.toString());
          }
          if (last) job.progress = Math.min(0.99, Number(last[1]) / Math.max(1, totalFrames));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          reject(err.code === "ENOENT" ? new Error("ffmpeg not found. Install ffmpeg to render videos.") : err);
        });
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
        });
      });
      const size = statSync(output).size;
      const current = this.getSession(session.id) ?? session;
      current.renders.push({
        file,
        camera: job.camera,
        fps: settings.fps,
        createdAt: new Date().toISOString(),
        sizeBytes: size,
      });
      await this.writeSession(current);
      job.status = "done";
      job.progress = 1;
      job.output = file;
      const sizeText = size < 1e6 ? `${Math.round(size / 1e3)} kB` : `${(size / 1e6).toFixed(1)} MB`;
      console.log(`Timelapse ${session.id}: rendered ${file} (${sizeText})`);
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      console.error(`Timelapse ${session.id}: render failed: ${job.error}`);
      await rm(output, { force: true }).catch(() => {});
    } finally {
      if (inputDir !== dir) await rm(inputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Links every camera's frame for each moment of the recording into COMPOSITE_FRAMES, so that ffmpeg can read
   * the cameras in step even when they captured at different moments.
   */
  private async linkComposite(
    dir: string,
    cameras: TimelapseCameraInfo[],
  ): Promise<{ inputDir: string; frames: number }> {
    const timeline = await readFile(path.join(dir, TIMELINE), "utf8").catch(() => null);
    const moments = alignMoments(timeline, cameras);
    const inputDir = path.join(dir, COMPOSITE_FRAMES);
    await rm(inputDir, { recursive: true, force: true });
    for (const [i, camera] of cameras.entries()) {
      await mkdir(path.join(inputDir, camera.id), { recursive: true });
      for (const [k, frames] of moments.entries()) {
        const source = path.join(dir, camera.id, `frame-${pad6(frames[i])}.jpg`);
        const target = path.join(inputDir, camera.id, `frame-${pad6(k + 1)}.jpg`);
        await link(source, target).catch(() => copyFile(source, target)); // e.g. no hard links on FAT
      }
    }
    return { inputDir, frames: moments.length };
  }

  public close(): void {
    this.closed = true;
    if (this.active) {
      const active = this.active;
      this.active = null;
      this.detach(active, true);
      for (const release of active.releases) release();
      active.session.status = "cancelled";
      active.session.finishedAt = new Date().toISOString();
      writeFileSync(path.join(active.dir, "timelapse.json"), `${JSON.stringify(active.session, null, 2)}\n`);
    }
  }
}

/** Compose the ffmpeg command line for a single-camera or composite render. */
export function buildFfmpegArgs(
  sessionDir: string,
  cameras: TimelapseCameraInfo[],
  settings: RenderSettings,
  output: string,
): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:1"];
  for (const camera of cameras) {
    args.push("-framerate", String(settings.fps), "-i", path.join(sessionDir, camera.id, "frame-%06d.jpg"));
  }
  const postRoll =
    settings.postRollSeconds > 0 ? [`tpad=stop_mode=clone:stop_duration=${settings.postRollSeconds}`] : [];
  if (cameras.length === 1) {
    const filters = [...rotationFilter(cameras[0].rotate), "scale=trunc(iw/2)*2:trunc(ih/2)*2", ...postRoll];
    args.push("-vf", filters.join(","));
  } else {
    // Normalize every camera to the same tile size (letterboxed), then stack.
    const rotated = cameras.map((c) => {
      const w = c.width ?? 1280;
      const h = c.height ?? 720;
      return c.rotate === 90 || c.rotate === 270 ? { w: h, h: w } : { w, h };
    });
    const tileW = Math.min(960, Math.max(...rotated.map((r) => r.w))) & ~1;
    const tileH = Math.round(tileW * Math.max(...rotated.map((r) => r.h / r.w))) & ~1;
    const chains = cameras.map((c, i) => {
      const filters = [
        ...rotationFilter(c.rotate),
        `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease`,
        `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2`,
        "setsar=1",
      ];
      return `[${i}:v]${filters.join(",")}[v${i}]`;
    });
    const inputs = cameras.map((_, i) => `[v${i}]`).join("");
    let stack: string;
    if (cameras.length <= 3) {
      stack = `${inputs}hstack=inputs=${cameras.length}:shortest=1`;
    } else {
      const cols = Math.ceil(Math.sqrt(cameras.length));
      const layout = cameras.map((_, i) => `${(i % cols) * tileW}_${Math.floor(i / cols) * tileH}`).join("|");
      stack = `${inputs}xstack=inputs=${cameras.length}:layout=${layout}:shortest=1:fill=black`;
    }
    const tail = postRoll.length ? `[stacked];[stacked]${postRoll.join(",")}[out]` : "[out]";
    args.push("-filter_complex", `${chains.join(";")};${stack}${tail}`, "-map", "[out]");
  }
  args.push(
    "-c:v", "libx264", "-preset", settings.preset, "-crf", String(settings.crf),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ); // biome-ignore format: readability
  return args;
}
