// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * Generic semi/full-auto weapon system.
 *
 * Default config matches CS:GO AK-47:
 *   - 600 RPM  (100 ms between shots)
 *   - 30-round magazine, 90 reserve
 *   - 2.43 s reload
 *   - Deterministic 30-shot spray pattern
 *
 * Pass a WeaponConfig to override for other weapons (e.g. Desert Eagle).
 */

// ── Spray pattern ─────────────────────────────────────────────────────────────
// Each entry is the INCREMENTAL [yaw, pitch] delta (radians) applied to the
// aim-punch when that shot fires.
//
// Positive pitch = camera kicks UP.
// Positive yaw   = camera kicks RIGHT.

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

// ── Weapon config ─────────────────────────────────────────────────────────────

export interface WeaponConfig {
  // Fire mode
  semiAuto?: boolean;       // true = one shot per click (like Deagle); false = full-auto
  // Ammo
  magazineSize?: number;
  reserveAmmo?: number;
  // Timings (seconds unless noted)
  fireIntervalMs?: number;  // minimum ms between shots
  reloadTimeS?: number;
  recoilCooldownS?: number;
  inspectTimeS?: number;
  // Recoil — if set, overrides spray pattern with a fixed per-shot kick
  punchPerShot?: readonly [number, number]; // [yaw_rad, pitch_rad]
  // Visual kick per shot (model bounce, separate from aim punch)
  modelKickPerShot?: number;
}

// ── CS:GO weapon constants — AK-47 defaults ───────────────────────────────────
export const FIRE_INTERVAL_MS  = 100;
export const MAGAZINE_SIZE     = 30;
export const RESERVE_AMMO      = 90;
export const RELOAD_TIME_S     = 2.43;
export const RECOIL_COOLDOWN_S = 0.4;
export const INSPECT_TIME_S    = 8.8667;

// CS:GO Desert Eagle config
export const DEAGLE_CONFIG: WeaponConfig = {
  semiAuto:       true,
  magazineSize:   7,
  reserveAmmo:    35,
  fireIntervalMs: 225,   // ~267 RPM theoretical max; semi-auto means click-limited
  reloadTimeS:    2.2,
  recoilCooldownS: 0.35,
  punchPerShot:   [0.0, 0.12],  // large upward kick per shot, no yaw
  modelKickPerShot: 0.18,
};

// CS:GO MP7
export const MP7_CONFIG: WeaponConfig = {
  semiAuto:        false,
  magazineSize:    25,
  reserveAmmo:     100,
  fireIntervalMs:  75,     // 800 RPM
  reloadTimeS:     3.13,
  recoilCooldownS: 0.3,
  punchPerShot:    [0.0, 0.04],
  modelKickPerShot: 0.05,
};

// CS:GO P90
export const P90_CONFIG: WeaponConfig = {
  semiAuto:        false,
  magazineSize:    50,
  reserveAmmo:     100,
  fireIntervalMs:  70,     // ~857 RPM
  reloadTimeS:     3.3,
  recoilCooldownS: 0.3,
  punchPerShot:    [0.0, 0.035],
  modelKickPerShot: 0.04,
};

// CS:GO AWP (ballista)
export const BALLISTA_CONFIG: WeaponConfig = {
  semiAuto:        true,
  magazineSize:    10,
  reserveAmmo:     30,
  fireIntervalMs:  1400,   // bolt-action cycle
  reloadTimeS:     3.67,
  recoilCooldownS: 1.25,
  punchPerShot:    [0.0, 0.22],
  modelKickPerShot: 0.30,
};

// CS:GO M249 (lamg)
export const LAMG_CONFIG: WeaponConfig = {
  semiAuto:        false,
  magazineSize:    100,
  reserveAmmo:     200,
  fireIntervalMs:  80,     // 750 RPM
  reloadTimeS:     6.2,
  recoilCooldownS: 0.45,
  punchPerShot:    [0.0, 0.055],
  modelKickPerShot: 0.06,
};


const PUNCH_DECAY_RATE = 5.0;

// ── Weapon class ──────────────────────────────────────────────────────────────

export class AK47 {
  // Config (frozen at construction)
  readonly semiAuto: boolean;
  private readonly magazineSize: number;
  private readonly reserveAmmo0: number;
  private readonly fireIntervalMs: number;
  private readonly reloadTimeS: number;
  private readonly recoilCooldownS: number;
  private readonly inspectTimeS: number;
  private readonly punchPerShot: readonly [number, number] | null;
  private readonly modelKickPerShot: number;

  // Magazine state
  ammo:    number;
  reserve: number;

  // Reload state
  reloading   = false;
  reloadTimer = 0;

  // Inspect state
  inspecting   = false;
  inspectTimer = 0;

  // Aim-punch
  punchPitch = 0;
  punchYaw   = 0;

  // Visual weapon kick
  modelKickPitch = 0;
  modelKickYaw   = 0;

  // Reload animation offsets
  reloadOffsetY = 0;
  reloadOffsetZ = 0;
  reloadRollZ   = 0;

