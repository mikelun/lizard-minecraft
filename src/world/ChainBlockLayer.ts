// ChainBlockLayer — renders chain blocks using the exact Minecraft chain.json geometry:
// two thin diagonal quads (zero-depth planes rotated 45° around Y axis).
// UV: element 1 uses chain.png cols 0-3/16, element 2 uses cols 3/16-6/16.
// For X-axis chains (running east-west), the Y-axis model is rotated -90° around Z.
// Axis is inferred from adjacent chain blocks (no orientation data in world.bin).

import * as THREE from "three";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";

const S = CHUNK_SIZE;

// ── Minecraft chain.json geometry (in block-local space 0..1) ─────────────────
// Y-axis chain: two diagonal quads rotated 45° around Y at centre (0.5, 0.5, 0.5)
// Element 1 vertices (NW→SE diagonal):
const E1Y_VERTS = [0.4335, 0, 0.4335, 0.5665, 0, 0.5665, 0.5665, 1, 0.5665, 0.4335, 1, 0.4335];
const E1_UVS    = [0, 0,  3/16, 0,  3/16, 1,  0, 1];
// Element 2 vertices (NE→SW diagonal):
const E2Y_VERTS = [0.5665, 0, 0.4335, 0.4335, 0, 0.5665, 0.4335, 1, 0.5665, 0.5665, 1, 0.4335];
const E2_UVS    = [3/16, 0,  6/16, 0,  6/16, 1,  3/16, 1];

// Rotate a flat array of xyz verts -90° around Z at centre (0.5, 0.5, 0.5)
// (xc, yc, zc) → (yc, -xc, zc) — turns the Y-axis chain into an X-axis chain.
function rotZ90(verts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < verts.length; i += 3) {
    const xc = verts[i]   - 0.5;
    const yc = verts[i+1] - 0.5;
    const zc = verts[i+2] - 0.5;
    out.push(yc + 0.5, -xc + 0.5, zc + 0.5);
  }
  return out;
}

// Rotate -90° around X: turns a Y-axis chain into a Z-axis chain.
// (xc, yc, zc) → (xc, zc, -yc)
function rotX90(verts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < verts.length; i += 3) {
    const xc = verts[i]   - 0.5;
    const yc = verts[i+1] - 0.5;
    const zc = verts[i+2] - 0.5;
    out.push(xc + 0.5, zc + 0.5, -yc + 0.5);
  }
  return out;
}

// Pre-computed per-axis element vertices
const E1_X_VERTS = rotZ90(E1Y_VERTS);
const E2_X_VERTS = rotZ90(E2Y_VERTS);
const E1_Z_VERTS = rotX90(E1Y_VERTS);
const E2_Z_VERTS = rotX90(E2Y_VERTS);

interface ChainPos { x: number; y: number; z: number; axis: "x" | "y" | "z" }

export class ChainBlockLayer {
  readonly group = new THREE.Group();

  private readonly scannedCols  = new Set<string>();
  private positions: ChainPos[] = [];
  // Temporary set for axis inference (populated during column load)
  private readonly chainSet = new Set<string>();
  private mesh: THREE.Mesh | null = null;
  private rebuildPending = false;
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    const tex = new THREE.TextureLoader().load("/textures/blocks/chain.png");
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.material = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
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
          if (getBlock(wx, y, wz) === BType.chain) {
            this.chainSet.add(`${wx},${y},${wz}`);
            found = true;
          }
        }
      }
    }
    if (!found) return;

    // Infer axis for each chain block from neighbours
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          if (getBlock(wx, y, wz) !== BType.chain) continue;
          const hasX = getBlock(wx - 1, y, wz) === BType.chain ||
                       getBlock(wx + 1, y, wz) === BType.chain;
          const hasZ = getBlock(wx, y, wz - 1) === BType.chain ||
                       getBlock(wx, y, wz + 1) === BType.chain;
          const axis: "x" | "y" | "z" = hasX ? "x" : hasZ ? "z" : "y";
          this.positions.push({ x: wx, y, z: wz, axis });
        }
      }
    }
    this.scheduleRebuild();
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
    setTimeout(() => { this.rebuildPending = false; this.rebuildMesh(); }, 0);
  }

  private rebuildMesh() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.positions.length === 0) return;

    const verts: number[] = [];
    const uvs:   number[] = [];
    const idx:   number[] = [];
    let vi = 0;

    for (const { x, y, z, axis } of this.positions) {
      const e1v = axis === "x" ? E1_X_VERTS : axis === "z" ? E1_Z_VERTS : E1Y_VERTS;
      const e2v = axis === "x" ? E2_X_VERTS : axis === "z" ? E2_Z_VERTS : E2Y_VERTS;

      // Element 1
      for (let i = 0; i < 12; i += 3)
        verts.push(e1v[i] + x, e1v[i+1] + y, e1v[i+2] + z);
      uvs.push(...E1_UVS);
      idx.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
      vi += 4;

      // Element 2
      for (let i = 0; i < 12; i += 3)
        verts.push(e2v[i] + x, e2v[i+1] + y, e2v[i+2] + z);
      uvs.push(...E2_UVS);
      idx.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
      vi += 4;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);

    this.mesh = new THREE.Mesh(geo, this.material);
    this.group.add(this.mesh);
  }
}
