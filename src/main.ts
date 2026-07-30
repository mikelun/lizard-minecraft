// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// NEW bootstrap: scene/renderer setup, game loop, target-block outline, HUD wiring.

import * as THREE from "three";
import { World } from "./world/World";
import { ModelLayer } from "./world/ModelLayer";
import { PlayerController } from "./player/Controller";
import { createHud } from "./ui/hud";
import { buildBlockTextureAtlas } from "./textures/blockTextures";
import { loadAllObjects } from "./world/AllObjectsLoader";
import { loadMarketingBanners } from "./world/MarketingBanners";
import { ChainBlockLayer } from "./world/ChainBlockLayer";
import { SlabLayer } from "./world/SlabLayer";
import { CrossPostLayer } from "./world/CrossPostLayer";
import { DoorLayer } from "./world/DoorLayer";
import { StairLayer } from "./world/StairLayer";
import { raycastWithNormal } from "./world/raycast";
import { spawnBulletHole } from "./world/BulletHoles";
import { setupMobileControls, type MobileControls } from "./ui/mobileHud";
import { buildGeoModel, GeckoAnimator } from "./world/GeckoLibGun";
import { SteveCharacter } from "./world/SteveCharacter";
import { GameClient } from "./net/GameClient";
import { RemotePlayers } from "./net/RemotePlayers";

const app = document.getElementById("app")!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.info.autoReset = false; // we reset manually so info accumulates across both render passes
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0x8fc7ff);
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor.getHex(), 60, 220);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(80, 120, 40);
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
fillLight.position.set(0, 60, -80);
scene.add(fillLight);

const atlas = await buildBlockTextureAtlas();
const world = new World(atlas, scene);

const modelLayer = new ModelLayer();
world.modelLayer = modelLayer;
scene.add(modelLayer.group);

const chainLayer = new ChainBlockLayer();
world.chainLayer = chainLayer;
scene.add(chainLayer.group);

const slabLayer = new SlabLayer();
world.slabLayer = slabLayer;
scene.add(slabLayer.group);

const crossPostLayer = new CrossPostLayer();
world.crossPostLayer = crossPostLayer;
scene.add(crossPostLayer.group);

const doorLayer = new DoorLayer();
world.doorLayer = doorLayer;
scene.add(doorLayer.group);

const stairLayer = new StairLayer();
world.stairLayer = stairLayer;
scene.add(stairLayer.group);

// Load spawn position
let spawnX = 0.5, spawnY = 80, spawnZ = 0.5;
let spawnPitch = 0, spawnYaw = 0;
try {
  const spawnData = await fetch('/world/spawn.json').then(r => r.json());
  spawnX = spawnData.x ?? spawnX;
  spawnY = spawnData.y ?? spawnY;
  spawnZ = spawnData.z ?? spawnZ;
  spawnPitch = spawnData.pitch ?? 0;
  spawnYaw = spawnData.yaw ?? 0;
} catch { /* no spawn.json — use defaults */ }
await world.loadBin();

const allObjectMeshes = await loadAllObjects(scene);
await loadMarketingBanners(scene);

const controller = new PlayerController(
  world,
  renderer.domElement,
  window.innerWidth / window.innerHeight,
  new THREE.Vector3(spawnX, spawnY, spawnZ),
);
if (spawnPitch !== 0 || spawnYaw !== 0) {
  controller.fpCamera.pitch = spawnPitch;
  controller.fpCamera.yaw = spawnYaw;
  controller.fpCamera.camera.rotation.set(spawnPitch, spawnYaw, 0, "YXZ");
}

// ── Weapon scene (rendered on top of main scene each frame) ──────────────────
// Separate THREE.Scene + camera so the weapon is never clipped by world geometry.
// Only the right arm (Minecraft skin-colored) + gun are visible — CS:GO style.
// The weapon camera tracks the main camera rotation so the viewmodel follows aim.

const weaponScene  = new THREE.Scene();
const weaponCamera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.01, 10);
weaponScene.add(weaponCamera);
// Ambient+directional intensity here directly determines how dark a matte-black
// gun texture reads in-game — the original 0.8/0.7 combo washed a genuinely
// near-black texture (measured ~RGB 15-55) out to a rendered mid-gray (~RGB
// 82-130, nearly 3x brighter than the source texture). Lowered to preserve the
// real material darkness while still showing some directional shading.
weaponScene.add(new THREE.AmbientLight(0xffffff, 0.3));
const weaponSun = new THREE.DirectionalLight(0xffffff, 0.35);
weaponSun.position.set(5, 10, 5);
weaponScene.add(weaponSun);

// ── Viewmodel group (child of weaponCamera = fixed in screen space) ───────────
// Matches TACZ's own convention: the gun model carries a "camera" bone marking
// where the player's eye sits relative to the gun. gunContainer is positioned
// (once the model loads, below) so that bone lands exactly at this group's
// origin — i.e. at the weaponCamera itself — instead of using a hand-tuned
// constant offset.
const viewmodelGroup = new THREE.Group();
weaponCamera.add(viewmodelGroup);
weaponScene.add(weaponCamera);

// ── Weapon slot array (6 slots: M16A1, Deagle, MP7, P90, Ballista, LAMG) ────
// Each slot owns its container, base pose, animator, and animation state.
// All containers live under viewmodelGroup so the camera drives all of them.
interface GunSlot {
  container: THREE.Group;
  basePos: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  animator: GeckoAnimator | null;
  state: string;
}
const gunSlots: GunSlot[] = Array.from({length: 6}, (_, i) => {
  const c = new THREE.Group();
  c.name = `gunSlot${i}`;
  c.visible = i === 0;
  viewmodelGroup.add(c);
  return { container: c, basePos: new THREE.Vector3(), baseQuat: new THREE.Quaternion(), animator: null, state: "idle" };
});
const kickQuaternion = new THREE.Quaternion();
const kickEuler = new THREE.Euler();
// Slot-0 aliases so the M16A1 TACZ loader below needs minimal changes
const gunContainer    = gunSlots[0].container;
const gunBasePosition = gunSlots[0].basePos;
const gunBaseQuaternion = gunSlots[0].baseQuat;
const steveRoot = gunContainer;

// ── Bullet tracer pool ───────────────────────────────────────────────────────
// Thin lines that appear briefly and fade — matches CS:GO tracer aesthetic.

