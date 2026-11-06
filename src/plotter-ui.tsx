/**
 * The "plotters" tab: an overview of every plotter with what it is plotting, and the forms to add and edit
 * plotters. Also the plotter switcher of the plot view. Talks to the REST API in plotter-routes.ts.
 */

import React, { useCallback, useEffect, useState } from "react";
import { api, formatElapsed, LiveImage, usePolling } from "./camera-ui.js";
import type { CameraWithStatus } from "./camera-types.js";
import type { Hardware } from "./ebb.js";
import {
  defaultPlotterConfig,
  type PlotterConfig,
  type PlotterKind,
  type PlotterWithStatus,
  type SerialPortListing,
  SIMULATED_PORT,
} from "./plotter-types.js";
import { formatDuration } from "./util.js";

/** Polls the plotter list; `refresh` fetches it right away. */
export function usePlotters(enabled: boolean, intervalMs = 2000) {
  const [plotters, setPlotters] = useState<PlotterWithStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { plotters } = await api<{ plotters: PlotterWithStatus[] }>("GET", "/plotters");
      setPlotters(plotters);
      setError(null);
    } catch (e) {
      setError(`Cannot reach the saxi server: ${(e as Error).message}`);
    }
  }, [enabled]);
  usePolling(refresh, intervalMs);
  return { plotters, refresh, error };
}

/** Which status dot a plotter gets. */
function dotFor(p: PlotterWithStatus): string {
  if (!p.enabled) return "idle";
  if (p.status.plotting) return p.status.paused ? "idle" : "starting";
  if (p.status.attention) return "error";
  if (p.status.connected) return "live";
  return "error";
}

/** One line about a plotter's connection. */
export function connectionLabel(p: PlotterWithStatus): string {
  const s = p.status;
  if (!p.enabled) return "disabled";
  if (s.connected) {
    const parts = [s.model, s.path === SIMULATED_PORT ? "simulated" : s.path, s.paper ? `${s.paper.name} paper` : null];
    return parts.filter(Boolean).join(" · ");
  }
  return s.error ? `not connected: ${s.error}` : "connecting…";
}

export function PlotterSwitcher({
  plotters,
  selected,
  onSelect,
}: {
  plotters: PlotterWithStatus[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (plotters.length < 2) return null;
  return (
    <div className="plotter-switcher">
      <select
        className="plotter-switcher__select"
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="plotter"
      >
        {plotters.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.status.plotting ? " · plotting" : p.status.connected ? "" : " · not connected"}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plotter form

const KIND_LABELS: Record<PlotterKind, string> = {
  ebb: "AxiDraw / NextDraw (EiBotBoard)",
  hpgl: "HP-GL plotter (HP 7475A…)",
};

const HARDWARE_LABELS: Record<Hardware, string> = {
  v3: "AxiDraw V3",
  brushless: "AxiDraw V3 Brushless",
  "nextdraw-2234": "NextDraw 2234",
  "idraw-h-se": "iDraw H SE",
};

const BAUD_RATES = [9600, 4800, 2400, 1200, 600, 300, 150, 110, 75];
const OTHER_PORT = "\u0000other";

type PlotterDraft = Omit<PlotterConfig, "id">;

function portLabel(port: SerialPortListing): string {
  const what = [port.ebb ? "AxiDraw" : null, port.manufacturer, port.serialNumber].filter(Boolean).join(" ");
  const used = port.usedBy.length ? ` (${port.usedBy.map((u) => u.name).join(", ")})` : "";
  return `${port.path}${what ? ` · ${what}` : ""}${used}`;
}

function PortField({
  draft,
  set,
  plotterId,
}: {
  draft: PlotterDraft;
  set: (p: Partial<PlotterDraft>) => void;
  plotterId: string | null;
}) {
  const [ports, setPorts] = useState<SerialPortListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<{ ports: SerialPortListing[] }>("GET", "/plotters/ports")
      .then(({ ports }) => !cancelled && setPorts(ports))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);
  const listed = ports?.find((p) => p.paths.includes(draft.port) || p.path === draft.port);
  const known = draft.port === "" || draft.port === SIMULATED_PORT || listed !== undefined;
  const value = other || (!known && ports !== null) ? OTHER_PORT : listed ? listed.path : draft.port;
  const candidates = (ports ?? []).filter((p) => (draft.kind === "ebb" ? true : !p.ebb));
  return (
    <>
      <label>
        port
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v === OTHER_PORT);
            if (v !== OTHER_PORT) set({ port: v });
          }}
        >
          {draft.kind === "ebb" && <option value="">first AxiDraw found</option>}
          {draft.kind === "hpgl" && !draft.port && <option value="">pick a port…</option>}
          {candidates.map((p) => (
            <option key={p.path} value={p.path} disabled={p.usedBy.some((u) => u.id !== plotterId)}>
              {portLabel(p)}
            </option>
          ))}
          <option value={SIMULATED_PORT}>simulated plotter (to try saxi out)</option>
          <option value={OTHER_PORT}>other…</option>
        </select>
      </label>
      {value === OTHER_PORT && (
        <input
          type="text"
          value={draft.port}
          placeholder={draft.kind === "hpgl" ? "/dev/ttyUSB0 or COM3" : "/dev/ttyACM0 or COM3"}
          onChange={(e) => set({ port: e.target.value })}
        />
      )}
      {error && <div className="camera-form__error">Could not list the serial ports: {error}</div>}
      {ports !== null && candidates.length === 0 && (
        <div className="camera-form__help">
          No {draft.kind === "hpgl" ? "serial adapters" : "serial ports"} found on the server. Plug the{" "}
          {draft.kind === "hpgl" ? "USB-serial adapter" : "AxiDraw"} in, then open this form again.
        </div>
      )}
    </>
  );
}

