// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
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
import { AK47, DEAGLE_CONFIG, MP7_CONFIG, P90_CONFIG, BALLISTA_CONFIG, LAMG_CONFIG } from "../world/AK47";

const REACH = 6;

export const HOTBAR: BType[] = [
  BType.grass, BType.dirt, BType.stone, BType.sand,
  BType.snow, BType.log, BType.leaf, BType.planks,
];

export class PlayerController {
  readonly fpCamera: FirstPersonCamera;
  readonly physics: PlayerPhysics;
  // Two independent weapon instances — index 0 is the M4A1 (full-auto),
  // index 1 is the Desert Eagle (semi-auto, CS:GO config).
  readonly weapons: AK47[] = [
    new AK47(),                    // 0 — M16A1
    new AK47(DEAGLE_CONFIG),       // 1 — Desert Eagle
    new AK47(MP7_CONFIG),          // 2 — MP7
    new AK47(P90_CONFIG),          // 3 — P90
    new AK47(BALLISTA_CONFIG),     // 4 — Ballista (AWP)
    new AK47(LAMG_CONFIG),         // 5 — LAMG (M249)
  ];
  weaponIndex = 0;

  get ak47(): AK47 {
    return this.weapons[this.weaponIndex];
  }

  // AWP scope: 0 = off, 1 = first zoom (~40°), 2 = second zoom (~15°)
  scopeLevel = 0;

  switchWeapon(): void {
    this.weapons[this.weaponIndex].releaseTrigger();
    this.scopeLevel = 0;
    this.weaponIndex = (this.weaponIndex + 1) % this.weapons.length;
  }

  toggleScope(): void {
    if (this.weaponIndex !== 4) return;
    this.scopeLevel = this.scopeLevel === 0 ? 1 : 0;
  }

  selectedIndex = 0;
  locked = false;
  targetBlock: { position: THREE.Vector3; normal: THREE.Vector3 } | null = null;

  // Callback invoked when a shot is fired (main.ts uses this to spawn tracers)
  onShot: ((origin: THREE.Vector3, direction: THREE.Vector3) => void) | null = null;

  readonly isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  // Joystick state: -1..+1 per axis (set by touch handlers, read in update)
  joystickX = 0;
  joystickZ = 0;

  private keys = new Set<string>();
  private mouseHeld = false;

  // Mobile touch tracking
  private joystickTouchId: number | null = null;
  private joystickBaseX = 0;
  private joystickBaseY = 0;
  private lookTouchId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;

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

  // Public methods for mobile buttons to call
  startFiring() { this.mouseHeld = true; }
  stopFiring()  { this.mouseHeld = false; this.ak47.releaseTrigger(); }
  doJump()      { this.physics.jump(); }

  private bindEvents() {
    this.domElement.addEventListener("click", () => {
      if (this.isMobile) return;
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
      if (e.button === 0) this.mouseHeld = true;
      else if (e.button === 2) {
        if (this.weaponIndex === 4) this.toggleScope();
        else this.placeBlock();
      }
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        this.mouseHeld = false;
        this.ak47.releaseTrigger();
      }
    });
    document.addEventListener("contextmenu", (e) => {
      if (this.locked) e.preventDefault();
    });