const TRACER_POOL_SIZE = 16;
const TRACER_LIFE_S    = 0.12;  // seconds visible
const TRACER_LENGTH    = 80;    // units forward

interface Tracer {
  line: THREE.Line;
  life: number;
}

const tracerMat = new THREE.LineBasicMaterial({
  color: 0xffe880,
  transparent: true,
  depthWrite: false,
});

const tracerPool: Tracer[] = [];
for (let i = 0; i < TRACER_POOL_SIZE; i++) {
  const geo  = new THREE.BufferGeometry();
  const pts  = new Float32Array(6); // 2 points × 3 coords
  geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  const line = new THREE.Line(geo, tracerMat.clone());
  line.visible = false;
  scene.add(line);
  tracerPool.push({ line, life: 0 });
}

let tracerIndex = 0;

function spawnTracer(origin: THREE.Vector3, direction: THREE.Vector3) {
  const t    = tracerPool[tracerIndex % TRACER_POOL_SIZE];
  tracerIndex++;
  const end  = origin.clone().addScaledVector(direction, TRACER_LENGTH);
  const pts  = t.line.geometry.attributes.position.array as Float32Array;
  pts[0] = origin.x; pts[1] = origin.y; pts[2] = origin.z;
  pts[3] = end.x;    pts[4] = end.y;    pts[5] = end.z;
  t.line.geometry.attributes.position.needsUpdate = true;
  t.line.visible = true;
  t.life = TRACER_LIFE_S;
  (t.line.material as THREE.LineBasicMaterial).opacity = 1.0;
}

// ── Shot handler: tracer + bullet-hole decal ─────────────────────────────────

const _shotRaycaster  = new THREE.Raycaster();
const _shotNormalMat  = new THREE.Matrix3();
const _shotInstMat    = new THREE.Matrix4();
const _shotNormalVec  = new THREE.Vector3();

function handleShot(origin: THREE.Vector3, dir: THREE.Vector3): number {
  // 1. Block DDA raycast (fast, exact voxel normals)
  const blockHit = raycastWithNormal(
    origin, dir, 200,
    (x, y, z) => world.isSolid(x, y, z),
  );

  let blockDist = Infinity;
  let blockPoint: THREE.Vector3 | null = null;
  let blockNormal: THREE.Vector3 | null = null;

  if (blockHit) {
    const n = blockHit.normal;
    const v = blockHit.position;
    // Exact ray–face intersection (DDA gives voxel coords + face normal)
    let t: number;
    if (n.x !== 0) {
      t = (v.x + (n.x > 0 ? 1 : 0) - origin.x) / dir.x;
    } else if (n.y !== 0) {
      t = (v.y + (n.y > 0 ? 1 : 0) - origin.y) / dir.y;
    } else {
      t = (v.z + (n.z > 0 ? 1 : 0) - origin.z) / dir.z;
    }
    if (t > 0) {
      blockDist   = t;
      blockPoint  = origin.clone().addScaledVector(dir, t);
      blockNormal = new THREE.Vector3(n.x, n.y, n.z);
    }
  }

  // 2. Three.js mesh raycast for AllObjects InstancedMeshes
  _shotRaycaster.set(origin, dir);
  _shotRaycaster.far = blockDist; // only check if closer than block hit
  const meshHits = _shotRaycaster.intersectObjects(allObjectMeshes, false);

  if (meshHits.length > 0 && meshHits[0].face != null) {
    const hit   = meshHits[0];
    const point = hit.point;

    // Transform local face normal → world space
    _shotNormalVec.copy(hit.face!.normal);
    if (hit.object instanceof THREE.InstancedMesh) {
      hit.object.getMatrixAt(hit.instanceId!, _shotInstMat);
      _shotNormalMat.getNormalMatrix(
        _shotInstMat.premultiply(hit.object.matrixWorld),
      );
    } else {
      _shotNormalMat.getNormalMatrix((hit.object as THREE.Mesh).matrixWorld);
    }
    _shotNormalVec.applyMatrix3(_shotNormalMat).normalize();

    spawnBulletHole(scene, point, _shotNormalVec);
    return meshHits[0].distance; // mesh hit was closer than block hit
  }

  // 3. Use block hit if no closer mesh
  if (blockPoint && blockNormal) {
    spawnBulletHole(scene, blockPoint, blockNormal);
  }
  return blockDist; // Infinity if nothing was hit
}

// ── Crosshair bloom ───────────────────────────────────────────────────────────
// Per-shot expansion that decays quickly, matching CS:GO inaccuracy feel.
let shootBloom   = 0;
let currentXhGap = 3;       // smoothed crosshair gap (px), starts at resting size
const BLOOM_PER_SHOT = 13;  // px per shot
const BLOOM_DECAY    = 8.0; // exponential decay rate (per second)

// Damage tables (mirror of server values, used for client-side display only)
const _GUN_TIERS    = [1, 2, 3, 0, 5, 4];
const _WEAPON_DMG   = [35, 50, 25, 20, 100, 15];
const _ZONE_MULT    = [0.75, 1.0, 4.0];

function showDamageNumber(worldPos: THREE.Vector3, zone: number) {
  const dmg = Math.round((_WEAPON_DMG[_GUN_TIERS[net.localTier] ?? 0] ?? 25) * (_ZONE_MULT[zone] ?? 1));
  const ndc = worldPos.clone().project(controller.fpCamera.camera);
  if (ndc.z > 1) return; // behind camera
  const sx = (ndc.x + 1) / 2 * window.innerWidth;
  const sy = (-ndc.y + 1) / 2 * window.innerHeight;

  const el = document.createElement('div');
  el.textContent = `-${dmg}`;
  const isHead = zone === 2;
  el.style.cssText = [
    'position:fixed',
    `left:${sx}px`,
    `top:${sy}px`,
    `color:${isHead ? '#ff3333' : zone === 0 ? '#aaaaaa' : '#ffdd00'}`,
    `font-size:${isHead ? '26px' : '18px'}`,
    'font-weight:bold',
    'font-family:monospace',
    'text-shadow:0 0 4px #000,1px 1px 2px #000',
    'pointer-events:none',
    'transform:translate(-50%,-50%)',
    'z-index:9000',
    'user-select:none',
  ].join(';');
  if (isHead) {
    const hs = document.createElement('div');
    hs.textContent = 'HEADSHOT';
    hs.style.cssText = 'font-size:11px;letter-spacing:2px;color:#ff7777;text-align:center';
    el.appendChild(hs);
  }
  document.body.appendChild(el);

  let t = 0;
  const DURATION = 0.9;
  const tick = (dt2: number) => {
    t += dt2;
    const p = Math.min(t / DURATION, 1);
    el.style.transform = `translate(-50%, calc(-50% - ${p * 55}px))`;
    el.style.opacity = String(1 - p * p);
    if (p < 1) requestAnimationFrame(() => tick(1 / 60));
    else el.remove();
  };
  requestAnimationFrame(() => tick(1 / 60));
}

