// Manages SteveCharacter instances for every remote player in the room.
// Receives tick data (positions/tiers) and JSON events (join/leave/respawn).

import * as THREE from 'three';
import { SteveCharacter } from '../world/SteveCharacter';
import type { RemotePlayerData } from './GameClient';

// Maps gun game tier → { geo, tex, scale } matching the server's GUN_TIERS array.
// GUN_TIERS = [1,2,3,0,5,4] means: tier 0→Deagle(slot1), tier 1→MP7, etc.
const TIER_GUNS = [
  { geo: '/pointblank/models/deserteagle.geo.json', tex: '/pointblank/textures/deserteagle.png', scale: 0.20 },
  { geo: '/pointblank/models/mp7.geo.json',         tex: '/pointblank/textures/mp7.png',         scale: 0.20 },
  { geo: '/pointblank/models/p90.geo.json',         tex: '/pointblank/textures/p90.png',         scale: 0.20 },
  { geo: '/tacz/models/m16a1_geo.json',             tex: '/tacz/textures/m16a1.png',             scale: 0.45 },
  { geo: '/pointblank/models/lamg.geo.json',        tex: '/pointblank/textures/lamg.png',        scale: 0.20 },
  { geo: '/pointblank/models/ballista.geo.json',    tex: '/pointblank/textures/ballista.png',    scale: 0.20 },
];

const HITBOX_HALF = new THREE.Vector3(0.3, 1.0, 0.3);

// Render remote players this many seconds behind the latest received snapshot.
// 2 ticks at 62 Hz = 32 ms — matches CS:GO's default cl_interp_ratio 2.
const INTERP_DELAY  = 0.032;
// Allow up to this multiplier past the interpolation window before clamping.
// DarkPlaces calls this "lerpexcess" — it hides single dropped packets.
const LERP_EXCESS   = 0.15;

interface Snapshot {
  x: number; y: number; z: number; yaw: number; t: number;
  // Velocity derived from previous snapshot (units/s). Used for extrapolation.
  vx: number; vy: number; vz: number;
}

interface Entry {
  steve: SteveCharacter;
  data:  RemotePlayerData;
  box:   THREE.Box3;
  snaps: Snapshot[];
}

export class RemotePlayers {
  private map = new Map<string, Entry>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Called when a player joins (from 'join' or 'welcome' events). */
  add(p: RemotePlayerData) {
    if (this.map.has(p.id)) return;
    const steve = new SteveCharacter();
    steve.aiming = true;
    steve.root.position.set(p.x, p.y, p.z);
    this.scene.add(steve.root);
    if (p.id.charCodeAt(0) % 2 === 0) {
      steve.equipSwatArmor();
    } else {
      steve.equipArmor('/marbled/military_armor.geo.json', '/marbled/desert_military_armor.png');
    }
    const def = TIER_GUNS[Math.min(p.tier, TIER_GUNS.length - 1)];
    steve.equipGun(def.geo, def.tex, def.scale);
    const t = performance.now() / 1000;
    this.map.set(p.id, {
      steve,
      data:  { ...p },
      box:   new THREE.Box3(),
      snaps: [{ x: p.x, y: p.y, z: p.z, yaw: 0, t, vx: 0, vy: 0, vz: 0 }],
    });
  }

  /** Called when a player leaves. */
  remove(id: string) {
    const e = this.map.get(id);
    if (!e) return;
    this.scene.remove(e.steve.root);
    this.map.delete(id);
  }

  /** Called when victim respawns — snap to new position and clear the snap buffer. */
  respawn(id: string, x: number, y: number, z: number) {
    const e = this.map.get(id);
    if (!e) return;
    e.data.x = x; e.data.y = y; e.data.z = z;
    // Clear stale snaps so we don't interpolate through the old death position.
    const t = performance.now() / 1000;
    e.snaps = [{ x, y, z, yaw: e.data.yaw, t, vx: 0, vy: 0, vz: 0 }];
  }

  /** Apply ~62 Hz position + tier updates from binary tick. */
  applyTick(players: RemotePlayerData[]) {
    const t = performance.now() / 1000;
    for (const p of players) {
      const e = this.map.get(p.id);
      if (!e) { this.add(p); continue; }

      e.data.x   = p.x;
      e.data.y   = p.y;
      e.data.z   = p.z;
      e.data.yaw = p.yaw;

      // Compute velocity from the previous snapshot for extrapolation.
      const prev = e.snaps[e.snaps.length - 1];
      const dt   = t - prev.t;
      const vx = dt > 0 ? (p.x - prev.x) / dt : prev.vx;
      const vy = dt > 0 ? (p.y - prev.y) / dt : prev.vy;
      const vz = dt > 0 ? (p.z - prev.z) / dt : prev.vz;

      // Push snapshot and keep a rolling 128-frame (~2 s) window.
      e.snaps.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, t, vx, vy, vz });
      if (e.snaps.length > 128) e.snaps.shift();

