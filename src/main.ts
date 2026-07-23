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

const app = document.getElementById("app")!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
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

const gunContainer = new THREE.Group();
gunContainer.name = "gunContainer";
viewmodelGroup.add(gunContainer);
// Base (un-swayed) position/orientation, set once after idle_view alignment in
// the async loader below; the tick loop adds kick/reload sway on top each frame.
const gunBasePosition = new THREE.Vector3();
const gunBaseQuaternion = new THREE.Quaternion();
const kickQuaternion = new THREE.Quaternion();
const kickEuler = new THREE.Euler();

// steveRoot alias kept for tick-loop sway code (points at gunContainer, which
// now carries both the gun and — as children of its own righthand_pos/
// lefthand_pos bones — the arm meshes, so sway/kick moves everything together).
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

function handleShot(origin: THREE.Vector3, dir: THREE.Vector3) {
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
    return; // mesh hit was closer than block hit
  }

  // 3. Use block hit if no closer mesh
  if (blockPoint && blockNormal) {
    spawnBulletHole(scene, blockPoint, blockNormal);
  }
}

// ── Crosshair bloom ───────────────────────────────────────────────────────────
// Per-shot expansion that decays quickly, matching CS:GO inaccuracy feel.
let shootBloom   = 0;
let currentXhGap = 3;       // smoothed crosshair gap (px), starts at resting size
const BLOOM_PER_SHOT = 13;  // px per shot
const BLOOM_DECAY    = 8.0; // exponential decay rate (per second)

// Wire controller shot callback → spread → tracer + bullet hole + crosshair bloom
const MAX_SPREAD_RAD = 4 * Math.PI / 180; // 4° cone at maximum bloom
controller.onShot = (origin, dirIn) => {
  // Scale spread angle by how open the crosshair is (gap=3 → 0°, gap=83 → 4°)
  const spreadFrac  = Math.max(0, (currentXhGap - 3) / 80);
  const spreadAngle = spreadFrac * MAX_SPREAD_RAD;

  let dir = dirIn;
  if (spreadAngle > 0.0001) {
    // Uniform random point inside a cone: radius = sqrt(rand) so distribution
    // is uniform over the disk (no clustering at center).
    const r     = Math.sqrt(Math.random()) * spreadAngle;
    const theta = Math.random() * Math.PI * 2;

    // Build an orthonormal frame perpendicular to the shot direction.
    const up    = Math.abs(dirIn.y) < 0.99
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const right  = new THREE.Vector3().crossVectors(dirIn, up).normalize();
    const realUp = new THREE.Vector3().crossVectors(right, dirIn).normalize();

    dir = dirIn.clone()
      .addScaledVector(right,  Math.sin(r) * Math.cos(theta))
      .addScaledVector(realUp, Math.sin(r) * Math.sin(theta))
      .normalize();
  }

  spawnTracer(origin, dir);
  handleShot(origin, dir);
  shootBloom = Math.min(shootBloom + BLOOM_PER_SHOT, 70);
};

// ── Load TACZ M4A1 (GeckoLib) — real mod assets, real bone-attachment convention ──
// TACZ does not use a separate player-rig animator to position the arms: each gun's
// own rig carries dedicated "righthand_pos"/"lefthand_pos" bones, driven by the gun's
// own animation set (static_idle/shoot/reload_*), and the real arm mesh is parented
// directly to those bones (with a fixed 180°-about-Z correction — TACZ's own bridge
// between GeckoLib's bone-forward convention and the arm-mesh's convention). This
// replaces the old WEAPON_OFFSET/steveRightArm/PlayerAnimator rig entirely.
let gunAnimator: GeckoAnimator | null = null;
let gunAnimState = "idle";

