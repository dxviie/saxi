import { describe, expect, test } from "vitest";
import {
  frameForPaper,
  frameFromClip,
  HP7475A_FRAMES,
  HpglEncoder,
  hpglProgram,
  parseRect,
  plotterTransform,
  simplifyPolyline,
  velocityInstruction,
} from "../hpgl.js";
import { replan } from "../massager.js";
import { defaultPlanOptions, HPGL_UNITS_PER_MM, PenMotion, plan } from "../planning.js";
import { PaperSize } from "../paper-size.js";

const A4 = frameFromClip({ x0: 0, y0: 0, x1: 11040, y1: 7721 });
const k = HPGL_UNITS_PER_MM;

/** A plan in HP units for paths given in mm. */
function planMm(paths: Array<Array<[number, number]>>) {
  const profile = {
    penDownProfile: { acceleration: 4900 * k, maximumVelocity: 100 * k, corneringFactor: 0.05 * k },
    penUpProfile: { acceleration: 4900 * k, maximumVelocity: 381 * k, corneringFactor: 0 },
    penUpPos: 1,
    penDownPos: 0,
    penDropDuration: 0.05,
    penLiftDuration: 0.05,
  };
  return plan(
    paths.map((p) => p.map(([x, y]) => ({ x: x * k, y: y * k }))),
    profile,
  );
}

describe("paper frames", () => {
  test("recognises the 7475A paper sizes by their hard-clip limits", () => {
    expect(A4.paper.name).toBe("A4");
    expect(A4.center).toEqual({ x: 5603, y: 4121 });
    expect(frameFromClip(parseRect("0,0,16158,11040") ?? A4.clip).paper.name).toBe("A3");
    expect(frameFromClip(parseRect("0,0,10365,7962") ?? A4.clip).paper.name).toBe("A");
    const odd = frameFromClip({ x0: 0, y0: 0, x1: 1000, y1: 500 });
    expect(odd.center).toEqual({ x: 500, y: 250 });
  });

  test("picks the frame for a drawing's paper", () => {
    expect(frameForPaper({ x: 210, y: 297 }).paper.name).toBe("A4");
    expect(frameForPaper({ x: 215.9, y: 279.4 }).paper.name).toBe("A");
    expect(frameForPaper({ x: 148, y: 210 }).paper.name).toBe("A4"); // A5 taped onto A4
    expect(frameForPaper({ x: 300, y: 420 }).paper.name).toBe("A3");
  });

  test("every default P1/P2 frame lies within the hard-clip limits", () => {
    for (const f of HP7475A_FRAMES) {
      expect(f.p1p2.x0).toBeGreaterThanOrEqual(f.clip.x0);
      expect(f.p1p2.y1).toBeLessThanOrEqual(f.clip.y1);
    }
  });
});

describe("coordinates", () => {
  test("landscape paper is centred on the frame with y flipped", () => {
    const t = plotterTransform({ x: 297, y: 210 }, A4);
    const centre = t({ x: 148.5 * k, y: 105 * k });
    expect(centre.x).toBeCloseTo(5603);
    expect(centre.y).toBeCloseTo(4121);
    // the top left of the paper is up and to the left: lower x, higher y
    const topLeft = t({ x: 20 * k, y: 20 * k });
    expect(topLeft.x).toBeLessThan(centre.x);
    expect(topLeft.y).toBeGreaterThan(centre.y);
    expect(topLeft.y - centre.y).toBeCloseTo(85 * k);
  });

  test("portrait paper is turned a quarter turn", () => {
    const t = plotterTransform({ x: 210, y: 297 }, A4);
    const centre = t({ x: 105 * k, y: 148.5 * k });
    expect(centre.x).toBeCloseTo(5603);
    expect(centre.y).toBeCloseTo(4121);
    // the top of a portrait drawing is at the left of the plot
    const top = t({ x: 105 * k, y: 10 * k });
    expect(top.x).toBeCloseTo(5603 - 138.5 * k);
    expect(top.y).toBeCloseTo(4121);
  });
});

