// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Reimplements the voxel-AABB collision core of
// escape-tsuami-client/src/game/player/physics.ts (buildPlayerBoxAt,
// collectNearbyVoxelBoxes, moveAxisWithStep's auto-step-up-a-ledge behavior,
// gravity/jump) against this project's World instead of porting the file
// verbatim -- the source version is ~60% multiplayer/engine-object collision,
// websocket joystick sync and editor branches that don't apply here, so a
// fresh, focused implementation was clearer than stripping that down.
// Tuning constants (STEP_HEIGHT, GRAVITY, TERMINAL_VELOCITY, jump force) are
// kept the same as the source for a familiar feel.

import * as THREE from "three";
import type { World } from "../world/World";
import { getNearbyObjectOBBs, type ObjectOBB } from "../world/AllObjectsLoader";

const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const CROUCH_HEIGHT = 1.2;
const CROUCH_EYE_HEIGHT = 1.0;
const CROUCH_SPEED = 3.4;

// 1.05 lets the player step up stairs (adjacent stair tops are 1.0 apart)
// and half-slabs, while still blocking 2-block walls.
const STEP_HEIGHT = 1.05;
const GRAVITY = 50;
const TERMINAL_VELOCITY = -50;
const JUMP_FORCE = 15;
const WALK_SPEED = 5;
const SLOW_SPEED = 2.5;
const FLY_SPEED = 20;
const FLY_VERTICAL_SPEED = 15;

interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

// SAT (separating-axis theorem) test between the player's axis-aligned box and a
// custom object's real oriented box. An AABB-vs-AABB test against a rotated object's
// axis-aligned bounding box would over-block — the AABB of a tilted box always
// overhangs its true edges. Testing all 15 candidate axes (the box's own 3 faces,
// the OBB's 3 faces, and their 9 pairwise cross products) is the standard exact
// box-vs-box test and makes the collidable region match the rendered shape exactly.
const _satD        = new THREE.Vector3();
const _satAxis     = new THREE.Vector3();
const _satAabbHalf = new THREE.Vector3();
const _WORLD_AXES  = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

function satAxisSeparates(
  axis: THREE.Vector3,
  aabbCenterX: number, aabbCenterY: number, aabbCenterZ: number,
  aabbHalf: THREE.Vector3,
  obb: ObjectOBB,
): boolean {
  const lenSq = axis.lengthSq();
  if (lenSq < 1e-10) return false; // degenerate (parallel) axis — no info, not separating
  _satAxis.copy(axis).multiplyScalar(1 / Math.sqrt(lenSq));

  _satD.set(obb.center.x - aabbCenterX, obb.center.y - aabbCenterY, obb.center.z - aabbCenterZ);
  const dist = Math.abs(_satD.dot(_satAxis));

  const r1 =
    aabbHalf.x * Math.abs(_satAxis.x) +
    aabbHalf.y * Math.abs(_satAxis.y) +
    aabbHalf.z * Math.abs(_satAxis.z);
  const r2 =
    obb.halfX * Math.abs(_satAxis.dot(obb.axisX)) +
    obb.halfY * Math.abs(_satAxis.dot(obb.axisY)) +
    obb.halfZ * Math.abs(_satAxis.dot(obb.axisZ));

  return dist > r1 + r2;
}

