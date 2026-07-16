// StairLayer — renders L-shaped stair blocks with proper Minecraft geometry.
// Each stair block encodes facing direction and half (top/bottom) in its ID:
//   id = base + facing * 2 + half
//   facing: north=0, south=1, east=2, west=3
//   half:   bottom=0, top=1
//
// Geometry (Minecraft stair model):
//   For half=bottom:
//     - Bottom slab: (0..1, 0..0.5, 0..1)
//     - Upper step depends on facing:
//         north: (0..1, 0.5..1, 0..0.5)
//         south: (0..1, 0.5..1, 0.5..1)
//         east:  (0.5..1, 0.5..1, 0..1)
//         west:  (0..0.5, 0.5..1, 0..1)
//   For half=top, flip Y (swap 0↔1 on y-axis):
//     - Top slab: (0..1, 0.5..1, 0..1)
//     - Lower step depends on facing (same X/Z but y=0..0.5)

import * as THREE from "three";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";
import { makeBlockMat } from "./blockShader";

const S = CHUNK_SIZE;

export const STAIR_ID_MIN = 50;
export const STAIR_ID_MAX = 113;

const STAIR_TYPES: Array<{ base: number; tex: string }> = [
  { base:  50, tex: '/mc/textures/block/stone_bricks.png' },
  { base:  58, tex: '/mc/textures/block/cut_sandstone.png' },
  { base:  66, tex: '/mc/textures/block/sandstone.png' },
  { base:  74, tex: '/mc/textures/block/red_sandstone_top.png' },
  { base:  82, tex: '/mc/textures/block/oak_planks.png' },
  { base:  90, tex: '/textures/blocks/prismarine_bricks.png' },
  { base:  98, tex: '/mc/textures/block/cobblestone.png' },
  { base: 106, tex: '/mc/textures/block/bricks.png' },
];

// ── Geometry helpers ──────────────────────────────────────────────────────────

function pushQuad(
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  u0: number, v0: number, u1: number, v1: number,
) {
  const i = vi.n;
  verts.push(ax, ay, az,  bx, by, bz,  cx, cy, cz,  dx, dy, dz);
  uvs.push(u0, v1,  u1, v1,  u1, v0,  u0, v0);
  idx.push(i, i+1, i+2,  i, i+2, i+3);
  vi.n += 4;
}

// Emit a box omitting specific faces to avoid internal z-fighting.
// skipBottom=true → don't emit the -Y face (avoids z-fight where step sits on slab).
// skipTop=true    → don't emit the +Y face (avoids z-fight where slab sits under step).
function emitBox(
  ox: number, oy: number, oz: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
  skipBottom = false,
  skipTop    = false,
) {
  // UVs always span [0,1] so every face shows the full texture regardless of face size.
  // Top (+Y)
  if (!skipTop) pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z0,
    0, 0, 1, 1);
  // Bottom (-Y)
  if (!skipBottom) pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z1,
    0, 0, 1, 1);
  // North (-Z)
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z0,  ox+x1, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z0,
    0, 0, 1, 1);
  // South (+Z)
  pushQuad(verts, uvs, idx, vi,
    ox+x1, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z1,  ox+x0, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z1,
    0, 0, 1, 1);
  // East (+X)
  pushQuad(verts, uvs, idx, vi,
    ox+x1, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z1,  ox+x1, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z0,
    0, 0, 1, 1);
  // West (-X)
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z0,  ox+x0, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z1,
    0, 0, 1, 1);
}