(async () => {
  try {
    const loadTex = (url: string) => new Promise<THREE.Texture>((res, rej) => {
      new THREE.TextureLoader().load(url, (t) => {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        res(t);
      }, undefined, rej);
    });

    const [geoData, gunAnimData, gunTex, rightArmGeo, leftArmGeo, steveTex] = await Promise.all([
      fetch("/tacz/models/m4a1_geo.json").then(r => r.json()),
      fetch("/tacz/animations/m4a1.animation.json").then(r => r.json()),
      loadTex("/tacz/textures/m4a1.png"),
      fetch("/pointblank/models/item/right_arm.geo.json").then(r => r.json()),
      fetch("/pointblank/models/item/left_arm.geo.json").then(r => r.json()),
      loadTex("/textures/steve.png"),
    ]);

    const { root: gunRoot, boneGroups: gunBones } = buildGeoModel(geoData, gunTex, 1 / 16);

    // Hide the placeholder hand cubes baked into righthand_pos/lefthand_pos
    // themselves (not the whole bone — the real Steve arm meshes are parented
    // to these same bones below, and hiding the bone would hide them too).
    for (const name of ["righthand_pos", "lefthand_pos"]) {
      const grp = gunBones[name];
      if (!grp) continue;
      for (const child of [...grp.children]) {
        if (child instanceof THREE.Mesh) grp.remove(child);
      }
    }

    // Hide unequipped-attachment variants this base file bundles (extended
    // magazines) and internal/loose ammunition visuals (bullets inside the
    // magazine, chambered round, a spare loose cartridge) that should stay
    // invisible inside their solid housings — this animator doesn't implement
    // the `scale`-to-zero toggling TACZ's Java code uses to show/hide these, so
    // left visible they'd sit permanently coincident with or poking out of the
    // equipped parts. Also hide internal-mechanism parts (bolt/buffer/
    // charging-handle group, selector dial ring assembly) — their rest-pose
    // layout in this file is an exploded/reference arrangement (correct for a
    // disassembly view, never reassembled by any animation we drive), not a
    // sitting-inside-the-receiver pose.
    //
    // "grip2" is genuinely an OPTIONAL attachment, not a base-gun part: M4A1's
    // own data file (m4a1_data.json) lists "grip" in allow_attachment_types
    // alongside scope/laser/muzzle/extended_mag — all slots that are EMPTY by
    // default until the player equips something. Snapping it onto grip_pos (an
    // earlier attempt) was wrong for the same reason leaving scope/laser
    // attachments visible would be wrong: nothing is equipped there, so nothing
    // should render, full stop — hide it like the other unequipped variants.
    for (const name of [
      "mag_extended_1", "mag_extended_2", "mag_extended_3",
      "sight_folded", "handguard_tactical",
      "bullet", "bullet_in_mag", "bullet_in_barrel",
      "m4a1_pull", "buffer", "rings3", "selector",
      "fore_sight3", "sight2", "grip2",
    ]) {
      if (gunBones[name]) gunBones[name].visible = false;
    }

    // oem_stock_tactical is different: TACZ's own promotional/HUD renders of
    // the M4A1 always show it equipped (unlike grip/scope/laser, a rifle isn't
    // shown stockless by default) — its rest-pose position in this file is
    // just a parked/storage spot, nowhere near the gun. Replicate what TACZ's
    // Java attachment code does at equip time: measure the real gap to the
    // gun's own stock_pos marker bone at runtime and close it, rather than
    // hardcoding a position.
    const snapToMarker = (pieceName: string, markerName: string) => {
      const piece = gunBones[pieceName];
      const marker = gunBones[markerName];
      if (!piece || !marker || !piece.parent) return;
      gunRoot.updateMatrixWorld(true);
      const pieceWorld  = piece.getWorldPosition(new THREE.Vector3());
      const markerWorld = marker.getWorldPosition(new THREE.Vector3());
      const parent = piece.parent;
      const pieceLocal  = parent.worldToLocal(pieceWorld.clone());
      const markerLocal = parent.worldToLocal(markerWorld.clone());
      piece.position.add(markerLocal.clone().sub(pieceLocal));
    };
    snapToMarker("oem_stock_tactical", "stock_pos");

    // Store base positions for position animation (bolt, mag insertion, etc.)
    for (const grp of Object.values(gunBones)) {
      grp.userData.basePos = [grp.position.x, grp.position.y, grp.position.z];
    }

    gunAnimator = new GeckoAnimator(gunAnimData, gunBones, 1 / 16);
    gunAnimator.play("static_idle");
    gunAnimator.update(0);

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
    gunContainer.position.copy(gunBasePosition);
    gunContainer.quaternion.copy(gunBaseQuaternion);

    // Real arm models (item/right_arm.geo.json + item/left_arm.geo.json, Steve skin
    // texture) at true S=1/32 scale (their 8×24×8px cubes → 0.25×0.75×0.25, matching
    // vanilla ModelBiped's 4×12×4 exactly at 2x resolution).
    //
    // These arm assets are actually from the "Point Blank" mod (pointblank/geo/item/
    // right_arm.geo.json — see public/pointblank/), not TACZ, and Point Blank's own
    // GunItemRenderer.applyArmRefTransforms (real source, github.com/Miss-Moss/
    // pointblank-jelly) attaches this exact mesh with a pure TRANSLATION aligning a
    // fixed reference point on the arm to a reference point on the gun — no rotation
    // at all. TACZ's Rz(180°) is specific to vanilla Minecraft's PlayerModel arm
    // (a different mesh with a different base orientation) and doesn't apply here;
    // applying it was pointing this mesh the wrong way. The arm bone's own pivot
    // ([-13.3, 25.3, -0.2], the shoulder joint — cube spans down from there to the
    // hand) is the natural reference point, so align it to the marker bone's origin
    // directly (position = 0,0,0), matching Point Blank's "translate to align a
    // reference point, no rotation" approach.
    //
    // TACZ's own static_idle animation ALSO applies scale [1, 1.5, 1] to the
    // righthand/lefthand bones (parents of righthand_pos/lefthand_pos) — meant
    // for the gun's own internal placeholder arm geometry, which presumably
    // expects it. Our replacement Steve arm mesh doesn't, so it needs a
    // compensating inverse scale to avoid stretching.
    const attachHand = (armGroup: THREE.Group, handPosBone: THREE.Object3D) => {
      handPosBone.updateMatrixWorld(true);
      const parentWorldScale = new THREE.Vector3();
      handPosBone.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), parentWorldScale);

      armGroup.rotation.set(0, 0, 0);
      armGroup.scale.set(1 / parentWorldScale.x, 1 / parentWorldScale.y, 1 / parentWorldScale.z);
      armGroup.position.set(0, 0, 0);

      handPosBone.add(armGroup);
    };

    const ARM_S = 1 / 32;
    const rightArmModel = buildGeoModel(rightArmGeo, steveTex, ARM_S);
    attachHand(rightArmModel.boneGroups["rightarm"], gunBones["righthand_pos"]);

    const leftArmModel = buildGeoModel(leftArmGeo, steveTex, ARM_S);
    attachHand(leftArmModel.boneGroups["leftarm"], gunBones["lefthand_pos"]);

    gunAnimState = "idle";

    console.log("[M4A1] GeckoLib model loaded. Bones:", Object.keys(gunBones).length);
    (window as any).__gunBones = gunBones;
  } catch (err) {
    console.error("[AK47] GeckoLib load error:", err);
  }
})();

