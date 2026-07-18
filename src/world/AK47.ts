/**
 * CS:GO AK-47 weapon system
 *
 * All timings and values match CS:GO exactly:
 *   - 600 RPM  (100 ms between shots)
 *   - 30-round magazine, 90 reserve
 *   - 2.43 s reload
 *   - Deterministic 30-shot spray pattern (real CS:GO recoil data, 50% scale)
 *   - CS:GO recoil model: punch is HELD while firing (no decay during spray),
 *     then decays exponentially after trigger release — matching how CS:GO
 *     actually works (incremental decay during firing caused bullets to land
 *     nowhere near the expected pattern positions).
 *   - Spray index resets 0.4 s after last shot (CS:GO weapon_recoil_cooldown)
 */

// ── Spray pattern ─────────────────────────────────────────────────────────────
// CUMULATIVE [yaw, pitch] position (radians) at each shot.
// Each entry is the ABSOLUTE punch at that shot index — fire() sets punch
// directly to this value instead of accumulating incremental deltas.
// This is how CS:GO works: the pattern table specifies cumulative positions,
// not per-shot deltas, and the recoil is held (not decayed) during spraying.
//
// Positive pitch = camera kicks UP   (bullets land higher)
// Positive yaw   = camera kicks RIGHT (bullets land right)
//
// Source: CS:GO community-measured AK-47 recoil data, scaled to 50% so the
// peak snap (~25° in CS:GO) becomes ~12.5° here — same pattern shape, less
// overwhelming camera movement for a Minecraft-scale world.
//
// Pattern shape:
//   Shots  1– 9: gentle left drift + upward climb
//   Shot  10:    ★ signature hard LEFT snap (−8.8°)
//   Shot  11:    continue left, peak (−12.7°)
//   Shots 12–16: aggressive recovery → right
//   Shots 17–27: right plateau (~+8°)
//   Shots 28–30: sweep back toward left

// [cumulative_yaw_rad, cumulative_pitch_rad]
export const SPRAY_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [ 0.000,  0.000],  //  1
  [-0.003,  0.013],  //  2
  [-0.007,  0.022],  //  3
  [-0.003,  0.034],  //  4
  [-0.007,  0.050],  //  5
  [-0.014,  0.064],  //  6
  [-0.029,  0.078],  //  7
  [-0.045,  0.085],  //  8
  [-0.057,  0.085],  //  9
  [-0.154,  0.083],  // 10 ★ BIG LEFT SNAP
  [-0.221,  0.079],  // 11
  [-0.188,  0.085],  // 12
  [-0.160,  0.086],  // 13
  [-0.136,  0.083],  // 14
  [-0.097,  0.079],  // 15
  [-0.047,  0.072],  // 16
  [ 0.009,  0.074],  // 17
  [ 0.056,  0.076],  // 18
  [ 0.091,  0.078],  // 19
  [ 0.116,  0.076],  // 20
  [ 0.130,  0.067],  // 21
  [ 0.139,  0.061],  // 22
  [ 0.135,  0.065],  // 23
  [ 0.135,  0.071],  // 24
  [ 0.135,  0.071],  // 25
  [ 0.139,  0.071],  // 26
  [ 0.135,  0.074],  // 27
  [ 0.074,  0.071],  // 28
  [ 0.013,  0.065],  // 29
  [-0.043,  0.059],  // 30
] as const;

// ── CS:GO weapon constants ────────────────────────────────────────────────────
export const FIRE_INTERVAL_MS  = 100;   // 600 RPM
export const MAGAZINE_SIZE     = 30;
export const RESERVE_AMMO      = 90;
export const RELOAD_TIME_S     = 2.43;
export const RECOIL_COOLDOWN_S = 0.4;   // spray index reset after this many s

// Aim-punch recovery: exponential decay ONLY after trigger release.
// half-life ≈ 350 ms — crosshair returns to center in ~1.5 s after spraying.
const PUNCH_DECAY_RATE = 2.0; // per second

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

    const idx     = Math.min(this.shotIndex, SPRAY_PATTERN.length - 1);
    const prevIdx = Math.max(0, idx - 1);

    // Set punch directly to cumulative pattern position (CS:GO model: no decay
    // during firing — the pattern is held while the trigger is held).
    this.punchYaw   = SPRAY_PATTERN[idx][0];
    this.punchPitch = SPRAY_PATTERN[idx][1];

    // Visual model kick uses the incremental delta for this shot
    const dyaw = SPRAY_PATTERN[idx][0] - SPRAY_PATTERN[prevIdx][0];
    this.modelKickPitch += 0.08;
    this.modelKickYaw   += dyaw * 1.5;

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

    // Aim-punch decays only after trigger release (CS:GO model).
    // While firing, punch is set directly in fire() — no decay here.
    if (!this._firing) {
      const decay = Math.exp(-PUNCH_DECAY_RATE * dt);
      this.punchPitch *= decay;
      this.punchYaw   *= decay;
    }

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
