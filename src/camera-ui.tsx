/**
 * The "camera" tab: live multi-camera view, camera and timelapse settings,
 * recording controls and the timelapse library. Talks to the REST API in
 * camera-routes.ts; it does not touch the plotter state at all.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type CameraConfig,
  type CameraKind,
  type CameraRotation,
  type CameraWithStatus,
  type RenderJob,
  type TimelapseSession,
  type TimelapseSettings,
  type TimelapseStatusResponse,
  defaultCameraConfig,
} from "./camera-types.js";

export type View = "plot" | "camera";

export function ViewTabs({ view, setView }: { view: View; setView: (v: View) => void }) {
  const tab = (id: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      className={`view-tab ${view === id ? "view-tab--active" : ""}`}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  );
  return (
    <div className="view-tabs" role="tablist">
      {tab("plot", "plot")}
      {tab("camera", "camera")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API helpers

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

/** Calls `fn` immediately and then every `intervalMs` while mounted. */
function usePolling(fn: () => Promise<void>, intervalMs: number) {
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        await fn();
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fn, intervalMs]);
}

function formatBytes(n: number): string {
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatElapsed(fromIso: string, toIso: string | null): string {
  const seconds = Math.max(0, (new Date(toIso ?? Date.now()).getTime() - new Date(fromIso).getTime()) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// Live view

/**
 * Polls a camera's snapshot endpoint at `fps` and draws each frame (rotated)
 * onto a canvas. The next request is only sent after the previous frame
 * arrived, so slow networks degrade gracefully instead of piling up.
 */
function LiveImage({ camera, fps }: { camera: CameraWithStatus; fps: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(true);
  const { id, enabled, rotate } = camera;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const began = Date.now();
      try {
        const res = await fetch(`/cameras/${id}/snapshot.jpg?fresh=1&t=${began}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const bitmap = await createImageBitmap(await res.blob());
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (canvas) {
          const sideways = rotate === 90 || rotate === 270;
          canvas.width = sideways ? bitmap.height : bitmap.width;
          canvas.height = sideways ? bitmap.width : bitmap.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate((rotate * Math.PI) / 180);
            ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
            ctx.restore();
          }
        }
        bitmap.close();
        setError(null);
        setWaiting(false);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (cancelled) return;
      timer = window.setTimeout(tick, Math.max(0, 1000 / fps - (Date.now() - began)));
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, enabled, rotate, fps]);

  return (
    <div className="camera-frame">
      <canvas
        ref={canvasRef}
        className={waiting ? "camera-frame__canvas camera-frame__canvas--empty" : "camera-frame__canvas"}
      />
      {!enabled && <div className="camera-frame__overlay">disabled</div>}
      {enabled && error && <div className="camera-frame__overlay camera-frame__overlay--error">{error}</div>}
      {enabled && !error && waiting && <div className="camera-frame__overlay">connecting…</div>}
    </div>
  );
}

function CameraCard({ camera, fps, onEdit }: { camera: CameraWithStatus; fps: number; onEdit: () => void }) {
  const { status } = camera;
  const detail = [
    camera.kind,
    status.width && status.height ? `${status.width}×${status.height}` : null,
    `${camera.fps} fps`,
    camera.rotate ? `${camera.rotate}°` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`camera-card ${camera.enabled ? "" : "camera-card--disabled"}`}>
      <LiveImage camera={camera} fps={fps} />
      <div className="camera-card__bar">
        <div>
          <span className={`status-dot status-dot--${camera.enabled ? status.state : "idle"}`} />
          <strong>{camera.name}</strong>
          <span className="camera-card__detail">{detail}</span>
        </div>
        <div className="camera-card__actions">
          <a
            className="button-like"
            href={`/cameras/${camera.id}/snapshot.jpg?fresh=1`}
            download={`${camera.name}.jpg`}
          >
            still
          </a>
          <button type="button" className="small" onClick={onEdit}>
            edit
          </button>
        </div>
      </div>
      {camera.enabled && status.error && <div className="camera-card__error">{status.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera form

const KIND_HELP: Record<CameraKind, { label: string; placeholder: string; help: string }> = {
  device: {
    label: "device",
    placeholder: "/dev/video0",
    help: "USB webcam via ffmpeg: /dev/video0 on Linux, a device index such as 0 on macOS, or the device name on Windows.",
  },
  libcamera: {
    label: "source (optional)",
    placeholder: "",
    help: "Raspberry Pi camera module via rpicam-vid / libcamera-vid.",
  },
  url: {
    label: "URL",
    placeholder: "http://192.168.1.20:8080/photo.jpg",
    help: "A JPEG snapshot URL (polled) or an MJPEG stream, e.g. from an IP camera, a phone camera app, an ESP32-CAM or mjpg-streamer.",
  },
  rtsp: {
    label: "RTSP URL",
    placeholder: "rtsp://user:pass@192.168.1.30/stream1",
    help: "An RTSP stream, read via ffmpeg.",
  },
};

function CameraForm({
  initial,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: CameraConfig | null;
  onSave: (config: Omit<CameraConfig, "id">) => Promise<void>;
  onDelete: (() => Promise<void>) | null;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Omit<CameraConfig, "id">>(() => {
    if (initial) {
      const { id: _id, ...rest } = initial;
      return rest;
    }
    return { ...defaultCameraConfig };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const kind = KIND_HELP[form.kind];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="camera-form">
      <label>
        name
        <input type="text" value={form.name} placeholder="Overhead" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        type
        <select
          value={form.kind}
          onChange={(e) => {
            const next = e.target.value as CameraKind;
            set({ kind: next, source: next === "device" ? defaultCameraConfig.source : "" });
          }}
        >
          <option value="device">USB / local camera</option>
          <option value="libcamera">Raspberry Pi camera</option>
          <option value="url">HTTP snapshot / MJPEG</option>
          <option value="rtsp">RTSP stream</option>
        </select>
      </label>
      {form.kind !== "libcamera" && (
        <label>
          {kind.label}
          <input
            type="text"
            value={form.source}
            placeholder={kind.placeholder}
            onChange={(e) => set({ source: e.target.value })}
          />
        </label>
      )}
      <div className="camera-form__help">{kind.help}</div>
      {(form.kind === "device" || form.kind === "libcamera") && (
        <label>
          resolution (optional)
          <input
            type="text"
            value={form.resolution}
            placeholder="1920x1080"
            onChange={(e) => set({ resolution: e.target.value })}
          />
        </label>
      )}
      {form.kind === "device" && (
        <label>
          input format (optional)
          <input
            type="text"
            value={form.inputFormat}
            placeholder="mjpeg"
            onChange={(e) => set({ inputFormat: e.target.value })}
          />
        </label>
      )}
      <div className="flex">
        <label className="pen-label">
          capture fps
          <input
            type="number"
            min="0.2"
            max="30"
            step="0.1"
            value={form.fps}
            onChange={(e) => set({ fps: Number(e.target.value) })}
          />
        </label>
        <label className="pen-label">
          rotate
          <select value={form.rotate} onChange={(e) => set({ rotate: Number(e.target.value) as CameraRotation })}>
            <option value={0}>0°</option>
            <option value={90}>90°</option>
            <option value={180}>180°</option>
            <option value={270}>270°</option>
          </select>
        </label>
      </div>
      <label className="flex-checkbox">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        enabled
      </label>
      {error && <div className="camera-form__error">{error}</div>}
      <div className="flex">
        <button type="button" disabled={busy} onClick={submit}>
          {initial ? "save" : "add"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
      {onDelete && (
        <button
          type="button"
          className="button-link"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Remove camera "${initial?.name}"?`)) return;
            setBusy(true);
            try {
              await onDelete();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          remove camera
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timelapse settings

function TimelapseSettingsForm({
  settings,
  ffmpeg,
  onChange,
}: {
  settings: TimelapseSettings;
  ffmpeg: boolean;
  onChange: (patch: Partial<TimelapseSettings>) => void;
}) {
  const render = (patch: Partial<TimelapseSettings["render"]>) =>
    onChange({ render: { ...settings.render, ...patch } });
  const num = (v: string) => Number(v);
  return (
    <>
      <label className="flex-checkbox" title="Start a recording when a plot starts and stop it when the plot ends">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        record every plot
      </label>
      <label title="What triggers a frame while plotting">
        trigger
        <select
          value={settings.trigger}
          onChange={(e) => onChange({ trigger: e.target.value as TimelapseSettings["trigger"] })}
        >
          <option value="penLift">every pen lift</option>
          <option value="interval">fixed interval</option>
          <option value="targetFrames">target frame count</option>
        </select>
      </label>
      {settings.trigger === "interval" && (
        <label title="Seconds between frames">
          interval (s)
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={settings.intervalSeconds}
            onChange={(e) => onChange({ intervalSeconds: num(e.target.value) })}
          />
        </label>
      )}
      {settings.trigger === "targetFrames" && (
        <label title="The interval is derived from the estimated plot duration so the whole plot ends up with about this many frames">
          target frames
          <input
            type="number"
            min="2"
            step="1"
            value={settings.targetFrames}
            onChange={(e) => onChange({ targetFrames: num(e.target.value) })}
          />
        </label>
      )}
      <div className="flex">
        <label className="pen-label" title="Never capture more often than this, whatever the trigger">
          min. gap (s)
          <input
            type="number"
            min="0"
            step="0.5"
            value={settings.minIntervalSeconds}
            onChange={(e) => onChange({ minIntervalSeconds: num(e.target.value) })}
          />
        </label>
        <label
          className="pen-label"
          title="Wait this long after a trigger before grabbing the frame, so the pen has actually lifted"
        >
          delay (ms)
          <input
            type="number"
            min="0"
            step="50"
            value={settings.captureDelayMs}
            onChange={(e) => onChange({ captureDelayMs: num(e.target.value) })}
          />
        </label>
      </div>
      <label
        className="flex-checkbox"
        title={ffmpeg ? "Render videos as soon as a recording ends" : "Requires ffmpeg on the server"}
      >
        <input
          type="checkbox"
          checked={settings.autoRender}
          disabled={!ffmpeg}
          onChange={(e) => onChange({ autoRender: e.target.checked })}
        />
        render when finished
      </label>
      <details>
        <summary className="camera-subheader">video settings</summary>
        <div className="flex">
          <label className="pen-label" title="Frames per second of the video">
            fps
            <input
              type="number"
              min="1"
              max="120"
              value={settings.render.fps}
              onChange={(e) => render({ fps: num(e.target.value) })}
            />
          </label>
          <label
            className="pen-label"
            title="x264 quality: lower is better and bigger (18 ≈ visually lossless, 23 default)"
          >
            quality (crf)
            <input
              type="number"
              min="0"
              max="51"
              value={settings.render.crf}
              onChange={(e) => render({ crf: num(e.target.value) })}
            />
          </label>
        </div>
        <div className="flex">
          <label
            className="pen-label"
            title="Slower presets compress better but take much longer, especially on a Raspberry Pi"
          >
            preset
            <select value={settings.render.preset} onChange={(e) => render({ preset: e.target.value })}>
              {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].map(
                (p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="pen-label" title="Hold the finished drawing for this long at the end">
            post-roll (s)
            <input
              type="number"
              min="0"
              max="60"
              step="0.5"
              value={settings.render.postRollSeconds}
              onChange={(e) => render({ postRollSeconds: num(e.target.value) })}
            />
          </label>
        </div>
        <label className="flex-checkbox" title="Also render one video with all cameras side by side">
          <input
            type="checkbox"
            checked={settings.render.composite}
            onChange={(e) => render({ composite: e.target.checked })}
          />
          multi-cam composite
        </label>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Timelapse library

function RenderProgress({ jobs, session }: { jobs: RenderJob[]; session: TimelapseSession }) {
  if (jobs.length === 0) return null;
  const label = (camera: string) => session.cameras.find((c) => c.id === camera)?.name ?? camera;
  return (
    <div className="render-jobs">
      {jobs.map((job) => (
        <div key={job.id} className={`render-job render-job--${job.status}`}>
          <span>
            {job.status === "running" ? "rendering" : job.status === "done" ? "rendered" : "failed"} {label(job.camera)}
            {job.status === "error" && job.error ? `: ${job.error}` : ""}
          </span>
          {job.status === "running" && (
            <span className="render-job__bar">
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function TimelapseCard({
  session,
  jobs,
  ffmpeg,
  renderDefaults,
  onRender,
  onDelete,
  onStop,
}: {
  session: TimelapseSession;
  jobs: RenderJob[];
  ffmpeg: boolean;
  renderDefaults: TimelapseSettings["render"];
  onRender: (opts: { fps: number; composite: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
  onStop: (() => Promise<void>) | null;
}) {
  const [fps, setFps] = useState(renderDefaults.fps);
  const [composite, setComposite] = useState(renderDefaults.composite);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thumbCamera = session.cameras.find((c) => c.frameCount > 0);
  const recording = session.status === "recording";
  const rendering = jobs.some((j) => j.status === "running");
  const thumbKey = `${session.frameCount}`;

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={`timelapse-card timelapse-card--${session.status}`}>
      <div className="timelapse-card__thumb">
        {thumbCamera ? (
          <img
            key={thumbKey}
            src={`/timelapses/${session.id}/frames/${thumbCamera.id}/last.jpg?f=${thumbKey}`}
            alt={`last frame of ${session.name}`}
            style={thumbCamera.rotate ? { transform: `rotate(${thumbCamera.rotate}deg)` } : undefined}
          />
        ) : (
          <div className="timelapse-card__nothumb">no frames</div>
        )}
      </div>
      <div className="timelapse-card__body">
        <div className="timelapse-card__title">
          <span
            className={`status-dot status-dot--${recording ? "live" : session.status === "finished" ? "idle" : "error"}`}
          />
          <strong>{session.name}</strong>
          <span className="timelapse-card__status">{session.status}</span>
        </div>
        <div className="timelapse-card__meta">
          {formatDate(session.startedAt)} · {formatElapsed(session.startedAt, session.finishedAt)} ·{" "}
          {session.frameCount} frames · {session.cameras.map((c) => c.name).join(", ")} ·{" "}
          {session.source === "plot" ? `plot, ${session.trigger}` : "manual"}
        </div>
        {session.renders.length > 0 && (
          <ul className="timelapse-card__renders">
            {session.renders.map((r) => {
              const url = `/timelapses/${session.id}/renders/${r.file}`;
              return (
                <li key={r.file}>
                  <button
                    type="button"
                    className="button-link"
                    onClick={() => setPlaying(playing === r.file ? null : r.file)}
                  >
                    {playing === r.file ? "hide" : "play"}
                  </button>
                  <a href={url} download={r.file}>
                    {r.file}
                  </a>
                  <span className="timelapse-card__size">{formatBytes(r.sizeBytes)}</span>
                </li>
              );
            })}
          </ul>
        )}
        {playing && (
          // biome-ignore lint/a11y/useMediaCaption: a timelapse has no dialogue
          <video
            className="timelapse-card__video"
            controls
            autoPlay
            src={`/timelapses/${session.id}/renders/${playing}`}
          />
        )}
        <RenderProgress jobs={jobs} session={session} />
        {error && <div className="camera-form__error">{error}</div>}
        <div className="timelapse-card__actions">
          {recording && onStop && (
            <button type="button" className="small" onClick={() => run(onStop)}>
              stop recording
            </button>
          )}
          {!recording && session.frameCount > 0 && (
            <>
              <label className="inline">
                fps
                <input type="number" min="1" max="120" value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </label>
              {session.cameras.length > 1 && (
                <label className="inline">
                  <input type="checkbox" checked={composite} onChange={(e) => setComposite(e.target.checked)} />
                  composite
                </label>
              )}
              <button
                type="button"
                className="small"
                disabled={!ffmpeg || rendering}
                title={ffmpeg ? "Render MP4 videos from the stored frames" : "ffmpeg is not installed on the server"}
                onClick={() => run(() => onRender({ fps, composite }))}
              >
                {rendering ? "rendering…" : "render"}
              </button>
            </>
          )}
          {!recording && (
            <button
              type="button"
              className="small danger"
              disabled={rendering}
              onClick={() => {
                if (window.confirm(`Delete "${session.name}" and all its frames and videos?`)) run(onDelete);
              }}
            >
              delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view

const PREVIEW_RATES = [0.5, 1, 2, 5];

export function CameraView({ tabs, title }: { tabs: React.ReactNode; title: React.ReactNode }) {
  const [cameras, setCameras] = useState<CameraWithStatus[]>([]);
  const [status, setStatus] = useState<TimelapseStatusResponse | null>(null);
  const [sessions, setSessions] = useState<TimelapseSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CameraConfig | "new" | null>(null);
  const [recordingName, setRecordingName] = useState("");
  const [previewFps, setPreviewFps] = useState(() => {
    const stored = Number(window.localStorage.getItem("cameraPreviewFps"));
    return PREVIEW_RATES.includes(stored) ? stored : 1;
  });

  const refresh = useCallback(async () => {
    try {
      const [c, s, t] = await Promise.all([
        api<{ cameras: CameraWithStatus[] }>("GET", "/cameras"),
        api<TimelapseStatusResponse>("GET", "/timelapse/status"),
        api<{ timelapses: TimelapseSession[] }>("GET", "/timelapses"),
      ]);
      setCameras(c.cameras);
      setStatus(s);
      setSessions(t.timelapses);
      setError(null);
    } catch (e) {
      setError(`Cannot reach the saxi server: ${(e as Error).message}`);
    }
  }, []);
  usePolling(refresh, 2000);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveSettings = (patch: Partial<TimelapseSettings>) => {
    if (!status) return;
    const next = { ...status.settings, ...patch };
    setStatus({ ...status, settings: next }); // optimistic
    void act(() => api("PUT", "/timelapse/settings", next));
  };

  const ffmpeg = status?.capabilities.ffmpeg ?? false;
  const active = status?.active ?? null;
  const enabledCameras = cameras.filter((c) => c.enabled);
  const jobsFor = (id: string) => (status?.renderJobs ?? []).filter((j) => j.sessionId === id);

  return (
    <div className="root camera-root">
      <div className="control-panel">
        {title}
        {tabs}
        <div className="section-header">cameras</div>
        <div className="section-body">
          {cameras.length === 0 && editing === null && <div className="camera-hint">No cameras yet.</div>}
          {editing === null && (
            <>
              {cameras.map((camera) => (
                <div key={camera.id} className="camera-row">
                  <label className="flex-checkbox" title={camera.enabled ? "Disable" : "Enable"}>
                    <input
                      type="checkbox"
                      checked={camera.enabled}
                      onChange={(e) => act(() => api("PUT", `/cameras/${camera.id}`, { enabled: e.target.checked }))}
                    />
                    <span className={`status-dot status-dot--${camera.enabled ? camera.status.state : "idle"}`} />
                    <span className="camera-row__name">{camera.name}</span>
                  </label>
                  <button type="button" className="button-link" onClick={() => setEditing(camera)}>
                    edit
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => setEditing("new")}>
                add camera
              </button>
            </>
          )}
          {editing !== null && (
            <CameraForm
              initial={editing === "new" ? null : editing}
              onSave={async (config) => {
                if (editing === "new") await api("POST", "/cameras", config);
                else await api("PUT", `/cameras/${editing.id}`, config);
                setEditing(null);
                await refresh();
              }}
              onDelete={
                editing === "new"
                  ? null
                  : async () => {
                      await api("DELETE", `/cameras/${editing.id}`);
                      setEditing(null);
                      await refresh();
                    }
              }
              onCancel={() => setEditing(null)}
            />
          )}
        </div>
        <div className="section-header">timelapse</div>
        <div className="section-body">
          {status && <TimelapseSettingsForm settings={status.settings} ffmpeg={ffmpeg} onChange={saveSettings} />}
        </div>
        <div className="spacer" />
        <div className="control-panel-bottom">
          <div className="section-header">recording</div>
          <div className="section-body">
            {active ? (
              <>
                <div className="recording-status">
                  <span className="status-dot status-dot--recording" />
                  <strong>{active.name}</strong>
                  <div className="camera-hint">
                    {active.frameCount} frames · {formatElapsed(active.startedAt, null)}
                    {status?.plotting ? " · plotting" : ""}
                  </div>
                </div>
                <div className="flex">
                  <button type="button" onClick={() => act(() => api("POST", "/timelapse/snap"))}>
                    snapshot
                  </button>
                  <button type="button" className="danger" onClick={() => act(() => api("POST", "/timelapse/stop"))}>
                    stop
                  </button>
                </div>
              </>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="recording name (optional)"
                  value={recordingName}
                  onChange={(e) => setRecordingName(e.target.value)}
                />
                <button
                  type="button"
                  className="record-button"
                  disabled={enabledCameras.length === 0}
                  title={
                    enabledCameras.length === 0
                      ? "Add and enable a camera first"
                      : "Start recording with all enabled cameras"
                  }
                  onClick={() =>
                    act(async () => {
                      await api("POST", "/timelapse/start", { name: recordingName });
                      setRecordingName("");
                    })
                  }
                >
                  start recording
                </button>
                <div className="camera-hint">
                  {status?.settings.enabled
                    ? "Plots are recorded automatically."
                    : "Plots are not recorded automatically."}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="camera-main">
        {error && <div className="camera-banner camera-banner--error">{error}</div>}
        {status && !ffmpeg && (
          <div className="camera-banner">
            ffmpeg was not found on the server, so USB/RTSP cameras and video rendering are unavailable. Install it with{" "}
            <code>sudo apt install ffmpeg</code> and restart saxi. HTTP cameras still work.
          </div>
        )}
        <div className="camera-main__header">
          <h2>live view</h2>
          <label className="inline">
            preview rate
            <select
              value={previewFps}
              onChange={(e) => {
                const v = Number(e.target.value);
                setPreviewFps(v);
                window.localStorage.setItem("cameraPreviewFps", String(v));
              }}
            >
              {PREVIEW_RATES.map((r) => (
                <option key={r} value={r}>
                  {r} fps
                </option>
              ))}
            </select>
          </label>
        </div>
        {cameras.length === 0 ? (
          <div className="camera-empty">
            <p>Add a camera to see it here.</p>
            <p>
              Cameras attached to the computer running saxi (USB webcams, a Raspberry Pi camera module), network cameras
              and phone camera apps that serve JPEG snapshots or MJPEG streams are all supported. Every enabled camera
              is captured in sync when a timelapse records, and each can be rendered on its own or combined side by
              side.
            </p>
          </div>
        ) : (
          <div className={`camera-grid camera-grid--${Math.min(cameras.length, 4)}`}>
            {cameras.map((camera) => (
              <CameraCard key={camera.id} camera={camera} fps={previewFps} onEdit={() => setEditing(camera)} />
            ))}
          </div>
        )}
        <div className="camera-main__header">
          <h2>timelapses</h2>
          {status && <span className="camera-hint">stored in {status.dataDir}</span>}
        </div>
        {sessions.length === 0 ? (
          <div className="camera-empty">
            <p>No timelapses yet. Start a recording, or enable “record every plot” and plot something.</p>
          </div>
        ) : (
          <div className="timelapse-list">
            {sessions.map((session) => (
              <TimelapseCard
                key={session.id}
                session={session}
                jobs={jobsFor(session.id)}
                ffmpeg={ffmpeg}
                renderDefaults={
                  status?.settings.render ?? { fps: 24, crf: 18, preset: "medium", postRollSeconds: 2, composite: true }
                }
                onRender={async (opts) => {
                  await api("POST", `/timelapses/${session.id}/render`, opts);
                  await refresh();
                }}
                onDelete={async () => {
                  await api("DELETE", `/timelapses/${session.id}`);
                  await refresh();
                }}
                onStop={
                  active?.id === session.id
                    ? async () => {
                        await api("POST", "/timelapse/stop");
                        await refresh();
                      }
                    : null
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
