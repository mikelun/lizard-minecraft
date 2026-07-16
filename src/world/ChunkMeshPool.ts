/**
 * Column-level mesh pool: one THREE.Mesh per 16×WORLD_HEIGHT×16 column
 * instead of one per 16³ chunk.
 *
 * With render distance 6 there are up to 13×13 = 169 columns loaded.
 * Frustum culling at column level typically leaves ~80-100 visible vs ~600
 * with per-chunk meshes (169 columns × 6 vertical slices each).
 *
 * Y-offset baking:
 *   Chunk vertices store positions in chunk-local space (Y ∈ [0, CHUNK_SIZE]).
 *   When merging slices into one column mesh we encode each slice's world-Y
 *   offset (cy × CHUNK_SIZE) into the packed vertex data, letting the mesh
 *   sit at y=0 while covering the full column height.
 *
 *   Encoding (matches chunk vertex shader):
 *     packed_data  bits [26:22]  = base_y   (0–31)
 *     packed_greedy bits  [3:2]  = ext_y    (0–3) → adds ext_y × 32 to Y
 *     world_y = base_y + ext_y × 32
 */

import * as THREE from "three";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";

const S = CHUNK_SIZE; // 16

// Bounding sphere for a full column in its local mesh space (mesh.position.y = 0):
//   X ∈ [0, S],  Y ∈ [0, WORLD_HEIGHT],  Z ∈ [0, S]
const COL_BS_CENTER = new THREE.Vector3(S / 2, WORLD_HEIGHT / 2, S / 2);
const COL_BS_RADIUS = Math.sqrt(
  (S / 2) ** 2 + (WORLD_HEIGHT / 2) ** 2 + (S / 2) ** 2,
);

interface ColumnEntry {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  /** cy → vertex data with world-Y baked in */
  slices: Map<number, { packed: Uint32Array; greedy: Uint32Array }>;
  /** true when slices changed but GPU buffers not yet rebuilt */
  dirty: boolean;
}

export class ChunkMeshPool {
  private readonly _columns = new Map<string, ColumnEntry>();
  /** slotId → { colKey, cy }  — needed by removeChunk which only knows slotId */
  private readonly _slotInfo = new Map<number, { colKey: string; cy: number }>();
  private readonly _material: THREE.ShaderMaterial;
  private readonly _scene: THREE.Scene;

  constructor(material: THREE.ShaderMaterial, scene: THREE.Scene) {
    this._material = material;
    this._scene = scene;
  }

  setChunk(
    slotId: number,
    wx: number,
    wy: number,
    wz: number,
    packed: Uint32Array,
    greedy: Uint32Array,
  ) {
    const cy     = Math.round(wy / S);
    const cx     = Math.round(wx / S);
    const cz     = Math.round(wz / S);
    const colKey = `${cx},${cz}`;

    let col = this._columns.get(colKey);
    if (!col) {
      const geometry = new THREE.BufferGeometry();
      geometry.boundingSphere = new THREE.Sphere(COL_BS_CENTER.clone(), COL_BS_RADIUS);

      const mesh = new THREE.Mesh(geometry, this._material);
      mesh.position.set(wx, 0, wz); // column anchored at ground; Y from vertex data
      mesh.frustumCulled = true;
      this._scene.add(mesh);

      col = { mesh, geometry, slices: new Map(), dirty: false };
      this._columns.set(colKey, col);
    }

    col.slices.set(cy, bakeYOffset(packed, greedy, cy));
    this._slotInfo.set(slotId, { colKey, cy });
    // Mark dirty — caller must call flushDirty() to push to GPU.
    col.dirty = true;
  }

  /**
   * Rebuild GPU buffers for at most `maxColumns` dirty columns.
   * Call once per frame from the game loop so burst worker results
   * don't spike frame time by all uploading in one render call.
   * Returns the number of columns actually rebuilt.
   */
  flushDirty(maxColumns: number): number {
    let count = 0;
    for (const col of this._columns.values()) {
      if (!col.dirty) continue;
      rebuildColumn(col);
      col.dirty = false;
      if (++count >= maxColumns) break;
    }
    return count;
  }

  removeChunk(slotId: number) {
    const info = this._slotInfo.get(slotId);
    if (!info) return;
    this._slotInfo.delete(slotId);

    const col = this._columns.get(info.colKey);
    if (!col) return;
    col.slices.delete(info.cy);

    if (col.slices.size === 0) {
      this._scene.remove(col.mesh);
      col.geometry.dispose();
      this._columns.delete(info.colKey);
    } else {
      // Unload is immediate (don't leave a stale column visible).
      rebuildColumn(col);
      col.dirty = false;
    }
  }

  clear() {
    for (const col of this._columns.values()) {
      this._scene.remove(col.mesh);
      col.geometry.dispose();
    }
    this._columns.clear();
    this._slotInfo.clear();
  }

  get chunkCount(): number {
    return this._columns.size;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Re-encode each vertex's Y so that the chunk-local Y plus the chunk's world
 * offset (cy × CHUNK_SIZE) is stored directly in packed_data / packed_greedy.
 * This lets all slices share a mesh whose position.y = 0.
 */
function bakeYOffset(
  packed: Uint32Array,
  greedy: Uint32Array,
  cy: number,
): { packed: Uint32Array; greedy: Uint32Array } {
  const newPacked = new Uint32Array(packed.length);
  const newGreedy = new Uint32Array(greedy.length);

  const yOffset = cy * S;

  for (let i = 0; i < packed.length; i++) {
    const p = packed[i];
    const g = greedy[i];

    // Reconstruct local Y from existing encoding
    const base_y  = (p >>> 22) & 31;
    const ext_y   = (g >>> 2)  & 3;
    const local_y = base_y + ext_y * 32;

    // World Y inside the column mesh
    const world_y = yOffset + local_y;
    const new_ext  = (world_y / 32) | 0;
    const new_base = world_y - new_ext * 32;

    // Write back — keep all other bits intact
    newPacked[i] = (p & ~(31 << 22)) | (new_base << 22);
    newGreedy[i] = (g & ~(3  <<  2)) | (new_ext  <<  2);
  }

  return { packed: newPacked, greedy: newGreedy };
}

/** Merge all slices of a column into one BufferGeometry upload. */
function rebuildColumn(col: ColumnEntry) {
  let total = 0;
  for (const s of col.slices.values()) total += s.packed.length;

  const mergedPacked = new Uint32Array(total);
  const mergedGreedy = new Uint32Array(total);

  // Sort by cy so the merged buffer is deterministic
  const sorted = [...col.slices.entries()].sort((a, b) => a[0] - b[0]);
  let offset = 0;
  for (const [, { packed, greedy }] of sorted) {
    mergedPacked.set(packed, offset);
    mergedGreedy.set(greedy, offset);
    offset += packed.length;
  }

  const packedAttr = new THREE.BufferAttribute(mergedPacked, 1);
  packedAttr.setUsage(THREE.DynamicDrawUsage);
  const greedyAttr = new THREE.BufferAttribute(mergedGreedy, 1);
  greedyAttr.setUsage(THREE.DynamicDrawUsage);

  col.geometry.setAttribute("packed_data",  packedAttr);
  col.geometry.setAttribute("packed_greedy", greedyAttr);
  col.geometry.setDrawRange(0, total);
}
