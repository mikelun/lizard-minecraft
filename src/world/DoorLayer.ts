// DoorLayer — renders oak doors and trapdoors with correct Minecraft geometry.
//
// Oak door (closed):
//   3/16-thick panel placed at the correct edge of the block based on facing.
//   Facing is encoded in the BType: door_base + facing  (N=0, S=1, E=2, W=3)
//   Both the lower and upper door halves carry the same facing ID.
//   Upper/lower is inferred by checking whether the block below is also a door.
//   Textures: oak_door_bottom.png (lower half), oak_door_top.png (upper half).
//   Legacy BType.oak_door (48) is rendered as south-facing.
//
// Trapdoors: BType = trapdoor_base + type*16 + open*8 + facing*2 + half

import * as THREE from "three";
import { makeBlockMat } from "./blockShader";
import { BType } from "./types";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../config";

const S = CHUNK_SIZE;

const TRAP_BASE      = BType.trapdoor_base; // 114
const DOOR_BASE      = BType.door_base;     // 185
const DOOR_TYPE_MAX  = 12;                  // 12 door types
const DOOR_ID_MAX    = DOOR_BASE + DOOR_TYPE_MAX * 4 - 1; // 232
const TRAP_D         = 3 / 16;
const DOOR_D         = 3 / 16;

/** Texture paths for each trapdoor type (index = type 0-3). */
const TRAP_TEX = [
  '/mc/textures/block/oak_trapdoor.png',
  '/mc/textures/block/iron_trapdoor.png',
  '/mc/textures/block/mangrove_trapdoor.png',
  '/mc/textures/block/spruce_trapdoor.png',
];

/**
 * Bottom / top texture paths for each door type (index matches DOOR_TYPE_IDX in converter).
 * 0=oak 1=warped 2=iron 3=mangrove 4=spruce 5=birch 6=dark_oak 7=jungle 8=acacia 9=bamboo 10=cherry 11=copper
 */
const DOOR_TEX: [string, string][] = [
  ['/mc/textures/block/oak_door_bottom.png',      '/mc/textures/block/oak_door_top.png'],
  ['/mc/textures/block/warped_door_bottom.png',   '/mc/textures/block/warped_door_top.png'],
  ['/mc/textures/block/iron_door_bottom.png',     '/mc/textures/block/iron_door_top.png'],
  ['/mc/textures/block/mangrove_door_bottom.png', '/mc/textures/block/mangrove_door_top.png'],
  ['/mc/textures/block/spruce_door_bottom.png',   '/mc/textures/block/spruce_door_top.png'],
  ['/mc/textures/block/birch_door_bottom.png',    '/mc/textures/block/birch_door_top.png'],
  ['/mc/textures/block/dark_oak_door_bottom.png', '/mc/textures/block/dark_oak_door_top.png'],
  ['/mc/textures/block/jungle_door_bottom.png',   '/mc/textures/block/jungle_door_top.png'],
  ['/mc/textures/block/acacia_door_bottom.png',   '/mc/textures/block/acacia_door_top.png'],
  ['/mc/textures/block/bamboo_door_bottom.png',   '/mc/textures/block/bamboo_door_top.png'],
  ['/mc/textures/block/cherry_door_bottom.png',   '/mc/textures/block/cherry_door_top.png'],
  ['/mc/textures/block/copper_door_bottom.png',   '/mc/textures/block/copper_door_top.png'],
];

/** True for any door BType (legacy 48, or encoded 185–232). */
function isDoorBType(id: number): boolean {
  return id === BType.oak_door || (id >= DOOR_BASE && id <= DOOR_ID_MAX);
}

/** Decode encoded door ID → { type, facing }. Legacy 48 → oak south. */
function decodeDoor(id: number): { type: number; facing: number } {
  if (id === BType.oak_door) return { type: 0, facing: 1 };
  const n = id - DOOR_BASE;
  return { type: Math.floor(n / 4), facing: n % 4 };
}

/** True for any trapdoor BType. */
export function isTrapdoorBType(id: number): boolean {
  return id === BType.oak_trapdoor || (id >= 114 && id <= 177);
}

