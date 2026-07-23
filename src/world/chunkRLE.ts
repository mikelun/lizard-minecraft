// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Ported verbatim from escape-tsuami-client/src/game/map/chunkRLE.ts.
// Run-length encoding for chunk palette-index arrays, used to compress chunks
// that are evicted from render range but kept in the global cache.

import { CHUNK_SIZE } from "../config";

const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

export interface RLEChunk {
  values: Uint8Array; // palette indices (always < 256 for ~20 block types)
  runs: Uint16Array; // run lengths stored as (length - 1), so 0 = run of 1
}

export function rleEncode(chunk: Uint8Array): RLEChunk {
  const values: number[] = [];
  const runs: number[] = [];
  let i = 0;
  while (i < chunk.length) {
    const val = chunk[i];
    let run = 1;
    while (i + run < chunk.length && chunk[i + run] === val && run < 65536) {
      run++;
    }
    values.push(val);
    runs.push(run - 1);
    i += run;
  }
  return {
    values: new Uint8Array(values),
    runs: new Uint16Array(runs),
  };
}

export function rleDecode(rle: RLEChunk): Uint8Array {
  const result = new Uint8Array(CHUNK_VOLUME);
  let offset = 0;
  for (let i = 0; i < rle.values.length; i++) {
    const run = rle.runs[i] + 1;
    result.fill(rle.values[i], offset, offset + run);
    offset += run;
  }
  return result;
}
