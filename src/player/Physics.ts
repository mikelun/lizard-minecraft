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

export class PlayerPhysics {
  readonly position: THREE.Vector3; // feet, center of the box's base
  readonly velocity = new THREE.Vector3();
  grounded = false;
  flying = false;
  crouching = false;

  private readonly spawn: THREE.Vector3;

  constructor(private world: World, spawn: THREE.Vector3) {
    this.spawn = spawn.clone();
    this.position = spawn.clone();
  }

  respawn() {
    this.position.copy(this.spawn);
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
    return {
      minX: pos.x - HALF_WIDTH, maxX: pos.x + HALF_WIDTH,
      minY: pos.y, maxY: pos.y + this.currentHeight(),
      minZ: pos.z - HALF_WIDTH, maxZ: pos.z + HALF_WIDTH,
    };
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
      const test = this.position.clone();
      test[axis] += moved + d * dir;
      if (this.collides(this.aabbAt(test))) break;
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
      const probe = this.position.clone();
      probe[axis] += delta * mid;
      if (this.collides(this.aabbAt(probe))) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  private moveAxisWithStep(axis: "x" | "z", delta: number) {
    if (delta === 0) return;
    const target = this.position.clone();
    target[axis] += delta;
    if (!this.collides(this.aabbAt(target))) {
      this.position[axis] = target[axis];
      return;
    }

    // Blocked -- try stepping up onto a ledge up to STEP_HEIGHT tall BEFORE
    // falling back to a partial slide-to-flush. Trying the slide first meant
    // the player stopped dead against every single-block terrain edge
    // (ubiquitous on any sloped ground, since the heightmap quantizes to
    // whole blocks) and only actually stepped up on the FOLLOWING frame once
    // already flush against it -- a visible stall-then-hop on nearly every
    // step. Attempting the step immediately, on the same frame the obstacle
    // is first hit, collapses that into one smooth motion instead.
    const raised = this.position.clone();
    raised.y += STEP_HEIGHT;
    const raisedTarget = raised.clone();
    raisedTarget[axis] += delta;

    if (!this.collides(this.aabbAt(raised)) && !this.collides(this.aabbAt(raisedTarget))) {
      // Find the lowest y (down to the original) that still clears, so we
      // don't float above a ledge shorter than STEP_HEIGHT.
      let landY = raisedTarget.y;
      for (let dyStep = 0.05; dyStep <= STEP_HEIGHT; dyStep += 0.05) {
        const testY = raisedTarget.y - dyStep;
        if (testY <= this.position.y) break;
        const testPos = raisedTarget.clone();
        testPos.y = testY;
        if (this.collides(this.aabbAt(testPos))) break;
        landY = testY;
      }
      this.position[axis] = raisedTarget[axis];
      this.position.y = Math.max(landY, this.position.y);
      return;
    }

    const safeFraction = this.maxSafeFraction(axis, delta);
    if (safeFraction > 0.001) {
      this.position[axis] += delta * safeFraction;
      return;
    }

    this.velocity[axis] = 0;
  }

  private checkGrounded(): boolean {
    const probe = this.position.clone();
    probe.y -= 0.05;
    return this.collides(this.aabbAt(probe));
  }

  jump() {
    if (this.flying) return;
    if (this.grounded) {
      this.velocity.y = JUMP_FORCE;
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
      const standTest = this.position.clone();
      const crouchAABB: AABB = {
        minX: standTest.x - HALF_WIDTH, maxX: standTest.x + HALF_WIDTH,
        minY: standTest.y, maxY: standTest.y + HEIGHT,
        minZ: standTest.z - HALF_WIDTH, maxZ: standTest.z + HALF_WIDTH,
      };
      let standBlocked = false;
      const x0 = Math.floor(crouchAABB.minX), x1 = Math.floor(crouchAABB.maxX - 1e-6);
      const y0 = Math.floor(crouchAABB.minY), y1 = Math.floor(crouchAABB.maxY - 1e-6);
      const z0 = Math.floor(crouchAABB.minZ), z1 = Math.floor(crouchAABB.maxZ - 1e-6);
      outer: for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            if (this.blockSolid(x, y, z, crouchAABB.minY, crouchAABB.maxY)) { standBlocked = true; break outer; }
          }
        }
      }
      if (standBlocked) this.crouching = true;
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
  }
}
