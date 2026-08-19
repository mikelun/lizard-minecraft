// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Small ambient wildlife: low-poly voxel lizards that wander the map, matching
// the brand's teal lizard mark. Walks the real terrain — solid walls block
// movement, half-height slabs/stairs are respected — and wander targets that
// would require climbing more than a small step are rejected up front.

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
const HALF_WIDTH  = 0.14; // footprint half-width, used for wall probes
const BODY_HEIGHT = 0.35;
const STEP_LIMIT  = 0.55; // max climbable rise per step (matches a slab/stair half-block)
const VERTICAL_SMOOTH = 10; // exponential lerp rate for the visual Y (no popping on ledges)

// ── Ground height, matching Physics.ts's simplified half-block model ──────────
// (bottom slabs/stairs: top surface at y+0.5; everything else: top surface at y+1)
function groundSurfaceY(world: World, x: number, z: number): number {
  const topY = world.surfaceHeightAt(x, z);
  const id = world.getBlock(x, topY, z);
  if (id >= 38 && id <= 44) return topY + 0.5;  // bottom slab
  if (id >= 50 && id <= 113) return topY + 0.5; // stairs (treated as bottom-half, like Physics.ts)
  return topY + 1;
}

// True if a lizard standing at (fromX,fromZ) can step to (toX,toZ) — rejects walls
// and anything taller than a small step, but allows gentle terrain and slabs/stairs.
function canStepTo(world: World, fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const fromY = groundSurfaceY(world, fromX, fromZ);
  const toY   = groundSurfaceY(world, toX, toZ);
  return Math.abs(toY - fromY) <= STEP_LIMIT;
}

interface Leg {
  pivot: THREE.Group;
  phaseOffset: number;
}

interface LizardInstance {
  root: THREE.Group;
  legs: Leg[];
  tailPivot: THREE.Group;
  box: THREE.Box3;
  x: number; z: number;      // logical feet position (XZ)
  visualY: number;           // smoothed render Y — lags behind the real ground height
  targetX: number; targetZ: number;
  running: boolean;
  dead: boolean;
  idleTimer: number;
  gaitPhase: number;
  yaw: number;
}

const RESPAWN_DELAY_MS = 5000;

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

export interface LizardHit {
  index: number;
  pos: THREE.Vector3;
}

export class LizardSwarm {
  private lizards: LizardInstance[] = [];
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  constructor(private scene: THREE.Scene, private world: World) {}

  /** Spawns `count` lizards scattered within the given XZ bounds. */
  spawn(count: number, minX: number, maxX: number, minZ: number, maxZ: number) {
    this.bounds = { minX, maxX, minZ, maxZ };
    for (let i = 0; i < count; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const y = groundSurfaceY(this.world, x, z);

      const { root, legs, tailPivot } = buildLizardMesh();
      const yaw = Math.random() * Math.PI * 2;
      root.position.set(x, y, z);
      root.rotation.y = yaw;
      this.scene.add(root);

      this.lizards.push({
        root, legs, tailPivot,
        box: new THREE.Box3(),
        x, z, visualY: y, targetX: x, targetZ: z,
        running: false,
        dead: false,
        idleTimer: IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN),
        gaitPhase: Math.random() * Math.PI * 2,
        yaw,
      });
    }
  }

  /** Hides a lizard and respawns it elsewhere on the map after a short delay. */
  die(index: number) {
    const l = this.lizards[index];
    if (!l || l.dead) return;
    l.dead = true;
    l.running = false;
    l.root.visible = false;
    setTimeout(() => {
      const { minX, maxX, minZ, maxZ } = this.bounds;
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const y = groundSurfaceY(this.world, x, z);
      l.x = x; l.z = z; l.visualY = y;
      l.targetX = x; l.targetZ = z;
      l.yaw = Math.random() * Math.PI * 2;
      l.root.position.set(x, y, z);
      l.root.rotation.y = l.yaw;
      l.dead = false;
      l.root.visible = true;
    }, RESPAWN_DELAY_MS);
  }

  private pickTarget(l: LizardInstance, minX: number, maxX: number, minZ: number, maxZ: number) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
    const tx = THREE.MathUtils.clamp(l.x + Math.cos(angle) * dist, minX, maxX);
    const tz = THREE.MathUtils.clamp(l.z + Math.sin(angle) * dist, minZ, maxZ);
    // Reject targets that would require climbing a wall — just stay idle a beat
    // longer and try again next tick rather than committing to a blocked path.
    if (!canStepTo(this.world, l.x, l.z, tx, tz)) return;
    l.targetX = tx;
    l.targetZ = tz;
    l.running = true;
  }

  update(dt: number, minX: number, maxX: number, minZ: number, maxZ: number) {
    for (const l of this.lizards) {
      if (l.dead) continue;
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
          const nx = l.x + (dx / dist) * step;
          const nz = l.z + (dz / dist) * step;
          if (canStepTo(this.world, l.x, l.z, nx, nz)) {
            l.x = nx;
            l.z = nz;
          } else {
            // Hit a wall mid-run — stop and pick a fresh target rather than
            // grinding against it every frame.
            l.running = false;
            l.idleTimer = IDLE_MIN * 0.5;
          }

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

      // Smooth the visual Y toward the real ground height instead of snapping —
      // ledges, slab edges, and stair steps glide instead of popping.
      const targetY = groundSurfaceY(this.world, l.x, l.z);
      l.visualY += (targetY - l.visualY) * Math.min(1, dt * VERTICAL_SMOOTH);

      l.root.position.set(l.x, l.visualY, l.z);
      l.root.rotation.y = l.yaw;

      for (const leg of l.legs) {
        leg.pivot.rotation.x = l.running ? Math.sin(l.gaitPhase + leg.phaseOffset) * 0.6 : 0;
      }
      l.tailPivot.rotation.y = l.running
        ? Math.sin(l.gaitPhase * 0.6) * 0.35
        : Math.sin(performance.now() / 900 + l.yaw) * 0.08;

      l.box.min.set(l.x - HALF_WIDTH, l.visualY, l.z - HALF_WIDTH);
      l.box.max.set(l.x + HALF_WIDTH, l.visualY + BODY_HEIGHT, l.z + HALF_WIDTH);
    }
  }

  /** Closest lizard hit by a ray, or null. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3): LizardHit | null {
    const ray = new THREE.Ray(origin, direction.clone().normalize());
    const hitPt = new THREE.Vector3();
    let best = Infinity, bestIndex = -1;
    const bestPt = new THREE.Vector3();
    for (let i = 0; i < this.lizards.length; i++) {
      if (this.lizards[i].dead) continue;
      const result = ray.intersectBox(this.lizards[i].box, hitPt);
      if (result !== null) {
        const dist = origin.distanceTo(hitPt);
        if (dist < best) { best = dist; bestIndex = i; bestPt.copy(hitPt); }
      }
    }
    return bestIndex === -1 ? null : { index: bestIndex, pos: bestPt.clone() };
  }
}