// Wire controller shot callback → tracer + bullet hole + crosshair bloom
controller.onShot = (origin, dirIn) => {
  const dir = dirIn; // no spread — bullets go exactly where the crosshair points

  spawnTracer(origin, dir);
  const wallDist = handleShot(origin, dir);
  shootBloom = Math.min(shootBloom + BLOOM_PER_SHOT, 70);

  // Gun Game: report hit to server only if the player is closer than any wall.
  if (net.connected) {
    const { id: hitId, zone, pos } = remotePlayers.raycast(origin, dir);
    if (hitId !== '') {
      const playerDist = origin.distanceTo(pos);
      if (playerDist < wallDist) {
        showDamageNumber(pos, zone);
        if (hitId === DUMMY_ID) {
          if (!dummyDead) {
            const slot = _GUN_TIERS[net.localTier] ?? 0;
            const dmg  = Math.round((_WEAPON_DMG[slot] ?? 25) * (_ZONE_MULT[zone] ?? 1));
            dummyHp = Math.max(0, dummyHp - dmg);
            if (dummyHp <= 0) {
              dummyDead = true;
              remotePlayers.hidePlayer(DUMMY_ID);
              setTimeout(() => {
                dummyHp   = 100;
                dummyDead = false;
                remotePlayers.showPlayer(DUMMY_ID);
              }, 3000);
            }
          }
        } else {
          net.sendHit(hitId, zone);
        }
      }
    }
  }
};

// How far to pull each weapon's viewmodel back from the literal eye position —
// see the full explanation where it's applied, in the M4A1 calibration below.
// 0.3 got the stock (buttstock) technically on-screen but right at the bottom
// edge, directly behind the hotbar UI (position:absolute, bottom:16px, ~70px
// tall — see src/ui/hud.ts) — invisible in practice even though "in frame."
// 0.7 gives it real clearance (verified: stock screen Y moves from ~708 to
// ~566 in an 800px-tall viewport, well above the hotbar) while barely
// shifting the rest of the gun (barrel moves only ~25px).
const WEAPON_PULLBACK = 0.7;

// ── Texture loader ────────────────────────────────────────────────────────────
const loadTex = (url: string) => new Promise<THREE.Texture>((res, rej) => {
  new THREE.TextureLoader().load(url, (t) => {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    res(t);
  }, undefined, rej);
});

// ── Load TACZ M16A1 (GeckoLib) — real mod assets, real bone-attachment convention ──
// TACZ does not use a separate player-rig animator to position the arms: each gun's
// own rig carries dedicated "righthand_pos"/"lefthand_pos" bones, driven by the gun's
// own animation set (static_idle/shoot/reload_*), and the real arm mesh is parented
// directly to those bones (with a fixed 180°-about-Z correction — TACZ's own bridge
// between GeckoLib's bone-forward convention and the arm-mesh's convention). This
// replaces the old WEAPON_OFFSET/steveRightArm/PlayerAnimator rig entirely.
// Slot 0 (M16A1 TACZ) loaded below — animator stored in gunSlots[0].animator

(async () => {
  try {
    const [geoData, gunAnimData, gunTex] = await Promise.all([
      fetch("/tacz/models/m16a1_geo.json").then(r => r.json()),
      fetch("/tacz/animations/m16a1.animation.json").then(r => r.json()),
      loadTex("/tacz/textures/m16a1.png"),
    ]);

    const { root: gunRoot, boneGroups: gunBones } = buildGeoModel(geoData, gunTex, 1 / 16);

    // Hide only the lefthand bone (placeholder cube), NOT mag_and_lefthand —
    // the magazine lives under mag_and_lefthand → mag_and_bullet → magazine.
    // For the right arm, remove only the placeholder cube mesh from righthand_pos
    // (the bone itself stays so the gun follows the animation).
    const leftHand = gunBones["lefthand"] ?? gunBones["lefthand_pos"];
    if (leftHand) leftHand.traverse((c: THREE.Object3D) => { c.visible = false; });

    const rhPos = gunBones["righthand_pos"];
    if (rhPos) {
      for (const child of [...rhPos.children]) {
        if (child instanceof THREE.Mesh) rhPos.remove(child);
      }
    }

    // Hide unequipped-attachment variants (extended magazines) and internal
    // ammo visuals (bullets inside magazine/barrel) that TACZ normally hides
    // via scale-to-zero toggling in Java — without that runtime, they'd poke
    // out of their housings permanently.
    for (const name of [
      "mag_extended_1", "mag_extended_2", "mag_extended_3",
      "bullet", "bullet_in_mag", "bullet_in_barrel",
    ]) {
      if (gunBones[name]) gunBones[name].visible = false;
    }

    // Store base positions for position animation (bolt, mag insertion, etc.)
    for (const grp of Object.values(gunBones)) {
      grp.userData.basePos = [grp.position.x, grp.position.y, grp.position.z];
    }

    gunSlots[0].animator = new GeckoAnimator(gunAnimData, gunBones, 1 / 16);
    gunSlots[0].animator.play("static_idle");
    gunSlots[0].animator.update(0);

    // Position AND orient the gun so its own "idle_view" bone — TACZ's real
    // first-person positioning reference (see the real Java source,
    // FirstPersonRenderGunEvent.applyFirstPersonPositioningTransform /
    // getPositioningNodeInverse) — lands exactly at this group's origin with
    // identity orientation. getPositioningNodeInverse walks the bone chain from
    // "idle_view" back to root and inverts BOTH the rotation and translation of
    // every bone along the way, not just a position offset — our previous fix
    // (negating "camera" bone's position only) canceled position correctly but
    // left the model's internal axes misaligned with the camera's, which is why
    // barrel and hand ended up on inconsistent sides of the camera plane.
    gunContainer.add(gunRoot);
    gunContainer.position.set(0, 0, 0);
    gunContainer.quaternion.identity();
    gunContainer.updateMatrixWorld(true);
    const idleView = gunBones["idle_view"] ?? gunBones["camera"];
    idleView.updateMatrixWorld(true);
    const vgInverse = new THREE.Matrix4().copy(viewmodelGroup.matrixWorld).invert();
    const idleViewLocalToVG = new THREE.Matrix4().multiplyMatrices(vgInverse, idleView.matrixWorld);
    const gunBaseMatrix = idleViewLocalToVG.invert();
    gunBaseMatrix.decompose(gunBasePosition, gunBaseQuaternion, new THREE.Vector3());
    // Pull the whole viewmodel back from the eye by a small, fixed amount along
    // the camera's own forward axis. A mathematically exact "idle_view sits at
    // the eye" placement puts parts genuinely close to the eye (e.g. the
    // buttstock, measured ~0.17 units out — much closer than the barrel's
    // ~1.5) at an extreme viewing angle, pushing them off-screen entirely
    // (verified: stock at screen (1360,1260) against a 1280×800 viewport).
    // Every FPS applies some version of this eye-to-viewmodel offset for
    // exactly this reason; 0.3 was chosen empirically as the smallest pull-back
    // that brings the stock back into frame without visibly displacing the
    // rest of the gun (barrel, much farther away, barely shifts on screen).
    gunBasePosition.z -= WEAPON_PULLBACK;
    // In TACZ, the gun renders inside Minecraft's first-person right-hand
    // context, which displaces the held item to the lower-right of the camera
    // center — that's why in the reference screenshot the gun appears in the
    // right half of the screen rather than centered. We replicate that offset
    // here: shift right (+X) and down (-Y) to match the reference positioning.
    gunBasePosition.x += 0.48;
    gunBasePosition.y -= 0.24;
    gunContainer.position.copy(gunBasePosition);
    gunContainer.quaternion.copy(gunBaseQuaternion);

    gunSlots[0].state = "idle";

    console.log("[M16A1] GeckoLib model loaded. Bones:", Object.keys(gunBones).length);
    (window as any).__gunBones = gunBones;
  } catch (err) {
    console.error("[AK47] GeckoLib load error:", err);
  }
})();

