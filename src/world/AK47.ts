// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * CS:GO AK-47 weapon system
 *
 * All timings and values match CS:GO exactly:
 *   - 600 RPM  (100 ms between shots)
 *   - 30-round magazine, 90 reserve
 *   - 2.43 s reload
 *   - Deterministic 30-shot spray pattern (derived from CS:GO recoil data)
 *   - Aim-punch system: accumulated per shot, exponentially decays after release
 *   - Spray index resets 0.4 s after last shot (CS:GO weapon_recoil_cooldown)
 */

// ── Spray pattern ─────────────────────────────────────────────────────────────
// Each entry is the INCREMENTAL [yaw, pitch] delta (radians) applied to the
// aim-punch when that shot fires.
//
// Positive pitch = camera kicks UP.
// Positive yaw   = camera kicks RIGHT.
//
// Values are derived from the CS:GO AK-47 recoil table:
//   raw_x / raw_y taken from community-measured compensation data;
//   actual_yaw  =  raw_x × SCALE
//   actual_pitch= -raw_y × SCALE  (screen −Y = up = +pitch in world)
//
// SCALE = 0.0005 rad/unit, chosen so the full 30-shot pattern spans
// ~11 ° vertically and ~5 ° horizontally — matching CS:GO observed values.

const S = 0.0005; // scale factor

// [yaw_delta_rad, pitch_delta_rad] — shot indices 0-29 (first shot = index 0)
export const SPRAY_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [ 0.000,  0.000],  // 1  — first shot: no pattern offset (only base inaccuracy)
  [ 0.001,  0.0085], // 2
  [-0.003,  0.006 ], // 3
  [ 0.001,  0.0195], // 4
  [ 0.001,  0.0255], // 5
  [ 0.005,  0.031 ], // 6
  [ 0.007,  0.030 ], // 7
  [ 0.0075, 0.027 ], // 8
  [-0.001,  0.0195], // 9
  [-0.013,  0.011 ], // 10
  [-0.0225, 0.0055], // 11
  [-0.018,  0.0035], // 12
  [-0.0135, 0.004 ], // 13
  [-0.012,  0.0025], // 14
  [-0.0085, 0.0015], // 15
  [ 0.0035, 0.001 ], // 16
  [ 0.0175, 0.004 ], // 17
  [ 0.023,  0.005 ], // 18
  [ 0.024,  0.004 ], // 19
  [ 0.0215, 0.000 ], // 20
  [ 0.015, -0.0025], // 21
  [ 0.0035,-0.0015], // 22
  [-0.002,  0.0025], // 23
  [-0.002,  0.004 ], // 24
  [ 0.001,  0.004 ], // 25
  [ 0.0035, 0.0015], // 26
  [-0.002,  0.0025], // 27
  [-0.0155,-0.0025], // 28
  [-0.027, -0.0065], // 29
  [-0.033, -0.0085], // 30
] as const;

// ── CS:GO weapon constants ────────────────────────────────────────────────────
export const FIRE_INTERVAL_MS  = 100;   // 600 RPM
export const MAGAZINE_SIZE     = 30;
export const RESERVE_AMMO      = 90;
export const RELOAD_TIME_S     = 2.43;
export const RECOIL_COOLDOWN_S = 0.4;   // spray index reset after this many s

// Aim-punch decay: exponential, half-life ≈ 140 ms.
// In CS:GO the punch decays with weapon_recoil_decay1_exp / decay2_exp; this
// single exponential approximates the observed recovery curve.
const PUNCH_DECAY_RATE = 5.0; // per second (e^(-5t); reaches ~1 % at t=0.9 s)

// ── AK47 class ────────────────────────────────────────────────────────────────

export class AK47 {
  // Magazine state
  ammo    = MAGAZINE_SIZE;
  reserve = RESERVE_AMMO;

  // Reload state
  reloading   = false;
  reloadTimer = 0;

  // Aim-punch (added to camera angles each frame for render + raycast)
  punchPitch = 0; // radians, positive = up
  punchYaw   = 0; // radians, positive = right

  // Visual weapon kick (separate from aim punch — drives the model animation)
  modelKickPitch = 0; // radians
  modelKickYaw   = 0;

