import { createNoise2D } from "simplex-noise";
import { SEA_LEVEL, SNOW_LVL, STONE_LVL, WORLD_HEIGHT } from "../config";
import { BType } from "./types";

// Exported max trunk height — World.ts uses this for chunk mesh bounds checks.
export const TREE_HEIGHT = 6;

const OAK_HEIGHT    = 5; // trunk blocks above ground
const CHERRY_HEIGHT = 6;

// Canopy layers: dy relative to trunk top, rSq = max dx²+dz² for a leaf to appear.
// Oak: classic 4-layer rounded canopy (matches Minecraft Java oak shape).
//   Bottom two layers: 5×5 minus the four far diagonal corners (rSq≤6).
//   Top two layers: 3×3 full / plus-sign cap.
// Cherry: 6-layer wide "mushroom cloud" canopy, max radius ≈4.5 blocks,
//   characteristic wide bottom with narrowing top — widest at dy=-2.
type CanopyLayer = { dy: number; rSq: number };

const OAK_CANOPY: CanopyLayer[] = [
  { dy: -2, rSq: 6 }, // 5×5 minus far corners  (√6 ≈ 2.45)
  { dy: -1, rSq: 6 },
  { dy:  0, rSq: 2 }, // full 3×3               (√2 ≈ 1.41, includes diagonals)
  { dy: +1, rSq: 1 }, // plus-sign cap           (cardinal 4 + center)
];

const CHERRY_CANOPY: CanopyLayer[] = [
  { dy: -3, rSq: 16 }, // 9×9 circle  (r = 4)
  { dy: -2, rSq: 20 }, // widest layer (r ≈ 4.5) — characteristic wide spread
  { dy: -1, rSq: 16 },
  { dy:  0, rSq:  9 }, // 7×7 circle  (r = 3)
  { dy: +1, rSq:  4 }, // 5×5 circle  (r = 2)
  { dy: +2, rSq:  1 }, // plus cap
];

// Farthest a leaf can be from its tree trunk (cherry dy=-2, rSq=20 → r≈4.47)
const CANOPY_RANGE = 5;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1337;

const noiseBase   = createNoise2D(mulberry32(SEED + 0)); // terrain base
const noiseRidge  = createNoise2D(mulberry32(SEED + 1)); // mountain ridges
const noiseTemp   = createNoise2D(mulberry32(SEED + 2)); // temperature axis
const noiseHumid  = createNoise2D(mulberry32(SEED + 3)); // humidity axis
const noiseDune   = createNoise2D(mulberry32(SEED + 4)); // desert dunes
const noiseMtn    = createNoise2D(mulberry32(SEED + 5)); // mountain region selector

// ---------------------------------------------------------------------------
// Biome weights — pre-1.18 Minecraft style: temperature × humidity → biome.
// Desert = hot (temp > 0) AND dry (humid < 0).
// Sakura  = cool (temp < 0) AND humid (humid > 0).
// Forest  = baseline, dominant in the middle of the parameter space.
// Each noise field is ~500-block scale; their product creates naturally-sized
// biome regions (~25% desert, ~25% sakura, ~50% forest).
// ---------------------------------------------------------------------------
interface BiomeW { forest: number; desert: number; sakura: number; }

function getBiomeWeights(wx: number, wz: number): BiomeW {
  const temp  = noiseTemp (wx * 0.0018, wz * 0.0018); // [-1, 1]
  const humid = noiseHumid(wx * 0.0022, wz * 0.0022); // [-1, 1]

  // Raw scores — amplify by 4 so biomes dominate in extreme regions
  const rawDes = Math.max(0,  temp) * Math.max(0, -humid) * 4;
  const rawSak = Math.max(0, -temp) * Math.max(0,  humid) * 4;
  const rawFor = 1.0; // constant baseline

  const total = rawDes + rawSak + rawFor;
  return { forest: rawFor / total, desert: rawDes / total, sakura: rawSak / total };
}

