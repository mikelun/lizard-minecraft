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

// Steve is ~1.8 units tall, 0.6 wide — hitbox is axis-aligned
const HITBOX_HALF = new THREE.Vector3(0.3, 0.9, 0.3);

interface Entry {
  steve: SteveCharacter;
  data:  RemotePlayerData;
  box:   THREE.Box3;
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
    const def = TIER_GUNS[Math.min(p.tier, TIER_GUNS.length - 1)];
    steve.equipGun(def.geo, def.tex, def.scale);
    this.map.set(p.id, { steve, data: { ...p }, box: new THREE.Box3() });
  }

  /** Called when a player leaves. */
  remove(id: number) {
    const e = this.map.get(id);
    if (!e) return;
    this.scene.remove(e.steve.root);
    this.map.delete(id);
  }

  /** Called when victim respawns — snap to new position. */
  respawn(id: number, x: number, y: number, z: number) {
    const e = this.map.get(id);
    if (e) { e.data.x = x; e.data.y = y; e.data.z = z; }
  }

  /** Apply 20 Hz position + tier updates from binary tick. */
  applyTick(players: RemotePlayerData[]) {
    for (const p of players) {
      const e = this.map.get(p.id);
      if (!e) { this.add(p); continue; }

      // Lerp position toward server-reported value (smooths 20 Hz ticks)
      e.data.x   = p.x;
      e.data.y   = p.y;
      e.data.z   = p.z;
      e.data.yaw = p.yaw;

      if (p.tier !== e.data.tier) {
        e.data.tier = p.tier;
        e.steve.clearGuns();
        const def = TIER_GUNS[Math.min(p.tier, TIER_GUNS.length - 1)];
        e.steve.equipGun(def.geo, def.tex, def.scale);
      }
    }
  }

  /** Per-frame update: drive Steve animations and update hitboxes. */
  update(dt: number) {
    for (const e of this.map.values()) {
      e.steve.root.position.set(e.data.x, e.data.y, e.data.z);
      e.steve.update(dt, true, e.data.yaw);
      // Update hitbox (center at feet + half-height up)
      const c = e.steve.root.position;
      e.box.min.set(c.x - HITBOX_HALF.x, c.y,                    c.z - HITBOX_HALF.z);
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

  removeAll() {
    for (const [id] of this.map) this.remove(id);
  }
}
