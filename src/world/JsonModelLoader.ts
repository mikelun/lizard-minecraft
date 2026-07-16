/**
 * JsonModelLoader — builds Three.js meshes from pre-resolved Minecraft block
 * model JSON files (output of scripts/extract_mc_models.py).
 *
 * Logic ported from vberlier/json-model-viewer (MIT licence), adapted for
 * modern Three.js BufferGeometry API.
 *
 * Model JSON format (produced by the Python extractor):
 *   {
 *     elements: [ { from, to, faces, rotation? } ],
 *     textures: { key: "/mc/textures/..." }
 *   }
 */

import * as THREE from "three";

// ── types ─────────────────────────────────────────────────────────────────────

interface McFace {
  uv?: [number, number, number, number];
  texture: string;   // "#key" or resolved path
  rotation?: 0 | 90 | 180 | 270;
  cullface?: string;
  tintindex?: number;
}

interface McElementRotation {
  origin: [number, number, number];
  axis: "x" | "y" | "z";
  angle: number;
  rescale?: boolean;
}

interface McElement {
  from: [number, number, number];
  to:   [number, number, number];
  faces: Partial<Record<"east"|"west"|"up"|"down"|"south"|"north", McFace>>;
  rotation?: McElementRotation;
}

export interface ResolvedModel {
  elements: McElement[];
  textures: Record<string, string>; // key → absolute URL like "/mc/textures/..."
  texture_size?: [number, number];  // e.g. [64,64] — UV divisor becomes texture_size[0]/16
}

// ── texture / material cache ──────────────────────────────────────────────────

const texCache = new Map<string, THREE.Texture>();
const matCache = new Map<string, THREE.MeshLambertMaterial>();

function loadTexture(url: string): THREE.Texture {
  if (texCache.has(url)) return texCache.get(url)!;
  const t = new THREE.TextureLoader().load(
    url,
    () => console.log(`[JsonModelLoader] texture loaded ok: ${url}`),
    undefined,
    (err) => console.error(`[JsonModelLoader] texture FAILED: ${url}`, err),
  );
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(url, t);
  return t;
}

function getMaterial(url: string): THREE.MeshLambertMaterial {
  if (matCache.has(url)) return matCache.get(url)!;
  const m = new THREE.MeshLambertMaterial({
    map: loadTexture(url),
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  matCache.set(url, m);
  return m;
}

const TRANSPARENT_MAT = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  side: THREE.DoubleSide,
});

// ── face geometry helpers ─────────────────────────────────────────────────────
// Coordinates are in Minecraft block-model space (0-16).
// We subtract 8 to centre the model at the origin (matching json-model-viewer).
//
// Vertex order per face: [TL, BL, BR, TR] when viewed from outside.
// UV map: map[0]=TL, map[1]=BL, map[2]=BR, map[3]=TR  → triangles (0,1,2),(0,2,3)
// Normals are computed per-face (flat shading via computeVertexNormals).

type FaceName = "east"|"west"|"up"|"down"|"south"|"north";

function faceVerts(
  face: FaceName,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
): [number, number, number][] {
  switch (face) {
    case "east":  return [[x2,y2,z2],[x2,y1,z2],[x2,y1,z1],[x2,y2,z1]];
    case "west":  return [[x1,y2,z1],[x1,y1,z1],[x1,y1,z2],[x1,y2,z2]];
    case "up":    return [[x1,y2,z1],[x1,y2,z2],[x2,y2,z2],[x2,y2,z1]];
    case "down":  return [[x1,y1,z1],[x1,y1,z2],[x2,y1,z2],[x2,y1,z1]];
    case "south": return [[x1,y2,z2],[x1,y1,z2],[x2,y1,z2],[x2,y2,z2]];
    case "north": return [[x2,y2,z1],[x2,y1,z1],[x1,y1,z1],[x1,y2,z1]];
  }
}

/** Default UV when not specified — fills the face from its element extent. */
function defaultUV(
  face: FaceName,
  from: [number,number,number], to: [number,number,number],
): [number,number,number,number] {
  const [x1,y1,z1] = from;
  const [x2,y2,z2] = to;
  switch (face) {
    case "east":  return [z1, 16-y2, z2, 16-y1];
    case "west":  return [16-z2, 16-y2, 16-z1, 16-y1];
    case "up":    return [x1, z1, x2, z2];
    case "down":  return [x1, 16-z2, x2, 16-z1];
    case "south": return [16-x2, 16-y2, 16-x1, 16-y1];
    case "north": return [x1, 16-y2, x2, 16-y1];
  }
}

const FACE_NAMES: FaceName[] = ["east","west","up","down","south","north"];

// ── element → mesh ────────────────────────────────────────────────────────────

function resolveTexRef(ref: string, textures: Record<string,string>): string | null {
  let key = ref.startsWith("#") ? ref.slice(1) : ref;
  const seen = new Set<string>();
  while (textures[key]?.startsWith("#")) {
    const next = textures[key].slice(1);
    if (seen.has(next)) break;
    seen.add(next);
    key = next;
  }
  return textures[key] ?? null;
}

