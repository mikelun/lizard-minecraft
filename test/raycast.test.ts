import { describe, expect, it } from "vitest";
import { raycastWithNormal } from "../src/world/raycast";

const wallAtX = (wx: number) => (x: number) => x === wx;

// Directions are slightly tilted: a component that is exactly 0 is not
// handled yet (see the `fails` test at the bottom).
describe("raycastWithNormal", () => {
  it("hits a wall along +x with a -x normal", () => {
    const hit = raycastWithNormal({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0.001, z: 0.001 }, 20, wallAtX(5));
    expect(hit).toEqual({ position: { x: 5, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 } });
  });

  it("hits the floor when looking down", () => {
    const hit = raycastWithNormal(
      { x: 0.5, y: 10.5, z: 0.5 },
      { x: 0.001, y: -1, z: 0.001 },
      20,
      (_x, y) => y <= 2,
    );
    expect(hit?.position).toEqual({ x: 0, y: 2, z: 0 });
    expect(hit?.normal).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("returns null when nothing is within range", () => {
    expect(raycastWithNormal({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0.001, z: 0.001 }, 3, wallAtX(10))).toBeNull();
  });

  it("passes the ray's entry/exit Y so callers can model half blocks", () => {
    const seen: [number, number][] = [];
    raycastWithNormal({ x: 0.5, y: 0.2, z: 0.5 }, { x: 1, y: 0.1, z: 0.001 }, 4, (_x, _y, _z, enterY, exitY) => {
      seen.push([enterY, exitY]);
      return false;
    });
    expect(seen[0][0]).toBeCloseTo(0.2);
    expect(seen[0][1]).toBeCloseTo(0.25);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeCloseTo(seen[i - 1][1]);
  });

  // Known bug: with a direction component of exactly 0 the step sign defaults
  // to -1, so tMax for that axis is -Infinity and the ray walks down that axis
  // instead of along the real direction. Remove `.fails` once fixed.
  it.fails("handles an exactly axis-aligned direction", () => {
    const hit = raycastWithNormal({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 20, wallAtX(5));
    expect(hit?.position).toEqual({ x: 5, y: 0, z: 0 });
  });
});