export const DOOR_BTYPES = new Set<number>([
  BType.oak_door,
  BType.oak_trapdoor,
  // Encoded door range 185-188 and trapdoor range checked via isDoorBType/isTrapdoorBType
]);

interface DoorPos { x: number; y: number; z: number; id: number }

function loadTex(path: string): THREE.Texture {
  const t = new THREE.TextureLoader().load(path);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}

// ── geometry helpers ──────────────────────────────────────────────────────────

/** Emit one quad. Vertices in CCW order from front. UV anchored bottom-left. */
function pushQuad(
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
  bx: number, by: number, bz: number,
  p0x: number, p0y: number, p0z: number,
  p1x: number, p1y: number, p1z: number,
  p2x: number, p2y: number, p2z: number,
  p3x: number, p3y: number, p3z: number,
  u0: number, v0: number, u1: number, v1: number,
) {
  const i = vi.n;
  verts.push(
    bx+p0x, by+p0y, bz+p0z,
    bx+p1x, by+p1y, bz+p1z,
    bx+p2x, by+p2y, bz+p2z,
    bx+p3x, by+p3y, bz+p3z,
  );
  uvs.push(u0,v1, u1,v1, u1,v0, u0,v0);
  idx.push(i,i+1,i+2, i,i+2,i+3);
  vi.n += 4;
}

/**
 * Emit a closed door panel at the correct edge of block (bx,by,bz) for the
 * given facing. Emits all 6 faces with correct Minecraft-matching UVs:
 *   - Main door faces (front/back): full texture [0,0,1,1]
 *   - Thin edge faces (top/bottom/sides): 3px strip [0,0,D,1] or [0,0,1,D]
 * Material must be DoubleSide (set in constructor).
 */
function emitDoor(
  bx: number, by: number, bz: number,
  facing: number, // 0=north, 1=south, 2=east, 3=west
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
) {
  const D = DOOR_D;
  const q = pushQuad.bind(null, verts, uvs, idx, vi, bx, by, bz);

  if (facing === 0 || facing === 1) {
    // Panel runs east-west; thickness in Z
    const z0 = facing === 0 ? 0 : 1 - D;
    const z1 = facing === 0 ? D : 1;
    // Front face: -Z for north, +Z for south (both use full texture)
    if (facing === 0)
      q(1,0,z0, 0,0,z0, 0,1,z0, 1,1,z0, 0,0,1,1); // -Z front
    else
      q(0,0,z1, 1,0,z1, 1,1,z1, 0,1,z1, 0,0,1,1); // +Z front
    // Back face
    if (facing === 0)
      q(0,0,z1, 1,0,z1, 1,1,z1, 0,1,z1, 0,0,1,1); // +Z back
    else
      q(1,0,z0, 0,0,z0, 0,1,z0, 1,1,z0, 0,0,1,1); // -Z back
    // Top edge
    q(0,1,z0, 1,1,z0, 1,1,z1, 0,1,z1, 0,0,1,D);
    // Bottom edge
    q(0,0,z1, 1,0,z1, 1,0,z0, 0,0,z0, 0,0,1,D);
    // West edge
    q(0,0,z0, 0,0,z1, 0,1,z1, 0,1,z0, 0,0,D,1);
    // East edge
    q(1,0,z1, 1,0,z0, 1,1,z0, 1,1,z1, 0,0,D,1);
  } else {
    // Panel runs north-south; thickness in X
    const x0 = facing === 3 ? 0 : 1 - D;
    const x1 = facing === 3 ? D : 1;
    // Front face: -X for west, +X for east
    if (facing === 3)
      q(x0,0,1, x0,0,0, x0,1,0, x0,1,1, 0,0,1,1); // -X front
    else
      q(x1,0,0, x1,0,1, x1,1,1, x1,1,0, 0,0,1,1); // +X front
    // Back face
    if (facing === 3)
      q(x1,0,0, x1,0,1, x1,1,1, x1,1,0, 0,0,1,1); // +X back
    else
      q(x0,0,1, x0,0,0, x0,1,0, x0,1,1, 0,0,1,1); // -X back
    // Top edge
    q(x0,1,0, x1,1,0, x1,1,1, x0,1,1, 0,0,D,1);
    // Bottom edge
    q(x0,0,1, x1,0,1, x1,0,0, x0,0,0, 0,0,D,1);
    // North edge (-Z)
    q(x1,0,0, x0,0,0, x0,1,0, x1,1,0, 0,0,1,D);
    // South edge (+Z)
    q(x0,0,1, x1,0,1, x1,1,1, x0,1,1, 0,0,1,D);
  }
}

