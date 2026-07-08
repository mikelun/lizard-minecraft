// Fresh, minimal port of the pointer-lock yaw/pitch behavior in
// escape-tsuami-client/src/game/player/camera.ts -- the source file is mostly
// third-person/editor camera modes and websocket-synced orientation broadcast,
// none of which apply to a single-player first-person game, so only the core
// mouse-look math is kept.

import * as THREE from "three";

const PITCH_LIMIT = Math.PI / 2 - 0.01;

export class FirstPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.05, 1000);
    this.camera.rotation.order = "YXZ";
  }

  onMouseMove(dx: number, dy: number) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
  }
}