// ── Generic Point Blank weapon loader (slots 1–5) ────────────────────────────
// Aligns using the _camera_ bone (positional only, no rotation — PB convention
// leaves gunBaseQuat at identity, so arm bone rest rotations = camera-space).
async function loadPointBlankGun(
  slot: GunSlot,
  label: string,
  modelUrl: string,
  animUrl: string | null,
  texUrl: string,
  startAnim: string,
  hideBones: string[] = [],
): Promise<void> {
  try {
    const fetches: Promise<unknown>[] = [
      fetch(modelUrl).then(r => r.json()),
      animUrl ? fetch(animUrl).then(r => r.json()) : Promise.resolve(null),
      loadTex(texUrl),
    ];
    const [geoData, animData, tex] = await Promise.all(fetches) as [unknown, unknown, THREE.Texture];

    const { root: gunRoot, boneGroups: gunBones } = buildGeoModel(geoData as any, tex as THREE.Texture, 1 / 16);

    for (const name of [...hideBones, "leftarm"]) {
      const grp = gunBones[name];
      if (grp) grp.traverse((c: THREE.Object3D) => { c.visible = false; });
    }
    for (const grp of Object.values(gunBones)) {
      grp.userData.basePos = [grp.position.x, grp.position.y, grp.position.z];
    }

    if (animData) {
      slot.animator = new GeckoAnimator(animData as any, gunBones, 1 / 16);
      slot.animator.play(startAnim, false);
      slot.animator.update(0);
    }

    slot.container.add(gunRoot);
    slot.container.position.set(0, 0, 0);
    slot.container.quaternion.identity();
    slot.container.updateMatrixWorld(true);

    const cameraBone = gunBones["_camera_"];
    if (cameraBone) {
      cameraBone.updateMatrixWorld(true);
      const camWorld = new THREE.Vector3();
      cameraBone.getWorldPosition(camWorld);
      slot.basePos.copy(viewmodelGroup.worldToLocal(camWorld)).negate();
    }
    slot.basePos.z -= WEAPON_PULLBACK;
    slot.container.position.copy(slot.basePos);
    // baseQuat stays identity (Point Blank convention)
    slot.container.visible = false;
    slot.state = "idle";

    console.log(`[${label}] loaded`);
  } catch (err) {
    console.error(`[${label}] load error:`, err);
  }
}

// Slot 1 — Desert Eagle
(async () => {
  const slot = gunSlots[1];
  try {
    const [geoData, animData, tex] = await Promise.all([
      fetch("/pointblank/models/deserteagle.geo.json").then(r => r.json()),
      fetch("/pointblank/animations/deserteagle.animation.json").then(r => r.json()),
      loadTex("/pointblank/textures/deserteagle.png"),
    ]);

    const { root: gunRoot, boneGroups: gunBones } = buildGeoModel(geoData, tex, 1 / 16);
    for (const name of ["_cb_suppressor", "_cb_scope", "muzzleflash", "bullet", "scope", "leftarm"]) {
      const grp = gunBones[name];
      if (grp) grp.traverse((c: THREE.Object3D) => { c.visible = false; });
    }
    for (const grp of Object.values(gunBones)) {
      grp.userData.basePos = [grp.position.x, grp.position.y, grp.position.z];
    }

    slot.animator = new GeckoAnimator(animData, gunBones, 1 / 16);
    slot.animator.play("animation.model.draw", false);
    slot.animator.update(0);

    slot.container.add(gunRoot);
    slot.container.position.set(0, 0, 0);
    slot.container.quaternion.identity();
    slot.container.updateMatrixWorld(true);

    const cameraBone = gunBones["_camera_"];
    cameraBone.updateMatrixWorld(true);
    const camWorld = new THREE.Vector3();
    cameraBone.getWorldPosition(camWorld);
    slot.basePos.copy(viewmodelGroup.worldToLocal(camWorld.clone())).negate();
    slot.basePos.z -= WEAPON_PULLBACK;
    slot.container.position.copy(slot.basePos);
    slot.container.visible = false;
    slot.state = "idle";

    console.log("[Deagle] loaded");
    (window as any).__gunBonesDeagle = gunBones;
  } catch (err) {
    console.error("[Deagle] load error:", err);
  }
})();

