// SlabLayer — renders half-height slab blocks (0.5 units tall, bottom-aligned)
// as batched geometry with proper Minecraft textures.
// Each slab type gets its own material+geometry batch so textures can differ.

import * as THREE from "three";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";
import { makeBlockMat } from "./blockShader";

const S = CHUNK_SIZE;

// Offset from bottom-slab BType to its top-slab BType (178 - 38 = 140)
export const TOP_SLAB_OFFSET = 140;

/** Set of all slab BType values — used by World to treat them as void. */
export const SLAB_BTYPES = new Set<number>([
  BType.cut_sandstone_slab,
  BType.smooth_sandstone_slab,
  BType.smooth_stone_slab,
  BType.smooth_red_sandstone_slab,
  BType.oak_slab,
  BType.stone_brick_slab,
  BType.prismarine_brick_slab,
  // Top-half variants
  BType.cut_sandstone_slab_top,
  BType.smooth_sandstone_slab_top,
  BType.smooth_stone_slab_top,
  BType.smooth_red_sandstone_slab_top,
  BType.oak_slab_top,
  BType.stone_brick_slab_top,
  BType.prismarine_brick_slab_top,
]);

// top / side texture paths for each slab type
const SLAB_TEXTURES: Partial<Record<number, { top: string; side: string }>> = {
  [BType.cut_sandstone_slab]: {
    top:  "/mc/textures/block/cut_sandstone.png",
    side: "/mc/textures/block/cut_sandstone.png",
  },
  [BType.smooth_sandstone_slab]: {
    top:  "/mc/textures/block/cut_sandstone.png",
    side: "/mc/textures/block/cut_sandstone.png",
  },
  [BType.smooth_stone_slab]: {
    top:  "/mc/textures/block/smooth_stone.png",
    side: "/mc/textures/block/smooth_stone_slab_side.png",
  },
  [BType.smooth_red_sandstone_slab]: {
    top:  "/mc/textures/block/red_sandstone_top.png",
    side: "/mc/textures/block/red_sandstone_top.png",
  },
  [BType.oak_slab]: {
    top:  "/mc/textures/block/oak_planks.png",
    side: "/mc/textures/block/oak_planks.png",
  },
  [BType.stone_brick_slab]: {
    top:  "/mc/textures/block/stone_bricks.png",
    side: "/mc/textures/block/stone_bricks.png",
  },
  [BType.prismarine_brick_slab]: {
    top:  "/textures/blocks/prismarine_bricks.png",
    side: "/textures/blocks/prismarine_bricks.png",
  },
  // Top-half variants share the same textures as their bottom counterparts
  [BType.cut_sandstone_slab_top]: {
    top:  "/mc/textures/block/cut_sandstone.png",
    side: "/mc/textures/block/cut_sandstone.png",
  },
  [BType.smooth_sandstone_slab_top]: {
    top:  "/mc/textures/block/cut_sandstone.png",
    side: "/mc/textures/block/cut_sandstone.png",
  },
  [BType.smooth_stone_slab_top]: {
    top:  "/mc/textures/block/smooth_stone.png",
    side: "/mc/textures/block/smooth_stone_slab_side.png",
  },
  [BType.smooth_red_sandstone_slab_top]: {
    top:  "/mc/textures/block/red_sandstone_top.png",
    side: "/mc/textures/block/red_sandstone_top.png",
  },
  [BType.oak_slab_top]: {
    top:  "/mc/textures/block/oak_planks.png",
    side: "/mc/textures/block/oak_planks.png",
  },
  [BType.stone_brick_slab_top]: {
    top:  "/mc/textures/block/stone_bricks.png",
    side: "/mc/textures/block/stone_bricks.png",
  },
  [BType.prismarine_brick_slab_top]: {
    top:  "/textures/blocks/prismarine_bricks.png",
    side: "/textures/blocks/prismarine_bricks.png",
  },
};

interface SlabPos { x: number; y: number; z: number; type: number }

