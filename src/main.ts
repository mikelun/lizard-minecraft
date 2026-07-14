// NEW bootstrap: scene/renderer setup, game loop, target-block outline, HUD wiring.

import * as THREE from "three";
import { World } from "./world/World";
import { PlayerController } from "./player/Controller";
import { createHud } from "./ui/hud";
import { buildBlockTextureAtlas } from "./textures/blockTextures";

const app = document.getElementById("app")!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0x8fc7ff);
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor.getHex(), 60, 220);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(80, 120, 40);
scene.add(sun);

const atlas = await buildBlockTextureAtlas();
const world = new World(atlas);
scene.add(world.mesh);

// MC world Dust_2 spawn: MC coords (1, -28, -34) → game coords (1, 36, -34).
// The terrain worker loads asynchronously, so we pick a fixed spawn above the
// highest possible block (game Y 47) and let gravity drop the player onto the
// map surface once chunks stream in.
const spawnX = 1.5, spawnZ = -33.5;
const spawnY = 50; // above the top of the MC world (game Y 47)
const controller = new PlayerController(
  world,
  renderer.domElement,
  window.innerWidth / window.innerHeight,
  new THREE.Vector3(spawnX, spawnY, spawnZ),
);

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
  hud.setDebugText(
    `FPS ${fps}\npos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}\ngrounded ${controller.physics.grounded}`,
  );

  renderer.render(scene, controller.camera);
}
requestAnimationFrame(tick);