      if (p.tier !== e.data.tier) {
        e.data.tier = p.tier;
        e.steve.clearGuns();
        const def = TIER_GUNS[Math.min(p.tier, TIER_GUNS.length - 1)];
        e.steve.equipGun(def.geo, def.tex, def.scale);
      }
    }
  }

  /** Per-frame update: interpolate positions CS:GO-style and drive animations. */
  update(dt: number) {
    const now = performance.now() / 1000;
    const renderTime = now - INTERP_DELAY;

    for (const e of this.map.values()) {
      let x = e.data.x, y = e.data.y, z = e.data.z, yaw = e.data.yaw;
      let walking = false;

      const snaps = e.snaps;
      if (snaps.length >= 2) {
        const latest = snaps[snaps.length - 1];

        if (renderTime >= latest.t) {
          // Extrapolation zone — renderTime is past the newest snapshot.
          // Use velocity from the latest snapshot to project forward (Quake 3 style).
          const ahead = renderTime - latest.t;
          x = latest.x + latest.vx * ahead;
          y = latest.y + latest.vy * ahead;
          z = latest.z + latest.vz * ahead;
          yaw = latest.yaw;
        } else {
          // Interpolation zone — find the pair that brackets renderTime.
          let i0 = snaps.length - 2;
          for (let i = snaps.length - 2; i >= 0; i--) {
            if (snaps[i].t <= renderTime) { i0 = i; break; }
          }
          const s0 = snaps[i0];
          const s1 = snaps[i0 + 1];

          if (s1 && s1.t > s0.t) {
            // DarkPlaces lerpexcess: allow slight over-shoot to bridge a dropped packet.
            const raw = (renderTime - s0.t) / (s1.t - s0.t);
            const alpha = Math.max(0, Math.min(1 + LERP_EXCESS, raw));
            x = s0.x + (s1.x - s0.x) * alpha;
            y = s0.y + (s1.y - s0.y) * alpha;
            z = s0.z + (s1.z - s0.z) * alpha;
            // Shortest-arc yaw lerp (Quake 3's LerpAngle).
            let dy = s1.yaw - s0.yaw;
            while (dy >  Math.PI) dy -= 2 * Math.PI;
            while (dy < -Math.PI) dy += 2 * Math.PI;
            yaw = s0.yaw + dy * alpha;
          }
        }

        // Detect walking from the two most recent snaps regardless of render lag.
        const last2 = snaps[snaps.length - 1];
        const prev2 = snaps[snaps.length - 2];
        const moved = Math.hypot(last2.x - prev2.x, last2.z - prev2.z);
        walking = moved > 0.006; // ~0.4 m/s threshold at 62 Hz
      }

      e.steve.root.position.set(x, y, z);
      e.steve.update(dt, walking, yaw);

      // Update hitbox from the interpolated position.
      const c = e.steve.root.position;
      e.box.min.set(c.x - HITBOX_HALF.x, c.y,                     c.z - HITBOX_HALF.z);
      e.box.max.set(c.x + HITBOX_HALF.x, c.y + HITBOX_HALF.y * 2, c.z + HITBOX_HALF.z);
    }
  }

  /**
   * Returns { id, zone, pos } for the closest remote player hit.
   * zone: 0=legs, 1=body, 2=head. pos is the world-space intersection point.
   * Returns id='' on miss.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3): { id: string; zone: number; pos: THREE.Vector3 } {
    const ray = new THREE.Ray(origin, direction.clone().normalize());
    const hitPt = new THREE.Vector3();
    const bestPt = new THREE.Vector3();
    let best = Infinity, bestId = '', bestZone = 1;

    for (const [id, e] of this.map) {
      const result = ray.intersectBox(e.box, hitPt);
      if (result !== null) {
        const dist = origin.distanceTo(hitPt);
        if (dist < best) {
          best = dist;
          bestId = id;
          bestPt.copy(hitPt);
          // Relative height within the box (0 = feet, 1 = top of head)
          const relY = (hitPt.y - e.box.min.y) / (e.box.max.y - e.box.min.y);
          bestZone = relY > 0.75 ? 2 : relY > 0.375 ? 1 : 0; // head(>1.5m) / body / legs
        }
      }
    }
    return { id: bestId, zone: bestZone, pos: bestPt };
  }

  /** Hide a player's Steve immediately (called when they die). */
  hidePlayer(id: string) {
    const e = this.map.get(id);
    if (e) e.steve.root.visible = false;
  }

  /** Show a player's Steve again (called when they respawn). */
  showPlayer(id: string) {
    const e = this.map.get(id);
    if (e) e.steve.root.visible = true;
  }

  removeAll() {
    for (const [id] of this.map) this.remove(id);
  }
}