function buildElementMesh(
  el: McElement,
  textures: Record<string, string>,
  uvScale = 16,   // divide UV coords by this; 16 for standard 16×16, 64 for texture_size:[64,64]
): THREE.Object3D {
  // Centre coordinates (0-16 → -8..+8, then /16 for Three.js block space 0-1).
  const s = 1 / 16;
  const x1 = (el.from[0] - 8) * s;
  const y1 = (el.from[1] - 8) * s;
  const z1 = (el.from[2] - 8) * s;
  const x2 = (el.to[0]   - 8) * s;
  const y2 = (el.to[1]   - 8) * s;
  const z2 = (el.to[2]   - 8) * s;

  // Collect unique materials
  const materials: THREE.Material[] = [];
  const matIndex = new Map<string, number>();

  const getMatIdx = (url: string | null): number => {
    if (!url) {
      // transparent placeholder
      const k = "__transparent__";
      if (!matIndex.has(k)) { matIndex.set(k, materials.length); materials.push(TRANSPARENT_MAT); }
      return matIndex.get(k)!;
    }
    if (!matIndex.has(url)) { matIndex.set(url, materials.length); materials.push(getMaterial(url)); }
    return matIndex.get(url)!;
  };

  const positions: number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];
  const groups: { start: number; count: number; matIdx: number }[] = [];

  for (const faceName of FACE_NAMES) {
    const faceSpec = el.faces[faceName];

    // Always emit a face slot so indices stay contiguous, but use transparent mat
    // for absent faces (mirrors json-model-viewer behaviour).
    const verts = faceVerts(faceName, x1, y1, z1, x2, y2, z2);
    const base  = positions.length / 3;

    for (const [vx,vy,vz] of verts) positions.push(vx, vy, vz);

    // UV
    let uvMap: [number,number][];
    if (faceSpec) {
      const [u1,v1,u2,v2] = faceSpec.uv ?? defaultUV(faceName, el.from, el.to);
      const EPS = 0.0005;
      const nu1 = (u1 + EPS) / uvScale,  nv1 = (v1 + EPS) / uvScale;
      const nu2 = (u2 - EPS) / uvScale,  nv2 = (v2 - EPS) / uvScale;
      uvMap = [
        [nu1, 1 - nv1],  // TL → map[0]
        [nu1, 1 - nv2],  // BL → map[1]
        [nu2, 1 - nv2],  // BR → map[2]
        [nu2, 1 - nv1],  // TR → map[3]
      ];
      // UV face rotation (shift map left N times, N = rotation/90)
      const rot = (faceSpec.rotation ?? 0) / 90;
      for (let r = 0; r < rot; r++) {
        uvMap = [uvMap[1], uvMap[2], uvMap[3], uvMap[0]];
      }
    } else {
      uvMap = [[0,0],[0,1],[1,1],[1,0]];
    }

    for (const [u,v] of uvMap) uvs.push(u, v);

    // Two triangles: (0,1,2) and (0,2,3)
    indices.push(base, base+1, base+2,  base, base+2, base+3);

    const url = faceSpec ? resolveTexRef(faceSpec.texture, textures) : null;
    const idx = getMatIdx(url);
    groups.push({ start: (indices.length - 6), count: 6, matIdx: idx });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  for (const g of groups) geo.addGroup(g.start, g.count, g.matIdx);

  // Geometry vertices already encode absolute positions in [-0.5, +0.5] space.
  // Mesh stays at origin; positioning is done by ModelLayer per-instance.
  const mesh = new THREE.Mesh(geo, materials);

  // Element rotation
  if (el.rotation) {
    const rot = el.rotation;
    const ox = (rot.origin[0] - 8) / 16;
    const oy = (rot.origin[1] - 8) / 16;
    const oz = (rot.origin[2] - 8) / 16;
    const angleRad = rot.angle * Math.PI / 180;

    const pivot = new THREE.Group();
    pivot.position.set(ox, oy, oz);
    pivot.add(mesh);
    mesh.position.set(-ox, -oy, -oz); // mesh relative to pivot

    if (rot.axis === "x") pivot.rotateX(angleRad);
    else if (rot.axis === "y") pivot.rotateY(angleRad);
    else                       pivot.rotateZ(angleRad);

    return pivot;
  }

  return mesh;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Build a Three.js Group from a pre-resolved model JSON.
 * The group is centred at (0,0,0); add it at the block corner
 * then offset by +0.5 on each axis to centre within the block,
 * OR (as done in ModelLayer) shift +0.5 by positioning the group
 * at blockPos and the geometry already being centred at 0.
 *
 * Actually: geometry is in [-0.5, +0.5] centred at origin.
 * Position the returned group at (blockX + 0.5, blockY + 0.5, blockZ + 0.5).
 */
export function buildModelGroup(model: ResolvedModel): THREE.Group {
  const uvScale = model.texture_size ? model.texture_size[0] : 16;
  const group = new THREE.Group();
  for (const el of model.elements) {
    group.add(buildElementMesh(el, model.textures, uvScale));
  }
  return group;
}

/** Fetch a model JSON and build a group. Returns null if the fetch fails. */
export async function loadModelGroup(name: string): Promise<THREE.Group | null> {
  try {
    const url = `/mc/models/${name}.json?v=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[JsonModelLoader] fetch failed: ${url} → ${res.status}`);
      return null;
    }
    const json = (await res.json()) as ResolvedModel;
    const group = buildModelGroup(json);
    console.log(`[JsonModelLoader] built ${name}: ${group.children.length} elements`);
    return group;
  } catch (e) {
    console.error(`[JsonModelLoader] error building ${name}:`, e);
    return null;
  }
}