// ---------------------------------------------------------------------------
// Per-biome height functions
// ---------------------------------------------------------------------------
function forestHeight(wx: number, wz: number): number {
  const base = noiseBase(wx * 0.006, wz * 0.006) * 0.6
             + noiseBase(wx * 0.014, wz * 0.014) * 0.2;
  const r1 = 1 - Math.abs(noiseRidge(wx * 0.007, wz * 0.007));
  const r2 = 1 - Math.abs(noiseRidge(wx * 0.015, wz * 0.015));
  const ridge = r1 * 0.65 + r2 * 0.35;
  const region = noiseMtn(wx * 0.003, wz * 0.003);
  const mtn = ridge * ridge * Math.max(0, region) * Math.max(0, region);
  return 40 + (base * 0.28 + mtn) * 52;
}

function desertHeight(wx: number, wz: number): number {
  const dune = noiseDune(wx * 0.009, wz * 0.009) * 0.55
             + noiseDune(wx * 0.022, wz * 0.022) * 0.30
             + noiseDune(wx * 0.050, wz * 0.050) * 0.15;
  return 42 + dune * 12;
}

function sakuraHeight(wx: number, wz: number): number {
  // Gentle rolling hills — no tall mountains, stays above sea level
  const base = noiseBase(wx * 0.008, wz * 0.008) * 0.5
             + noiseBase(wx * 0.020, wz * 0.020) * 0.2;
  return 43 + base * 14; // ~36–57 blocks
}

// ---------------------------------------------------------------------------
// Surface height — weighted blend across all three biomes
// ---------------------------------------------------------------------------
export function surfaceHeight(wx: number, wz: number): number {
  const w = getBiomeWeights(wx, wz);
  const h = forestHeight(wx, wz) * w.forest
          + desertHeight(wx, wz) * w.desert
          + sakuraHeight(wx, wz) * w.sakura;
  return Math.max(2, Math.min(WORLD_HEIGHT - 4, Math.round(h)));
}

// ---------------------------------------------------------------------------
// Surface block
// ---------------------------------------------------------------------------
function columnHash(wx: number, wz: number): number {
  return mulberry32(((wx * 374761393 + wz * 668265263) ^ SEED) >>> 0)();
}

function getSurfaceBlock(h: number, w: BiomeW, wx: number, wz: number): BType {
  // Desert dominant
  if (w.desert > w.forest && w.desert > w.sakura) return BType.sand;
  // Forest/sakura elevation-based
  if (h >= SNOW_LVL)      return BType.snow;
  if (h >= STONE_LVL)     return BType.stone;
  if (h <= SEA_LEVEL + 2) return BType.sand; // beach
  return BType.grass;
}

function getSubBlock(surf: BType): BType {
  if (surf === BType.sand)  return BType.sand;
  if (surf === BType.stone) return BType.stone;
  if (surf === BType.snow)  return BType.stone;
  return BType.dirt;
}

// ---------------------------------------------------------------------------
// Tree placement — returns which tree type grows here (if any)
// ---------------------------------------------------------------------------
type TreeType = "oak" | "cherry" | null;