// Emit the two boxes that form a stair block given its orientation index (0-7).
// orientIdx = facing * 2 + half
//   facing: 0=north, 1=south, 2=east, 3=west
//   half:   0=bottom, 1=top
//
// We skip the top face of the bottom slab (z-fights with step's bottom face)
// and the bottom face of the upper step (same shared plane).
function emitStair(
  x: number, y: number, z: number,
  orientIdx: number,
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
) {
  const facing = Math.floor(orientIdx / 2);  // 0=north,1=south,2=east,3=west
  const isTop  = (orientIdx & 1) === 1;

  if (!isTop) {
    // half=bottom: slab at y=0..0.5 (render top — exposed half is visible), step at y=0.5..1 (skip bottom — internal face)
    emitBox(x, y, z,  0, 0, 0,  1, 0.5, 1,  verts, uvs, idx, vi, false, false);
    switch (facing) {
      case 0: emitBox(x, y, z,  0, 0.5, 0,    1, 1, 0.5,  verts, uvs, idx, vi, true); break; // north → step on north half (z=0..0.5)
      case 1: emitBox(x, y, z,  0, 0.5, 0.5,  1, 1, 1,    verts, uvs, idx, vi, true); break; // south → step on south half (z=0.5..1)
      case 2: emitBox(x, y, z,  0.5, 0.5, 0,  1, 1, 1,    verts, uvs, idx, vi, true); break; // east  → step on east half (x=0.5..1)
      case 3: emitBox(x, y, z,  0, 0.5, 0,    0.5, 1, 1,  verts, uvs, idx, vi, true); break; // west  → step on west half (x=0..0.5)
    }
  } else {
    // half=top: slab at y=0.5..1 (skip bottom — internal face), step at y=0..0.5 (render top — exposed)
    emitBox(x, y, z,  0, 0.5, 0,  1, 1, 1,  verts, uvs, idx, vi, true);
    switch (facing) {
      case 0: emitBox(x, y, z,  0, 0, 0,    1, 0.5, 0.5,  verts, uvs, idx, vi, false, false); break; // north → step on north half
      case 1: emitBox(x, y, z,  0, 0, 0.5,  1, 0.5, 1,    verts, uvs, idx, vi, false, false); break; // south → step on south half
      case 2: emitBox(x, y, z,  0.5, 0, 0,  1, 0.5, 1,    verts, uvs, idx, vi, false, false); break; // east  → step on east half
      case 3: emitBox(x, y, z,  0, 0, 0,    0.5, 0.5, 1,  verts, uvs, idx, vi, false, false); break; // west  → step on west half
    }
  }
}

// ── Material helper ───────────────────────────────────────────────────────────

// ── Main class ────────────────────────────────────────────────────────────────

interface StairPos { x: number; y: number; z: number; base: number; orientIdx: number }

export class StairLayer {
  readonly group = new THREE.Group();

  private readonly scannedCols = new Set<string>();
  private positions: StairPos[] = [];
  private rebuildPending = false;

  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly mats   = new Map<number, THREE.Material>();

  constructor() {
    for (const { base, tex } of STAIR_TYPES) {
      this.mats.set(base, makeBlockMat(tex, { doubleSide: true, polygonOffset: true }));
    }
  }

  onColumnLoaded(
    cx: number, cz: number,
    getBlock: (x: number, y: number, z: number) => number,
  ) {
    const key = `${cx},${cz}`;
    if (this.scannedCols.has(key)) return;
    this.scannedCols.add(key);

    const ox = cx * S, oz = cz * S;
    let found = false;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const id = getBlock(wx, y, wz);
          if (id >= STAIR_ID_MIN && id <= STAIR_ID_MAX) {
            // Find which stair type this belongs to
            let base = STAIR_ID_MIN;
            for (const st of STAIR_TYPES) {
              if (id >= st.base && id < st.base + 8) { base = st.base; break; }
            }
            const orientIdx = id - base;
            this.positions.push({ x: wx, y, z: wz, base, orientIdx });
            found = true;
          }
        }
      }
    }
    if (found) this.scheduleRebuild();
  }

  onColumnUnloaded(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    if (!this.scannedCols.has(key)) return;
    this.scannedCols.delete(key);

    const ox = cx * S, oz = cz * S;
    const before = this.positions.length;
    this.positions = this.positions.filter(
      p => !(p.x >= ox && p.x < ox + S && p.z >= oz && p.z < oz + S),
    );
    if (this.positions.length !== before) this.scheduleRebuild();
  }

  private scheduleRebuild() {
    if (this.rebuildPending) return;
    this.rebuildPending = true;
    setTimeout(() => { this.rebuildPending = false; this.rebuildMeshes(); }, 0);
  }

  private rebuildMeshes() {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    if (this.positions.length === 0) return;

    // Group by base (texture type)
    const byBase = new Map<number, StairPos[]>();
    for (const pos of this.positions) {
      if (!byBase.has(pos.base)) byBase.set(pos.base, []);
      byBase.get(pos.base)!.push(pos);
    }

    for (const [base, posList] of byBase) {
      const mat = this.mats.get(base);
      if (!mat) continue;

      const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
      const vi = { n: 0 };

      for (const { x, y, z, orientIdx } of posList) {
        emitStair(x, y, z, orientIdx, verts, uvs, idx, vi);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.meshes.set(base, mesh);
    }
  }
}
