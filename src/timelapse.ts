/**
 * Timelapse recording and rendering.
 *
 * A recording ("session") captures synchronized frame sets from every enabled
 * camera into `<dataDir>/timelapses/<session>/<cameraId>/frame-000001.jpg`,
 * either automatically while a plot runs (triggered by pen lifts or on an
 * interval) or manually. Finished sessions can be rendered to MP4 with ffmpeg,
 * one video per camera plus an optional multi-camera composite.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
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
  type TimelapseStatus,
  type TimelapseTrigger,
} from "./camera-types.js";
import { PenMotion, type Motion } from "./planning.js";

const TRIGGERS: TimelapseTrigger[] = ["penLift", "interval", "targetFrames"];
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
  const trigger = TRIGGERS.includes(o.trigger as TimelapseTrigger) ? (o.trigger as TimelapseTrigger) : base.trigger;
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

interface ActiveSession {
  session: TimelapseSession;
  dir: string;
  cameras: Camera[];
  releases: Array<() => void>;
  lastFrames: Map<string, Buffer>;
  capturing: boolean;
  lastCaptureAt: number;
  intervalTimer: NodeJS.Timeout | null;
  /** Interval currently in use for timed triggers, in seconds. */
  intervalSeconds: number;
  plotAttached: boolean;
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
        frameCount: 0,
        width: null,
        height: null,
      })),
      renders: [],
    };
    const dir = this.sessionDir(id);
    for (const camera of cameras) mkdirSync(path.join(dir, camera.config.id), { recursive: true });
    await this.writeSession(session);

    const active: ActiveSession = {
      session,
      dir,
      cameras,
      releases: cameras.map((c) => c.retain()),
      lastFrames: new Map(),
      capturing: false,
      lastCaptureAt: 0,
      intervalTimer: null,
      intervalSeconds: this.settings.intervalSeconds,
      plotAttached: false,
    };
    this.active = active;
    console.log(`Timelapse ${id}: recording with ${cameras.map((c) => c.config.name).join(", ")}`);

    if (opts.source === "plot") {
      this.attachPlot(active, opts.planDurationSeconds);
    } else if (this.settings.trigger !== "penLift") {
      this.startIntervalTimer(active);
    }
    return session;
  }

  /** Capture one frame set into the active recording. Resolves with the new frame count. */
  public async snap(): Promise<number> {
    const active = this.active;
    if (!active) throw new TimelapseError("no recording in progress", 409);
    // Unlike automatic triggers, a manual snapshot waits for an in-flight capture instead of being dropped.
    for (let i = 0; i < 200 && active.capturing; i++) await sleep(50);
    if (this.active !== active) throw new TimelapseError("recording stopped", 409);
    const captured = await this.captureSet(active, 0);
    if (!captured) throw new TimelapseError("a capture is already in progress, try again", 429);
    return active.session.frameCount;
  }

  public async stop(status: Exclude<TimelapseStatus, "recording"> = "finished"): Promise<TimelapseSession> {
    const active = this.active;
    if (!active) throw new TimelapseError("no recording in progress", 409);
    this.active = null;
    if (active.intervalTimer) clearInterval(active.intervalTimer);
    // let an in-flight capture land before releasing the cameras
    for (let i = 0; i < 100 && active.capturing; i++) await sleep(50);
    for (const release of active.releases) release();
    const session = active.session;
    session.status = session.frameCount === 0 && status === "finished" ? "failed" : status;
    session.finishedAt = new Date().toISOString();
    await this.writeSession(session);
    console.log(`Timelapse ${session.id}: ${session.status} with ${session.frameCount} frame sets`);
    if (session.status !== "failed" && this.settings.autoRender && (await this.cameras.getCapabilities()).ffmpeg) {
      this.render(session.id, {});
    }
    return session;
  }

  private startIntervalTimer(active: ActiveSession): void {
    if (active.intervalTimer) clearInterval(active.intervalTimer);
    active.intervalTimer = setInterval(
      () => void this.captureSet(active, this.settings.captureDelayMs),
      Math.max(500, active.intervalSeconds * 1000),
    );
  }

  private attachPlot(active: ActiveSession, planDurationSeconds?: number): void {
    active.plotAttached = true;
    const s = this.settings;
    if (s.trigger === "targetFrames" && planDurationSeconds && planDurationSeconds > 0) {
      active.intervalSeconds = Math.max(s.minIntervalSeconds, planDurationSeconds / s.targetFrames);
    } else {
      active.intervalSeconds = s.intervalSeconds;
    }
    if (s.trigger !== "penLift") this.startIntervalTimer(active);
  }

  /**
   * Capture a synchronized frame from every camera in the session.
   * Returns false when a capture was already in progress (the trigger is dropped).
   */
  private async captureSet(active: ActiveSession, delayMs: number): Promise<boolean> {
    if (active.capturing) return false;
    active.capturing = true;
    try {
      if (delayMs > 0) await sleep(delayMs);
      if (this.active !== active) return false;
      const results = await Promise.all(
        active.cameras.map((camera) =>
          camera
            .getFrame({ fresh: true, timeoutMs: Math.max(5000, (2 * 1000) / camera.config.fps + 1000) })
            .then((frame) => ({ camera, frame, error: null as Error | null }))
            .catch((error: Error) => ({ camera, frame: null as Buffer | null, error })),
        ),
      );
      let wroteAny = false;
      for (const { camera, frame, error } of results) {
        const id = camera.config.id;
        const info = active.session.cameras.find((c) => c.id === id);
        if (!info) continue;
        let data = frame;
        if (!data) {
          data = active.lastFrames.get(id) ?? null;
          console.warn(
            `Timelapse ${active.session.id}: ${camera.config.name}: ${error?.message ?? "no frame"}${data ? " (repeating previous frame)" : ""}`,
          );
          if (!data) continue;
        } else {
          active.lastFrames.set(id, data);
        }
        const file = path.join(active.dir, id, `frame-${pad6(info.frameCount + 1)}.jpg`);
        try {
          await writeFile(file, data);
        } catch (e) {
          console.error(`Timelapse ${active.session.id}: could not write ${file}: ${(e as Error).message}`);
          continue;
        }
        info.frameCount += 1;
        if (info.width === null) {
          const dims = jpegDimensions(data);
          info.width = dims?.width ?? null;
          info.height = dims?.height ?? null;
        }
        wroteAny = true;
      }
      if (wroteAny) {
        active.session.frameCount += 1;
        active.lastCaptureAt = Date.now();
        await this.writeSession(active.session);
      }
      return true;
    } finally {
      active.capturing = false;
    }
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
      await bounded(this.captureSet(active, 0), 10000);
    } catch (e) {
      console.error(`Timelapse: could not start recording: ${(e as Error).message}`);
    }
  }

  /** Called for every motion executed while plotting. */
  public plotMotion(motion: Motion): void {
    const active = this.active;
    if (!active?.plotAttached || this.settings.trigger !== "penLift") return;
    if (!(motion instanceof PenMotion) || !(motion.initialPos < motion.finalPos)) return; // only pen lifts
    if (Date.now() - active.lastCaptureAt < this.settings.minIntervalSeconds * 1000) return;
    void this.captureSet(active, this.settings.captureDelayMs).catch((e) => console.error(e));
  }

  /** Called once the plot has finished or was cancelled and the machine is idle. */
  public async plotEnded(cancelled: boolean): Promise<void> {
    const active = this.active;
    if (!active?.plotAttached) return;
    try {
      active.plotAttached = false;
      if (active.intervalTimer && active.session.source === "plot") {
        clearInterval(active.intervalTimer);
        active.intervalTimer = null;
      }
      // final frame: the finished drawing (wait for any in-flight capture first)
      for (let i = 0; i < 100 && active.capturing; i++) await sleep(50);
      await bounded(this.captureSet(active, this.settings.captureDelayMs), 10000);
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
    const totalFrames =
      Math.min(...subject.map((c) => c.frameCount)) + Math.ceil(settings.postRollSeconds * settings.fps);
    const args = buildFfmpegArgs(dir, subject, settings, output);

    console.log(`Timelapse ${session.id}: rendering ${file}`);
    try {
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
    }
  }

  public close(): void {
    this.closed = true;
    if (this.active) {
      const active = this.active;
      this.active = null;
      if (active.intervalTimer) clearInterval(active.intervalTimer);
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