function treeTypeAt(wx: number, wz: number): TreeType {
  const w = getBiomeWeights(wx, wz);
  const h = surfaceHeight(wx, wz);
  const surf = getSurfaceBlock(h, w, wx, wz);
  if (surf !== BType.grass) return null;
  if (h < SEA_LEVEL) return null;

  const hash = columnHash(wx, wz);

  // Cherry trees in sakura-dominant areas
  if (w.sakura > w.forest && w.sakura > 0.3) {
    if (hash < 0.015 * w.sakura) return "cherry";
    return null;
  }
  // Oak trees in forest (not near desert edge)
  if (w.forest > 0.5 && w.desert < 0.35) {
    if (hash < 0.012 * w.forest) return "oak";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ore hash
// ---------------------------------------------------------------------------
function oreHash(x: number, y: number, z: number, salt: number): number {
  return mulberry32(
    ((x * 374761393 + y * 1274126177 + z * 668265263 + salt * 999983) ^ SEED) >>> 0,
  )();
}

// ---------------------------------------------------------------------------
// Column generator
// ---------------------------------------------------------------------------
export function generateColumn(worldX: number, worldZ: number, out: Uint16Array) {
  out.fill(BType.air);

  const w     = getBiomeWeights(worldX, worldZ);
  const h     = surfaceHeight(worldX, worldZ);
  const top   = getSurfaceBlock(h, w, worldX, worldZ);
  const sub   = getSubBlock(top);

  // Solid terrain
  for (let y = 0; y <= h; y++) {
    if (y === h)         out[y] = top;
    else if (y >= h - 3) out[y] = sub;
    else                 out[y] = BType.stone;
  }

  // Ores (underground stone only)
  for (let y = 1; y < h - 4; y++) {
    if (out[y] !== BType.stone) continue;
    if (y < 16) {
      if (oreHash(worldX, y, worldZ, 1) < 0.0012) { out[y] = BType.diamond_ore;  continue; }
      if (oreHash(worldX, y, worldZ, 2) < 0.0080) { out[y] = BType.redstone_ore; continue; }
    }
    if (y < 32) {
      if (oreHash(worldX, y, worldZ, 5) < 0.0008) { out[y] = BType.emerald_ore;  continue; }
      if (oreHash(worldX, y, worldZ, 3) < 0.0035) { out[y] = BType.gold_ore;     continue; }
      if (oreHash(worldX, y, worldZ, 4) < 0.0045) { out[y] = BType.lapis_ore;    continue; }
    }
    if (y < 55) {
      if (oreHash(worldX, y, worldZ, 6) < 0.0110) { out[y] = BType.iron_ore;     continue; }
    }
    if (oreHash(worldX, y, worldZ, 7) < 0.0160)   { out[y] = BType.coal_ore; }
  }

  // Water below sea level
  if (h < SEA_LEVEL) {
    for (let y = h + 1; y <= SEA_LEVEL; y++) out[y] = BType.water;
  }

  // Tree trunk
  const myTree = treeTypeAt(worldX, worldZ);
  if (myTree) {
    const logBlock  = myTree === "cherry" ? BType.cherry_log : BType.log;
    const trunkH    = myTree === "cherry" ? CHERRY_HEIGHT    : OAK_HEIGHT;
    for (let ty = 1; ty <= trunkH; ty++) {
      const y = h + ty;
      if (y < WORLD_HEIGHT) out[y] = logBlock;
    }
  }

  // Canopy contributed by every tree trunk within CANOPY_RANGE blocks.
  // We iterate the neighbourhood, look up each column's tree type, then apply
  // the per-type canopy layers using a radius-squared test so the shape matches
  // the layer definitions above.
  for (let dx = -CANOPY_RANGE; dx <= CANOPY_RANGE; dx++) {
    for (let dz = -CANOPY_RANGE; dz <= CANOPY_RANGE; dz++) {
      const dSq = dx * dx + dz * dz;
      if (dSq > 20) continue; // beyond widest possible canopy (cherry rSq=20)

      const nx = worldX + dx, nz = worldZ + dz;
      const nTree = treeTypeAt(nx, nz);
      if (!nTree) continue;

      const leafBlock = nTree === "cherry" ? BType.cherry_leaf : BType.leaf;
      const trunkH    = nTree === "cherry" ? CHERRY_HEIGHT     : OAK_HEIGHT;
      const canopy    = nTree === "cherry" ? CHERRY_CANOPY     : OAK_CANOPY;
      const nh        = surfaceHeight(nx, nz);
      const trunkTop  = nh + trunkH;

      for (const { dy, rSq } of canopy) {
        if (dSq > rSq) continue;
        const y = trunkTop + dy;
        if (y >= 0 && y < WORLD_HEIGHT && out[y] === BType.air) out[y] = leafBlock;
      }
    }
  }
}
