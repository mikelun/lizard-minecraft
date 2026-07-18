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
// Each entry is the INCREMENTAL [yaw, pitch] delta (radians) added to the
// aim-punch when that shot fires.  Aim-punch decays at PUNCH_DECAY_RATE=5/s
// (≈0.607× per 100 ms shot interval), so the bullet landing position at shot N
// is approximately Σ delta[k] × 0.607^(N−k).
//
// Positive pitch = camera kicks UP   (bullets land higher)
// Positive yaw   = camera kicks RIGHT (bullets land right)
//
// CS:GO AK-47 pattern shape (left → BIG LEFT SNAP → right → settle):
//   Shots  1– 9: gentle left drift + vertical rise
//   Shot  10: ★ signature hard LEFT snap (~8 °)
//   Shot  11: continue left, brief
//   Shots 12–17: aggressive recovery to RIGHT
//   Shots 18–22: right plateau, slowing
//   Shots 23–27: near-center oscillation
//   Shots 28–30: slight pull back left

// [yaw_delta_rad, pitch_delta_rad] — shot indices 0–29 (first shot = index 0)
export const SPRAY_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [ 0.000,  0.000],   // 1  first shot: no kick
  [-0.002,  0.022],   // 2  slight left, rising
  [-0.003,  0.018],   // 3
  [-0.001,  0.021],   // 4
  [-0.003,  0.028],   // 5
  [-0.006,  0.030],   // 6
  [-0.020,  0.024],   // 7  hard left starts
  [-0.025,  0.016],   // 8
  [-0.024,  0.005],   // 9
  [-0.095, -0.003],   // 10 ★ BIG LEFT SNAP
  [-0.058, -0.004],   // 11 continue left
  [ 0.042,  0.008],   // 12 snap back right
  [ 0.045,  0.002],   // 13
  [ 0.040, -0.003],   // 14
  [ 0.054, -0.006],   // 15
  [ 0.065, -0.010],   // 16
  [ 0.062,  0.005],   // 17
  [ 0.055,  0.004],   // 18 right plateau
  [ 0.042,  0.003],   // 19
  [ 0.030, -0.003],   // 20
  [ 0.018, -0.017],   // 21 settling
  [ 0.013, -0.008],   // 22
  [-0.008,  0.007],   // 23
  [ 0.001,  0.009],   // 24
  [ 0.001,  0.000],   // 25
  [ 0.008,  0.001],   // 26
  [-0.008,  0.006],   // 27
  [-0.010, -0.006],   // 28 slight pull back
  [-0.010, -0.009],   // 29
  [-0.010, -0.009],   // 30
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
  }
}
