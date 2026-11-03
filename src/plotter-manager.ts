/**
 * The plotters saxi drives, persisted to `<dataDir>/plotters.json`.
 *
 * Without that file saxi starts with one AxiDraw, connected to the `--device` port or to the first AxiDraw found,
 * as it always did. The file is written as soon as plotters are added or edited.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import { newId } from "./camera.js";
import type { Hardware } from "./ebb.js";
import { Plotter, type PlotterDeps } from "./plotter.js";
import {
  defaultHpglSettings,
  defaultPlotterConfig,
  MACHINE_SETTING_KEYS,
  PLOTTER_KINDS,
  type PlotterConfig,
  type PlotterKind,
  type PlotterSettings,
  type PlotterWithStatus,
  type SerialPortListing,
  SIMULATED_PORT,
} from "./plotter-types.js";

const HARDWARE: Hardware[] = ["v3", "brushless", "nextdraw-2234"];

export class PlotterConfigError extends Error {}

function bad(message: string): never {
  throw new PlotterConfigError(message);
}

function validateSettings(input: unknown): PlotterSettings {
  if (typeof input !== "object" || input === null) return {};
  const o = input as Record<string, unknown>;
  const settings: PlotterSettings = {};
  for (const key of MACHINE_SETTING_KEYS) {
    const value = o[key];
    if (value === undefined || value === null) continue;
    if (key === "penHome") {
      const home = value as { x?: unknown; y?: unknown };
      const x = Number(home?.x);
      const y = Number(home?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) settings.penHome = { x, y };
      continue;
    }
    const n = Number(value);
    if (Number.isFinite(n)) settings[key] = n;
  }
  const pen = Number(o.pen);
  if (Number.isInteger(pen) && pen >= 1 && pen <= 6) settings.pen = pen;
  return settings;
}

/** Validate user-supplied plotter settings, filling defaults. Throws PlotterConfigError. */
export function validatePlotterConfig(input: unknown, id: string): PlotterConfig {
  if (typeof input !== "object" || input === null) bad("plotter config must be an object");
  const o = { ...defaultPlotterConfig, ...(input as Record<string, unknown>) };
  const kind = o.kind as PlotterKind;
  if (!PLOTTER_KINDS.includes(kind)) bad(`kind must be one of ${PLOTTER_KINDS.join(", ")}`);
  const port = typeof o.port === "string" ? o.port.trim() : "";
  if (port.startsWith("-")) bad("port must not start with '-'");
  if (kind === "hpgl" && !port) bad("an HP-GL plotter needs a serial port");
  const serialNumber = typeof o.serialNumber === "string" ? o.serialNumber.trim().slice(0, 64) : "";
  const hardware = (HARDWARE.includes(o.hardware as Hardware) ? o.hardware : "v3") as Hardware;
  const baudRate = Math.round(Number(o.baudRate));
  if (!Number.isFinite(baudRate) || baudRate < 0 || baudRate > 115200) bad("baudRate must be 0 (detect) to 115200");
  const name =
    (typeof o.name === "string" ? o.name.trim() : "").slice(0, 60) || (kind === "hpgl" ? "HP plotter" : "AxiDraw");
  return {
    id,
    name,
    kind,
    port,
    serialNumber,
    hardware,
    baudRate,
    rtscts: Boolean(o.rtscts),
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
    settings: validateSettings(o.settings),
  };
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId?.toUpperCase() === "04D8" && p.productId?.toUpperCase() === "FD92")
  );
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** udev's stable links to serial ports (Linux), by the port they point at. */
function serialLinks(devDir = "/dev"): Map<string, { byId: string[]; byPath: string[] }> {
  const links = new Map<string, { byId: string[]; byPath: string[] }>();
  for (const kind of ["by-id", "by-path"] as const) {
    const dir = path.join(devDir, "serial", kind);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const link = path.join(dir, entry);
      try {
        const node = path.resolve(dir, readlinkSync(link));
        const found = links.get(node) ?? { byId: [], byPath: [] };
        (kind === "by-id" ? found.byId : found.byPath).push(link);
        links.set(node, found);
      } catch {
        // not a link
      }
    }
  }
  return links;
}

