/**
 * CarLoader — renders the block_display "car" extracted from world 2.
 * 73 passenger-stacked entities, all at pos=[0,0,0]; actual visual placement
 * comes entirely from each entity's transform.translation + rotations + scale.
 */

import * as THREE from "three";

// ── block colours ─────────────────────────────────────────────────────────────
// Keys without "minecraft:" prefix (as stored in car.json).

const BLOCK_COLORS: Record<string, number> = {
  white_concrete:        0xF0F2F2,  // bright white car body
  white_terracotta:      0xE8D8C8,
  black_concrete:        0x101215,  // near-black tires/trim
  black_concrete_powder: 0x1A1D22,
  coal_block:            0x181818,  // wheel hubs
  blue_ice:              0x7EC8E8,  // light-blue windows
  orange_concrete:       0xFF8000,  // front headlights
  yellow_concrete:       0xFFD000,  // yellow lights
  red_terracotta:        0xC03030,  // brake lights
  red_concrete:          0xAA1010,
  gray_concrete:         0x505050,
  light_gray_concrete:   0xB0B5B5,
};

const matCache = new Map<string, THREE.MeshLambertMaterial>();
function getMat(block: string): THREE.MeshLambertMaterial {
  // Strip optional "minecraft:" prefix
  const key = block.startsWith("minecraft:") ? block.slice("minecraft:".length) : block;
  if (matCache.has(key)) return matCache.get(key)!;
  const color = BLOCK_COLORS[key] ?? 0xFF00FF; // magenta = unknown
  const m = new THREE.MeshLambertMaterial({ color });
  matCache.set(key, m);
  return m;
}

// ── types ─────────────────────────────────────────────────────────────────────

interface DisplayTransform {
  translation: [number, number, number];
  left_rotation: [number, number, number, number];
  right_rotation: [number, number, number, number];
  scale: [number, number, number];
}
interface CarEntity {
  pos: [number, number, number];
  block: string;
  transform: DisplayTransform;
}
interface CarModel {
  type: string;
  origin: [number, number, number];
  entities: CarEntity[];
}

// ── geometry builder ──────────────────────────────────────────────────────────

const boxGeo = new THREE.BoxGeometry(1, 1, 1);

function buildCarGroup(model: CarModel): THREE.Group {
  const group = new THREE.Group();

  for (const entity of model.entities) {
    const { pos, block, transform } = entity;
    const { translation, left_rotation, right_rotation, scale } = transform;

    const mesh = new THREE.Mesh(boxGeo, getMat(block));

    // Minecraft block_display transform:
    //   rendered_pos = pos + T(translation) * LR * S(scale) * RR * block_vert
    // block_vert ∈ [0,1]³; BoxGeometry is centred, so offset +0.5 first.
    const rrQ = new THREE.Quaternion(
      right_rotation[0], right_rotation[1], right_rotation[2], right_rotation[3]);
    const lrQ = new THREE.Quaternion(
      left_rotation[0],  left_rotation[1],  left_rotation[2],  left_rotation[3]);

    const displayMatrix = new THREE.Matrix4()
      .multiply(new THREE.Matrix4().makeTranslation(translation[0], translation[1], translation[2]))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(lrQ))
      .multiply(new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rrQ))
      .multiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5));

    mesh.applyMatrix4(displayMatrix);

    const eg = new THREE.Group();
    eg.position.set(pos[0], pos[1], pos[2]);
    eg.add(mesh);
    group.add(eg);
  }

  return group;
}

// ── public API ────────────────────────────────────────────────────────────────

export async function loadCar(): Promise<THREE.Group | null> {
  try {
    const res = await fetch(`/mc/models/car.json?v=${Date.now()}`);
    if (!res.ok) { console.error("[CarLoader] fetch failed:", res.status); return null; }
    const model = (await res.json()) as CarModel;
    if (model.type !== "block_display_group") {
      console.error("[CarLoader] unexpected type:", model.type); return null;
    }
    const group = buildCarGroup(model);
    console.log(`[CarLoader] car: ${model.entities.length} display entities`);
    return group;
  } catch (e) {
    console.error("[CarLoader] error:", e);
    return null;
  }
}
