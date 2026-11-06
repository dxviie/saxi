import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { EBBPort } from "../ebb.js";
import { HpglPlotter } from "../hpgl-plotter.js";
import { createSimulatedHpgl } from "../hpgl-sim.js";
import { replan } from "../massager.js";
import { defaultPlanOptions, type Plan } from "../planning.js";
import { PaperSize } from "../paper-size.js";
import { Plotter } from "../plotter.js";
import { PlotterManager } from "../plotter-manager.js";
import type { PlotterConfig } from "../plotter-types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hpPlan(rows = 8): Plan {
  const paths = Array.from({ length: rows }, (_, r) => ({
    points: Array.from({ length: 30 }, (_, i) => ({ x: 100 + i * 20, y: 100 + r * 60 + (i % 2) * 20 })),
    stroke: "black",
    groupId: "",
  }));
  return replan(paths as never, {
    ...defaultPlanOptions,
    hardware: "hp7475a",
    layerMode: "all",
    fitPage: false,
    paperSize: PaperSize.standard.A4.landscape,
  });
}

/** Runs a plan through the driver the way the plot loop does. */
async function plotAll(plotter: HpglPlotter, plan: Plan) {
  await plotter.prePlot(plan, { name: "t", paperSize: { x: 297, y: 210 } });
  for (let i = 0; i < plan.motions.length; i++) await plotter.executeMotion(plan.motions[i], i, plan);
  await plotter.finish();
}

/** The simulated plotter behind a serial port whose writes take `ms` each, like a busy adapter. */
function slowPort(sim: ReturnType<typeof createSimulatedHpgl>, ms: number): EBBPort {
  const writer = sim.writable.getWriter();
  return {
    readable: sim.readable,
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        await sleep(ms);
        await writer.write(chunk);
      },
    }),
    close: () => sim.close(),
  };
}

const hpConfig: PlotterConfig = {
  id: "hp",
  name: "HP",
  kind: "hpgl",
  port: "simulated",
  serialNumber: "",
  hardware: "v3",
  baudRate: 9600,
  rtscts: false,
  enabled: true,
  settings: {},
};

describe("cancelling", () => {
  test("a cancel while the timelapse captures the blank page ends the plot cleanly", async () => {
    process.env.SAXI_SIMULATION_SPEED = "100";
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const recorder = {
      plotStarted: () => sleep(300), // capturing the blank page
      plotterBusy() {},
      plotMotion() {},
      plotEnded: async () => {},
    };
    const plotter = new Plotter(hpConfig, {
      recorder: recorder as never,
      emit: () => {},
      findEbb: async () => null,
      save: () => {},
    });
    await plotter.start();
    const done = plotter.plot(hpPlan(1), { name: "t", hardware: "hp7475a" });
    await sleep(100);
    plotter.cancel();
    await done;
    await sleep(50);
    process.off("unhandledRejection", onUnhandled);
    delete process.env.SAXI_SIMULATION_SPEED;
    expect(unhandled).toEqual([]);
    expect(plotter.isPlotting).toBe(false);
    await plotter.stop();
  });

  test("a second cancel doesn't stop the pen being put away", async () => {
    const sim = createSimulatedHpgl({ timeScale: 0.002 });
    const plotter = await HpglPlotter.connect(sim, "sim", { pollMs: 0 });
    const plan = hpPlan();
    const run = plotAll(plotter, plan).catch((e: Error) => e);
    await sleep(100);
    plotter.cancel();
    await run;
    const cleanup = plotter.postCancel(plan);
    await sleep(20);
    plotter.cancel(); // pressed again while the pen is being put away
    const started = Date.now();
    await cleanup;
    await plotter.postPlot();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sim.executed.slice(-3)).toEqual(["PU", "SP0", "OA"]);
    await plotter.close();
  });

  test("nothing of a cancelled plot is sent after the pen is put away", async () => {
    const sim = createSimulatedHpgl({ timeScale: 0.002 });
    const plotter = await HpglPlotter.connect(slowPort(sim, 60), "sim", { pollMs: 0 });
    const plan = hpPlan();
    const run = plotAll(plotter, plan).catch((e: Error) => e);
    await sleep(400); // writes are in flight
    plotter.cancel();
    expect(await run).toBeInstanceOf(Error);
    await plotter.postCancel(plan);
    await plotter.postPlot();
    const stowed = sim.executed.length;
    await sleep(800);
    expect(sim.executed.length).toBe(stowed);
    expect(sim.executed.slice(-3)).toEqual(["PU", "SP0", "OA"]);
    await plotter.close();
  });
});

describe("plotter manager", () => {
  const ebbPort = {
    path: "/dev/ttyACM0",
    manufacturer: "SchmalzHaus",
    serialNumber: "EggBot",
    vendorId: "04D8",
    productId: "FD92",
    pnpId: undefined,
    locationId: undefined,
  };

  function managerWith(plotters: Array<Partial<PlotterConfig>>, opts = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "saxi-manager-"));
    writeFileSync(path.join(dir, "plotters.json"), JSON.stringify({ plotters }));
    return new PlotterManager(dir, { recorder: null, emit: () => {} }, { listPorts: async () => [ebbPort], ...opts });
  }

  test("two AxiDraws looking for a board at once don't take the same one", async () => {
    const manager = managerWith([
      { id: "a", kind: "ebb" },
      { id: "b", kind: "ebb" },
    ]);
    const [a, b] = manager.all();
    const found = await Promise.all([manager.findEbb(a), manager.findEbb(b)]);
    expect(found.filter((p) => p === "/dev/ttyACM0")).toHaveLength(1);
    expect(found).toContain(null);
    // nor can another plotter be set up on the port one found by itself
    expect(() => manager.add({ kind: "ebb", port: "/dev/ttyACM0" })).toThrow(/already uses/);
    await manager.close();
  });

  test("--device sets the port of the first AxiDraw, but not its model", async () => {
    const manager = managerWith([{ id: "a", kind: "ebb", hardware: "brushless" }], {
      defaultPort: "/dev/ttyUSB7",
      defaultHardware: "v3",
    });
    const [a] = manager.all();
    expect(a.port).toBe("/dev/ttyUSB7");
    expect(a.hardware).toBe("brushless");
    manager.update("a", { settings: { penUpHeight: 40 } });
    expect(a.config).toMatchObject({ port: "", hardware: "brushless" }); // the override isn't saved
    expect(a.port).toBe("/dev/ttyUSB7"); // and stays
    manager.update("a", { hardware: "v3" });
    expect(a.port).toBe("/dev/ttyUSB7");
    await manager.close();
  });
});