// Emit faces for a 1×0.5×1 slab.
// topHalf=false → bottom slab (y..y+0.5), topHalf=true → top slab (y+0.5..y+1).
// For top slabs: renders at y+0.5..y+1 and adds a pit-cover quad at y
// (same material, polygonOffset) to hide the terrain face below that would
// otherwise show through the void space y..y+0.5.
function emitSlabFaces(
  x: number, y: number, z: number,
  topVerts: number[], topUVs: number[], topIdx: number[], topVI: number[],
  sideVerts: number[], sideUVs: number[], sideIdx: number[], sideVI: number[],
  topHalf = false,
) {
  const h = 0.5;
  const yBase = topHalf ? y + 0.5 : y;
  // Side UV: bottom half of texture for bottom slab, top half for top slab.
  // Three.js flipY: v=0=image-bottom, v=1=image-top.
  const vLo = topHalf ? 0.5 : 0.0;
  const vHi = topHalf ? 1.0 : 0.5;

  // ── Top face ──────────────────────────────────────────────────────────────
  // Vertices in CCW order when viewed from above → normal = +Y (visible from above).
  // Winding: SW→SE→NE→NW
  let ti = topVI[0];
  topVerts.push(
    x,   yBase+h, z+1,   // SW
    x+1, yBase+h, z+1,   // SE
    x+1, yBase+h, z,     // NE
    x,   yBase+h, z,     // NW
  );
  topUVs.push(0,0, 1,0, 1,1, 0,1);
  topIdx.push(ti, ti+1, ti+2, ti, ti+2, ti+3);
  topVI[0] += 4;

  // ── Bottom face ───────────────────────────────────────────────────────────
  ti = topVI[0];
  topVerts.push(
    x,   yBase, z,     // NW
    x+1, yBase, z,     // NE
    x+1, yBase, z+1,   // SE
    x,   yBase, z+1,   // SW
  );
  topUVs.push(0,1, 1,1, 1,0, 0,0);
  topIdx.push(ti, ti+1, ti+2, ti, ti+2, ti+3);
  topVI[0] += 4;

  // ── Pit-cover face for top slabs ─────────────────────────────────────────
  // Terrain treats the slab position as void so it renders the top face of
  // the block below at y.  Without this cover that face is visible as a pit
  // when looking from above.  Emit an upward-facing quad at y that sits on
  // top of the terrain face (polygonOffset factor=-1/units=-4 wins the depth
  // test, same as the slab bottom face on a bottom slab).
  if (topHalf) {
    ti = topVI[0];
    topVerts.push(
      x,   y, z+1,   // SW
      x+1, y, z+1,   // SE
      x+1, y, z,     // NE
      x,   y, z,     // NW
    );
    topUVs.push(0,0, 1,0, 1,1, 0,1);
    topIdx.push(ti, ti+1, ti+2, ti, ti+2, ti+3);
    topVI[0] += 4;
  }

  // ── Side faces ──────────────────────────────────────────────────────────
  // North (-Z)
  let si = sideVI[0];
  sideVerts.push(
    x+1, yBase,   z,
    x,   yBase,   z,
    x,   yBase+h, z,
    x+1, yBase+h, z,
  );
  sideUVs.push(0,vLo, 1,vLo, 1,vHi, 0,vHi);
  sideIdx.push(si, si+1, si+2, si, si+2, si+3);
  sideVI[0] += 4;

  // South (+Z)
  si = sideVI[0];
  sideVerts.push(
    x,   yBase,   z+1,
    x+1, yBase,   z+1,
    x+1, yBase+h, z+1,
    x,   yBase+h, z+1,
  );
  sideUVs.push(0,vLo, 1,vLo, 1,vHi, 0,vHi);
  sideIdx.push(si, si+1, si+2, si, si+2, si+3);
  sideVI[0] += 4;

  // East (+X)
  si = sideVI[0];
  sideVerts.push(
    x+1, yBase,   z+1,
    x+1, yBase,   z,
    x+1, yBase+h, z,
    x+1, yBase+h, z+1,
  );
  sideUVs.push(0,vLo, 1,vLo, 1,vHi, 0,vHi);
  sideIdx.push(si, si+1, si+2, si, si+2, si+3);
  sideVI[0] += 4;

  // West (-X)
  si = sideVI[0];
  sideVerts.push(
    x,   yBase,   z,
    x,   yBase,   z+1,
    x,   yBase+h, z+1,
    x,   yBase+h, z,
  );
  sideUVs.push(0,vLo, 1,vLo, 1,vHi, 0,vHi);
  sideIdx.push(si, si+1, si+2, si, si+2, si+3);
  sideVI[0] += 4;
}