describe("encoder", () => {
  const identity = { transform: (p: { x: number; y: number }) => p, clip: { x0: 0, y0: 0, x1: 1000, y1: 1000 } };

  test("drops collinear points the planner adds", () => {
    expect(
      simplifyPolyline([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    // but not where the line turns back
    expect(
      simplifyPolyline([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 0 },
      ]),
    ).toHaveLength(3);
  });

  test("turns pen motions into PU/PD and strokes into PD point lists", () => {
    const p = planMm([
      [
        [10, 10],
        [20, 10],
        [20, 20],
      ],
    ]);
    const encoder = new HpglEncoder({ ...identity, clip: { x0: 0, y0: 0, x1: 2000, y1: 2000 } });
    const out = p.motions.flatMap((m) => encoder.encode(m));
    const r = (mm: number) => Math.round(mm * k);
    expect(out).toEqual([
      `PU${r(10)},${r(10)};`,
      "PD;",
      `PD${r(20)},${r(10)},${r(20)},${r(20)};`,
      "PU;",
      "PU0,0;", // back home
    ]);
  });

  test("lines are cut at the edge of the plotting area and the pen stays up outside", () => {
    const encoder = new HpglEncoder(identity);
    const stroke = plan(
      [
        [
          { x: 500, y: 500 },
          { x: 1500, y: 500 },
          { x: 1500, y: 600 },
          { x: 500, y: 600 },
        ],
      ],
      {
        penDownProfile: { acceleration: 1000, maximumVelocity: 100, corneringFactor: 0 },
        penUpProfile: { acceleration: 1000, maximumVelocity: 100, corneringFactor: 0 },
        penUpPos: 1,
        penDownPos: 0,
        penDropDuration: 0,
        penLiftDuration: 0,
      },
    );
    const out = stroke.motions.flatMap((m) => encoder.encode(m));
    expect(out).toEqual([
      "PU500,500;",
      "PD;",
      "PD1000,500;", // to the edge
      "PU;", // outside
      "PU1000,600;", // back in
      "PD;",
      "PD500,600;",
      "PU;",
      "PU0,0;",
    ]);
  });

  test("a path starting outside the area lowers the pen where it comes in", () => {
    const encoder = new HpglEncoder(identity);
    const motions = [
      ...plan(
        [
          [
            { x: -100, y: 100 },
            { x: 100, y: 100 },
          ],
        ],
        {
          penDownProfile: { acceleration: 1000, maximumVelocity: 100, corneringFactor: 0 },
          penUpProfile: { acceleration: 1000, maximumVelocity: 100, corneringFactor: 0 },
          penUpPos: 1,
          penDownPos: 0,
          penDropDuration: 0,
          penLiftDuration: 0,
        },
      ).motions,
    ];
    const out = motions.flatMap((m) => encoder.encode(m));
    expect(out).toEqual(["PU0,100;", "PD;", "PD100,100;", "PU;", "PU0,0;"]);
    expect(motions.filter((m) => m instanceof PenMotion)).toHaveLength(2);
  });

  test("long strokes are split into PD instructions of a few points", () => {
    const zigzag = Array.from({ length: 40 }, (_, i): [number, number] => [10 + i, i % 2 ? 10 : 20]);
    const p = planMm([zigzag]);
    const encoder = new HpglEncoder({ transform: (q) => q, clip: A4.clip, maxPointsPerInstruction: 16 });
    const out = p.motions.flatMap((m) => encoder.encode(m));
    const strokes = out.filter((i) => /^PD\d/.test(i));
    expect(strokes.length).toBe(3); // 39 points
    expect(strokes.every((s) => s.split(",").length <= 32)).toBe(true);
  });
});

describe("program", () => {
  test("velocity is set in cm/s, or left at full speed", () => {
    expect(velocityInstruction(100)).toBe("VS10;");
    expect(velocityInstruction(1)).toBe("VS0.38;");
    expect(velocityInstruction(500)).toBe("VS;");
  });

  test("a whole plan becomes a program that picks a pen and puts it away", () => {
    const options = {
      ...defaultPlanOptions,
      hardware: "hp7475a" as const,
      layerMode: "all" as const,
      paperSize: PaperSize.standard.A4.landscape,
    };
    const lines = [
      {
        points: [
          { x: 100, y: 100 },
          { x: 400, y: 100 },
        ],
        stroke: "black",
        groupId: "",
      },
    ] as never;
    const p = replan(lines, options);
    const program = hpglProgram(p, { paperSize: options.paperSize.size, pen: 2, penSpeed: 80 }).trim().split("\n");
    expect(program.slice(0, 3)).toEqual(["IN;", "SP2;", "VS8;"]);
    expect(program.slice(-2)).toEqual(["PU;", "SP0;"]);
    expect(program).toContain("PD;");
    // all coordinates within the A4 plotting area
    for (const line of program.filter((l) => /^P[UD]\d/.test(l))) {
      const nums = line.slice(2, -1).split(",").map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(0);
        expect(nums[i]).toBeLessThanOrEqual(11040);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
        expect(nums[i + 1]).toBeLessThanOrEqual(7721);
      }
    }
  });
});
