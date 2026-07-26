// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// ModelLayer — renders custom 3D models for all non-cube blocks using the
// canonical Minecraft 1.21.5 block models extracted from the jar.
//
// Handles: chest · stairs (8 materials × 8 variants) ·
//          slabs (7 materials × 2 halves) · trapdoors (oak/iron × 16 states)
//
// Block orientation follows the Minecraft blockstates JSON convention:
//   Y rotation first, then X rotation (Three.js rotation.order = "YXZ").

import * as THREE from "three";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";
import { loadModelGroup } from "./JsonModelLoader";

const S = CHUNK_SIZE;
const D = THREE.MathUtils.degToRad;

// ── Stair base model names per base BType ─────────────────────────────────────

const STAIR_BASES: Partial<Record<number, string>> = {
  [BType.stone_brick_stairs]:          "stone_brick_stairs",
  [BType.smooth_sandstone_stairs]:     "smooth_sandstone_stairs",
  [BType.sandstone_stairs]:            "sandstone_stairs",
  [BType.smooth_red_sandstone_stairs]: "smooth_red_sandstone_stairs",
  [BType.oak_stairs]:                  "oak_stairs",
  [BType.prismarine_brick_stairs]:     "prismarine_brick_stairs",
  [BType.cobblestone_stairs]:          "cobblestone_stairs",
  [BType.brick_stairs]:                "brick_stairs",
};

// variant_offset = id − base_id = facing*2 + half
// facing: 0=north→y=270, 1=south→y=90, 2=east→y=0, 3=west→y=180
// half:   0=bottom→x=0,  1=top→x=180
// From Minecraft blockstates/stone_brick_stairs.json
const STAIR_ROTS: [rotX: number, rotY: number][] = [
  [0,   270], // offset 0: north, bottom
  [180, 270], // offset 1: north, top
  [0,   90],  // offset 2: south, bottom
  [180, 90],  // offset 3: south, top
  [0,   0],   // offset 4: east,  bottom
  [180, 0],   // offset 5: east,  top
  [0,   180], // offset 6: west,  bottom
  [180, 180], // offset 7: west,  top
];

// ── Slab model names per BType ────────────────────────────────────────────────

const SLAB_MODELS: Partial<Record<number, string>> = {
  [BType.cut_sandstone_slab]:             "cut_sandstone_slab",
  [BType.smooth_sandstone_slab]:          "smooth_sandstone_slab",
  [BType.smooth_stone_slab]:              "smooth_stone_slab",
  [BType.smooth_red_sandstone_slab]:      "smooth_red_sandstone_slab",
  [BType.oak_slab]:                       "oak_slab",
  [BType.stone_brick_slab]:              "stone_brick_slab",
  [BType.prismarine_brick_slab]:          "prismarine_brick_slab",
  [BType.cut_sandstone_slab_top]:         "cut_sandstone_slab_top",
  [BType.smooth_sandstone_slab_top]:      "smooth_sandstone_slab_top",
  [BType.smooth_stone_slab_top]:          "smooth_stone_slab_top",
  [BType.smooth_red_sandstone_slab_top]:  "smooth_red_sandstone_slab_top",
  [BType.oak_slab_top]:                   "oak_slab_top",
  [BType.stone_brick_slab_top]:          "stone_brick_slab_top",
  [BType.prismarine_brick_slab_top]:      "prismarine_brick_slab_top",
};

// ── Trapdoor state decoder ────────────────────────────────────────────────────
// BType = trapdoor_base + type*16 + open*8 + facing*2 + half
// type:   0=oak, 1=iron, 2=mangrove, 3=spruce
// open:   0=closed (flat), 1=open (vertical)
// facing: 0=north, 1=south, 2=east, 3=west
// half:   0=bottom, 1=top

const TRAPDOOR_TYPE_NAMES = ["oak", "iron", "mangrove", "spruce"];
const TRAPDOOR_OPEN_ROTY  = [0, 180, 90, 270]; // N, S, E, W

function trapdoorVariant(id: number): { modelName: string; rotY: number } {
  const state  = id - BType.trapdoor_base;
  const type   = (state >> 4) & 3;
  const sub    = state & 0xF;
  const open   = (sub >> 3) & 1;
  const facing = (sub >> 1) & 3;
  const half   = sub & 1;
  const mat    = TRAPDOOR_TYPE_NAMES[type] ?? "oak";

  if (!open) {
    return { modelName: `${mat}_trapdoor_${half ? "top" : "bottom"}`, rotY: 0 };
  }
  return { modelName: `${mat}_trapdoor_open`, rotY: TRAPDOOR_OPEN_ROTY[facing] ?? 0 };
}

// ── Variant resolution ────────────────────────────────────────────────────────

interface Variant { modelName: string; rotX: number; rotY: number }