// ── SWAT Steve character ──────────────────────────────────────────────────────
// Placed at a fixed spot in the Dust_2 world, standing and animating.
const steveCharacter = new SteveCharacter();
// Spawn yaw=-1.685 → lookDir≈(+0.994,0,+0.113). Place Steve 3 units in front.
steveCharacter.root.position.set(-7, 5.0, 46);
scene.add(steveCharacter.root);
steveCharacter.equipSwatArmor();

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

  controller.update(dt);
  world.update(controller.physics.position);

  // Sync weapon camera orientation to main camera so viewmodel follows aim direction
  weaponCamera.rotation.copy(controller.camera.rotation);
  weaponCamera.updateMatrixWorld(true);

  // Animation state machine — drive the gun's own GeckoLib animation from AK47 state.
  // The arm meshes are children of the gun's righthand_pos/lefthand_pos bones, so
  // this alone also drives their movement — no separate player-rig animator needed.
  const ak = controller.ak47;
  if (gunAnimator) {
    // gun animation priority: reload > fire > idle (TACZ's own animation names)
    if (ak.reloading && gunAnimState !== "reload") {
      gunAnimator.play("reload_tactical");
      gunAnimState = "reload";
    } else if (ak.isFiring && !ak.reloading && gunAnimState !== "fire") {
      gunAnimator.play("shoot");
      gunAnimState = "fire";
    } else if (!ak.reloading && !ak.isFiring && gunAnimState !== "idle") {
      gunAnimator.play("static_idle");
      gunAnimState = "idle";
    }
    gunAnimator.update(dt);
  }
  // Face Steve toward the player
  const steveDx = controller.physics.position.x - steveCharacter.root.position.x;
  const steveDz = controller.physics.position.z - steveCharacter.root.position.z;
  const steveYaw = Math.atan2(-steveDx, -steveDz);
  steveCharacter.update(dt, true, steveYaw);

  // Apply kick/sway to gunContainer (steveRoot alias) on top of its idle_view-aligned
  // base position/orientation. Kick/roll are small screen-space sway effects, applied
  // as an extra rotation in the parent (camera) frame on top of the base orientation —
  // i.e. composed as kick * base, not overwriting the base orientation outright.
  steveRoot.position.set(
    gunBasePosition.x,
    gunBasePosition.y - ak.modelKickPitch * 0.3 + ak.reloadOffsetY,
    gunBasePosition.z  + ak.modelKickPitch * 0.1 + ak.reloadOffsetZ,
  );
  kickQuaternion.setFromEuler(kickEuler.set(ak.modelKickPitch * 0.4, 0, ak.reloadRollZ));
  steveRoot.quaternion.multiplyQuaternions(kickQuaternion, gunBaseQuaternion);

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
  renderer.render(scene, controller.camera);

  // Render weapon on top: preserve color buffer, only clear depth so the
  // weapon is never occluded by world geometry.
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(weaponScene, weaponCamera);
  renderer.autoClear = true;

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
