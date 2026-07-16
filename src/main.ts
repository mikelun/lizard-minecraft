// NEW bootstrap: scene/renderer setup, game loop, target-block outline, HUD wiring.

import * as THREE from "three";
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
// Fill light from south to illuminate stair risers and other north-facing faces
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

// Load spawn position from world/spawn.json (written by convert_world.py).
// Falls back to a safe default if the file is missing.
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

// Load all block_display objects from the CS:GO Dust_2 world (includes the car).
loadAllObjects(scene);

const controller = new PlayerController(
  world,
  renderer.domElement,
  window.innerWidth / window.innerHeight,
  new THREE.Vector3(spawnX, spawnY, spawnZ),
);
// Apply spawn camera orientation if provided
if (spawnPitch !== 0 || spawnYaw !== 0) {
  controller.fpCamera.pitch = spawnPitch;
  controller.fpCamera.yaw = spawnYaw;
  controller.fpCamera.camera.rotation.set(spawnPitch, spawnYaw, 0, "YXZ");
}

const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
const outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x000000 }));
outline.visible = false;
scene.add(outline);

const hud = createHud(app);

window.addEventListener("resize", () => {
  controller.camera.aspect = window.innerWidth / window.innerHeight;
  controller.camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastTime = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  hud.showPrompt(!controller.locked);
  hud.setSelected(controller.selectedIndex);

  controller.update(dt);
  world.update(controller.physics.position);

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
  renderer.render(scene, controller.camera);

  const tris = renderer.info.render.triangles;
  const calls = renderer.info.render.calls;
  hud.setDebugText(
    `FPS ${fps}` +
    `\npos  ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}` +
    `\npitch ${pitch.toFixed(4)}  yaw ${yaw.toFixed(4)}` +
    `\nspawn.json → {"x":${p.x.toFixed(3)},"y":${p.y.toFixed(3)},"z":${p.z.toFixed(3)},"pitch":${pitch.toFixed(4)},"yaw":${yaw.toFixed(4)}}` +
    `\ngrounded ${controller.physics.grounded}  block_at[${by}]=${blockAt}` +
    `\ntriangles ${tris.toLocaleString()}  draw calls ${calls}`,
  );
}
requestAnimationFrame(tick);

// Expose internals for screenshot tooling
(window as any).__game = { controller, renderer, scene };
