// NEW: the source repo has no terrain generator (game/map/height.ts is empty
// stubs -- world data comes from a server there). This is fresh code: a
// deterministic simplex-noise heightmap driving the biome bands defined in
// config.ts, plus simple deterministic tree scattering.

import { createNoise2D } from "simplex-noise";
import {
  DIRT_LVL,
  GRASS_LVL,
  SAND_LVL,
  SEA_LEVEL,
  SNOW_LVL,
  STONE_LVL,
  WORLD_HEIGHT,
} from "../config";
import { BType } from "./types";

const TREE_PROBABILITY = 0.01;
// Exported: World.ts's chunk-emptiness pre-check samples raw surfaceHeight()
// only, which knows nothing about trees -- callers that need the true
// highest-possible block in a column (including trunk + canopy) must add
// this on top of surfaceHeight()'s result.
export const TREE_HEIGHT = 5;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed seed -> same world every run, and (critically) the same height for a
// given (x,z) no matter which chunk column asks first, which lets neighboring
// columns compute tree canopies independently without touching each other's data.
const SEED = 1337;
const noiseBase = createNoise2D(mulberry32(SEED));
const noiseDetail = createNoise2D(mulberry32(SEED + 1));

// Gentler than the original (base amplitude 34, detail freq 0.06): that combo
// could carve near-vertical 1-2 block slot canyons between adjacent columns
// (steep local gradient from the high-frequency detail layer), which read as
// solid-black holes on screen and forced extra vertical chunks to be meshed
// per column. Lower amplitude + lower detail frequency/weight keeps rolling
// hills and the occasional peak without the harsh, narrow crevices, and
// shrinks the height range so fewer of a column's MAX_HEIGHT_IN_CHUNKS
// vertical layers ever contain exposed geometry.
export function surfaceHeight(worldX: number, worldZ: number): number {
  const n =
    noiseBase(worldX * 0.012, worldZ * 0.012) * 0.8 +
    noiseDetail(worldX * 0.035, worldZ * 0.035) * 0.2;
  const h = Math.round(56 + n * 22);
  return Math.max(2, Math.min(WORLD_HEIGHT - TREE_HEIGHT - 4, h));
}

function surfaceBlock(h: number): BType {
  if (h >= SNOW_LVL) return BType.snow;
  if (h >= STONE_LVL) return BType.stone;
  if (h >= DIRT_LVL) return BType.dirt;
  if (h >= GRASS_LVL) return BType.grass;
  if (h >= SAND_LVL) return BType.sand;
  return BType.sand;
}

// Deterministic per-column hash in [0, 1), independent of generation order.
function columnHash(worldX: number, worldZ: number): number {
  const rand = mulberry32(
    ((worldX * 374761393 + worldZ * 668265263) ^ SEED) >>> 0,
  );
  return rand();
}

function hasTreeAt(worldX: number, worldZ: number): boolean {
  const h = surfaceHeight(worldX, worldZ);
  if (surfaceBlock(h) !== BType.grass || h < SEA_LEVEL) return false;
  return columnHash(worldX, worldZ) < TREE_PROBABILITY;
}

/** Fills `out[y]` (length WORLD_HEIGHT) with the block column at (worldX, worldZ). */
export function generateColumn(worldX: number, worldZ: number, out: Uint16Array) {
  out.fill(BType.air);

  const h = surfaceHeight(worldX, worldZ);
  const top = surfaceBlock(h);

  for (let y = 0; y <= h; y++) {
    if (y === h) {
      out[y] = top === BType.sand && h < SEA_LEVEL ? BType.sand : top;
    } else if (y >= h - 3) {
      out[y] = top === BType.stone || top === BType.snow ? BType.stone : BType.dirt;
    } else {
      out[y] = BType.stone;
    }
  }

  if (h < SEA_LEVEL) {
    for (let y = h + 1; y <= SEA_LEVEL; y++) out[y] = BType.water;
  }

  // Own trunk, if this column rolls a tree.
  if (hasTreeAt(worldX, worldZ)) {
    for (let ty = 1; ty <= TREE_HEIGHT; ty++) {
      const y = h + ty;
      if (y < WORLD_HEIGHT) out[y] = BType.log;
    }
  }

  // Canopy contributed by nearby trunk columns (each column independently
  // derives its neighbors' tree state, so no cross-chunk mutation is needed).
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nx = worldX + dx;
      const nz = worldZ + dz;
      if (!hasTreeAt(nx, nz)) continue;

      const nh = surfaceHeight(nx, nz);
      const canopyBase = nh + TREE_HEIGHT - 2;
      for (let ly = 0; ly < 3; ly++) {
        const radius = ly === 1 ? 2 : 1;
        if (dx * dx + dz * dz > radius * radius) continue;
        const y = canopyBase + ly;
        if (y >= 0 && y < WORLD_HEIGHT && out[y] === BType.air) {
          out[y] = BType.leaf;
        }
      }
    }
  }
}
