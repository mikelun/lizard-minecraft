// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * AllObjectsLoader — renders all block_display objects extracted from the
 * CS:GO Dust_2 Minecraft world (public/mc/models/all_objects.json).
 *
 * Coordinate mapping:
 *   game_x = mc_x  (dx = 0)
 *   game_y = mc_y + 64  (matches mc_y_offset stored in world.bin header)
 *   game_z = mc_z  (dz = 0)
 */

import * as THREE from "three";
import { vsBlock, fsBlock, makeDirBlockMat } from "./blockShader";
import { fetchWithRetry } from "./fetchRetry";

// ── types ─────────────────────────────────────────────────────────────────────

interface DisplayTransform {
  translation: [number, number, number];
  left_rotation: [number, number, number, number];
  right_rotation: [number, number, number, number];
  scale: [number, number, number];
}
interface DisplayEntity {
  pos: [number, number, number];
  block: string;
  transform: DisplayTransform;
}
interface WorldObject {
  id: string;
  origin: [number, number, number];
  entities: DisplayEntity[];
}
interface AllObjects {
  objects: WorldObject[];
}

// ── coordinate mapping ────────────────────────────────────────────────────────
// dy matches mc_y_offset from world.bin header (mc_y + 64 = game_y).
const MC_TO_GAME = { dx: 0, dy: 64, dz: 0 };

// ── texture loading ───────────────────────────────────────────────────────────

const texCache = new Map<string, THREE.Texture>();

const _texLoader = new THREE.TextureLoader();

function loadTex(name: string): THREE.Texture {
  const url = `/mc/textures/block/${name}.png`;
  if (texCache.has(url)) return texCache.get(url)!;

  // A single failed request used to leave this texture blank forever (no retry,
  // just a console error) — retry a couple of times, updating the same cached
  // Texture instance in place so meshes already using it pick up the fix.
  let attempt = 0;
  const onError = () => {
    attempt++;
    if (attempt >= 3) { console.error(`[AllObjects] texture failed after retries: ${url}`); return; }
    setTimeout(() => {
      _texLoader.load(url, fresh => { t.image = fresh.image; t.needsUpdate = true; }, undefined, onError);
    }, 400 * attempt);
  };
  const t = _texLoader.load(url, undefined, undefined, onError);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  // NoColorSpace: Three.js 0.171 defaults TextureLoader to SRGBColorSpace which
  // decodes sRGB→linear before the shader samples it.  DataArrayTexture (terrain)
  // has NoColorSpace so its pixels are sampled raw.  Force the same here so both
  // go through the same gamma pipeline and colours match.
  t.colorSpace = THREE.NoColorSpace;
  texCache.set(url, t);
  return t;
}

// ── material cache ────────────────────────────────────────────────────────────

const singleMatCache = new Map<string, THREE.ShaderMaterial>();
const colorMatCache  = new Map<string, THREE.MeshLambertMaterial>();

// Textures that need alpha transparency (their .png has transparent pixels)
const TRANSPARENT_BLOCKS = new Set([
  "iron_bars", "glass_pane", "glass", "oak_fence", "spruce_fence",
  "iron_trapdoor", "oak_trapdoor",
  "dead_bush",
]);