    document.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "KeyR" && !e.repeat) { this.scopeLevel = 0; this.ak47.reload(); }
      if (e.code === "KeyF" && !e.repeat) this.ak47.inspect();
      if (e.code === "KeyQ" && !e.repeat) this.switchWeapon();
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= HOTBAR.length) this.selectedIndex = num - 1;
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));

    if (this.isMobile) this.bindTouchEvents();
  }

  private bindTouchEvents() {
    const el = this.domElement;
    const JRAD = 70; // px, must match mobileHud.ts

    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        const leftHalf = t.clientX < window.innerWidth * 0.45;
        if (leftHalf && this.joystickTouchId === null) {
          this.joystickTouchId = t.identifier;
          this.joystickBaseX = t.clientX;
          this.joystickBaseY = t.clientY;
          this.joystickX = 0;
          this.joystickZ = 0;
        } else if (!leftHalf && this.lookTouchId === null) {
          this.lookTouchId = t.identifier;
          this.lookLastX = t.clientX;
          this.lookLastY = t.clientY;
        }
      }
    }, { passive: false });

    el.addEventListener("touchmove", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joystickTouchId) {
          const dx = t.clientX - this.joystickBaseX;
          const dy = t.clientY - this.joystickBaseY;
          const dist = Math.hypot(dx, dy);
          const factor = dist > 0 ? Math.min(dist, JRAD) / dist : 0;
          this.joystickX = (dx * factor) / JRAD;
          this.joystickZ = (dy * factor) / JRAD;
        } else if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lookLastX;
          const dy = t.clientY - this.lookLastY;
          // 1.5× scale: touch swipes cover more pixels than mouse movement deltas
          this.fpCamera.onMouseMove(dx * 1.5, dy * 1.5);
          this.lookLastX = t.clientX;
          this.lookLastY = t.clientY;
        }
      }
    }, { passive: false });

    const endTouch = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joystickTouchId) {
          this.joystickTouchId = null;
          this.joystickX = 0;
          this.joystickZ = 0;
        } else if (t.identifier === this.lookTouchId) {
          this.lookTouchId = null;
        }
      }
    };
    el.addEventListener("touchend",    endTouch, { passive: false });
    el.addEventListener("touchcancel", endTouch, { passive: false });
  }

  private eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(
      this.physics.position.x,
      this.physics.smoothY + this.physics.eyeHeight,
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

    // Virtual joystick (mobile): joystickZ positive = down on screen = backward
    forward -= this.joystickZ;
    strafe  += this.joystickX;

    const yaw = this.fpCamera.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const wishX = fx * forward + rx * strafe;
    const wishZ = fz * forward + rz * strafe;

    const shift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const ctrl = this.keys.has("ControlLeft") || this.keys.has("ControlRight");
    this.physics.crouching = ctrl;

    let wishY = 0;
    if (this.physics.flying) {
      if (this.keys.has("Space")) wishY += 1;
      if (shift) wishY -= 1;
    }

    this.physics.update(dt, wishX, wishZ, shift, wishY);
    if (!this.physics.flying && this.keys.has("Space")) this.physics.jump();

    // AK-47: full-auto fire while mouse held
    this.ak47.update(dt);
    if (this.mouseHeld && (this.locked || this.isMobile)) {
      // Snapshot punch BEFORE firing: the bullet follows the recoil accumulated
      // from PREVIOUS shots, not this shot's own kick — so a fresh trigger pull
      // (no prior punch) always fires level, while the camera/gun still kick
      // immediately on every shot (fire() below updates punch for rendering
      // and for the NEXT shot's bullet). This is the standard "recoil climb
      // affects your next shot" model, and — unlike gating on shotIndex, tried
      // earlier — doesn't depend on the weapon's specific recovery-timer
      // tuning to behave consistently.
      const prePunchPitch = this.ak47.punchPitch;
      const prePunchYaw   = this.ak47.punchYaw;
      const fired = this.ak47.fire();
      if (fired) this.scopeLevel = 0; // AWP unscopes after each shot
      if (fired && this.onShot) {
        const eye = this.eyePosition();
        const dir = new THREE.Vector3(0, 0, -1)
          .applyEuler(new THREE.Euler(
            this.fpCamera.pitch + prePunchPitch,
            this.fpCamera.yaw   + prePunchYaw,
            0, "YXZ",
          ));
        this.onShot(eye, dir);
      }
    }

    const eye = this.eyePosition();
    this.camera.position.copy(eye);

    // Camera rotation = base angles + current aim punch (so the screen kicks with recoil)
    const renderPitch = this.fpCamera.pitch + this.ak47.punchPitch;
    const renderYaw   = this.fpCamera.yaw   + this.ak47.punchYaw;
    this.camera.rotation.set(renderPitch, renderYaw, 0, "YXZ");

    // Raycast for block targeting uses the punched direction
    const dir = new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(renderPitch, renderYaw, 0, "YXZ"));
    const hit = raycastWithNormal(eye, dir, REACH, (x, y, z) => this.world.getBlock(x, y, z) !== BType.air);
    this.targetBlock = hit
      ? { position: new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) }
      : null;
  }
}
