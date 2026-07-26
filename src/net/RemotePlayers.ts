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

const HITBOX_HALF = new THREE.Vector3(0.3, 0.9, 0.3);

// CS:GO cl_interp equivalent — render remote players this many seconds behind
// the most recently received snapshot. At 20 Hz ticks (50 ms), 100 ms gives us
// exactly 2 ticks of buffer, enough to always have two frames to interpolate between.
const INTERP_DELAY = 0.1;

interface Snapshot {
  x: number; y: number; z: number; yaw: number; t: number;
}

interface Entry {
  steve: SteveCharacter;
  data:  RemotePlayerData;
  box:   THREE.Box3;
  snaps: Snapshot[];
}

export class RemotePlayers {
  private map = new Map<number, Entry>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Called when a player joins (from 'join' or 'welcome' events). */
  add(p: RemotePlayerData) {
    if (this.map.has(p.id)) return;
    const steve = new SteveCharacter();
    steve.aiming = true;
    steve.root.position.set(p.x, p.y, p.z);
    this.scene.add(steve.root);
    if (p.id % 2 === 0) {
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
      snaps: [{ x: p.x, y: p.y, z: p.z, yaw: 0, t }],
    });
  }

  /** Called when a player leaves. */
  remove(id: number) {
    const e = this.map.get(id);
    if (!e) return;
    this.scene.remove(e.steve.root);
    this.map.delete(id);
  }

  /** Called when victim respawns — snap to new position and clear the snap buffer. */
  respawn(id: number, x: number, y: number, z: number) {
    const e = this.map.get(id);
    if (!e) return;
    e.data.x = x; e.data.y = y; e.data.z = z;
    // Clear stale snaps so we don't interpolate through the old death position.
    const t = performance.now() / 1000;
    e.snaps = [{ x, y, z, yaw: e.data.yaw, t }];
  }

  /** Apply 20 Hz position + tier updates from binary tick. */
  applyTick(players: RemotePlayerData[]) {
    const t = performance.now() / 1000;
    for (const p of players) {
      const e = this.map.get(p.id);
      if (!e) { this.add(p); continue; }

      e.data.x   = p.x;
      e.data.y   = p.y;
      e.data.z   = p.z;
      e.data.yaw = p.yaw;

      // Push snapshot and keep a rolling 30-frame (~1.5 s) window.
      e.snaps.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, t });
      if (e.snaps.length > 30) e.snaps.shift();

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
        // Find the pair of snapshots that bracket renderTime (walk backward from end).
        let i0 = 0;
        for (let i = snaps.length - 2; i >= 0; i--) {
          if (snaps[i].t <= renderTime) { i0 = i; break; }
        }
        const s0 = snaps[i0];
        const s1 = snaps[Math.min(i0 + 1, snaps.length - 1)];

        if (s1.t > s0.t) {
          const alpha = Math.max(0, Math.min(1, (renderTime - s0.t) / (s1.t - s0.t)));
          x = s0.x + (s1.x - s0.x) * alpha;
          y = s0.y + (s1.y - s0.y) * alpha;
          z = s0.z + (s1.z - s0.z) * alpha;
          // Yaw: always take the shortest arc to avoid 360° wrapping artefacts.
          let dy = s1.yaw - s0.yaw;
          while (dy >  Math.PI) dy -= 2 * Math.PI;
          while (dy < -Math.PI) dy += 2 * Math.PI;
          yaw = s0.yaw + dy * alpha;
        }

        // Detect walking from the two most recent snaps regardless of render lag.
        const last = snaps[snaps.length - 1];
        const prev = snaps[snaps.length - 2];
        const moved = Math.hypot(last.x - prev.x, last.z - prev.z);
        walking = moved > 0.02; // ~0.4 m/s threshold at 20 Hz
      }

      e.steve.root.position.set(x, y, z);
      e.steve.update(dt, walking, yaw);

      // Update hitbox from the interpolated position.
      const c = e.steve.root.position;
      e.box.min.set(c.x - HITBOX_HALF.x, c.y,                     c.z - HITBOX_HALF.z);
      e.box.max.set(c.x + HITBOX_HALF.x, c.y + HITBOX_HALF.y * 2, c.z + HITBOX_HALF.z);
    }
  }

  /** Returns the ID of the first remote player whose hitbox the ray intersects, or -1. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3): number {
    const ray = new THREE.Ray(origin, direction.clone().normalize());
    let best = Infinity, bestId = -1;
    for (const [id, e] of this.map) {
      const t = ray.intersectBox(e.box, new THREE.Vector3());
      if (t !== null) {
        const dist = origin.distanceTo(t);
        if (dist < best) { best = dist; bestId = id; }
      }
    }
    return bestId;
  }

  /** Hide a player's Steve immediately (called when they die). */
  hidePlayer(id: number) {
    const e = this.map.get(id);
    if (e) e.steve.root.visible = false;
  }

  /** Show a player's Steve again (called when they respawn). */
  showPlayer(id: number) {
    const e = this.map.get(id);
    if (e) e.steve.root.visible = true;
  }

  removeAll() {
    for (const [id] of this.map) this.remove(id);
  }
}