// Slots 2–6 — Point Blank weapons
loadPointBlankGun(gunSlots[2], "MP7",
  "/pointblank/models/mp7.geo.json",
  "/pointblank/animations/mp7.animation.json",
  "/pointblank/textures/mp7.png",
  "animation.model.draw",
  ["muzzleflash", "bullet"],
);
loadPointBlankGun(gunSlots[3], "P90",
  "/pointblank/models/p90.geo.json",
  "/pointblank/animations/p90.animation.json",
  "/pointblank/textures/p90.png",
  "animation.model.draw",
  ["muzzleflash", "bullet"],
);
loadPointBlankGun(gunSlots[4], "Ballista",
  "/pointblank/models/ballista.geo.json",
  "/pointblank/animations/ballista.animation.json",
  "/pointblank/textures/ballista.png",
  "animation.model.draw",
  ["muzzleflash", "bullet"],
);
loadPointBlankGun(gunSlots[5], "LAMG",
  "/pointblank/models/lamg.geo.json",
  "/pointblank/animations/lamg.animation.json",
  "/pointblank/textures/lamg.png",
  "animation.model.draw",
  ["muzzleflash", "bullet"],
);


// TACZ M16A1 at 0.45 matches PB AK47 proportions (TACZ models are 2.25× smaller internally)
// PB pistols/SMGs at 0.20 and rifles at 0.20 match that same reference scale
const BOT_WEAPONS = [
  { geo: "/tacz/models/m16a1_geo.json",          tex: "/tacz/textures/m16a1.png",          scale: 0.45 },
  { geo: "/pointblank/models/deserteagle.geo.json", tex: "/pointblank/textures/deserteagle.png", scale: 0.20 },
  { geo: "/pointblank/models/mp7.geo.json",       tex: "/pointblank/textures/mp7.png",       scale: 0.20 },
  { geo: "/pointblank/models/p90.geo.json",       tex: "/pointblank/textures/p90.png",       scale: 0.20 },
  { geo: "/pointblank/models/ballista.geo.json",  tex: "/pointblank/textures/ballista.png",  scale: 0.20 },
  { geo: "/pointblank/models/lamg.geo.json",      tex: "/pointblank/textures/lamg.png",      scale: 0.20 },
];

// ── SWAT Steve (CT side) ─────────────────────────────────────────────────────
const steveCharacter = new SteveCharacter();
steveCharacter.root.position.set(-7, 5.0, 46);
scene.add(steveCharacter.root);
steveCharacter.equipSwatArmor();
steveCharacter.startWeaponCycle(BOT_WEAPONS, 5);
steveCharacter.aiming = true;

// ── Terrorist Steve (T side) — offset start so they don't swap in sync ────────
const steveT = new SteveCharacter();
steveT.root.position.set(-7, 5.0, 43);
scene.add(steveT.root);
steveT.equipArmor("/marbled/military_armor.geo.json", "/marbled/desert_military_armor.png");
// Start terrorist's cycle at a different weapon so they're never holding the same gun
steveT.startWeaponCycle([...BOT_WEAPONS.slice(3), ...BOT_WEAPONS.slice(0, 3)], 5);
steveT.aiming = true;

// ── Block outline ────────────────────────────────────────────────────────────
const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
const outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x000000 }));
outline.visible = false;
scene.add(outline);

// ── Mobile controls (touch devices only) ─────────────────────────────────────
let mobileControls: MobileControls | null = null;
if (controller.isMobile) {
  mobileControls = setupMobileControls(app, controller);
}

// ── HUD ──────────────────────────────────────────────────────────────────────
const hud = createHud(app);

