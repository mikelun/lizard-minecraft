// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// ModelLayer — renders custom 3D models for blocks that the cube mesher skips.
// Uses JsonModelLoader which ports the vberlier/json-model-viewer approach to
// modern Three.js BufferGeometry.

import * as THREE from "three";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";
import { loadModelGroup } from "./JsonModelLoader";

const S = CHUNK_SIZE;

/** Block types handled here instead of the cube mesher. */
export const CUSTOM_MODEL_BTYPES = new Set<number>([BType.chest]);

// ── model registry ────────────────────────────────────────────────────────────

// Map from BType → model name (filename stem under /mc/models/)
const MODEL_NAMES: Partial<Record<number, string>> = {
  [BType.chest]: "chest",
};

// Pre-loaded prototype groups, cloned for each placed instance.
const prototypes = new Map<number, THREE.Group | null>();

async function loadPrototype(btype: number): Promise<THREE.Group | null> {
  if (prototypes.has(btype)) return prototypes.get(btype)!;
  const name = MODEL_NAMES[btype];
  if (!name) { prototypes.set(btype, null); return null; }
  console.log(`[ModelLayer] loading prototype for btype=${btype} name=${name}`);
  const group = await loadModelGroup(name);
  if (group) {
    console.log(`[ModelLayer] prototype loaded ok, children=${group.children.length}`);
  } else {
    console.error(`[ModelLayer] prototype FAILED to load for btype=${btype}`);
  }
  prototypes.set(btype, group);
  return group;
}

// ── key helpers ───────────────────────────────────────────────────────────────

function colKey(cx: number, cz: number)          { return `${cx},${cz}`; }
function blkKey(x: number, y: number, z: number) { return `${x},${y},${z}`; }

// ── ModelLayer ────────────────────────────────────────────────────────────────

export class ModelLayer {
  /** Add this group to the Three.js scene. */
  readonly group = new THREE.Group();

  // block-key → placed group
  private readonly instances = new Map<string, THREE.Group>();
  // columns already scanned
  private readonly scannedCols = new Set<string>();

  // Pending placements requested before the prototype finished loading.
  private readonly pending = new Map<number, Array<{ wx: number; wy: number; wz: number }>>();

  constructor() {
    // Eagerly load all prototypes so they're ready when columns stream in.
    for (const btype of CUSTOM_MODEL_BTYPES) {
      loadPrototype(btype).then(() => {
        // Place any positions that were queued while loading.
        // Process even if proto is null — placeBlock shows the debug box either way.
        const queue = this.pending.get(btype) ?? [];
        this.pending.delete(btype);
        for (const { wx, wy, wz } of queue) {
          this.placeBlock(btype, wx, wy, wz);
        }
      });
    }
  }

  // ── public API ──────────────────────────────────────────────────────────────

  /** Call after terrain data for chunk column (cx, cz) is ready. */
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
          if (CUSTOM_MODEL_BTYPES.has(id)) {
            this.placeBlock(id, wx, y, wz);
          }
        }
      }
    }
  }

  /** Call when a column goes out of range. */
  onColumnUnloaded(cx: number, cz: number) {
    const ck = colKey(cx, cz);
    if (!this.scannedCols.has(ck)) return;
    this.scannedCols.delete(ck);

    const ox = cx * S, oz = cz * S;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          this.removeAt(wx, y, wz);
        }
      }
    }
  }

  /** Call when a block is placed or broken by the player. */
  onBlockChanged(wx: number, wy: number, wz: number, newId: BType) {
    this.removeAt(wx, wy, wz);
    if (CUSTOM_MODEL_BTYPES.has(newId)) {
      this.placeBlock(newId, wx, wy, wz);
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private placeBlock(btype: number, wx: number, wy: number, wz: number) {
    const key = blkKey(wx, wy, wz);
    if (this.instances.has(key)) return;

    const proto = prototypes.get(btype);

    if (proto === undefined) {
      // Prototype still loading — queue it
      if (!this.pending.has(btype)) this.pending.set(btype, []);
      this.pending.get(btype)!.push({ wx, wy, wz });
      console.log(`[ModelLayer] queued btype=${btype} at (${wx},${wy},${wz}), proto not ready yet`);
      return;
    }

    if (proto === null) {
      console.warn(`[ModelLayer] no model for btype=${btype}`);
      return;
    }

    const inst = proto.clone(true);
    inst.position.set(wx + 0.5, wy + 0.5, wz + 0.5);
    this.group.add(inst);
    this.instances.set(key, inst);
  }

  private removeAt(wx: number, wy: number, wz: number) {
    const key = blkKey(wx, wy, wz);
    const inst = this.instances.get(key);
    if (!inst) return;
    this.group.remove(inst);
    this.instances.delete(key);
  }
}
