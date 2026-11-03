/**
 * One plotter: its connection (kept up, and re-established when it drops), and its plot loop with pause and
 * cancel. The machine itself is behind a PlotterDriver: an EiBotBoard (AxiDraw and friends) or an HP-GL plotter.
 */

import type { Hardware } from "./ebb.js";
import { EBB, type EBBPort } from "./ebb.js";
import { HPGL_BAUD_RATES, HpglPlotter } from "./hpgl-plotter.js";
import { createSimulatedHpgl } from "./hpgl-sim.js";
import { type Motion, PenMotion, type Plan } from "./planning.js";
import type { PlotterDriver } from "./plotter-driver.js";
import {
  type PlotJobInfo,
  type PlotJobStatus,
  type PlotterConfig,
  type PlotterStatus,
  type PlotterWithStatus,
  planHardwareFor,
  SIMULATED_PORT,
} from "./plotter-types.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import { createSimulatedEbb } from "./sim-ports.js";
import type { TimelapseRecorder } from "./timelapse.js";
import { formatDuration } from "./util.js";

/** Before a plot, the pen moves to its starting height and the EBB waits this long before the first motion. */
const PRE_PLOT_PEN_DELAY_MS = 1000;
const RETRY_MS = 5000;

export class PlotterError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  });
}

/** How fast simulated plotters run: SAXI_SIMULATION_SPEED=10 runs them ten times faster than real ones. */
function simulationTimeScale(): number {
  const speed = Number(process.env.SAXI_SIMULATION_SPEED || 1);
  return speed > 0 ? 1 / speed : 1;
}

// ---------------------------------------------------------------------------
// EiBotBoard

export class EbbDriver implements PlotterDriver {
  public readonly reportsProgress = false;
  public readonly startDelayMs = PRE_PLOT_PEN_DELAY_MS;
  public readonly paper = null;
  public readonly attention = null;
  public onReached: (motionIdx: number) => void = () => {};
  public onChange: () => void = () => {};

  constructor(
    public readonly ebb: EBB,
    public readonly path: string,
    public readonly closed: Promise<void>,
  ) {}

  public get model(): string {
    return `EBB ${this.ebb.firmwareVersion.join(".")}`;
  }

  private static penUpPosition(plan: Plan): number | null {
    const first = plan.motions.find((m) => m instanceof PenMotion) as PenMotion | undefined;
    return first ? first.initialPos : null;
  }

  public async prePlot(plan: Plan): Promise<void> {
    await this.ebb.configureFifoDepth();
    await this.ebb.enableMotors(1); // 16x microstepping, matches defaults from Axidraw
    const up = EbbDriver.penUpPosition(plan);
    if (up !== null) await this.ebb.setPenHeight(up, 1000, PRE_PLOT_PEN_DELAY_MS);
  }

  public executeMotion(motion: Motion): Promise<void> {
    return this.ebb.executeMotion(motion);
  }

  public async pause(): Promise<void> {}
  public async resume(): Promise<void> {}
  public async finish(): Promise<void> {}

  public cancel(): void {
    this.ebb.cancel();
  }

  public async postCancel(plan: Plan): Promise<void> {
    const up = EbbDriver.penUpPosition(plan);
    if (up !== null) await this.ebb.setPenHeight(up, 1000);
    await this.ebb.command("HM,4000"); // HM returns carriage home without 3rd and 4th arguments
    // The board may still be executing motion queued in its FIFO; issuing
    // HM while moving makes the steppers grind against whatever they're doing.
    await this.ebb.waitUntilMotorsIdle();
  }

  public async postPlot(): Promise<void> {
    await this.ebb.waitUntilMotorsIdle();
    await this.ebb.disableMotors();
  }

  public async setPenHeight(height: number, rate: number): Promise<void> {
    if (this.ebb.supportsSR()) await this.ebb.setServoPowerTimeout(10000, true);
    await this.ebb.setPenHeight(height, rate);
  }