export class SlabLayer {
  readonly group = new THREE.Group();

  private readonly scannedCols = new Set<string>();
  private positions: SlabPos[] = [];
  private rebuildPending = false;

  // Per-type meshes: top face mesh + side face mesh
  private readonly meshes = new Map<number, { top: THREE.Mesh; sides: THREE.Mesh }>();
  // Per-type materials
  private readonly mats = new Map<number, { top: THREE.Material; side: THREE.Material }>();

  constructor() {
    for (const [btype, paths] of Object.entries(SLAB_TEXTURES) as [string, { top: string; side: string }][]) {
      const id = Number(btype);
      const opts = { doubleSide: true, polygonOffset: true };
      this.mats.set(id, { top: makeBlockMat(paths.top, opts), side: makeBlockMat(paths.side, opts) });
    }
  }

  onColumnLoaded(
    cx: number, cz: number,
    getBlock: (x: number, y: number, z: number) => BType,
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
          const id = getBlock(wx, y, wz) as number;
          if (SLAB_BTYPES.has(id)) {
            this.positions.push({ x: wx, y, z: wz, type: id });
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
    // Remove old meshes
    for (const { top, sides } of this.meshes.values()) {
      this.group.remove(top);
      this.group.remove(sides);
      top.geometry.dispose();
      sides.geometry.dispose();
    }
    this.meshes.clear();

    if (this.positions.length === 0) return;

    // Group positions by type
    const byType = new Map<number, SlabPos[]>();
    for (const pos of this.positions) {
      if (!byType.has(pos.type)) byType.set(pos.type, []);
      byType.get(pos.type)!.push(pos);
    }

    for (const [type, posList] of byType) {
      const mats = this.mats.get(type);
      if (!mats) continue;

      const topVerts: number[] = [], topUVs: number[] = [], topIdx: number[] = [];
      const sideVerts: number[] = [], sideUVs: number[] = [], sideIdx: number[] = [];
      const topVI = [0], sideVI = [0];

      // Top-slab BTypes are 178–184 (= bottom BType + TOP_SLAB_OFFSET).
      // They render at y+0.5..y+1; a pit-cover quad at y hides the terrain
      // face that would otherwise show through the void space below.
      const isTopHalf = (type as number) >= 178;
      for (const { x, y, z } of posList) {
        emitSlabFaces(x, y, z, topVerts, topUVs, topIdx, topVI, sideVerts, sideUVs, sideIdx, sideVI, isTopHalf);
      }

      const topGeo = new THREE.BufferGeometry();
      topGeo.setAttribute("position", new THREE.Float32BufferAttribute(topVerts, 3));
      topGeo.setAttribute("uv", new THREE.Float32BufferAttribute(topUVs, 2));
      topGeo.setIndex(topIdx);
      topGeo.computeVertexNormals();
      const topMesh = new THREE.Mesh(topGeo, mats.top);

      const sideGeo = new THREE.BufferGeometry();
      sideGeo.setAttribute("position", new THREE.Float32BufferAttribute(sideVerts, 3));
      sideGeo.setAttribute("uv", new THREE.Float32BufferAttribute(sideUVs, 2));
      sideGeo.setIndex(sideIdx);
      sideGeo.computeVertexNormals();
      const sideMesh = new THREE.Mesh(sideGeo, mats.side);

      this.group.add(topMesh);
      this.group.add(sideMesh);
      this.meshes.set(type, { top: topMesh, sides: sideMesh });
    }
  }
}
