import { describe, expect, it } from "vitest";
import { WILAYA_MAP_PATHS, WILAYA_MAP_VIEWBOX } from "./wilaya-map";

describe("wilaya map (generated)", () => {
  it("covers exactly the platform wilaya ids 1-58", () => {
    const ids = Object.keys(WILAYA_MAP_PATHS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(ids).toHaveLength(58);
    expect(ids).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  });

  it("uses a square 1000-unit viewBox", () => {
    expect(WILAYA_MAP_VIEWBOX).toBe("0 0 1000 1000");
  });

  it("emits a non-empty closed path for every wilaya", () => {
    for (const [id, d] of Object.entries(WILAYA_MAP_PATHS)) {
      expect(d, `wilaya ${id} has an empty path`).toMatch(/^M/);
      expect(d.endsWith("Z"), `wilaya ${id} path is not closed`).toBe(true);
    }
  });

  it("keeps all path coordinates inside the viewBox", () => {
    const [vx, vy, vw, vh] = WILAYA_MAP_VIEWBOX.split(" ").map(Number);
    for (const [id, d] of Object.entries(WILAYA_MAP_PATHS)) {
      for (const m of d.matchAll(/[ML](-?\d+\.?\d*) (-?\d+\.?\d*)/g)) {
        const x = Number(m[1]);
        const y = Number(m[2]);
        expect(x, `wilaya ${id} x out of bounds`).toBeGreaterThanOrEqual(vx);
        expect(x, `wilaya ${id} x out of bounds`).toBeLessThanOrEqual(vx + vw);
        expect(y, `wilaya ${id} y out of bounds`).toBeGreaterThanOrEqual(vy);
        expect(y, `wilaya ${id} y out of bounds`).toBeLessThanOrEqual(vy + vh);
      }
    }
  });
});
