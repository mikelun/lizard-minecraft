import { describe, expect, it } from "vitest";
import { getXYZId, packData, packGreedy } from "../src/world/packing";
import { CHUNK_SIZE } from "../src/config";

// Must match the unpacking in the chunk vertex shader (src/world/shaders.ts).
function unpackData(v: number) {
  return {
    x: (v >>> 27) & 31,
    y: (v >>> 22) & 31,
    z: (v >>> 17) & 31,
    face: (v >>> 14) & 7,
    ao: (v >>> 12) & 3,
    flip: (v >>> 11) & 1,
    tex: (v >>> 3) & 255,
  };
}

describe("packing", () => {
  it("packData round-trips every field at its limits", () => {
    for (const f of [
      { x: 0, y: 0, z: 0, face: 0, ao: 0, flip: 0, tex: 0 },
      { x: 31, y: 31, z: 31, face: 7, ao: 3, flip: 1, tex: 255 },
      { x: 5, y: 17, z: 9, face: 3, ao: 2, flip: 0, tex: 42 },
    ]) {
      expect(unpackData(packData(f.x, f.y, f.z, f.face, f.ao, f.flip, f.tex))).toEqual(f);
    }
  });

  it("packData leaves the 3 vertex bits free", () => {
    expect(packData(31, 31, 31, 7, 3, 1, 255) & 7).toBe(0);
  });

  it("packGreedy stores size and upper coordinate bits", () => {
    const v = packGreedy(64, 33, 96, 32, 64);
    expect((v >> 13) & 127).toBe(64);
    expect((v >> 6) & 127).toBe(33);
    expect((v >> 4) & 3).toBe(3);
    expect((v >> 2) & 3).toBe(1);
    expect(v & 3).toBe(2);
  });

  it("getXYZId is a dense x-major index", () => {
    expect(getXYZId(0, 0, 0)).toBe(0);
    expect(getXYZId(0, 0, 1)).toBe(1);
    expect(getXYZId(0, 1, 0)).toBe(CHUNK_SIZE);
    expect(getXYZId(1, 0, 0)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    const n = CHUNK_SIZE - 1;
    expect(getXYZId(n, n, n)).toBe(CHUNK_SIZE ** 3 - 1);
  });
});