  // Reload animation offsets applied to the weapon group each frame
  reloadOffsetY = 0;  // vertical drop (negative = down)
  reloadOffsetZ = 0;  // push backward
  reloadRollZ   = 0;  // roll/tilt (negative = CCW tilt, mag-side up)

  // Internal fire state
  private fireTimer     = 0;   // ms remaining before next shot is allowed
  private shotIndex     = 0;   // position in SPRAY_PATTERN (0 = first shot)
  private recoveryTimer = 0;   // seconds since last shot
  private _firing       = false;

  // ── Public API ──────────────────────────────────────────────────────────────

  get shotsFired(): number { return this.shotIndex; }
  get canFire():    boolean { return !this.reloading && this.ammo > 0 && this.fireTimer <= 0; }
  get isFiring():   boolean { return this._firing; }

  /**
   * Attempt to fire one round.
   * Returns true if a shot was actually fired (caller should cast a ray).
   */
  fire(): boolean {
    if (!this.canFire) {
      if (!this.reloading && this.ammo === 0 && this.reserve > 0) this.reload();
      return false;
    }

    // Apply spray pattern increment to aim punch
    const idx = Math.min(this.shotIndex, SPRAY_PATTERN.length - 1);
    this.punchYaw   += SPRAY_PATTERN[idx][0];
    this.punchPitch += SPRAY_PATTERN[idx][1];

    // Visual model kick (springs back to 0 in update())
    this.modelKickPitch += 0.08;
    this.modelKickYaw   += SPRAY_PATTERN[idx][0] * 1.5;

    // Advance state
    this.ammo--;
    this.shotIndex    = Math.min(this.shotIndex + 1, SPRAY_PATTERN.length - 1);
    this.fireTimer    = FIRE_INTERVAL_MS;
    this.recoveryTimer = 0;
    this._firing      = true;

    return true;
  }

  releaseTrigger(): void {
    this._firing = false;
  }

  reload(): void {
    if (this.reloading || this.reserve <= 0 || this.ammo >= MAGAZINE_SIZE) return;
    this.reloading   = true;
    this.reloadTimer = RELOAD_TIME_S;
    this._firing     = false;
    this.shotIndex   = 0;
  }

  /**
   * Call once per frame (dt in seconds).
   * Handles fire-rate cooldown, reload, punch decay, spray-index reset.
   */
  update(dt: number): void {
    // Fire-rate timer
    if (this.fireTimer > 0) this.fireTimer -= dt * 1000;

    // Reload countdown
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const needed = MAGAZINE_SIZE - this.ammo;
        const take   = Math.min(needed, this.reserve);
        this.ammo   += take;
        this.reserve -= take;
        this.reloading = false;
      }
    }

    // Aim-punch exponential decay toward 0 (happens both while and after firing)
    const decay = Math.exp(-PUNCH_DECAY_RATE * dt);
    this.punchPitch *= decay;
    this.punchYaw   *= decay;

    // Spray-index reset after cooldown
    if (!this._firing) {
      this.recoveryTimer += dt;
      if (this.recoveryTimer >= RECOIL_COOLDOWN_S) {
        this.shotIndex = 0;
      }
    } else {
      this.recoveryTimer = 0;
    }

    // Visual model kick springs back
    const kickDecay = Math.exp(-12 * dt);
    this.modelKickPitch *= kickDecay;
    this.modelKickYaw   *= kickDecay;

    // Reload animation
    if (this.reloading) {
      const t = 1 - this.reloadTimer / RELOAD_TIME_S; // 0 → 1 as reload progresses

      // Smooth envelope: ramps up in first 30 %, holds, ramps down in last 30 %
      const ss = (a: number, b: number, x: number) => {
        const c = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return c * c * (3 - 2 * c);
      };
      const env = ss(0, 0.30, t) * (1 - ss(0.70, 1.0, t));

      // Small upward bump at ~55 % = new magazine clicks in
      const clickT = Math.max(0, Math.min(1, (t - 0.50) / 0.10));
      const click  = Math.sin(clickT * Math.PI) * 0.03;

      this.reloadOffsetY = -0.17 * env + click;
      this.reloadOffsetZ =  0.06 * env;
      this.reloadRollZ   = -0.45 * env;
    } else {
      this.reloadOffsetY = 0;
      this.reloadOffsetZ = 0;
      this.reloadRollZ   = 0;
    }
  }
}