  // Internal fire state
  private fireTimer      = 0;
  private shotIndex      = 0;
  private recoveryTimer  = 0;
  private _firing        = false;
  private triggerHeld    = false; // semi-auto lock: reset on releaseTrigger()

  constructor(config: WeaponConfig = {}) {
    this.semiAuto         = config.semiAuto         ?? false;
    this.magazineSize     = config.magazineSize      ?? MAGAZINE_SIZE;
    this.reserveAmmo0     = config.reserveAmmo       ?? RESERVE_AMMO;
    this.fireIntervalMs   = config.fireIntervalMs    ?? FIRE_INTERVAL_MS;
    this.reloadTimeS      = config.reloadTimeS       ?? RELOAD_TIME_S;
    this.recoilCooldownS  = config.recoilCooldownS   ?? RECOIL_COOLDOWN_S;
    this.inspectTimeS     = config.inspectTimeS      ?? INSPECT_TIME_S;
    this.punchPerShot     = config.punchPerShot      ?? null;
    this.modelKickPerShot = config.modelKickPerShot  ?? 0.08;

    this.ammo    = this.magazineSize;
    this.reserve = this.reserveAmmo0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get shotsFired(): number { return this.shotIndex; }
  get canFire():    boolean { return !this.reloading && this.ammo > 0 && this.fireTimer <= 0; }
  get isFiring():   boolean { return this._firing; }
  get isInspecting(): boolean { return this.inspecting; }

  fire(): boolean {
    // Semi-auto lock: only one shot per trigger press
    if (this.semiAuto && this.triggerHeld) return false;

    if (!this.canFire) {
      if (!this.reloading && this.ammo === 0 && this.reserve > 0) this.reload();
      return false;
    }

    // Apply recoil — every shot kicks the camera/gun model for visual feedback.
    // (Controller.ts keeps the FIRST shot's bullet level by reading punchPitch/
    // punchYaw BEFORE calling fire(), not by skipping the kick itself here —
    // shotIndex resets on its own recovery timer independent of "is this
    // really the first shot of a fresh trigger pull," so gating on it here
    // produced wildly different, wrong behavior per weapon: e.g. the AWP's
    // 1.25s recoilCooldownS is close to its 1.4s fire interval, so shotIndex
    // was back to 0 before nearly every single shot, silencing recoil
    // entirely; a fast-tapped Deagle accumulated across separate trigger
    // pulls instead, only becoming visible a few taps in.)
    if (this.punchPerShot) {
      this.punchYaw   += this.punchPerShot[0];
      this.punchPitch += this.punchPerShot[1];
      this.modelKickYaw = 0;
    } else {
      const idx = Math.min(this.shotIndex, SPRAY_PATTERN.length - 1);
      this.punchYaw   += SPRAY_PATTERN[idx][0];
      this.punchPitch += SPRAY_PATTERN[idx][1];
      this.modelKickYaw += SPRAY_PATTERN[idx][0] * 1.5;
    }
    this.modelKickPitch += this.modelKickPerShot;

    this.ammo--;
    this.shotIndex    = Math.min(this.shotIndex + 1, SPRAY_PATTERN.length - 1);
    this.fireTimer    = this.fireIntervalMs;
    this.recoveryTimer = 0;
    this._firing      = true;
    this.inspecting   = false;

    if (this.semiAuto) this.triggerHeld = true;

    return true;
  }

  releaseTrigger(): void {
    this._firing    = false;
    this.triggerHeld = false;
  }

  reload(): void {
    if (this.reloading || this.reserve <= 0 || this.ammo >= this.magazineSize) return;
    this.reloading   = true;
    this.reloadTimer = this.reloadTimeS;
    this._firing     = false;
    this.shotIndex   = 0;
    this.inspecting  = false;
  }

  inspect(): void {
    if (this.reloading || this._firing || this.inspecting) return;
    this.inspecting   = true;
    this.inspectTimer = this.inspectTimeS;
  }

  update(dt: number): void {
    if (this.fireTimer > 0) this.fireTimer -= dt * 1000;

    if (this.inspecting) {
      this.inspectTimer -= dt;
      if (this.inspectTimer <= 0) this.inspecting = false;
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const needed = this.magazineSize - this.ammo;
        const take   = Math.min(needed, this.reserve);
        this.ammo   += take;
        this.reserve -= take;
        this.reloading = false;
      }
    }

    const decay = Math.exp(-PUNCH_DECAY_RATE * dt);
    this.punchPitch *= decay;
    this.punchYaw   *= decay;

    if (!this._firing) {
      this.recoveryTimer += dt;
      if (this.recoveryTimer >= this.recoilCooldownS) {
        this.shotIndex = 0;
      }
    } else {
      this.recoveryTimer = 0;
    }

    const kickDecay = Math.exp(-12 * dt);
    this.modelKickPitch *= kickDecay;
    this.modelKickYaw   *= kickDecay;

    if (this.reloading) {
      const t = 1 - this.reloadTimer / this.reloadTimeS;
      const ss = (a: number, b: number, x: number) => {
        const c = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return c * c * (3 - 2 * c);
      };
      const env = ss(0, 0.30, t) * (1 - ss(0.70, 1.0, t));
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