export function PlotterForm({
  initial,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: PlotterConfig | null;
  onSave: (config: PlotterDraft) => Promise<void>;
  onDelete: (() => Promise<void>) | null;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<PlotterDraft>(() => {
    if (initial) {
      const { id: _id, ...rest } = initial;
      return rest;
    }
    return { ...defaultPlotterConfig };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PlotterDraft>) => setForm((f) => ({ ...f, ...patch }));

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
        <input
          type="text"
          value={form.name}
          placeholder={form.kind === "hpgl" ? "HP 7475A" : "AxiDraw"}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        type
        <select
          value={form.kind}
          onChange={(e) => {
            const kind = e.target.value as PlotterKind;
            set({ kind, port: kind === form.kind ? form.port : "", baudRate: kind === "hpgl" ? 0 : form.baudRate });
          }}
        >
          {(Object.keys(KIND_LABELS) as PlotterKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <PortField draft={form} set={set} plotterId={initial?.id ?? null} />
      {form.kind === "ebb" ? (
        <>
          <label>
            model
            <select value={form.hardware} onChange={(e) => set({ hardware: e.target.value as Hardware })}>
              {(Object.keys(HARDWARE_LABELS) as Hardware[]).map((h) => (
                <option key={h} value={h}>
                  {HARDWARE_LABELS[h]}
                </option>
              ))}
            </select>
          </label>
          {form.port === "" && (
            <>
              <label>
                board nickname (optional)
                <input
                  type="text"
                  value={form.serialNumber}
                  placeholder="any AxiDraw"
                  onChange={(e) => set({ serialNumber: e.target.value })}
                />
              </label>
              <div className="camera-form__help">
                Several AxiDraws look alike to the computer. Give each board a nickname (EBB firmware 2.5.5 or newer:{" "}
                <code>saxi nickname &lt;name&gt;</code>, then unplug and replug it) and enter it here, or pick each one
                by its port.
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <label>
            baud rate
            <select value={form.baudRate} onChange={(e) => set({ baudRate: Number(e.target.value) })}>
              <option value={0}>detect</option>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="flex-checkbox">
            <input type="checkbox" checked={form.rtscts} onChange={(e) => set({ rtscts: e.target.checked })} />
            hardware handshake on CTS
          </label>
          <div className="camera-form__help">
            Use a null-modem cable. On the 7475A, set the rear switches to parity off (S1 and S2), D (direct) and MET
            for A4/A3 paper or US for letter/tabloid. saxi paces the data itself, so the handshake is only needed for a
            cable that brings the plotter's DTR (pin 20) to the adapter's CTS. “detect” tries each baud rate.
          </div>
        </>
      )}
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
            if (!window.confirm(`Remove plotter "${initial?.name}"?`)) return;
            setBusy(true);
            try {
              await onDelete();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          remove plotter
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview

/** The cameras to show for a plotter: those assigned to it, otherwise those recording every plotter. */
function camerasFor(plotter: PlotterWithStatus, cameras: CameraWithStatus[]): CameraWithStatus[] {
  const enabled = cameras.filter((c) => c.enabled);
  const own = enabled.filter((c) => c.plotters.includes(plotter.id));
  return own.length ? own : enabled.filter((c) => c.plotters.length === 0);
}

function PlotterCard({
  plotter,
  cameras,
  onOpen,
  onEdit,
  act,
}: {
  plotter: PlotterWithStatus;
  cameras: CameraWithStatus[];
  onOpen: () => void;
  onEdit: () => void;
  act: (fn: () => Promise<unknown>) => void;
}) {
  const { status } = plotter;
  const job = status.job;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!job) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [job]);
  const fraction = status.progress ? status.progress.motionIdx / Math.max(1, status.progress.motions) : 0;
  const elapsed = job ? (Date.now() - new Date(job.startedAt).getTime()) / 1000 : 0;
  const left = job ? Math.max(0, job.estimatedSeconds * (1 - fraction)) : 0;
  const camera = camerasFor(plotter, cameras)[0];
  const post = (action: string) => act(() => api("POST", `/plotters/${plotter.id}/${action}`));

  return (
    <div className={`camera-card plotter-card ${plotter.enabled ? "" : "camera-card--disabled"}`}>
      <div className="plotter-card__media">
        <div className="plotter-card__drawing">
          {job ? (
            <img
              key={job.startedAt}
              src={`/plotters/${plotter.id}/preview.svg?t=${encodeURIComponent(job.startedAt)}`}
              alt={`drawing being plotted on ${plotter.name}`}
            />
          ) : (
            <div className="plotter-card__idle">{status.connected ? "ready" : "not connected"}</div>
          )}
        </div>
        {camera && (
          <div className="plotter-card__camera" title={camera.name}>
            <LiveImage camera={camera} fps={0.5} />
          </div>
        )}
      </div>
      <div className="camera-card__bar">
        <div className="plotter-card__name">
          <span className={`status-dot status-dot--${dotFor(plotter)}`} />
          <strong>{plotter.name}</strong>
          <span className="camera-card__detail">{connectionLabel(plotter)}</span>
        </div>
        <div className="camera-card__actions">
          <button type="button" className="small" onClick={onOpen}>
            open
          </button>
          <button type="button" className="small" onClick={onEdit}>
            edit
          </button>
        </div>
      </div>
      {status.attention && <div className="plotter-card__attention">{status.attention}</div>}
      {job && (
        <div className="plotter-card__job">
          <div className="plotter-card__jobline">
            <strong>{job.name}</strong>
            <span>
              {status.paused ? "paused" : "plotting"} · {Math.round(fraction * 100)}% ·{" "}
              {formatElapsed(job.startedAt, null)} elapsed{left > 0 ? ` · about ${formatDuration(left)} left` : ""}
            </span>
          </div>
          <span className="render-job__bar plotter-card__progress">
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
          <div className="camera-card__actions plotter-card__controls">
            <button type="button" className="small" onClick={() => post(status.paused ? "resume" : "pause")}>
              {status.paused ? "resume" : "pause"}
            </button>
            <button
              type="button"
              className="small danger"
              onClick={() => {
                if (window.confirm(`Cancel the plot on ${plotter.name}?`)) post("cancel");
              }}
            >
              cancel
            </button>
            <span className="camera-hint">
              {elapsed > 0 ? `started ${new Date(job.startedAt).toLocaleTimeString()}` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function PlottersView({
  tabs,
  title,
  plotters,
  refresh,
  error,
  onOpen,
}: {
  tabs: React.ReactNode;
  title: React.ReactNode;
  plotters: PlotterWithStatus[];
  refresh: () => Promise<void>;
  error: string | null;
  onOpen: (id: string) => void;
}) {
  const [editing, setEditing] = useState<PlotterConfig | "new" | null>(null);
  const [cameras, setCameras] = useState<CameraWithStatus[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadCameras = useCallback(async () => {
    try {
      setCameras((await api<{ cameras: CameraWithStatus[] }>("GET", "/cameras")).cameras);
    } catch {
      // the overview works without cameras
    }
  }, []);
  usePolling(loadCameras, 10000);

  const act = (fn: () => Promise<unknown>) => {
    setActionError(null);
    fn()
      .then(refresh)
      .catch((e) => setActionError((e as Error).message));
  };
  const plotting = plotters.filter((p) => p.status.plotting).length;

  return (
    <div className="root camera-root">
      <div className="control-panel">
        {title}
        {tabs}
        <div className="section-header">plotters</div>
        <div className="section-body">
          {editing === null && (
            <>
              {plotters.map((p) => (
                <div key={p.id} className="camera-row">
                  <button type="button" className="button-link plotter-row__open" onClick={() => onOpen(p.id)}>
                    <span className={`status-dot status-dot--${dotFor(p)}`} />
                    <span className="camera-row__name">{p.name}</span>
                  </button>
                  <button type="button" className="button-link" onClick={() => setEditing(p)}>
                    edit
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => setEditing("new")}>
                add plotter
              </button>
            </>
          )}
          {editing !== null && (
            <PlotterForm
              initial={editing === "new" ? null : editing}
              onSave={async (config) => {
                if (editing === "new") await api("POST", "/plotters", config);
                else await api("PUT", `/plotters/${editing.id}`, config);
                setEditing(null);
                await refresh();
              }}
              onDelete={
                editing === "new" || plotters.length < 2
                  ? null
                  : async () => {
                      await api("DELETE", `/plotters/${editing.id}`);
                      setEditing(null);
                      await refresh();
                    }
              }
              onCancel={() => setEditing(null)}
            />
          )}
        </div>
        <div className="spacer" />
        <div className="control-panel-bottom">
          <div className="section-body">
            <div className="camera-hint">
              Each plotter has its own drawing and settings in the plot tab. Assign cameras to plotters in the camera
              tab to record each one's plots.
            </div>
          </div>
        </div>
      </div>
      <div className="camera-main">
        {(error || actionError) && <div className="camera-banner camera-banner--error">{error ?? actionError}</div>}
        <div className="camera-main__header">
          <h2>plotters</h2>
          <span className="camera-hint">
            {plotting === 0 ? "nothing plotting" : `${plotting} of ${plotters.length} plotting`}
          </span>
        </div>
        <div className={`camera-grid camera-grid--${Math.min(plotters.length, 4)} plotter-grid`}>
          {plotters.map((p) => (
            <PlotterCard
              key={p.id}
              plotter={p}
              cameras={cameras}
              onOpen={() => onOpen(p.id)}
              onEdit={() => setEditing(p)}
              act={act}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