function singleMat(texName: string): THREE.ShaderMaterial {
  if (singleMatCache.has(texName)) return singleMatCache.get(texName)!;
  const needsAlpha = TRANSPARENT_BLOCKS.has(texName);
  const m = new THREE.ShaderMaterial({
    vertexShader: vsBlock,
    fragmentShader: fsBlock,
    uniforms: { map: { value: loadTex(texName) } },
    transparent: needsAlpha,
    side: needsAlpha ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  singleMatCache.set(texName, m);
  return m;
}

function glassMat(texName: string): THREE.ShaderMaterial {
  const key = texName + "__glass";
  if (singleMatCache.has(key)) return singleMatCache.get(key)!;
  const m = new THREE.ShaderMaterial({
    vertexShader: vsBlock,
    fragmentShader: fsBlock,
    uniforms: { map: { value: loadTex(texName) } },
    transparent: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  singleMatCache.set(key, m);
  return m;
}

/**
 * Single ShaderMaterial for blocks with different top/side/bottom faces.
 * Uses fsDirBlock to pick the right texture from the world-space normal,
 * eliminating the old 6-material array that caused 6 draw calls per mesh.
 */
function dirMat(side: string, top: string, bottom?: string): THREE.ShaderMaterial {
  const bot = bottom ?? top;
  return makeDirBlockMat(
    `/mc/textures/block/${side}.png`,
    `/mc/textures/block/${top}.png`,
    `/mc/textures/block/${bot}.png`,
  );
}

function colorMat(hex: number): THREE.MeshLambertMaterial {
  const key = hex.toString(16);
  if (colorMatCache.has(key)) return colorMatCache.get(key)!;
  const m = new THREE.MeshLambertMaterial({
    color: hex,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  colorMatCache.set(key, m);
  return m;
}

// ── block → material resolver ─────────────────────────────────────────────────
//
// Returns either a single Material or an array of 6 (for BoxGeometry groups).
// BoxGeometry group order: [+X, -X, +Y, -Y, +Z, -Z] = [right,left,top,bottom,front,back]

function getBlockMaterial(block: string): THREE.Material {
  const key = block.startsWith("minecraft:") ? block.slice(10) : block;

  switch (key) {
    // ── concrete (all faces same) ──────────────────────────────────────────
    case "white_concrete":          return singleMat("white_concrete");
    case "light_gray_concrete":     return singleMat("light_gray_concrete");
    case "gray_concrete":           return singleMat("gray_concrete");
    case "black_concrete":          return singleMat("black_concrete");
    case "black_concrete_powder":   return singleMat("black_concrete_powder");
    case "cyan_concrete":           return singleMat("cyan_concrete");
    case "red_concrete":            return singleMat("red_concrete");
    case "red_concrete_powder":     return singleMat("red_concrete_powder");
    case "light_blue_concrete":     return singleMat("light_blue_concrete");
    case "lime_concrete_powder":    return singleMat("lime_concrete_powder");
    case "green_concrete":          return singleMat("green_concrete");
    case "orange_concrete":         return singleMat("orange_concrete");
    case "yellow_concrete":         return singleMat("yellow_concrete");

    // ── sandstone ─────────────────────────────────────────────────────────
    case "cut_sandstone":
      return dirMat("cut_sandstone", "sandstone_top", "sandstone_bottom");
    case "smooth_red_sandstone":
      return dirMat("cut_red_sandstone", "red_sandstone_top", "red_sandstone_top");

    // ── stone / brick ──────────────────────────────────────────────────────
    case "stone":                   return singleMat("stone");
    case "stone_bricks":
    case "stone_brick_slab":        return singleMat("stone_bricks");
    case "bricks":
    case "brick_stairs":            return singleMat("bricks");
    case "diorite":                 return singleMat("diorite");
    case "red_nether_bricks":       return singleMat("red_nether_bricks");
    case "cobbled_deepslate":       return singleMat("cobbled_deepslate");
    case "polished_blackstone_bricks": return singleMat("polished_blackstone_bricks");

    // ── wood ──────────────────────────────────────────────────────────────
    case "oak_log":
      return dirMat("oak_log", "oak_log_top");
    case "stripped_oak_log":
      return dirMat("stripped_oak_log", "stripped_oak_log_top");
    case "oak_planks":              return singleMat("oak_planks");
    case "spruce_planks":
    case "spruce_fence":            return singleMat("spruce_planks");
    case "mangrove_planks":         return singleMat("mangrove_planks");
    case "warped_planks":           return singleMat("warped_planks");
    case "bamboo_slab":             return singleMat("bamboo_planks");
    case "stripped_warped_stem":
      return dirMat("stripped_warped_stem", "stripped_warped_stem_top");

    // ── doors ────────────────────────────────────────────────────────────
    case "mangrove_door":
      return dirMat("mangrove_door_bottom", "mangrove_door_top");
    case "birch_door":
      return dirMat("birch_door_bottom", "birch_door_top");
    case "warped_door":
      return dirMat("warped_door_bottom", "warped_door_top");

    // ── terracotta ────────────────────────────────────────────────────────
    case "white_terracotta":        return singleMat("white_terracotta");
    case "orange_terracotta":       return singleMat("orange_terracotta");
    case "lime_terracotta":         return singleMat("lime_terracotta");
    case "red_terracotta":          return singleMat("red_terracotta");

    // ── metal / mineral ───────────────────────────────────────────────────
    case "iron_block":              return singleMat("iron_block");
    case "iron_bars":               return singleMat("iron_bars");   // cross geo, no box AO
    case "coal_block":              return singleMat("coal_block");
    case "diamond_block":           return singleMat("diamond_block");
    case "redstone_block":          return singleMat("redstone_block");

    // ── natural ───────────────────────────────────────────────────────────
    case "red_sand":                return singleMat("red_sand");
    case "dirt":                    return singleMat("dirt");
    case "glowstone":               return singleMat("glowstone");

    // ── glass / ice ───────────────────────────────────────────────────────
    case "blue_ice":                return singleMat("blue_ice");
    case "black_stained_glass":     return glassMat("black_stained_glass"); // transparent, no box AO

    // ── fabric / organic ──────────────────────────────────────────────────
    case "green_carpet":            return singleMat("green_carpet");
    case "cyan_wool":               return singleMat("cyan_wool");

    // ── plants ────────────────────────────────────────────────────────────
    case "dead_bush":               return singleMat("dead_bush");
    case "tall_seagrass":           return colorMat(0x2A7A20);
    case "potted_jungle_sapling":   return colorMat(0x2A7A20);
    case "potted_flowering_azalea_bush": return colorMat(0xD070A0);
    case "light":                   return colorMat(0xFFFFCC);

    default:
      return colorMat(0xFF00FF); // magenta = unknown
  }
}

// ── geometry ──────────────────────────────────────────────────────────────────

const boxGeo = new THREE.BoxGeometry(1, 1, 1);

// Iron bars / glass pane: two perpendicular planes (cross shape).
function buildCrossGeo(): THREE.BufferGeometry {
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
  let vi = 0;
  function quad(
    ax:number,ay:number,az:number, bx:number,by:number,bz:number,
    cx:number,cy:number,cz:number, dx:number,dy:number,dz:number,
  ) {
    pos.push(ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz);
    uvs.push(0,0, 1,0, 1,1, 0,1);
    idx.push(vi,vi+1,vi+2, vi,vi+2,vi+3);
    vi += 4;
  }
  quad(-0.5,-0.5,0,  0.5,-0.5,0,  0.5,0.5,0,  -0.5,0.5,0);
  quad(0,-0.5,-0.5,  0,-0.5,0.5,  0,0.5,0.5,  0,0.5,-0.5);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
const crossGeo = buildCrossGeo();

const CROSS_BLOCKS = new Set(["iron_bars", "glass_pane", "dead_bush"]);

// Thin/decorative blocks a player should still be able to walk through,
// matching vanilla Minecraft (plants, potted foliage, light fixtures).
const NON_SOLID_BLOCKS = new Set([
  "dead_bush", "tall_seagrass", "potted_jungle_sapling",
  "potted_flowering_azalea_bush", "light",
]);

// Collision for AllObjects entities (car, decorative props) — these live entirely
// outside the world.bin voxel grid, so World.isSolid() has no way to see them.
//
// The collision volume is each entity's real ORIENTED box (center + rotated axes +
// half-extents) — not an axis-aligned bounding box of it. An AABB necessarily
// overhangs a rotated object's true edges (that's just geometry: the AABB of a
// tilted box is always bigger than the box), so anything not perfectly axis-aligned
// was blocking more space than the model actually occupies. Physics.ts tests real
// OBB-vs-AABB overlap (SAT) against these directly, so the collidable region
// matches the rendered shape exactly, at any rotation.
//
// A spatial hash (bucket by integer cell, keyed off each OBB's loose world AABB) is
// only a broad-phase index to avoid testing all ~1000 entities every frame — it
// never affects the actual solidity decision.
export interface ObjectOBB {
  center: THREE.Vector3;
  axisX: THREE.Vector3; axisY: THREE.Vector3; axisZ: THREE.Vector3; // unit, world-space
  halfX: number; halfY: number; halfZ: number;
}

const objectOBBs = new Map<string, ObjectOBB[]>();

export function getNearbyObjectOBBs(
  minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number,
): ObjectOBB[] {
  const x0 = Math.floor(minX), x1 = Math.floor(maxX - 1e-6);
  const y0 = Math.floor(minY), y1 = Math.floor(maxY - 1e-6);
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - 1e-6);
  const seen = new Set<ObjectOBB>();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const bucket = objectOBBs.get(`${x},${y},${z}`);
        if (bucket) for (const obb of bucket) seen.add(obb);
      }
    }
  }
  return Array.from(seen);
}

const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _aabbCorner = new THREE.Vector3();
function registerSolidOBB(matrix: THREE.Matrix4) {
  matrix.decompose(_pos, _quat, _scale);
  const obb: ObjectOBB = {
    center: _pos.clone(),
    axisX: new THREE.Vector3(1, 0, 0).applyQuaternion(_quat),
    axisY: new THREE.Vector3(0, 1, 0).applyQuaternion(_quat),
    axisZ: new THREE.Vector3(0, 0, 1).applyQuaternion(_quat),
    halfX: Math.abs(_scale.x) * 0.5,
    halfY: Math.abs(_scale.y) * 0.5,
    halfZ: Math.abs(_scale.z) * 0.5,
  };

  // Loose world AABB (8-corner transform) — used only to pick which spatial-hash
  // buckets this OBB gets indexed into, not for the actual collision decision.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    _aabbCorner.set(
      (i & 1) ? 0.5 : -0.5,
      (i & 2) ? 0.5 : -0.5,
      (i & 4) ? 0.5 : -0.5,
    ).applyMatrix4(matrix);
    minX = Math.min(minX, _aabbCorner.x); maxX = Math.max(maxX, _aabbCorner.x);
    minY = Math.min(minY, _aabbCorner.y); maxY = Math.max(maxY, _aabbCorner.y);
    minZ = Math.min(minZ, _aabbCorner.z); maxZ = Math.max(maxZ, _aabbCorner.z);
  }

  const x0 = Math.floor(minX), x1 = Math.floor(maxX - 1e-6);
  const y0 = Math.floor(minY), y1 = Math.floor(maxY - 1e-6);
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - 1e-6);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const key = `${x},${y},${z}`;
        let bucket = objectOBBs.get(key);
        if (!bucket) { bucket = []; objectOBBs.set(key, bucket); }
        bucket.push(obb);
      }
    }
  }
}

