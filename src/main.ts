// NEW bootstrap: scene/renderer setup, game loop, target-block outline, HUD wiring.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { World } from "./world/World";
import { ModelLayer } from "./world/ModelLayer";
import { PlayerController } from "./player/Controller";
import { createHud } from "./ui/hud";
import { buildBlockTextureAtlas } from "./textures/blockTextures";
import { loadAllObjects } from "./world/AllObjectsLoader";
import { ChainBlockLayer } from "./world/ChainBlockLayer";
import { SlabLayer } from "./world/SlabLayer";
import { CrossPostLayer } from "./world/CrossPostLayer";
import { DoorLayer } from "./world/DoorLayer";
import { StairLayer } from "./world/StairLayer";
import { raycastWithNormal } from "./world/raycast";
import { spawnBulletHole } from "./world/BulletHoles";
import { setupMobileControls, type MobileControls } from "./ui/mobileHud";

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
// Using a separate THREE.Scene + camera so the weapon is never clipped by
// world geometry and doesn't need depthTest hacks.

const weaponScene  = new THREE.Scene();
const weaponCamera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.01, 10);
weaponScene.add(new THREE.AmbientLight(0xffffff, 1.0));
const weaponSun = new THREE.DirectionalLight(0xffffff, 0.6);
weaponSun.position.set(1, 2, 1);
weaponScene.add(weaponSun);

// Weapon group: positioned in front-right of the weapon camera (view space offset).
// Everything inside this group moves with the weapon camera.
const weaponGroup = new THREE.Group();
weaponCamera.add(weaponGroup);
weaponScene.add(weaponCamera);

// Initial view-space offset: right/down/forward in camera local space.
// The GLB will be added inside weaponGroup; scale/orientation adjusted after load.
const WEAPON_OFFSET = new THREE.Vector3(0.18, -0.22, -0.34);

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

// ── Load AK-47 GLB model ─────────────────────────────────────────────────────

const gltfLoader = new GLTFLoader();
gltfLoader.load(
  "/models/ak47.glb",
  (gltf) => {
    const model = gltf.scene;

    // ── Scale & pivot ────────────────────────────────────────────────────────
    // Native model: barrel along +X (x=2.172, y=0.630, z=0.138 units).
    // Scale so the full gun length fits ~0.55 weapon-view units.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z); // = size.x (barrel)
    const targetSize = 0.76;
    model.scale.setScalar(targetSize / maxDim);

    // Center, then shift pivot so the trigger/grip area sits at the group origin
    // (trigger is ~35 % from barrel tip = ~65 % from stock end along +X).
    box.setFromObject(model);
    const center = new THREE.Vector3();
    box.getCenter(center);
    model.position.sub(center);
    // Grip offset: shift +X a bit so grip (not centre) is at group origin.
    // scaledfullLength ≈ 0.55; 15 % of that toward barrel
    // Barrel is along +X in model space.
    // rotation.y = +π/2 sends +X → -Z (forward into screen). ✓
    // Pivot: push model toward stock so trigger area sits at group origin.
    // Pivot: center of bounding box at group origin; barrel tip is at model +X end.
    // Z offset: push gun slightly forward so more barrel is visible.
    model.position.x += 0.04;
    model.position.y -= 0.02;
    model.position.z += 0.10;

    // Back to v9-style rotation (user approved basic look) with only ry fixed:
    // v9 had ry = PI/2 - 0.07 → barrel tilted slightly RIGHT of crosshair.
    // Fix: ry = PI/2 + 0.05 → barrel tilts slightly LEFT toward crosshair.
    // rz=0.30 gives the visual roll (receiver top visible) without breaking barrel aim.
    model.rotation.order = 'YXZ';
    model.rotation.set(
      0.05,                // X: minimal pitch
      Math.PI / 2 + 0.05, // Y: barrel into screen + tiny left tilt (fixes v9's right-of-crosshair)
      0.30,               // Z: ~17° roll — same as v9 which user approved
    );

    weaponGroup.position.copy(WEAPON_OFFSET);
    weaponGroup.add(model);

    // Make weapon materials not affected by world lighting (render in weapon scene)
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(m => {
          (m as THREE.MeshStandardMaterial).envMapIntensity = 0;
        });
      }
    });

    console.log("[AK47] model loaded, size x/y/z:", size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3), "scale:", (targetSize / maxDim).toFixed(4));
    (window as any).__ak47model = model;
  },
  undefined,
  (err) => console.error("[AK47] GLB load error:", err),
);

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

  // Sync weapon camera to main camera orientation (but independent position)
  weaponCamera.rotation.copy(controller.camera.rotation);
  weaponCamera.updateMatrixWorld(true);

  // Apply visual model kick from AK-47 recoil
  const ak = controller.ak47;
  weaponGroup.position.copy(WEAPON_OFFSET);
  weaponGroup.position.y -= ak.modelKickPitch * 0.3;  // kick down (screen kicks up)
  weaponGroup.position.z += ak.modelKickPitch * 0.1;  // push back slightly
  weaponGroup.rotation.x  = ak.modelKickPitch * 0.4;  // tilt barrel up

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
    `\npos  ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}` +
    `\npitch ${pitch.toFixed(4)}  yaw ${yaw.toFixed(4)}` +
    `\nspawn.json → {"x":${p.x.toFixed(3)},"y":${p.y.toFixed(3)},"z":${p.z.toFixed(3)},"pitch":${pitch.toFixed(4)},"yaw":${yaw.toFixed(4)}}` +
    `\ngrounded ${controller.physics.grounded}  block_at[${by}]=${blockAt}` +
    `\ntriangles ${tris.toLocaleString()}  draw calls ${calls}`,
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
(window as any).__weaponGroup = weaponGroup;
