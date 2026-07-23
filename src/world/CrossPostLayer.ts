// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// CrossPostLayer — renders iron_bars, glass_pane, and oak_fence with correct
// Minecraft geometry including neighbour-connection arms.
//
// iron_bars / glass_pane post: 2×16×2 px at centre (from=7, to=9 in MC units)
// oak_fence post:              4×16×4 px at centre (from=6, to=10)
//
// Connection arms (iron_bars / glass_pane):
//   Each arm is a 2×16×8 px slab extending from the centre post edge to the
//   block boundary in the connected direction — matching Minecraft's
//   iron_bars_side.json / template_glass_pane_side.json geometry.
//   A bar/pane connects to: another bar/pane of the same type, or any solid block.

import * as THREE from "three";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";
import { makeBlockMat } from "./blockShader";

const S = CHUNK_SIZE;

// ── Which BTypes this layer handles ─────────────────────────────────────────
export const CROSS_POST_BTYPES = new Set<number>([
  BType.iron_bars,
  BType.glass_pane,
  BType.oak_fence,
]);

// ── Block-type groups for connection logic ───────────────────────────────────
// iron_bars/glass_pane connect to the same type OR any solid (non-transparent) block.
// fence connects to other fences OR any solid block.
function connectsTo(fromType: BType, neighborId: number): boolean {
  if (neighborId === BType.air) return false;
  // same type always connects
  if (neighborId === fromType) return true;
  // cross-connects between bars and panes
  if (fromType === BType.iron_bars && neighborId === BType.glass_pane) return true;
  if (fromType === BType.glass_pane && neighborId === BType.iron_bars) return true;
  // connect to any solid, opaque block (not transparent posts/slabs/etc.)
  const nonSolid = CROSS_POST_BTYPES.has(neighborId)  // other post types
    || neighborId === BType.chain
    || neighborId === BType.water
    // slab types
    || (neighborId >= 38 && neighborId <= 44)
    // door types
    || neighborId === BType.oak_door
    || neighborId === BType.oak_trapdoor;
  return !nonSolid;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
// Push a quad (4 verts CCW from front) + UV + two triangles into flat arrays.
// uv0..uv3: (u,v) for each vertex.
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

// Emit all 6 faces of an axis-aligned box (DoubleSide materials skip winding).
// UV for each face samples the correct slice of the texture.
function emitBox(
  ox: number, oy: number, oz: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
) {
  // Top (+Y)  — CCW from above: SW→SE→NE→NW
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z0,
    x0, z0, x1, z1);
  // Bottom (-Y)
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z1,
    x0, z0, x1, z1);
  // North (-Z): CCW from north
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z0,  ox+x1, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z0,
    x0, y0, x1, y1);
  // South (+Z): CCW from south
  pushQuad(verts, uvs, idx, vi,
    ox+x1, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z1,  ox+x0, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z1,
    x0, y0, x1, y1);
  // East (+X): CCW from east
  pushQuad(verts, uvs, idx, vi,
    ox+x1, oy+y0, oz+z0,  ox+x1, oy+y0, oz+z1,  ox+x1, oy+y1, oz+z1,  ox+x1, oy+y1, oz+z0,
    z0, y0, z1, y1);
  // West (-X): CCW from west
  pushQuad(verts, uvs, idx, vi,
    ox+x0, oy+y0, oz+z1,  ox+x0, oy+y0, oz+z0,  ox+x0, oy+y1, oz+z0,  ox+x0, oy+y1, oz+z1,
    z0, y0, z1, y1);
}

// ── Post / arm geometry dimensions (in block 0..1 space) ────────────────────
// iron_bars / glass_pane post: 2px at 7/16..9/16
const BAR_LO = 7/16, BAR_HI = 9/16;
// oak_fence post: 4px at 6/16..10/16
const FNC_LO = 6/16, FNC_HI = 10/16;

// ── Iron bars / glass pane: flat-plane geometry matching Minecraft's model ───
//
// Minecraft renders iron_bars_side as a 2px-thick (in one axis) box whose two
// WIDE faces show the texture.  Rather than 3D boxes with wrong UV slices we
// emit two DoubleSide quads per arm direction (the two wide faces of the thin
// box), plus two quads for the narrow post-cap ends.
//
// Flat panel for an N/S arm: two faces in the XY plane at z = BAR_LO / BAR_HI
//   spanning x=0..1, y=0..1, UV = (0,0)-(1,1) left/right half of the texture
// Flat panel for an E/W arm: two faces in the ZY plane at x = BAR_LO / BAR_HI
//   spanning z=0..1, y=0..1

function emitBarPlane(
  ox: number, oy: number, oz: number,
  dir: "NS" | "EW",
  from: number, to: number,   // extent along the connection direction (0..1)
  lo: number, hi: number,     // post thickness lo/hi on the OTHER axis
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
) {
  // UV: the half of the texture matching "from..to" (0..0.5 or 0.5..1 or 0..1)
  // Single centered plane — one quad at the midpoint of lo/hi avoids the
  // "two split lines" artifact that two offset quads produce when seen from above.
  // from/to control both the vertex extent and UV sampling along the arm direction.
  const mid = (lo + hi) / 2;
  if (dir === "NS") {
    // One flat quad in XY plane at z=mid, x spanning from..to
    const i = vi.n;
    verts.push(
      ox + from, oy,   oz + mid,
      ox + to,   oy,   oz + mid,
      ox + to,   oy+1, oz + mid,
      ox + from, oy+1, oz + mid,
    );
    uvs.push(from,0, to,0, to,1, from,1);
    idx.push(i,i+1,i+2, i,i+2,i+3);
    vi.n += 4;
  } else {
    // One flat quad in ZY plane at x=mid, z spanning from..to
    const i = vi.n;
    verts.push(
      ox + mid, oy,   oz + from,
      ox + mid, oy,   oz + to,
      ox + mid, oy+1, oz + to,
      ox + mid, oy+1, oz + from,
    );
    uvs.push(from,0, to,0, to,1, from,1);
    idx.push(i,i+1,i+2, i,i+2,i+3);
    vi.n += 4;
  }
}

