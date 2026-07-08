// Fresh port of the input-handling shell of
// escape-tsuami-client/src/game/player/controller.ts, trimmed to what a
// standalone single-player game needs: WASD + jump + sprint, pointer-lock
// mouse-look, left-click break / right-click place via the DDA raycast, and
// number-key hotbar selection. The source's mobile joystick, websocket state
// sync and editor-mode branches are dropped.

import * as THREE from "three";
import { World } from "../world/World";
import { FirstPersonCamera } from "./Camera";
import { PlayerPhysics } from "./Physics";
import { raycastWithNormal } from "../world/raycast";
import { BType } from "../world/types";

const REACH = 6;

export const HOTBAR: BType[] = [
  BType.grass, BType.dirt, BType.stone, BType.sand,
  BType.snow, BType.log, BType.leaf, BType.planks,
];

export class PlayerController {
  readonly fpCamera: FirstPersonCamera;
  readonly physics: PlayerPhysics;

  selectedIndex = 0;
  locked = false;
  targetBlock: { position: THREE.Vector3; normal: THREE.Vector3 } | null = null;

  private keys = new Set<string>();

  constructor(
    private world: World,
    private domElement: HTMLElement,
    aspect: number,
    spawn: THREE.Vector3,
  ) {
    this.fpCamera = new FirstPersonCamera(aspect);
    this.physics = new PlayerPhysics(world, spawn);
    this.bindEvents();
  }

  get camera() {
    return this.fpCamera.camera;
  }

  get selectedBlock(): BType {
    return HOTBAR[this.selectedIndex];
  }

  private bindEvents() {
    this.domElement.addEventListener("click", () => {
      if (!this.locked) this.domElement.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.domElement;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.fpCamera.onMouseMove(e.movementX, e.movementY);
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.breakBlock();
      else if (e.button === 2) this.placeBlock();
    });
    document.addEventListener("contextmenu", (e) => {
      if (this.locked) e.preventDefault();
    });

    document.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= HOTBAR.length) this.selectedIndex = num - 1;
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  private eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(
      this.physics.position.x,
      this.physics.position.y + this.physics.eyeHeight,
      this.physics.position.z,
    );
  }

  private breakBlock() {
    if (!this.targetBlock) return;
    const { position } = this.targetBlock;
    if (this.world.getBlock(position.x, position.y, position.z) === BType.air) return;
    this.world.setBlock(position.x, position.y, position.z, BType.air);
  }

  private placeBlock() {
    if (!this.targetBlock) return;
    const { position, normal } = this.targetBlock;
    const px = position.x + normal.x;
    const py = position.y + normal.y;
    const pz = position.z + normal.z;

    const playerMinX = this.physics.position.x - 0.3, playerMaxX = this.physics.position.x + 0.3;
    const playerMinZ = this.physics.position.z - 0.3, playerMaxZ = this.physics.position.z + 0.3;
    const playerMinY = this.physics.position.y, playerMaxY = this.physics.position.y + 1.8;
    const overlapsPlayer =
      px + 1 > playerMinX && px < playerMaxX &&
      pz + 1 > playerMinZ && pz < playerMaxZ &&
      py + 1 > playerMinY && py < playerMaxY;
    if (overlapsPlayer) return;

    this.world.setBlock(px, py, pz, this.selectedBlock);
  }

  update(dt: number) {
    let forward = 0, strafe = 0;
    if (this.keys.has("KeyW")) forward += 1;
    if (this.keys.has("KeyS")) forward -= 1;
    if (this.keys.has("KeyD")) strafe += 1;
    if (this.keys.has("KeyA")) strafe -= 1;

    const yaw = this.fpCamera.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const wishX = fx * forward + rx * strafe;
    const wishZ = fz * forward + rz * strafe;

    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    this.physics.update(dt, wishX, wishZ, sprint);
    if (this.keys.has("Space")) this.physics.jump();

    const eye = this.eyePosition();
    this.camera.position.copy(eye);

    const dir = this.fpCamera.forward;
    const hit = raycastWithNormal(eye, dir, REACH, (x, y, z) => this.world.getBlock(x, y, z) !== BType.air);
    this.targetBlock = hit
      ? { position: new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) }
      : null;
  }
}