  public async limp(): Promise<void> {
    await this.ebb.disableMotors();
  }

  public async close(): Promise<void> {
    if ((this.ebb.port as { connected?: boolean }).connected !== false) await this.ebb.close();
  }
}

// ---------------------------------------------------------------------------
// Plotter

/** A serial port as saxi opens it: streams plus a disconnect event. */
interface OpenedPort extends EBBPort {
  addEventListener?(type: string, listener: () => void, options?: unknown): void;
  connected?: boolean;
}

async function openSerial(path: string, baudRate: number, rtscts = false): Promise<OpenedPort> {
  const port = new SerialPortSerialPort(path);
  await port.open({ baudRate, flowControl: rtscts ? "hardware" : "none" });
  if (!port.readable || !port.writable) {
    throw new Error("Serial port opened but readable/writable streams are unavailable");
  }
  return port as unknown as OpenedPort;
}

function disconnection(port: OpenedPort): Promise<void> {
  return new Promise((resolve) => port.addEventListener?.("disconnect", () => resolve(), { once: true }));
}

export interface PlotterDeps {
  recorder: TimelapseRecorder | null;
  /** Sends a message to the UI clients watching this plotter. */
  emit: (plotterId: string, message: Record<string, unknown>) => void;
  /** Finds the port of an AxiDraw that no other plotter uses. */
  findEbb: (plotter: Plotter) => Promise<string | null>;
  /** The configuration changed by itself (e.g. a detected baud rate) and should be saved. */
  save: () => void;
}

export class Plotter {
  public driver: PlotterDriver | null = null;
  /** The port this plotter is connected to, or trying. */
  public activePath: string | null = null;
  /** Port and hardware given on the command line, which win over the configuration until it is edited. */
  public override: { port?: string; hardware?: Hardware } = {};

  private error: string | null = null;
  private plotting = false;
  private unpaused: Promise<void> | null = null;
  private signalUnpause: (() => void) | null = null;
  private motionIdx: number | null = null;
  private currentPlan: Plan | null = null;
  private job: PlotJobStatus | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private interrupt: () => void = () => {};
  private running: Promise<void> | null = null;

  constructor(
    public config: PlotterConfig,
    private readonly deps: PlotterDeps,
  ) {}

  public get id(): string {
    return this.config.id;
  }

  public get port(): string {
    return this.override.port ?? this.config.port;
  }

  public get hardware(): Hardware {
    return this.override.hardware ?? this.config.hardware;
  }

  public get isPlotting(): boolean {
    return this.plotting;
  }

  public status(): PlotterStatus {
    const plan = this.currentPlan;
    return {
      connected: this.driver !== null,
      path: this.driver?.path ?? null,
      model: this.driver?.model ?? null,
      paper: this.driver?.paper ?? null,
      attention: this.driver?.attention ?? null,
      error: this.driver ? null : this.error,
      plotting: this.plotting,
      paused: this.unpaused !== null,
      job: this.job,
      progress: plan && this.motionIdx !== null ? { motionIdx: this.motionIdx, motions: plan.motions.length } : null,
    };
  }

  /** The plot in progress, if any. */
  public currentPlot(): { plan: Plan; job: PlotJobStatus | null } | null {
    return this.currentPlan ? { plan: this.currentPlan, job: this.job } : null;
  }

  public withStatus(): PlotterWithStatus {
    return { ...this.config, hardware: this.hardware, status: this.status() };
  }

  private emit(message: Record<string, unknown>): void {
    this.deps.emit(this.id, message);
  }

  /** What the UI shows about the connection (the "dev" message). */
  public deviceInfo(): Record<string, unknown> {
    return {
      path: this.driver?.path ?? null,
      hardware: this.hardware,
      kind: this.config.kind,
      model: this.driver?.model ?? null,
      paper: this.driver?.paper ?? null,
      attention: this.driver?.attention ?? null,
      name: this.config.name,
    };
  }