function getVariant(id: number): Variant | null {
  // Chest
  if (id === BType.chest) return { modelName: "chest", rotX: 0, rotY: 0 };

  // Slabs
  const slabName = SLAB_MODELS[id];
  if (slabName !== undefined) return { modelName: slabName, rotX: 0, rotY: 0 };

  // Stairs
  for (const [baseStr, modelBase] of Object.entries(STAIR_BASES)) {
    const base   = Number(baseStr);
    const offset = id - base;
    if (offset >= 0 && offset < 8) {
      const [rotX, rotY] = STAIR_ROTS[offset];
      return { modelName: modelBase as string, rotX, rotY };
    }
  }

  return null;
}

// ── Set of all BType IDs handled by this layer ────────────────────────────────
// Stairs, slabs, and trapdoors use merged geometry layers for performance.
// This layer only handles sparse blocks where individual Group.clone() is fine.

export const CUSTOM_MODEL_BTYPES = new Set<number>([BType.chest]);

// ── Prototype cache ───────────────────────────────────────────────────────────
// "loading" sentinel avoids duplicate fetch requests

const LOADING_SENTINEL = Symbol("loading");
type ProtoEntry = THREE.Group | null | typeof LOADING_SENTINEL;

const prototypes = new Map<string, ProtoEntry>();

async function ensurePrototype(modelName: string): Promise<THREE.Group | null> {
  const cur = prototypes.get(modelName);
  if (cur === LOADING_SENTINEL) return null; // in-flight
  if (cur !== undefined) return cur as THREE.Group | null;

  prototypes.set(modelName, LOADING_SENTINEL);
  const g = await loadModelGroup(modelName);
  prototypes.set(modelName, g);
  return g;
}

// ── Key helpers ───────────────────────────────────────────────────────────────

function colKey(cx: number, cz: number)          { return `${cx},${cz}`; }
function blkKey(x: number, y: number, z: number) { return `${x},${y},${z}`; }

// ── ModelLayer ────────────────────────────────────────────────────────────────

export class ModelLayer {
  /** Add this group to the Three.js scene. */
  readonly group = new THREE.Group();

  private readonly instances    = new Map<string, THREE.Group>();
  private readonly scannedCols  = new Set<string>();

  // Pending placements keyed by model name — drained when prototype finishes loading.
  private readonly pending = new Map<string, Array<{ btype: number; wx: number; wy: number; wz: number }>>();

  constructor() {
    // Eagerly start loading all needed prototypes.
    ensurePrototype("chest").then(g => {
      if (!g) return;
      const queue = this.pending.get("chest");
      if (!queue) return;
      this.pending.delete("chest");
      for (const { btype, wx, wy, wz } of queue) this._place(btype, wx, wy, wz);
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  onColumnLoaded(
    cx: number, cz: number,
    getBlock: (x: number, y: number, z: number) => BType,
  ) {
    const ck = colKey(cx, cz);
    if (this.scannedCols.has(ck)) return;
    this.scannedCols.add(ck);

    const ox = cx * S, oz = cz * S;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const id = getBlock(wx, y, wz);
          if (CUSTOM_MODEL_BTYPES.has(id)) this._place(id, wx, y, wz);
        }
      }
    }
  }

  onColumnUnloaded(cx: number, cz: number) {
    const ck = colKey(cx, cz);
    if (!this.scannedCols.has(ck)) return;
    this.scannedCols.delete(ck);

    const ox = cx * S, oz = cz * S;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) this._remove(wx, y, wz);
      }
    }
  }

  onBlockChanged(wx: number, wy: number, wz: number, newId: BType) {
    this._remove(wx, wy, wz);
    if (CUSTOM_MODEL_BTYPES.has(newId)) this._place(newId, wx, wy, wz);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _place(btype: number, wx: number, wy: number, wz: number) {
    const key = blkKey(wx, wy, wz);
    if (this.instances.has(key)) return;

    const variant = getVariant(btype);
    if (!variant) return;

    const { modelName, rotX, rotY } = variant;
    const proto = prototypes.get(modelName);

    if (proto === LOADING_SENTINEL || proto === undefined) {
      // Prototype still loading — queue for deferred placement
      if (!this.pending.has(modelName)) this.pending.set(modelName, []);
      this.pending.get(modelName)!.push({ btype, wx, wy, wz });
      return;
    }
    if (proto === null) return; // load failed — skip silently

    const inst = proto.clone(true);
    // Minecraft blockstates apply Y rotation first, then X (YXZ Euler order)
    inst.rotation.order = "YXZ";
    inst.rotation.y = D(rotY);
    inst.rotation.x = D(rotX);
    inst.position.set(wx + 0.5, wy + 0.5, wz + 0.5);
    this.group.add(inst);
    this.instances.set(key, inst);
  }

  private _remove(wx: number, wy: number, wz: number) {
    const key = blkKey(wx, wy, wz);
    const inst = this.instances.get(key);
    if (!inst) return;
    this.group.remove(inst);
    this.instances.delete(key);
  }
}
