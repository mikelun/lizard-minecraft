// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Small ambient wildlife: low-poly voxel lizards that wander the map, matching
// the brand's teal lizard mark. Purely decorative — no collision, no AI beyond
// "pick a nearby point, run to it, pause, repeat."

import * as THREE from "three";
import type { World } from "./World";

const BODY_COLOR = 0x2dd4bf; // teal — matches the lizard.build mark
const ACCENT_COLOR = 0x0f766e; // darker teal for head/tail/legs

const RUN_SPEED   = 3.2;  // units/sec
const WANDER_MIN  = 2;    // min distance to next wander target
const WANDER_MAX  = 7;    // max distance to next wander target
const IDLE_MIN    = 1.2;  // seconds
const IDLE_MAX    = 3.5;
const ARRIVE_EPS  = 0.15;
const TURN_RATE   = 8;    // yaw lerp speed
const GAIT_RATE   = 10;   // leg-swing speed while running

interface Leg {
  pivot: THREE.Group;
  phaseOffset: number;
}

interface LizardInstance {
  root: THREE.Group;
  legs: Leg[];
  tailPivot: THREE.Group;
  x: number; z: number; // feet position (y is derived from terrain each step)
  targetX: number; targetZ: number;
  running: boolean;
  idleTimer: number;
  gaitPhase: number;
  yaw: number;
}

function buildLizardMesh(): { root: THREE.Group; legs: Leg[]; tailPivot: THREE.Group } {
  const root = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.75 });
  const accentMat = new THREE.MeshStandardMaterial({ color: ACCENT_COLOR, roughness: 0.75 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.5), bodyMat);
  body.position.set(0, 0.16, 0);
  root.add(body);

  // Forward is local -Z, matching the rest of the codebase's facing convention.
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.16), accentMat);
  head.position.set(0, 0.17, -0.32);
  root.add(head);

  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.16, 0.25);
  root.add(tailPivot);
  const tailSeg1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.22), accentMat);
  tailSeg1.position.set(0, 0, 0.11);
  tailPivot.add(tailSeg1);
  const tailSeg2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.2), accentMat);
  tailSeg2.position.set(0, -0.01, 0.32);
  tailPivot.add(tailSeg2);

  const legGeo = new THREE.BoxGeometry(0.05, 0.16, 0.05);
  const legDefs: [number, number][] = [
    [-0.11, -0.18], [0.11, -0.18], // front-left, front-right
    [-0.11, 0.16],  [0.11, 0.16],  // back-left, back-right
  ];
  const legs: Leg[] = legDefs.map(([lx, lz], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(lx, 0.16, lz);
    root.add(pivot);
    const leg = new THREE.Mesh(legGeo, accentMat);
    leg.position.set(0, -0.08, 0);
    pivot.add(leg);
    // Diagonal trot: front-left+back-right swing together, opposite the other pair.
    const phaseOffset = (i === 0 || i === 3) ? 0 : Math.PI;
    return { pivot, phaseOffset };
  });

  return { root, legs, tailPivot };
}

export class LizardSwarm {
  private lizards: LizardInstance[] = [];

  constructor(private scene: THREE.Scene, private world: World) {}

  /** Spawns `count` lizards scattered within the given XZ bounds. */
  spawn(count: number, minX: number, maxX: number, minZ: number, maxZ: number) {
    for (let i = 0; i < count; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const y = this.world.surfaceHeightAt(x, z) + 1;

      const { root, legs, tailPivot } = buildLizardMesh();
      const yaw = Math.random() * Math.PI * 2;
      root.position.set(x, y, z);
      root.rotation.y = yaw;
      this.scene.add(root);

      this.lizards.push({
        root, legs, tailPivot,
        x, z, targetX: x, targetZ: z,
        running: false,
        idleTimer: IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN),
        gaitPhase: Math.random() * Math.PI * 2,
        yaw,
      });
    }
  }

  private pickTarget(l: LizardInstance, minX: number, maxX: number, minZ: number, maxZ: number) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
    l.targetX = THREE.MathUtils.clamp(l.x + Math.cos(angle) * dist, minX, maxX);
    l.targetZ = THREE.MathUtils.clamp(l.z + Math.sin(angle) * dist, minZ, maxZ);
    l.running = true;
  }

  update(dt: number, minX: number, maxX: number, minZ: number, maxZ: number) {
    for (const l of this.lizards) {
      if (!l.running) {
        l.idleTimer -= dt;
        if (l.idleTimer <= 0) this.pickTarget(l, minX, maxX, minZ, maxZ);
      } else {
        const dx = l.targetX - l.x;
        const dz = l.targetZ - l.z;
        const dist = Math.hypot(dx, dz);
        if (dist < ARRIVE_EPS) {
          l.running = false;
          l.idleTimer = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
        } else {
          const step = Math.min(dist, RUN_SPEED * dt);
          l.x += (dx / dist) * step;
          l.z += (dz / dist) * step;

          // Forward is local -Z: root.rotation.y = θ maps -Z to (-sinθ,-cosθ),
          // so facing the travel direction (dx,dz) needs θ = atan2(-dx,-dz)
          // (same convention main.ts uses for steveYaw).
          const targetYaw = Math.atan2(-dx, -dz);
          let dYaw = targetYaw - l.yaw;
          while (dYaw >  Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          l.yaw += dYaw * Math.min(1, dt * TURN_RATE);
          l.gaitPhase += dt * GAIT_RATE;
        }
      }

      const y = this.world.surfaceHeightAt(l.x, l.z) + 1;
      l.root.position.set(l.x, y, l.z);
      l.root.rotation.y = l.yaw;

      for (const leg of l.legs) {
        leg.pivot.rotation.x = l.running ? Math.sin(l.gaitPhase + leg.phaseOffset) * 0.6 : 0;
      }
      l.tailPivot.rotation.y = l.running
        ? Math.sin(l.gaitPhase * 0.6) * 0.35
        : Math.sin(performance.now() / 900 + l.yaw) * 0.08;
    }
  }
}
