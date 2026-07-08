// NEW bootstrap: scene/renderer setup, game loop, target-block outline, HUD wiring.

import * as THREE from "three";
import { World } from "./world/World";
import { PlayerController } from "./player/Controller";
import { createHud } from "./ui/hud";

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

const world = new World();
scene.add(world.mesh);

// Search a small ring of columns around the origin for a locally flat spot
// to spawn on (the heightmap has a large amplitude, so (0,0) itself can land
// on a steep slope or cliff edge). Spawn at the CENTER of a column, not its
// corner: the player's AABB is narrower than a block but not by much, so
// starting exactly on an integer (block-corner) coordinate lets it straddle
// two voxel columns and can wedge it against whichever neighbor is taller.
function pickSpawnColumn(): { x: number; z: number } {
  let best = { x: 0, z: 0 };
  let bestVariance = Infinity;
  for (let x = -16; x <= 16; x += 4) {
    for (let z = -16; z <= 16; z += 4) {
      const h = world.surfaceHeightAt(x + 0.5, z + 0.5);
      const hx = world.surfaceHeightAt(x + 1.5, z + 0.5);
      const hz = world.surfaceHeightAt(x + 0.5, z + 1.5);
      const variance = Math.abs(hx - h) + Math.abs(hz - h);
      if (variance < bestVariance) {
        bestVariance = variance;
        best = { x, z };
      }
    }
  }
  return best;
}

const spawnColumn = pickSpawnColumn();
const spawnX = spawnColumn.x + 0.5, spawnZ = spawnColumn.z + 0.5;
const spawnY = world.surfaceHeightAt(spawnX, spawnZ) + 1;
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