// ── Trapdoor helpers (unchanged) ──────────────────────────────────────────────

/** Decode a trapdoor BType into its components. */
function decodeTrap(id: number): { type: number; open: number; facing: number; half: number } {
  if (id === BType.oak_trapdoor) {
    return { type: 0, open: 0, facing: 0, half: 0 };
  }
  const n = id - TRAP_BASE;
  return {
    type:   (n >> 4) & 3,
    open:   (n >> 3) & 1,
    facing: (n >> 1) & 3,
    half:   n & 1,
  };
}

function emitBox(
  x: number, y: number, z: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  uvTop: [number,number,number,number],
  uvSide: [number,number,number,number],
  verts: number[], uvs: number[], idx: number[], vi: { n: number },
) {
  function quad(
    ax: number,ay: number,az: number,
    bx: number,by: number,bz: number,
    cx: number,cy: number,cz: number,
    dx: number,dy: number,dz: number,
    u0: number,v0: number,u1: number,v1: number,
  ) {
    const i = vi.n;
    verts.push(x+ax,y+ay,z+az, x+bx,y+by,z+bz, x+cx,y+cy,z+cz, x+dx,y+dy,z+dz);
    uvs.push(u0,v1, u1,v1, u1,v0, u0,v0);
    idx.push(i,i+1,i+2, i,i+2,i+3);
    vi.n += 4;
  }
  const [tu0,tv0,tu1,tv1] = uvTop;
  const [su0,sv0,su1,sv1] = uvSide;
  quad(x0,y1,z0, x1,y1,z0, x1,y1,z1, x0,y1,z1,  tu0,tv0, tu1,tv1);
  quad(x0,y0,z1, x1,y0,z1, x1,y0,z0, x0,y0,z0,  tu0,tv0, tu1,tv1);
  quad(x1,y0,z0, x0,y0,z0, x0,y1,z0, x1,y1,z0,  su0,sv0, su1,sv1);
  quad(x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1,  su0,sv0, su1,sv1);
  quad(x1,y0,z1, x1,y0,z0, x1,y1,z0, x1,y1,z1,  su0,sv0, su1,sv1);
  quad(x0,y0,z0, x0,y0,z1, x0,y1,z1, x0,y1,z0,  su0,sv0, su1,sv1);
}

// ── DoorLayer class ───────────────────────────────────────────────────────────

export class DoorLayer {
  readonly group = new THREE.Group();

  private readonly scannedCols = new Set<string>();
  private positions: DoorPos[] = [];
  private rebuildPending = false;

  // Active meshes — keyed by "type,half" (e.g. "1,0" = warped bottom)
  private doorMeshes = new Map<string, THREE.Mesh>();
  private trapdoorMeshes: (THREE.Mesh | null)[] = [null, null, null, null];

  // Per-type materials: index = door type (0-11), [0]=bottom [1]=top
  private readonly doorMats: [THREE.Material, THREE.Material][];
  private readonly trapdoorMats: THREE.Material[];

  private getBlock: ((x: number, y: number, z: number) => BType) | null = null;

  constructor() {
    const doorOpts = { transparent: true, doubleSide: true, polygonOffset: true };
    this.doorMats = DOOR_TEX.map(([bot, top]) => [
      makeBlockMat(bot, doorOpts),
      makeBlockMat(top, doorOpts),
    ]);
    this.trapdoorMats = TRAP_TEX.map(path => makeBlockMat(path, doorOpts));
  }