  /** The messages a UI client needs when it starts watching this plotter. */
  public initialMessages(): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [
      { c: "dev", p: this.deviceInfo() },
      { c: "pause", p: { paused: !!this.unpaused } },
    ];
    if (this.motionIdx !== null) messages.push({ c: "progress", p: { motionIdx: this.motionIdx } });
    if (this.currentPlan !== null) {
      messages.push({ c: "plan", p: { motions: this.currentPlan.toTransferable(), job: this.job } });
    }
    return messages;
  }

  // ----- connection

  /** Starts connecting. Resolves once the first attempt is over, connected or not (at most `waitMs`). */
  public start(waitMs = 3000): Promise<void> {
    let firstAttempt: () => void = () => {};
    const attempted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    this.running = this.loop(firstAttempt);
    return Promise.race([attempted, sleep(waitMs)]);
  }

  /** Stops for good: the plotter was removed or the server is closing. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.cancel();
    this.interrupt();
    await this.running;
  }

  /** New settings. Changes to the connection reconnect (not while plotting). */
  public reconfigure(config: PlotterConfig): void {
    const before = this.config;
    this.config = config;
    if (
      before.kind !== config.kind ||
      before.port !== config.port ||
      before.serialNumber !== config.serialNumber ||
      before.baudRate !== config.baudRate ||
      before.rtscts !== config.rtscts ||
      before.enabled !== config.enabled
    ) {
      this.override = {};
      this.interrupt();
    } else if (before.hardware !== config.hardware) {
      this.override = {};
      if (this.driver instanceof EbbDriver) this.driver.ebb.changeHardware(config.hardware);
      this.emit({ c: "dev", p: this.deviceInfo() });
    }
  }

  private async loop(firstAttempt: () => void): Promise<void> {
    while (!this.stopped) {
      const interrupted = new Promise<"interrupted">((resolve) => {
        this.interrupt = () => resolve("interrupted");
      });
      if (!this.config.enabled) {
        this.error = null;
        firstAttempt();
        await interrupted;
        continue;
      }
      let driver: PlotterDriver | null = null;
      try {
        const path = await Promise.race([this.resolvePort(interrupted), interrupted]);
        if (path === "interrupted") continue;
        this.activePath = path;
        driver = await this.open(path);
        if (this.stopped) break;
        this.attach(driver);
        firstAttempt();
        const why = await Promise.race([driver.closed.then(() => "closed" as const), interrupted]);
        if (why === "closed" && !this.stopped) {
          console.error(`${this.config.name}: lost the connection, reconnecting...`);
        }
      } catch (e) {
        this.error = (e as Error).message;
        console.error(`${this.config.name}: ${this.error}. Retrying in ${RETRY_MS / 1000} seconds...`);
        firstAttempt();
        await Promise.race([sleep(RETRY_MS), interrupted]);
      } finally {
        this.activePath = null;
        if (driver) {
          if (this.driver === driver) this.driver = null;
          await driver.close().catch(() => {});
          this.emit({ c: "dev", p: this.deviceInfo() });
        }
      }
    }
  }

  /** The port to connect to; for an AxiDraw without one, waits until one shows up. */
  private async resolvePort(interrupted: Promise<unknown>): Promise<string> {
    if (this.port) return this.port;
    if (this.config.kind !== "ebb") throw new Error("no serial port set");
    let waiting = false;
    while (!this.stopped) {
      const found = await this.deps.findEbb(this);
      if (found) return found;
      if (!waiting) {
        console.log(`${this.config.name}: waiting for an AxiDraw to be connected...`);
        waiting = true;
      }
      if ((await Promise.race([sleep(RETRY_MS), interrupted])) === "interrupted") break;
    }
    throw new Error("stopped");
  }

  private async open(path: string): Promise<PlotterDriver> {
    if (this.config.kind === "ebb") {
      console.log(`Found EBB at ${path}`);
      const port = path === SIMULATED_PORT ? createSimulatedEbb() : await openSerial(path, 9600);
      try {
        const ebb = await EBB.create(port, this.hardware);
        return new EbbDriver(ebb, path, path === SIMULATED_PORT ? new Promise(() => {}) : disconnection(port));
      } catch (e) {
        await port.close().catch(() => {});
        throw new Error(`Error connecting to EBB: ${(e as Error).message}`);
      }
    }
    if (path === SIMULATED_PORT) {
      return HpglPlotter.connect(createSimulatedHpgl({ timeScale: simulationTimeScale() }), path);
    }
    const { baudRate, rtscts } = this.config;
    const rates = baudRate > 0 ? [baudRate] : HPGL_BAUD_RATES;
    for (const rate of rates) {
      const port = await openSerial(path, rate, rtscts);
      try {
        const plotter = await HpglPlotter.connect(port, path, { rtscts, timeoutMs: rates.length > 1 ? 1500 : 3000 });
        console.log(`${this.config.name}: ${plotter.model} at ${path}, ${rate} baud`);
        if (baudRate <= 0) {
          // remember what worked
          this.config = { ...this.config, baudRate: rate };
          this.deps.save();
        }
        void disconnection(port)
          .then(() => plotter.close())
          .catch(() => {});
        return plotter;
      } catch (e) {
        if (rates.length === 1) throw e;
      }
    }
    throw new Error(
      `no answer at ${rates.join(", ")} baud: check that the cable is a null-modem one and that the plotter is on`,
    );
  }

  private attach(driver: PlotterDriver): void {
    this.driver = driver;
    this.error = null;
    driver.onChange = () => this.emit({ c: "dev", p: this.deviceInfo() });
    this.emit({ c: "dev", p: this.deviceInfo() });
  }

  // ----- manual control

  public async setPenHeight(height: number, rate: number): Promise<void> {
    await this.driver?.setPenHeight(height, rate);
  }

  public async selectPen(pen: number): Promise<void> {
    await this.driver?.selectPen?.(pen);
  }

  public async limp(): Promise<void> {
    await this.driver?.limp();
  }

  // ----- plotting

  /** Starts a plot. Throws a PlotterError if it can't. Resolves when the plot is over. */
  public plot(plan: Plan, job: PlotJobInfo): Promise<void> {
    if (this.plotting) throw new PlotterError("Plot in progress", 400);
    const planned = job.hardware;
    const hpgl = this.config.kind === "hpgl";
    if (planned && (planned === "hp7475a") !== hpgl) {
      throw new PlotterError(
        `this plan was made for ${planned === "hp7475a" ? "an HP-GL plotter" : "an AxiDraw"}, but ${this.config.name} is ${hpgl ? "an HP-GL plotter" : "an AxiDraw"}: plan it again for this plotter`,
        400,
      );
    }
    if (!this.driver && hpgl) throw new PlotterError(`${this.config.name} is not connected`, 409);
    this.plotting = true;
    this.controller = new AbortController();
    return this.run(plan, job, this.controller.signal).finally(() => {
      this.plotting = false;
      this.controller = null;
    });
  }

  public pause(): void {
    if (!this.unpaused) {
      this.unpaused = new Promise((resolve) => {
        this.signalUnpause = resolve;
      });
      this.emit({ c: "pause", p: { paused: true } });
    }
  }

  public resume(): void {
    if (this.signalUnpause) {
      this.signalUnpause();
      this.signalUnpause = this.unpaused = null;
    }
  }

  public cancel(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.driver?.cancel();
    if (this.unpaused) {
      this.signalUnpause?.();
      this.emit({ c: "pause", p: { paused: false } });
    }
    this.unpaused = this.signalUnpause = null;
  }

  private async run(plan: Plan, job: PlotJobInfo, signal: AbortSignal): Promise<void> {
    console.log(`${this.config.name}: received plan of estimated duration ${formatDuration(plan.duration())}`);
    const driver = this.driver ?? (await this.simulatedEbb());
    console.log(this.driver ? "Beginning plot..." : "Simulating plot...");
    const recorder = this.deps.recorder;
    const begin = Date.now();
    let wakeLock: { release(): void } | null = null;
    // The wake-lock module is macOS-only.
    if (process.platform === "darwin") {
      try {
        const { WakeLock } = await import("wake-lock");
        wakeLock = new WakeLock("saxi plotting");
      } catch (_error) {
        console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
      }
    }

    const abortPromise = onceAbort(signal);
    this.unpaused = null;
    this.signalUnpause = null;
    this.motionIdx = 0;
    this.currentPlan = plan;
    this.job = { ...job, startedAt: new Date().toISOString(), estimatedSeconds: plan.duration() };
    this.emit({ c: "plan", p: { motions: plan.toTransferable(), job: this.job } });

    // Drivers that know when the plotter gets to each motion report it; the others are reported as sent.
    let reported = -1;
    const reach = (motionIdx: number) => {
      const until = Math.min(motionIdx, plan.motions.length - 1);
      if (until <= reported || this.motionIdx === null) return;
      for (let i = reported + 1; i <= until; i++) recorder?.plotMotion(plan.motions[i], this.id, { now: true });
      reported = until;
      this.motionIdx = until;
      this.emit({ c: "progress", p: { motionIdx: until } });
    };
    driver.onReached = driver.reportsProgress ? reach : () => {};

    const context = { plotterId: this.id, plotterName: this.config.name, jobName: job.name };
    await recorder?.plotStarted(plan.duration(), context); // captures the blank page before anything moves
    let penIsUp = true;
    try {
      await Promise.race([driver.prePlot(plan, job), abortPromise]);
      recorder?.plotterBusy(driver.startDelayMs, this.id); // tells the timelapse when the first motion really starts
      if (driver.reportsProgress) reach(0);
      for (let i = 0; i < plan.motions.length; i++) {
        const motion = plan.motions[i];
        if (!driver.reportsProgress) {
          this.motionIdx = i;
          this.emit({ c: "progress", p: { motionIdx: i } });
          recorder?.plotMotion(motion, this.id);
        }

        await Promise.race([driver.executeMotion(motion, i, plan), abortPromise]);

        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }

        if (this.unpaused && penIsUp) {
          await Promise.race([driver.pause(), abortPromise]);
          await Promise.race([this.unpaused, abortPromise]);
          await Promise.race([driver.resume(), abortPromise]);
          this.emit({ c: "pause", p: { paused: false } });
        }
      }
      await Promise.race([driver.finish(), abortPromise]);

      this.emit({ c: "finished" });
      console.log(`${this.config.name}: plot took ${formatDuration((Date.now() - begin) / 1000)}`);
    } catch (err) {
      if (signal.aborted) {
        await driver.postCancel(plan).catch((e) => console.error(`${this.config.name}: ${(e as Error).message}`));
        this.emit({ c: "cancelled" });
        return;
      }
      console.error(`${this.config.name}: plot failed: ${(err as Error).message}`);
      this.emit({ c: "cancelled" });
      throw err; // propagate real errors
    } finally {
      this.motionIdx = null;
      this.currentPlan = null;
      this.job = null;
      wakeLock?.release();
      await driver.postPlot().catch((e) => console.error(`${this.config.name}: ${(e as Error).message}`));
      await recorder?.plotEnded(signal.aborted, this.id); // final frame of the finished drawing
      if (driver !== this.driver) await driver.close().catch(() => {});
    }
  }

  private async simulatedEbb(): Promise<PlotterDriver> {
    const ebb = await EBB.create(createSimulatedEbb(), this.hardware);
    return new EbbDriver(ebb, SIMULATED_PORT, new Promise(() => {}));
  }

  /** What saxi plans for on this plotter. */
  public planHardware() {
    return planHardwareFor({ kind: this.config.kind, hardware: this.hardware });
  }
}