window.addEventListener("resize", () => {
  controller.camera.aspect = window.innerWidth / window.innerHeight;
  controller.camera.updateProjectionMatrix();
  weaponCamera.aspect = window.innerWidth / window.innerHeight;
  weaponCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Gun Game multiplayer ──────────────────────────────────────────────────────
// Weapon slot index per gun-game tier (matches server's GUN_TIERS array):
//   tier 0→Deagle(1)  1→MP7(2)  2→P90(3)  3→M16A1(0)  4→LAMG(5)  5→Ballista(4)
const GUN_TIER_SLOTS = [1, 2, 3, 0, 5, 4];
const WEAPON_NAMES   = ['M16A1', 'Deagle', 'MP7', 'P90', 'Ballista', 'LAMG'];

const _wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:9001';
const net           = new GameClient(_wsUrl);
const remotePlayers = new RemotePlayers(scene);

// ── Training dummy ────────────────────────────────────────────────────────────
const DUMMY_ID = '__dummy__';
let dummyHp   = 100;
let dummyDead = false;
remotePlayers.add({ id: DUMMY_ID, x: -14, y: 5, z: 36, yaw: Math.PI, tier: 0 });

// ── Kill feed DOM element ──────────────────────────────────────────────────
// ── Global UI styles (animations) ─────────────────────────────────────────
{
  const s = document.createElement('style');
  s.textContent = `
    @keyframes vvDots{0%,100%{opacity:.2}40%{opacity:1}}
    @keyframes vvPulse{0%,100%{opacity:.7}50%{opacity:1}}
    @keyframes vvFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
    @keyframes vvKill{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:translateX(0)}}
    @keyframes vvRespawnBar{from{width:100%}to{width:0%}}
    .vv-dot{display:inline-block;animation:vvDots 1.2s ease-in-out infinite}
    .vv-dot:nth-child(2){animation-delay:.2s}
    .vv-dot:nth-child(3){animation-delay:.4s}
  `;
  document.head.appendChild(s);
}

// ── Kill feed ──────────────────────────────────────────────────────────────
const killFeedEl = document.createElement('div');
killFeedEl.style.cssText = `
  position:fixed;top:16px;right:16px;width:300px;
  font-family:'Arial',sans-serif;font-size:12px;color:#fff;
  pointer-events:none;display:flex;flex-direction:column;gap:2px;
`;
document.getElementById('app')!.appendChild(killFeedEl);

function pushKillFeed(html: string) {
  const line = document.createElement('div');
  line.style.cssText = `
    background:rgba(0,0,0,0.72);border-left:2px solid rgba(255,255,255,0.18);
    padding:5px 10px;animation:vvKill .15s ease-out;
    backdrop-filter:blur(4px);letter-spacing:.3px;
  `;
  line.innerHTML = html;
  killFeedEl.prepend(line);
  setTimeout(() => {
    line.style.transition = 'opacity .4s';
    line.style.opacity = '0';
    setTimeout(() => line.remove(), 400);
  }, 4600);
}

// ── Tier / weapon progression banner ──────────────────────────────────────
const tierBanner = document.createElement('div');
tierBanner.style.cssText = `
  position:fixed;bottom:120px;left:50%;transform:translateX(-50%);
  font-family:'Arial',sans-serif;font-size:11px;letter-spacing:1.5px;
  text-transform:uppercase;color:rgba(255,255,255,0.5);
  pointer-events:none;display:none;text-align:center;
`;
document.getElementById('app')!.appendChild(tierBanner);

function updateTierBanner() {
  if (!net.connected || net.localId === '') { tierBanner.style.display = 'none'; return; }
  const slot = GUN_TIER_SLOTS[net.localTier];
  const next = net.localTier + 1 < GUN_TIER_SLOTS.length
    ? WEAPON_NAMES[GUN_TIER_SLOTS[net.localTier + 1]]
    : 'WIN';
  tierBanner.style.display = 'block';
  tierBanner.innerHTML =
    `<span style="color:#e8b84b;font-weight:bold">${WEAPON_NAMES[slot]}</span>` +
    `<span style="margin:0 8px;opacity:.4">›</span>` +
    `<span>${next}</span>` +
    `<span style="margin-left:10px;opacity:.35">${net.localTier + 1} / ${GUN_TIER_SLOTS.length}</span>`;
}

// ── HP bar (bottom-left, CS style) ────────────────────────────────────────
const hpBarWrap = document.createElement('div');
hpBarWrap.style.cssText = `
  position:fixed;bottom:20px;left:24px;
  font-family:'Arial',sans-serif;pointer-events:none;display:none;width:140px;
`;
hpBarWrap.innerHTML = `
  <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:5px">
    <span id="hp-value" style="font-size:38px;font-weight:700;color:#fff;line-height:1;letter-spacing:-1px"></span>
    <span style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1px;text-transform:uppercase">HP</span>
  </div>
  <div style="height:2px;background:rgba(255,255,255,0.12);border-radius:1px;overflow:hidden">
    <div id="hp-fill" style="height:100%;width:100%;transition:width .12s,background .3s;border-radius:1px"></div>
  </div>
`;
document.getElementById('app')!.appendChild(hpBarWrap);
const hpValueEl = hpBarWrap.querySelector('#hp-value') as HTMLElement;
const hpFillEl  = hpBarWrap.querySelector('#hp-fill')  as HTMLElement;
let _localHp = 100;
function setLocalHp(hp: number) {
  _localHp = hp;
  hpValueEl.textContent = String(hp);
  hpFillEl.style.width = hp + '%';
  hpFillEl.style.background = hp > 50 ? '#57c455' : hp > 25 ? '#d4913a' : '#c94040';
}

// ── Connecting overlay ─────────────────────────────────────────────────────
const connectingOverlay = document.createElement('div');
connectingOverlay.style.cssText = `
  position:fixed;inset:0;background:#0d0e10;display:flex;flex-direction:column;
  align-items:center;justify-content:center;z-index:500;
  font-family:'Arial',sans-serif;gap:28px;
`;
connectingOverlay.innerHTML = `
  <div style="font-size:28px;font-weight:700;letter-spacing:6px;text-transform:uppercase;
    color:#fff">LIZARD</div>
  <div style="width:220px;height:1px;background:rgba(255,255,255,0.1)"></div>
  <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.35)">
    Connecting<span class="vv-dot">.</span><span class="vv-dot">.</span><span class="vv-dot">.</span>
  </div>
`;
document.getElementById('app')!.appendChild(connectingOverlay);

// Freeze player in place until the server welcome arrives.
controller.physics.flying  = true;
controller.physics.velocity.set(0, 0, 0);

// ── Death screen ───────────────────────────────────────────────────────────
const deathScreen = document.createElement('div');
deathScreen.style.cssText = `
  position:fixed;inset:0;display:none;flex-direction:column;
  align-items:center;justify-content:center;pointer-events:none;z-index:200;
  background:radial-gradient(ellipse 120% 100% at 50% 100%, rgba(120,0,0,0.55) 0%, rgba(0,0,0,0.72) 60%);
`;
deathScreen.innerHTML = `
  <div style="font-family:'Arial',sans-serif;text-align:center;animation:vvFadeIn .25s ease-out">
    <div style="font-size:11px;letter-spacing:5px;text-transform:uppercase;
      color:rgba(255,255,255,0.4);margin-bottom:14px">You were</div>
    <div style="font-size:68px;font-weight:900;letter-spacing:8px;text-transform:uppercase;
      color:#fff;line-height:1">ELIMINATED</div>
    <div style="margin-top:28px;width:260px;height:2px;background:rgba(255,255,255,0.1);
      border-radius:1px;overflow:hidden;margin-left:auto;margin-right:auto">
      <div id="respawn-bar" style="height:100%;background:rgba(255,255,255,0.35);border-radius:1px"></div>
    </div>
    <div id="respawn-cd" style="margin-top:12px;font-size:11px;letter-spacing:3px;
      text-transform:uppercase;color:rgba(255,255,255,0.35)"></div>
  </div>
`;
document.getElementById('app')!.appendChild(deathScreen);
const respawnCdEl   = deathScreen.querySelector('#respawn-cd')  as HTMLElement;
const respawnBarEl  = deathScreen.querySelector('#respawn-bar') as HTMLElement;
let _isDead = false;
let _respawnCountdown = 0;

function enterDeathState() {
  _isDead = true;
  _respawnCountdown = 3;
  setLocalHp(0);
  deathScreen.style.display = 'flex';
  respawnCdEl.textContent = 'Respawning in 3';
  respawnBarEl.style.transition = 'none';
  respawnBarEl.style.width = '100%';
  // Force reflow so the transition starts from 100%
  void respawnBarEl.offsetWidth;
  respawnBarEl.style.transition = 'width 3s linear';
  respawnBarEl.style.width = '0%';
}
function exitDeathState() {
  _isDead = false;
  _respawnCountdown = 0;
  setLocalHp(100);
  deathScreen.style.display = 'none';
}

net.onEvent = ev => {
  if (ev.t === 'welcome') {
    for (const p of ev.players) remotePlayers.add(p);
    // Teleport to the server-assigned spawn and unfreeze.
    controller.physics.position.set(ev.spawn[0], ev.spawn[1], ev.spawn[2]);
    controller.physics.smoothY = ev.spawn[1];
    controller.physics.velocity.set(0, 0, 0);
    controller.physics.flying = false;
    connectingOverlay.style.display = 'none';
    hpBarWrap.style.display = 'block';
    setLocalHp(100);
    // Force correct weapon immediately so there's no one-frame M16A1 flash.
    controller.weaponIndex = GUN_TIER_SLOTS[net.localTier];
    updateTierBanner();
  } else if (ev.t === 'join') {
    remotePlayers.add({ id: ev.id, x: ev.x, y: ev.y, z: ev.z, yaw: 0, tier: ev.tier });
  } else if (ev.t === 'leave') {
    remotePlayers.remove(ev.id);
  } else if (ev.t === 'kill') {
    const short = (id: string) => id.slice(0, 4).toUpperCase();
    const killerLabel = ev.killer === net.localId
      ? '<span style="color:#57c455;font-weight:700">YOU</span>'
      : `<span style="color:rgba(255,255,255,0.8)">#${short(ev.killer)}</span>`;
    const victimLabel = ev.victim === net.localId
      ? '<span style="color:#c94040;font-weight:700">YOU</span>'
      : `<span style="color:rgba(255,255,255,0.55)">#${short(ev.victim)}</span>`;
    pushKillFeed(`${killerLabel}<span style="color:rgba(255,255,255,0.2);margin:0 7px">✕</span>${victimLabel}<span style="color:rgba(255,255,255,0.25);margin-left:8px;font-size:10px;letter-spacing:.5px">${ev.weaponName.toUpperCase()}</span>`);
    if (ev.killer === net.localId) updateTierBanner();
    if (ev.victim === net.localId) {
      enterDeathState();
    } else {
      remotePlayers.hidePlayer(ev.victim);
    }
  } else if (ev.t === 'win') {
    const label = ev.id === net.localId ? 'VICTORY' : `PLAYER #${ev.id.slice(0,4).toUpperCase()} WINS`;
    pushKillFeed(`<span style="color:#e8b84b;font-weight:700;letter-spacing:2px">${label}</span>`);
    updateTierBanner();
  } else if (ev.t === 'reset') {
    pushKillFeed('<span style="color:rgba(255,255,255,0.25);letter-spacing:2px;font-size:10px">NEW ROUND</span>');
    net.localTier = 0;
    controller.weaponIndex = GUN_TIER_SLOTS[0];
    exitDeathState();
    updateTierBanner();
  } else if (ev.t === 'respawn') {
    if (ev.id === net.localId) {
      exitDeathState();
      controller.physics.position.set(ev.x, ev.y, ev.z);
      controller.physics.smoothY = ev.y;
      controller.physics.velocity.set(0, 0, 0);
    } else {
      remotePlayers.respawn(ev.id, ev.x, ev.y, ev.z);
      remotePlayers.showPlayer(ev.id);
    }
  }
};

net.onSnapshot = players => remotePlayers.applyTick(players);

net.connect();

// Position send throttle — 20 Hz
let _netTimer = 0;

// Walk bob state

// ── FOV / scope state ─────────────────────────────────────────────────────────
const BASE_FOV   = 75;
const SCOPE_FOVS = [BASE_FOV, 40]; // level 0 = off, 1 = zoomed
let currentFov   = BASE_FOV;

// ── Game loop ────────────────────────────────────────────────────────────────
let lastTime = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  hud.showPrompt(!controller.locked && !controller.isMobile);
  mobileControls?.updateKnob(controller.joystickX, controller.joystickZ);
  hud.setSelected(controller.selectedIndex);

  // ── Gun Game: force weapon slot to current tier ────────────────────────────
  if (net.connected && net.localId !== '') {
    const forcedSlot = GUN_TIER_SLOTS[net.localTier];
    if (controller.weaponIndex !== forcedSlot) {
      controller.weapons[controller.weaponIndex].releaseTrigger();
      controller.weaponIndex = forcedSlot;
    }
  }

  // ── Respawn countdown ───────────────────────────────────────────────────
  if (_isDead && _respawnCountdown > 0) {
    _respawnCountdown -= dt;
    const secs = Math.max(1, Math.ceil(_respawnCountdown));
    respawnCdEl.textContent = `Respawning in ${secs}`;
  }

  controller.update(dt);
  world.update(controller.physics.position);

  // AWP scope — smooth FOV lerp, overlay, and movement blur on reticle
  const scopeLvl = controller.scopeLevel;
  const targetFov = SCOPE_FOVS[scopeLvl];
  currentFov += (targetFov - currentFov) * (1 - Math.exp(-20 * dt));
  controller.camera.fov = currentFov;
  controller.camera.updateProjectionMatrix();
  hud.setScopeOverlay(scopeLvl);
  if (scopeLvl > 0) {
    const vel = controller.physics.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    // blur scales with speed; multiply by zoom level so higher zoom blurs more
    const blur = Math.min(speed * 0.55, 4);
    hud.setScopeBlur(blur);
  }

  // Sync weapon camera orientation to main camera so viewmodel follows aim direction
  weaponCamera.rotation.copy(controller.camera.rotation);
  weaponCamera.updateMatrixWorld(true);

  // Animation state machine — drive the ACTIVE weapon's own GeckoLib animation
  // from its AK47 gameplay state. The arm meshes are children of the gun's own
  // hand-marker bones, so this alone also drives their movement — no separate
  // player-rig animator needed. Both weapons stay loaded and in the scene graph
  // at all times; only visibility (and which one gets updated) toggles.
  const ak = controller.ak47;
  const wIdx = controller.weaponIndex;

  // Show only the active weapon container; hide viewmodel entirely when scoped or dead
  const scoped = scopeLvl > 0;
  for (let i = 0; i < gunSlots.length; i++) {
    gunSlots[i].container.visible = i === wIdx && !scoped && !_isDead;
  }

  const activeSlot = gunSlots[wIdx];

  if (wIdx === 0 && activeSlot.animator) {
    // Slot 0 — M16A1 TACZ animation names
    const { animator, state } = activeSlot;
    if (ak.reloading && state !== "reload") {
      animator.play("reload_tactical"); activeSlot.state = "reload";
    } else if (ak.isFiring && !ak.reloading && state !== "fire") {
      animator.play("shoot"); activeSlot.state = "fire";
    } else if (ak.isInspecting && !ak.reloading && !ak.isFiring && state !== "inspect") {
      animator.play("inspect"); activeSlot.state = "inspect";
    } else if (!ak.reloading && !ak.isFiring && !ak.isInspecting && state !== "idle") {
      animator.play("static_idle"); activeSlot.state = "idle";
    }
    animator.update(dt);
  } else if (wIdx > 0 && activeSlot.animator) {
    // Slots 1–5 — Point Blank animation names (animation.model.*)
    const { animator, state } = activeSlot;
    if (ak.reloading && state !== "reload") {
      animator.play("animation.model.reload", false); activeSlot.state = "reload";
    } else if (ak.isFiring && !ak.reloading && state !== "fire") {
      animator.play("animation.model.fire", false); activeSlot.state = "fire";
    } else if (ak.isInspecting && !ak.reloading && !ak.isFiring && state !== "inspect") {
      animator.play("animation.model.inspect", false); activeSlot.state = "inspect";
    } else if (!ak.reloading && !ak.isFiring && !ak.isInspecting && state !== "idle") {
      animator.play("animation.model.idle"); activeSlot.state = "idle";
    }
    animator.update(dt);
  }
  // Face Steve toward the player
  const steveDx = controller.physics.position.x - steveCharacter.root.position.x;
  const steveDz = controller.physics.position.z - steveCharacter.root.position.z;
  const steveYaw = Math.atan2(-steveDx, -steveDz);
  steveCharacter.update(dt, true, steveYaw);

  const steveTDx = controller.physics.position.x - steveT.root.position.x;
  const steveTDz = controller.physics.position.z - steveT.root.position.z;
  steveT.update(dt, true, Math.atan2(-steveTDx, -steveTDz));

  // ── Multiplayer: send position + update remote player characters ───────────
  remotePlayers.update(dt);
  _netTimer -= dt;
  if (_netTimer <= 0) {
    _netTimer = 0.016; // ~62 Hz
    const pp = controller.physics.position;
    net.sendPosition(pp.x, pp.y, pp.z, controller.fpCamera.yaw);
  }

  // Walk bob — CS:GO style: Y does two cycles per stride, X does one.
  // Apply kick/sway to the active weapon's container (no walk bob — gun stays static).
  activeSlot.container.position.set(
    activeSlot.basePos.x,
    activeSlot.basePos.y - ak.modelKickPitch * 0.3 + ak.reloadOffsetY,
    activeSlot.basePos.z  + ak.modelKickPitch * 0.1 + ak.reloadOffsetZ,
  );
  kickQuaternion.setFromEuler(kickEuler.set(ak.modelKickPitch * 0.4, 0, ak.reloadRollZ));
  activeSlot.container.quaternion.multiplyQuaternions(kickQuaternion, activeSlot.baseQuat);

  // Block outline
  if (controller.targetBlock) {
    outline.visible = true;
    outline.position.set(
      controller.targetBlock.position.x + 0.5,
      controller.targetBlock.position.y + 0.5,
      controller.targetBlock.position.z + 0.5,
    );
  } else {
    outline.visible = false;
  }

  // Update tracers
  for (const t of tracerPool) {
    if (!t.line.visible) continue;
    t.life -= dt;
    if (t.life <= 0) {
      t.line.visible = false;
    } else {
      (t.line.material as THREE.LineBasicMaterial).opacity = t.life / TRACER_LIFE_S;
    }
  }

  // FPS counter
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }
  const p = controller.physics.position;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  const blockBelow = world.getBlock(bx, by - 1, bz);
  const blockAt    = world.getBlock(bx, by,     bz);
  const pitch = controller.fpCamera.pitch;
  const yaw   = controller.fpCamera.yaw;

  // Render main scene
  renderer.info.reset();
  renderer.render(scene, controller.camera);

  // Render weapon on top: preserve color buffer, only clear depth so the
  // weapon is never occluded by world geometry.
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(weaponScene, weaponCamera);
  renderer.autoClear = true;

  // Totals across both passes (autoReset disabled at init so info accumulates).
  const tris  = renderer.info.render.triangles;
  const calls = renderer.info.render.calls;
  hud.setDebugText(
    `FPS ${fps}` +
    `
pos  ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}` +
    `
pitch ${pitch.toFixed(4)}  yaw ${yaw.toFixed(4)}` +
    `
spawn.json → {"x":${p.x.toFixed(3)},"y":${p.y.toFixed(3)},"z":${p.z.toFixed(3)},"pitch":${pitch.toFixed(4)},"yaw":${yaw.toFixed(4)}}` +
    `
grounded ${controller.physics.grounded}  block_at[${by}]=${blockAt}` +
    `
triangles ${tris.toLocaleString()}  draw calls ${calls}`,
  );
  hud.setAmmo(ak.ammo, ak.reserve, ak.reloading);

  // ── Dynamic crosshair ───────────────────────────────────────────────────────
  shootBloom *= Math.exp(-BLOOM_DECAY * dt);

  const vel     = controller.physics.velocity;
  const grounded = controller.physics.grounded;
  const speed    = Math.hypot(vel.x, vel.z);
  const moveSpread = speed * 4.0;
  const airSpread  = grounded ? 0 : 52;
  const targetGap  = 3 + Math.min(moveSpread + airSpread + shootBloom, 80);

  // Smooth: expand fast, contract slower (CS:GO feel)
  const xhRate  = targetGap > currentXhGap ? 20 : 16;
  currentXhGap += (targetGap - currentXhGap) * (1 - Math.exp(-xhRate * dt));
  hud.updateCrosshair(currentXhGap);
}
requestAnimationFrame(tick);

(window as any).__game = { controller, renderer, scene };
(window as any).__steveRoot = steveRoot;
