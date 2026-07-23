// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Ported verbatim from escape-tsuami-client/src/game/map/worker/utils.ts.
// Bit-packing shared between the greedy mesher (chunkMesh.worker.ts) and the
// chunk vertex shader (shaders.ts) — the two sides must agree on layout.

import { CHUNK_SIZE } from "../config";

export function packData(
  x: number,
  y: number,
  z: number,
  faceId: number,
  ao: number,
  flip_id: number,
  tex_id: number = 4,
) {
  return (
    ((x & 31) << 27) |
    ((y & 31) << 22) |
    ((z & 31) << 17) |
    ((faceId & 7) << 14) |
    ((ao & 3) << 12) |
    ((flip_id & 1) << 11) |
    ((tex_id & 255) << 3)
  );
}

// packed_greedy layout (20 bits used):
//   bits 19-13: greedy_w (7 bits, 0-64)
//   bits 12-6:  greedy_h (7 bits, 0-64)
//   bits  5-4:  x[6:5] (upper 2 bits of x)
//   bits  3-2:  y[6:5] (upper 2 bits of y)
//   bits  1-0:  z[6:5] (upper 2 bits of z)
export function packGreedy(
  w: number,
  h: number,
  x: number = 0,
  y: number = 0,
  z: number = 0,
): number {
  return (
    ((w & 127) << 13) |
    ((h & 127) << 6) |
    (((x >> 5) & 3) << 4) |
    (((y >> 5) & 3) << 2) |
    ((z >> 5) & 3)
  );
}

export function pushToBuffer(b: number[], v: number[]) {
  for (let i = 0; i < 6; i++) {
    b.push(wv(v[i], i));
  }
}

function wv(n: number, vertex: number) {
  return n + ((vertex & 7) << 0);
}

export function getXYZId(x: number, y: number, z: number) {
  return x * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + z;
}