// ── Material setup ───────────────────────────────────────────────────────────

const BLOCK_TEX: Partial<Record<BType, { path: string; transparent: boolean }>> = {
  [BType.iron_bars]:  { path: "/mc/textures/block/iron_bars.png",       transparent: true },
  // glass_pane_top.png has a center-2px bar pattern — maps correctly to flat pane panels
  [BType.glass_pane]: { path: "/mc/textures/block/glass_pane_top.png",  transparent: true },
  [BType.oak_fence]:  { path: "/mc/textures/block/oak_planks.png",      transparent: false },
};

// ── Main class ───────────────────────────────────────────────────────────────
interface PostPos {
  x: number; y: number; z: number; type: BType;
  connN: boolean; connS: boolean; connE: boolean; connW: boolean;
}

export class CrossPostLayer {
  readonly group = new THREE.Group();

  private readonly scannedCols = new Set<string>();
  private positions: PostPos[] = [];
  private rebuildPending = false;

  private readonly meshes = new Map<BType, THREE.Mesh>();
  private readonly mats   = new Map<BType, THREE.Material>();

  // World.getBlock — stored so rebuildMeshes can re-check connections.
  private getBlock: ((x: number, y: number, z: number) => BType) | null = null;

  constructor() {
    for (const [btStr, texInfo] of Object.entries(BLOCK_TEX) as [string, { path: string; transparent: boolean }][]) {
      const bt = Number(btStr) as BType;
      this.mats.set(bt, makeBlockMat(texInfo.path, { transparent: texInfo.transparent, doubleSide: true, polygonOffset: true }));
    }
  }

  onColumnLoaded(
    cx: number, cz: number,
    getBlock: (x: number, y: number, z: number) => BType,
  ) {
    const key = `${cx},${cz}`;
    if (this.scannedCols.has(key)) return;
    this.scannedCols.add(key);
    this.getBlock = getBlock; // World.getBlock reads directly from world.bin → always fresh

    const ox = cx * S, oz = cz * S;
    let found = false;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const id = getBlock(wx, y, wz) as number;
          if (CROSS_POST_BTYPES.has(id)) {
            const type = id as BType;
            this.positions.push({
              x: wx, y, z: wz, type,
              connN: connectsTo(type, getBlock(wx,   y, wz-1) as number),
              connS: connectsTo(type, getBlock(wx,   y, wz+1) as number),
              connE: connectsTo(type, getBlock(wx+1, y, wz)   as number),
              connW: connectsTo(type, getBlock(wx-1, y, wz)   as number),
            });
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

    const byType = new Map<BType, PostPos[]>();
    for (const pos of this.positions) {
      if (!byType.has(pos.type)) byType.set(pos.type, []);
      byType.get(pos.type)!.push(pos);
    }

    for (const [type, posList] of byType) {
      const mat = this.mats.get(type);
      if (!mat) continue;

      const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
      const vi = { n: 0 };

      const isBar   = type === BType.iron_bars || type === BType.glass_pane;
      const isFence = type === BType.oak_fence;

      for (const { x, y, z, connN, connS, connE, connW } of posList) {
        if (isBar) {
          // Render bars as flat panels — one direction at a time to avoid two
          // transparent planes crossing (which causes shimmer/doubling artifacts).
          //
          // Strategy:
          //   EW connections (arm goes along X) → NS planes (quads at z=lo/hi, x=0..1)
          //   NS connections (arm goes along Z) → EW planes (quads at x=lo/hi, z=0..1)
          //   Both → NS for main face, EW only in arm zones (z=0..lo and z=hi..1)
          //   Neither → just post: NS planes spanning only x=BAR_LO..BAR_HI
          const hasNS = connN || connS;
          const hasEW = connE || connW;

          if (hasEW && !hasNS) {
            // Bars run E-W → flat NS panel visible from N/S
            emitBarPlane(x, y, z, "NS", 0, 1, BAR_LO, BAR_HI, verts, uvs, idx, vi);
          } else if (hasNS && !hasEW) {
            // Bars run N-S → flat EW panel visible from E/W
            emitBarPlane(x, y, z, "EW", 0, 1, BAR_LO, BAR_HI, verts, uvs, idx, vi);
          } else if (hasNS && hasEW) {
            // T or + shape: NS panel for center + full EW arms outside center column
            emitBarPlane(x, y, z, "NS", 0, 1, BAR_LO, BAR_HI, verts, uvs, idx, vi);
            emitBarPlane(x, y, z, "EW", 0, BAR_LO, BAR_LO, BAR_HI, verts, uvs, idx, vi);
            emitBarPlane(x, y, z, "EW", BAR_HI, 1, BAR_LO, BAR_HI, verts, uvs, idx, vi);
          } else {
            // Isolated post: narrow NS panel (center strip only)
            emitBarPlane(x, y, z, "NS", BAR_LO, BAR_HI, BAR_LO, BAR_HI, verts, uvs, idx, vi);
          }
        } else if (isFence) {
          // Centre post only (fence rails would require separate logic per height)
          emitBox(x, y, z, FNC_LO, 0, FNC_LO, FNC_HI, 1, FNC_HI, verts, uvs, idx, vi);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.meshes.set(type, mesh);
    }
  }
}
