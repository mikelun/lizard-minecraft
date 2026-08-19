// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Bullet hole decal system — canvas-texture PlaneGeometry pool.
// spawnBulletHole() is called from the shot handler in main.ts after a hit.

import * as THREE from "three";

const HOLE_SIZE  = 0.22;   // world units (≈ 3.5 px on a 16×16 Minecraft block)
const MAX_HOLES  = 128;    // oldest recycled when exceeded
const DEPTH_PUSH = 0.008;  // push off surface to prevent z-fighting

// ── Texture (canvas procedural) ───────────────────────────────────────────────

function makeHoleTexture(): THREE.Texture {
  const S = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const r = S / 2;

  // Plain black circle — solid center, soft-fading edge so it isn't a hard disc.
  const hole = ctx.createRadialGradient(r, r, 0, r, r, r * 0.48);
  hole.addColorStop(0,   "rgba(0,0,0,0.97)");
  hole.addColorStop(0.8, "rgba(0,0,0,0.97)");
  hole.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(r, r, r * 0.48, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const _holeTex = makeHoleTexture();
const _holeMat = new THREE.MeshBasicMaterial({
  map:                  _holeTex,
  transparent:          true,
  depthWrite:           false,
  polygonOffset:        true,
  polygonOffsetFactor:  -2,
  polygonOffsetUnits:   -2,
  side:                 THREE.FrontSide,
});
const _holeGeo = new THREE.PlaneGeometry(HOLE_SIZE, HOLE_SIZE);

// ── Pool ──────────────────────────────────────────────────────────────────────

const _pool: THREE.Mesh[] = [];
let   _next = 0;
let   _scene: THREE.Scene | null = null;

function getSlot(scene: THREE.Scene): THREE.Mesh {
  _scene = scene;
  if (_pool.length < MAX_HOLES) {
    const m = new THREE.Mesh(_holeGeo, _holeMat);
    m.visible = false;
    m.matrixAutoUpdate = false;
    scene.add(m);
    _pool.push(m);
    return m;
  }
  return _pool[_next++ % MAX_HOLES];
}

// ── Public API ────────────────────────────────────────────────────────────────

const _Z = new THREE.Vector3(0, 0, 1);

export function spawnBulletHole(
  scene: THREE.Scene,
  point: THREE.Vector3,
  normal: THREE.Vector3,
): void {
  const mesh = getSlot(scene);

  // Position
  mesh.position.copy(point).addScaledVector(normal, DEPTH_PUSH);

  // Orient: local +Z aligns with surface normal, then random spin for variety
  const q = new THREE.Quaternion().setFromUnitVectors(_Z, normal.clone().normalize());
  const spin = new THREE.Quaternion().setFromAxisAngle(_Z, Math.random() * Math.PI * 2);
  mesh.quaternion.multiplyQuaternions(q, spin);

  mesh.updateMatrix();
  mesh.visible = true;
}