  onColumnLoaded(
    cx: number, cz: number,
    getBlock: (x: number, y: number, z: number) => BType,
  ) {
    const key = `${cx},${cz}`;
    if (this.scannedCols.has(key)) return;
    this.scannedCols.add(key);
    this.getBlock = getBlock;

    const ox = cx * S, oz = cz * S;
    let found = false;
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const id = getBlock(wx, y, wz) as number;
          if (isDoorBType(id) || isTrapdoorBType(id)) {
            this.positions.push({ x: wx, y, z: wz, id });
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
    setTimeout(() => { this.rebuildPending = false; this.rebuild(); }, 0);
  }

  private rebuild() {
    for (const m of this.doorMeshes.values()) { this.group.remove(m); m.geometry.dispose(); }
    this.doorMeshes.clear();
    for (const m of this.trapdoorMeshes) { if (m) { this.group.remove(m); m.geometry.dispose(); } }
    this.trapdoorMeshes = [null, null, null, null];

    // Group door positions by (type, half): key = "type,half"
    const doorGroups = new Map<string, DoorPos[]>();
    const trapdoorPosns: DoorPos[][] = [[], [], [], []];

    for (const p of this.positions) {
      if (isDoorBType(p.id)) {
        const { type } = decodeDoor(p.id);
        const belowId = this.getBlock ? (this.getBlock(p.x, p.y - 1, p.z) as number) : 0;
        const half = isDoorBType(belowId) ? 1 : 0; // 0=bottom, 1=top
        const key = `${type},${half}`;
        if (!doorGroups.has(key)) doorGroups.set(key, []);
        doorGroups.get(key)!.push(p);
      } else if (isTrapdoorBType(p.id)) {
        const { type } = decodeTrap(p.id);
        trapdoorPosns[type].push(p);
      }
    }

    for (const [key, posns] of doorGroups) {
      const [typeStr, halfStr] = key.split(',');
      const type = Number(typeStr);
      const half = Number(halfStr); // 0=bottom tex, 1=top tex
      const mat = this.doorMats[Math.min(type, this.doorMats.length - 1)][half];
      const mesh = this.buildDoors(posns, mat);
      if (mesh) this.doorMeshes.set(key, mesh);
    }
    for (let t = 0; t < 4; t++) {
      this.trapdoorMeshes[t] = this.buildTrapdoors(trapdoorPosns[t], this.trapdoorMats[t]);
    }
  }

  private buildDoors(posns: DoorPos[], mat: THREE.Material): THREE.Mesh | null {
    if (posns.length === 0) return null;
    const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
    const vi = { n: 0 };

    for (const { x, y, z, id } of posns) {
      const { facing } = decodeDoor(id);
      emitDoor(x, y, z, facing, verts, uvs, idx, vi);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    this.group.add(mesh);
    return mesh;
  }

  private buildTrapdoors(posns: DoorPos[], mat: THREE.Material): THREE.Mesh | null {
    if (posns.length === 0) return null;
    const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
    const vi = { n: 0 };

    for (const { x, y, z, id } of posns) {
      const { open, facing, half } = decodeTrap(id);

      if (open === 0) {
        const y0 = half === 1 ? 1 - TRAP_D : 0;
        const y1 = half === 1 ? 1          : TRAP_D;
        emitBox(x, y, z,
          0, y0, 0,  1, y1, 1,
          [0, 0, 1, 1],
          [0, 1-TRAP_D, 1, 1],
          verts, uvs, idx, vi);
      } else {
        switch (facing) {
          case 0:
            emitBox(x, y, z, 0, 0, 0, 1, 1, TRAP_D,
              [0, 0, 1, 1], [0, 0, 1, 1], verts, uvs, idx, vi); break;
          case 1:
            emitBox(x, y, z, 0, 0, 1-TRAP_D, 1, 1, 1,
              [0, 0, 1, 1], [0, 0, 1, 1], verts, uvs, idx, vi); break;
          case 2:
            emitBox(x, y, z, 1-TRAP_D, 0, 0, 1, 1, 1,
              [0, 0, 1, 1], [0, 0, 1, 1], verts, uvs, idx, vi); break;
          case 3:
            emitBox(x, y, z, 0, 0, 0, TRAP_D, 1, 1,
              [0, 0, 1, 1], [0, 0, 1, 1], verts, uvs, idx, vi); break;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    this.group.add(mesh);
    return mesh;
  }
}