function obbOverlapsAABB(box: AABB, obb: ObjectOBB): boolean {
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, cz = (box.minZ + box.maxZ) / 2;
  _satAabbHalf.set((box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2, (box.maxZ - box.minZ) / 2);

  for (const ax of _WORLD_AXES) {
    if (satAxisSeparates(ax, cx, cy, cz, _satAabbHalf, obb)) return false;
  }
  const obbAxes = [obb.axisX, obb.axisY, obb.axisZ];
  for (const ax of obbAxes) {
    if (satAxisSeparates(ax, cx, cy, cz, _satAabbHalf, obb)) return false;
  }
  for (const wa of _WORLD_AXES) {
    for (const oa of obbAxes) {
      if (satAxisSeparates(new THREE.Vector3().crossVectors(wa, oa), cx, cy, cz, _satAabbHalf, obb)) return false;
    }
  }
  return true; // no separating axis found on any of the 15 candidates — boxes overlap
}


export class PlayerPhysics {
  readonly position: THREE.Vector3; // feet, center of the box's base
  readonly velocity = new THREE.Vector3();
  grounded = false;
  flying = false;
  crouching = false;

  /** Smoothed Y for the camera eye — lags behind position.y on step-ups so
   *  the view glides up rather than cutting. Physics always uses position.y. */
  smoothY: number;

  // True while the camera is still gliding up from a half-block step-up.
  // Cleared on landing or when a real jump is initiated so jumps feel snappy.
  private _stepping = false;

  private readonly spawn: THREE.Vector3;

  // Pre-allocated temporaries — reused every frame to avoid GC pressure.
  private readonly _tmpA  = new THREE.Vector3();
  private readonly _tmpC  = new THREE.Vector3();
  private readonly _aabb: AABB = { minX:0, minY:0, minZ:0, maxX:0, maxY:0, maxZ:0 };

  constructor(private world: World, spawn: THREE.Vector3) {
    this.spawn = spawn.clone();
    this.position = spawn.clone();
    this.smoothY = spawn.y;
  }

  respawn() {
    this.position.copy(this.spawn);
    this.smoothY = this.spawn.y;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }

  get eyeHeight() {
    return this.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
  }

  private currentHeight() {
    return this.crouching ? CROUCH_HEIGHT : HEIGHT;
  }

  private aabbAt(pos: THREE.Vector3): AABB {
    const h = this.currentHeight();
    this._aabb.minX = pos.x - HALF_WIDTH; this._aabb.maxX = pos.x + HALF_WIDTH;
    this._aabb.minY = pos.y;              this._aabb.maxY = pos.y + h;
    this._aabb.minZ = pos.z - HALF_WIDTH; this._aabb.maxZ = pos.z + HALF_WIDTH;
    return this._aabb;
  }

  /** Returns whether block (bx,by,bz) collides with the player AABB whose
   *  Y extent is [boxMinY, boxMaxY].  Bottom slabs occupy only the lower half
   *  of their voxel; top slabs occupy only the upper half. */
  private blockSolid(bx: number, by: number, bz: number, boxMinY: number, boxMaxY: number): boolean {
    const id = this.world.getBlock(bx, by, bz);
    if (id === 0) return false;
    // Bottom slabs: IDs 38-44 — solid region is by..by+0.5
    if (id >= 38 && id <= 44) return boxMinY < by + 0.5;
    // Top slabs: IDs 178-184 — solid region is by+0.5..by+1
    if (id >= 178 && id <= 184) return boxMaxY > by + 0.5;
    // Stairs: IDs 50-113 — treat as bottom slab for physics (y..y+0.5).
    // Each stair step rises 1 full block, so STEP_HEIGHT=1.05 handles the
    // 1.0-block gap between adjacent stair tops (0.5 → 1.5 → 2.5...).
    if (id >= 50 && id <= 113) return boxMinY < by + 0.5;
    return this.world.isSolid(bx, by, bz);
  }

  private collides(box: AABB): boolean {
    const x0 = Math.floor(box.minX), x1 = Math.floor(box.maxX - 1e-6);
    const y0 = Math.floor(box.minY), y1 = Math.floor(box.maxY - 1e-6);
    const z0 = Math.floor(box.minZ), z1 = Math.floor(box.maxZ - 1e-6);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.blockSolid(x, y, z, box.minY, box.maxY)) return true;
        }
      }
    }

    // Decorative AllObjects entities (car, props) live outside the world.bin
    // voxel grid — collide against their real ORIENTED boxes via SAT, so the
    // collidable region matches the rendered shape exactly, at any rotation.
    const nearby = getNearbyObjectOBBs(box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ);
    for (const obb of nearby) {
      if (obbOverlapsAABB(box, obb)) return true;
    }
    return false;
  }

  /** Moves along one world axis by `delta`, stepping in small increments and
   * stopping just short of the first collision. Returns how far it actually moved. */
  private sweepAxis(axis: "x" | "y" | "z", delta: number): number {
    if (delta === 0) return 0;
    const step = 0.05;
    const dir = Math.sign(delta);
    let remaining = Math.abs(delta);
    let moved = 0;
    while (remaining > 0) {
      const d = Math.min(step, remaining);
      this._tmpA.copy(this.position);
      this._tmpA[axis] += moved + d * dir;
      if (this.collides(this.aabbAt(this._tmpA))) break;
      moved += d * dir;
      remaining -= d;
    }
    this.position[axis] += moved;
    return moved;
  }

  private moveY(dy: number) {
    const moved = this.sweepAxis("y", dy);
    if (Math.abs(moved) < Math.abs(dy) - 1e-6) this.velocity.y = 0;
  }

  // Largest fraction of `delta` (in [0,1]) the player can move along `axis`
  // without colliding. Handles the case where the full step is blocked but a
  // partial one isn't -- e.g. the player is already flush against a block
  // boundary (a neighboring column's box slightly overlaps its own) and
  // needs to be able to slide away rather than freeze entirely.
  private maxSafeFraction(axis: "x" | "z", delta: number): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      this._tmpA.copy(this.position);
      this._tmpA[axis] += delta * mid;
      if (this.collides(this.aabbAt(this._tmpA))) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  private moveAxisWithStep(axis: "x" | "z", delta: number) {
    if (delta === 0) return;

    // _tmpA = target (move along axis)
    this._tmpA.copy(this.position);
    this._tmpA[axis] += delta;
    if (!this.collides(this.aabbAt(this._tmpA))) {
      this.position[axis] = this._tmpA[axis];
      return;
    }

    // Blocked at current height. Only auto-step when grounded — prevents
    // airborne clipping against stair sides or half-block edges from
    // teleporting the player upward.
    if (!this.grounded) {
      const safeFraction = this.maxSafeFraction(axis, delta);
      if (safeFraction > 0.001) this.position[axis] += delta * safeFraction;
      return;
    }

    // Scan downward from the max step height for the ACTUAL floor at the
    // forward position — not the first clear height found (that over-selects
    // the very top of the range whenever the area ahead is simply open air,
    // e.g. approaching any ledge with clearance above it, which reported
    // `needed` as a near-full STEP_HEIGHT and force-jumped on every single
    // slab/stair instead of stepping smoothly) and not gated on the full
    // STEP_HEIGHT raise being clear up front either (that over-rejected a
    // real, walkable small step whenever the ceiling clearance was enough for
    // the actual step but less than the full STEP_HEIGHT constant).
    //
    // Correct rule: walk down from the top of the range. Skip past a ceiling
    // if the very top is blocked. Once clear, keep tracking the lowest still-
    // clear Y — that's the true floor surface — and stop at the first
    // collision after being clear (the floor itself).
    let landY: number | null = null;
    for (let testY = this.position.y + STEP_HEIGHT; testY > this.position.y + 1e-6; testY -= 0.05) {
      this._tmpC.copy(this.position);
      this._tmpC.y = testY;
      this._tmpC[axis] += delta;
      if (!this.collides(this.aabbAt(this._tmpC))) {
        landY = testY;
      } else if (landY !== null) {
        break; // was clear, now blocked — landY is the floor surface
      }
      // else: still inside a ceiling/obstruction near the top — keep descending
    }

    if (landY === null) {
      const safeFraction = this.maxSafeFraction(axis, delta);
      if (safeFraction > 0.001) {
        this.position[axis] += delta * safeFraction;
        return;
      }
      this.velocity[axis] = 0;
      return;
    }

    const needed = landY - this.position.y;
    if (needed <= 0.55) {
      // Half-block step (slab, stair top): snap position so horizontal movement
      // isn't stalled, then let smoothY glide the camera up slowly.
      this.position.y = landY;
      this.position[axis] += delta;
      this._stepping = true;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      // Full-block ledge: force a jump so the player hops over naturally.
      if (this.velocity.y <= 0) {
        this.velocity.y = JUMP_FORCE;
        this._stepping = false;
      }
    }
  }

  private checkGrounded(): boolean {
    this._tmpA.copy(this.position);
    this._tmpA.y -= 0.05;
    return this.collides(this.aabbAt(this._tmpA));
  }

  jump() {
    if (this.flying) return;
    if (this.grounded) {
      this.velocity.y = JUMP_FORCE;
      this._stepping = false;
      this.smoothY = this.position.y; // snap now, not next frame
      this.grounded = false;
    }
  }

  update(dt: number, wishX: number, wishZ: number, slow: boolean, wishY = 0) {
    dt = Math.min(dt, 1 / 20);
    if (this.position.y < -5) { this.respawn(); return; }

    if (this.flying) {
      // Normalize the full 3D wish vector so diagonal flight doesn't go faster.
      const fullLen = Math.hypot(wishX, wishY, wishZ);
      if (fullLen > 0) {
        this.position.x += (wishX / fullLen) * FLY_SPEED * dt;
        this.position.y += (wishY / fullLen) * FLY_SPEED * dt;
        this.position.z += (wishZ / fullLen) * FLY_SPEED * dt;
      }
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
      this.grounded = false;
      return;
    }

    this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, TERMINAL_VELOCITY);

    // If crouching was cleared this frame, check that standing up won't embed us in a block.
    if (!this.crouching) {
      // Temporarily force full height into the shared AABB (bypasses aabbAt's crouching branch).
      const p = this.position;
      this._aabb.minX = p.x - HALF_WIDTH; this._aabb.maxX = p.x + HALF_WIDTH;
      this._aabb.minY = p.y;              this._aabb.maxY = p.y + HEIGHT;
      this._aabb.minZ = p.z - HALF_WIDTH; this._aabb.maxZ = p.z + HALF_WIDTH;
      if (this.collides(this._aabb)) this.crouching = true;
    }

    const speed = this.crouching ? CROUCH_SPEED : slow ? SLOW_SPEED : WALK_SPEED;
    const len = Math.hypot(wishX, wishZ) || 1;
    const vx = wishX !== 0 || wishZ !== 0 ? (wishX / len) * speed : 0;
    const vz = wishX !== 0 || wishZ !== 0 ? (wishZ / len) * speed : 0;

    // Store XZ speed so external systems (crosshair, etc.) can read it.
    this.velocity.x = vx;
    this.velocity.z = vz;

    this.moveY(this.velocity.y * dt);
    this.grounded = this.checkGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    this.moveAxisWithStep("x", vx * dt);
    this.moveAxisWithStep("z", vz * dt);

    // Smooth the camera Y only during half-block step-ups (_stepping flag).
    // Real jumps and falling snap immediately so they feel snappy.
    if (this._stepping && this.position.y > this.smoothY) {
      this.smoothY += (this.position.y - this.smoothY) * Math.min(1, 12 * dt);
      if (this.smoothY >= this.position.y) { this.smoothY = this.position.y; this._stepping = false; }
    } else {
      this._stepping = false;
      this.smoothY = this.position.y;
    }
  }
}
