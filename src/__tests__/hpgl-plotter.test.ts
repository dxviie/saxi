import { describe, expect, test } from "vitest";
import { HpglPlotter, identifyHpgl } from "../hpgl-plotter.js";
import { createSimulatedHpgl } from "../hpgl-sim.js";
import { replan } from "../massager.js";
import { defaultPlanOptions, PenMotion, type Plan } from "../planning.js";
import { PaperSize } from "../paper-size.js";

/** A plan for the 7475A: `rows` horizontal lines of zigzags, laid out on A4. */
function testPlan(rows = 6, teeth = 30): Plan {
  const paths = Array.from({ length: rows }, (_, r) => ({
    // in SVG pixels, inside the default 20 mm margin
    points: Array.from({ length: teeth }, (_, i) => ({ x: 100 + i * 20, y: 100 + r * 60 + (i % 2) * 20 })),
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

async function plotAll(plotter: HpglPlotter, plan: Plan, opts: { pauseAfter?: number } = {}) {
  await plotter.prePlot(plan, { name: "test", paperSize: { x: 297, y: 210 }, pen: 2, penSpeed: 100 });
  let penIsUp = true;
  for (let i = 0; i < plan.motions.length; i++) {
    const motion = plan.motions[i];
    await plotter.executeMotion(motion, i, plan);
    if (motion instanceof PenMotion) penIsUp = motion.initialPos < motion.finalPos;
    if (opts.pauseAfter !== undefined && i >= opts.pauseAfter && penIsUp) {
      opts.pauseAfter = undefined;
      await plotter.pause();
      await plotter.resume();
    }
  }
  await plotter.finish();
  await plotter.postPlot();
}

describe("HP-GL plotter", () => {
  test("identifies the plotter and the paper it is set to", async () => {
    const port = createSimulatedHpgl({ paper: "A3", timeScale: 0 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 0 });
    expect(plotter.model).toBe("HP 7475A");
    expect(plotter.paper?.name).toBe("A3");
    expect(port.escapes.slice(0, 2)).toEqual([".(", ".K"]);
    await plotter.close();
    expect(port.closedByHost).toBe(true);
  });

  test("gives up on a port where nothing answers", async () => {
    const port = createSimulatedHpgl({ silent: true });
    await expect(HpglPlotter.connect(port, "sim", { timeoutMs: 100, pollMs: 0 })).rejects.toThrow(/null-modem/);
    expect(port.closedByHost).toBe(true);
    expect(await identifyHpgl(createSimulatedHpgl({ silent: true }), 50)).toBeNull();
    expect((await identifyHpgl(createSimulatedHpgl({ timeScale: 0 }), 500))?.model).toBe("HP 7475A");
  });

  test("plots a whole plan without overflowing the plotter's buffer, reporting where it is", async () => {
    const port = createSimulatedHpgl({ timeScale: 0.0002 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 0 });
    const plan = testPlan();
    const reached: number[] = [];
    plotter.onReached = (i) => reached.push(i);
    await plotAll(plotter, plan);

    expect(port.maxBuffered).toBeLessThanOrEqual(1024);
    expect(port.maxBuffered).toBeGreaterThan(500); // and keeps it reasonably full
    // progress only goes forward, and gets to the end (the return home is left out)
    expect(reached).toEqual([...reached].sort((a, b) => a - b));
    expect(reached.at(-1)).toBe(plan.motions.length - 1);
    // pen 2 at 10 cm/s, put away at the end
    const run = port.executed.slice(port.executed.lastIndexOf("IN"));
    expect(run.slice(0, 4)).toEqual(["IN", "OH", "SP2", "VS10"]);
    expect(port.executed.slice(-3)).toEqual(["PU", "SP0", "OA"]);
    // every zigzag drawn: 29 lines per row
    expect(port.strokes.filter((s) => s.pen === 2)).toHaveLength(6 * 29);
    for (const s of port.strokes) {
      expect(s.from.x).toBeGreaterThanOrEqual(0);
      expect(s.to.y).toBeLessThanOrEqual(7721);
    }
    await plotter.close();
  });

  test("puts the pen away while paused", async () => {
    const port = createSimulatedHpgl({ timeScale: 0 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 0 });
    await plotAll(plotter, testPlan(2, 4), { pauseAfter: 5 });
    const pens = port.executed.filter((i) => i.startsWith("SP"));
    expect(pens).toEqual(["SP2", "SP0", "SP2", "SP0"]);
    await plotter.close();
  });

  test("cancelling clears the plotter's buffer and puts the pen away", async () => {
    const port = createSimulatedHpgl({ timeScale: 0.002 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 0 });
    const plan = testPlan(8, 30);
    const run = plotAll(plotter, plan).catch((e: Error) => e);
    await new Promise((resolve) => setTimeout(resolve, 150));
    plotter.cancel();
    expect(await run).toBeInstanceOf(Error);
    await plotter.postCancel(plan);
    await plotter.postPlot();
    expect(port.escapes.filter((e) => e === ".K").length).toBeGreaterThanOrEqual(3); // connect, prePlot, cancel
    expect(port.executed.slice(-3)).toEqual(["PU", "SP0", "OA"]);
    expect(port.strokes.length).toBeLessThan(8 * 29);
    await plotter.close();
  });

  test("reports a raised paper lever or VIEW", async () => {
    const port = createSimulatedHpgl({ timeScale: 0 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 20 });
    let changes = 0;
    plotter.onChange = () => changes++;
    port.setStatusBits(32);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(plotter.attention).toMatch(/lever/);
    port.setStatusBits(16);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(plotter.attention).toMatch(/VIEW/);
    port.setStatusBits(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(plotter.attention).toBeNull();
    expect(changes).toBe(3);
    await plotter.close();
  });

  test("leaves out status checks while position answers are coming", async () => {
    const checksDuringPlot = async (quietMs: number) => {
      const port = createSimulatedHpgl({ timeScale: 0.05 });
      const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 5, quietMs });
      await plotAll(plotter, testPlan());
      const checks = port.escapes.filter((e) => e === ".O").length;
      await plotter.close();
      return checks;
    };
    expect(await checksDuringPlot(0)).toBeGreaterThan(0);
    expect(await checksDuringPlot(10000)).toBe(0);
  });

  test("still reports a raised paper lever during a plot", async () => {
    const port = createSimulatedHpgl({ timeScale: 0.05 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 10, quietMs: 50 });
    const done = plotAll(plotter, testPlan());
    await new Promise((resolve) => setTimeout(resolve, 30));
    port.setStatusBits(32);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(plotter.attention).toMatch(/lever/);
    port.setStatusBits(0);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plotter.attention).toBeNull();
    await plotter.close();
  });

  test("notices when the plotter stops answering", async () => {
    const port = createSimulatedHpgl({ timeScale: 0 });
    const plotter = await HpglPlotter.connect(port, "sim", { pollMs: 20 });
    let closed = false;
    void plotter.closed.then(() => {
      closed = true;
    });
    // switched off: the adapter stays, the plotter goes quiet
    (port as unknown as { close(): Promise<void> }).close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(true);
  });
});