function computeDisplayMatrix(transform: DisplayTransform): THREE.Matrix4 {
  const { translation, left_rotation, right_rotation, scale } = transform;
  const rrQ = new THREE.Quaternion(
    right_rotation[0], right_rotation[1], right_rotation[2], right_rotation[3]);
  const lrQ = new THREE.Quaternion(
    left_rotation[0], left_rotation[1], left_rotation[2], left_rotation[3]);
  return new THREE.Matrix4()
    .multiply(new THREE.Matrix4().makeTranslation(translation[0], translation[1], translation[2]))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(lrQ))
    .multiply(new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rrQ))
    .multiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5));
}

// ── public API ────────────────────────────────────────────────────────────────

export async function loadAllObjects(scene: THREE.Scene): Promise<THREE.InstancedMesh[]> {
  const meshes: THREE.InstancedMesh[] = [];
  let data: AllObjects;
  try {
    const res = await fetchWithRetry("/mc/models/all_objects.json");
    data = await res.json() as AllObjects;
  } catch (e) {
    console.error("[AllObjects] error:", e);
    return [];
  }

  // Accumulate per (geometry, material) batches for InstancedMesh.
  const batches = new Map<string, {
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    matrices: THREE.Matrix4[];
  }>();

  // Max game Y for object origins (mc_y + 64). Objects above this are floating
  // remnants of the removed elevated island and should be excluded.
  const MAX_OBJECT_GAME_Y = 30;

  let entityCount = 0;
  for (const obj of data.objects) {
    if (obj.entities.length === 0) continue;

    const [mx, my, mz] = obj.origin;
    if (my + 64 > MAX_OBJECT_GAME_Y) continue;
    const originMatrix = new THREE.Matrix4().makeTranslation(
      mx + MC_TO_GAME.dx,
      my + MC_TO_GAME.dy,
      mz + MC_TO_GAME.dz,
    );

    for (const entity of obj.entities) {
      if (entity.block === "air" || entity.block === "minecraft:air") continue;

      const { pos, block, transform } = entity;
      const { scale } = transform;
      if (scale[0] === 0 || scale[1] === 0 || scale[2] === 0) continue;

      const key = block.startsWith("minecraft:") ? block.slice(10) : block;
      if (key === "iron_bars" || key === "glass_pane") continue;

      const mat = getBlockMaterial(block);
      const geo = CROSS_BLOCKS.has(key) ? crossGeo : boxGeo;

      const posMatrix = new THREE.Matrix4().makeTranslation(pos[0], pos[1], pos[2]);
      const displayMatrix = computeDisplayMatrix(transform);

      const worldMatrix = new THREE.Matrix4()
        .multiplyMatrices(originMatrix, posMatrix)
        .multiply(displayMatrix);

      if (!NON_SOLID_BLOCKS.has(key)) registerSolidOBB(worldMatrix);

      const batchKey = geo.uuid + "|" + mat.uuid;
      let batch = batches.get(batchKey);
      if (!batch) {
        batch = { geo, mat, matrices: [] };
        batches.set(batchKey, batch);
      }
      batch.matrices.push(worldMatrix);
      entityCount++;
    }
  }

  // Build one InstancedMesh per unique (geometry, material) batch
  let instancedMeshCount = 0;
  for (const { geo, mat, matrices } of batches.values()) {
    const im = new THREE.InstancedMesh(geo, mat, matrices.length);
    im.matrixAutoUpdate = false;
    im.frustumCulled = false;
    for (let i = 0; i < matrices.length; i++) {
      im.setMatrixAt(i, matrices[i]);
    }
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    meshes.push(im);
    instancedMeshCount++;
  }

  console.log(`[AllObjects] ${entityCount} entities → ${instancedMeshCount} InstancedMesh`);
  return meshes;
}