export interface PlotterManagerOptions {
  /** `--device`: port for the first AxiDraw. */
  defaultPort?: string;
  /** `--hardware`: model of the AxiDraw saxi starts with when no plotters are configured. */
  defaultHardware?: Hardware;
  /** Lists the serial ports (for tests). */
  listPorts?: () => Promise<PortInfo[]>;
}

export class PlotterManager {
  private plotters = new Map<string, Plotter>();
  private readonly configPath: string;
  private readonly listPorts: () => Promise<PortInfo[]>;
  private readonly deps: PlotterDeps;
  private closed = false;

  constructor(
    public readonly dataDir: string,
    deps: Omit<PlotterDeps, "findEbb" | "save">,
    opts: PlotterManagerOptions = {},
  ) {
    this.configPath = path.join(dataDir, "plotters.json");
    this.listPorts = opts.listPorts ?? (() => autoDetect().list());
    this.deps = { ...deps, findEbb: (p) => this.findEbb(p), save: () => this.save() };
    this.load(opts);
  }

  private load(opts: PlotterManagerOptions): void {
    if (existsSync(this.configPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as { plotters?: unknown[] };
        for (const entry of raw.plotters ?? []) {
          const id = (entry as { id?: string }).id;
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
          try {
            this.plotters.set(id, new Plotter(validatePlotterConfig(entry, id), this.deps));
          } catch (e) {
            console.warn(`Ignoring invalid plotter ${id} in ${this.configPath}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        console.warn(`Could not read ${this.configPath}: ${(e as Error).message}`);
      }
    }
    if (this.plotters.size === 0) {
      const config = validatePlotterConfig(
        { name: "AxiDraw", kind: "ebb", port: opts.defaultPort ?? "", hardware: opts.defaultHardware ?? "v3" },
        "default",
      );
      this.plotters.set(config.id, new Plotter(config, this.deps));
    } else if (opts.defaultPort) {
      const first = [...this.plotters.values()].find((p) => p.config.kind === "ebb");
      if (first) {
        console.log(`${first.config.name}: using --device ${opts.defaultPort}`);
        first.override = { port: opts.defaultPort, hardware: opts.defaultHardware };
      }
    }
  }

  private save(): void {
    if (this.closed) return;
    mkdirSync(this.dataDir, { recursive: true });
    const plotters = [...this.plotters.values()].map((p) => p.config);
    writeFileSync(this.configPath, `${JSON.stringify({ plotters }, null, 2)}\n`);
  }

  /** Connects to every plotter. Resolves once each has had a first go (at most a few seconds). */
  public async start(): Promise<void> {
    await Promise.all([...this.plotters.values()].map((p) => p.start()));
  }

  public list(): PlotterWithStatus[] {
    return [...this.plotters.values()].map((p) => p.withStatus());
  }

  public get(id: string): Plotter | undefined {
    return this.plotters.get(id);
  }

  /** The plotter that the single-plotter API (/plot, /pause, …) and old UIs drive: the first one. */
  public default(): Plotter {
    const first = this.plotters.values().next().value;
    if (!first) throw new Error("no plotters");
    return first;
  }

  public all(): Plotter[] {
    return [...this.plotters.values()];
  }

  public anyPlotting(): boolean {
    return this.all().some((p) => p.isPlotting);
  }

  private checkPort(config: PlotterConfig): void {
    if (!config.port || config.port === SIMULATED_PORT) return;
    const mine = realpath(config.port);
    const other = this.all().find((p) => p.id !== config.id && p.port && realpath(p.port) === mine);
    if (other) bad(`${other.config.name} already uses ${config.port}`);
  }

  public add(input: unknown): PlotterWithStatus {
    const id = newId();
    const raw = input as Partial<PlotterConfig>;
    const config = validatePlotterConfig(
      raw?.kind === "hpgl" && !raw.settings ? { ...raw, settings: defaultHpglSettings } : input,
      id,
    );
    this.checkPort(config);
    const plotter = new Plotter(config, this.deps);
    this.plotters.set(id, plotter);
    this.save();
    if (!this.closed) void plotter.start();
    return plotter.withStatus();
  }

  public update(id: string, input: unknown): PlotterWithStatus | undefined {
    const plotter = this.plotters.get(id);
    if (!plotter) return undefined;
    const patch = (input ?? {}) as Partial<PlotterConfig>;
    const config = validatePlotterConfig(
      {
        ...plotter.config,
        hardware: plotter.hardware,
        ...patch,
        settings: patch.settings ? { ...plotter.config.settings, ...patch.settings } : plotter.config.settings,
      },
      id,
    );
    this.checkPort(config);
    const reconnects =
      config.kind !== plotter.config.kind ||
      config.port !== plotter.config.port ||
      config.serialNumber !== plotter.config.serialNumber ||
      config.baudRate !== plotter.config.baudRate ||
      config.rtscts !== plotter.config.rtscts ||
      config.enabled !== plotter.config.enabled;
    if (reconnects && plotter.isPlotting) bad(`${plotter.config.name} is plotting: change its connection afterwards`);
    plotter.reconfigure(config);
    this.save();
    return plotter.withStatus();
  }

  public async remove(id: string): Promise<boolean> {
    const plotter = this.plotters.get(id);
    if (!plotter) return false;
    if (plotter.isPlotting) bad(`${plotter.config.name} is plotting`);
    if (this.plotters.size === 1) bad("saxi needs at least one plotter");
    this.plotters.delete(id);
    this.save();
    await plotter.stop();
    return true;
  }

  /**
   * The port of an AxiDraw for `plotter` (which has no port of its own): one no other plotter is connected to or
   * configured with, with the plotter's serial number if it has one.
   */
  public async findEbb(plotter: Plotter): Promise<string | null> {
    let ports: PortInfo[];
    try {
      ports = (await this.listPorts()).filter(isEBB);
    } catch {
      return null;
    }
    const taken = new Set(
      this.all()
        .filter((p) => p !== plotter)
        .flatMap((p) => [p.port, p.activePath ?? ""])
        .filter((p) => p && p !== SIMULATED_PORT)
        .map(realpath),
    );
    const wanted = plotter.config.serialNumber;
    const found = ports.find((p) => !taken.has(realpath(p.path)) && (!wanted || p.serialNumber === wanted));
    return found?.path ?? null;
  }

  /** The serial ports of the server, for picking one in the plotter form. */
  public async ports(): Promise<SerialPortListing[]> {
    const ports = await this.listPorts();
    const links = process.platform === "linux" ? serialLinks() : new Map();
    const configured = this.all().map((p) => ({
      id: p.id,
      name: p.config.name,
      port: realpath(p.port || p.activePath || ""),
    }));
    return ports.map((p) => {
      const node = realpath(p.path);
      const found = links.get(node) ?? { byId: [], byPath: [] };
      // the by-id link names the adapter by its serial number; identical adapters without one share it
      const twins = ports.filter((q) => q !== p && q.serialNumber && q.serialNumber === p.serialNumber).length > 0;
      const stable = (twins ? found.byPath[0] : (found.byId[0] ?? found.byPath[0])) ?? p.path;
      return {
        path: stable,
        paths: [...new Set([...found.byId, ...found.byPath, p.path])],
        manufacturer: p.manufacturer ?? null,
        serialNumber: p.serialNumber ?? null,
        vendorId: p.vendorId ?? null,
        productId: p.productId ?? null,
        ebb: isEBB(p),
        usedBy: configured.filter((c) => c.port && c.port === node).map(({ id, name }) => ({ id, name })),
      };
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.all().map((p) => p.stop()));
  }
}
