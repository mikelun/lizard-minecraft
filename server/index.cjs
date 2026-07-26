'use strict';
// Gun Game (Arms Race) server — uWebSockets.js
// Run: node server/index.cjs

const uWS = require('uWebSockets.js');

const PORT        = parseInt(process.env.PORT || '9001', 10);
const MAX_PLAYERS = 10;
const TICK_MS     = 50; // 20 Hz

// Weapon tiers: each entry is the weapon slot index in the client (Controller.ts weapons[])
//   0=M16A1  1=Deagle  2=MP7  3=P90  4=Ballista  5=LAMG
const GUN_TIERS  = [1, 2, 3, 0, 5, 4]; // Deagle → MP7 → P90 → M16A1 → LAMG → Ballista
const TIER_COUNT = GUN_TIERS.length;

const WEAPON_NAMES = ['M16A1', 'Deagle', 'MP7', 'P90', 'Ballista', 'LAMG'];

const SPAWNS = [
  [-12, 5, 46], [-10, 5, 44], [-8,  5, 42],
  [-14, 5, 48], [-6,  5, 40], [-16, 5, 44],
  [-10, 5, 50], [-4,  5, 46], [-12, 5, 38], [-8, 5, 54],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _nextId   = 1;
let _nextRoom = 0;

function randomSpawn() {
  return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function sendBin(ws, buf) {
  try { ws.send(buf, true); } catch (_) {}
}

// ─── Room ─────────────────────────────────────────────────────────────────────

class Room {
  constructor(id) {
    this.id      = id;
    this.players = new Map(); // playerId → state
    this._tickId = setInterval(() => this._tick(), TICK_MS);
  }

  // 20 Hz position broadcast
  _tick() {
    const ps = [...this.players.values()];
    if (!ps.length) return;

    // Binary: [0x01, count, per-player: id(1)+x(4)+y(4)+z(4)+yaw(4)+tier(1) = 18 bytes]
    const buf = Buffer.allocUnsafe(2 + ps.length * 18);
    buf[0] = 0x01;
    buf[1] = ps.length;
    let off = 2;
    for (const p of ps) {
      buf[off]                = p.id;
      buf.writeFloatLE(p.x,   off + 1);
      buf.writeFloatLE(p.y,   off + 5);
      buf.writeFloatLE(p.z,   off + 9);
      buf.writeFloatLE(p.yaw, off + 13);
      buf[off + 17]           = p.tier;
      off += 18;
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    for (const p of ps) sendBin(p.ws, ab);
  }

  broadcast(obj, excludeId = -1) {
    const str = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id !== excludeId) try { p.ws.send(str); } catch (_) {}
    }
  }

  addPlayer(ws) {
    const id    = _nextId++;
    const spawn = SPAWNS[id % SPAWNS.length];
    const state = { id, ws, x: spawn[0], y: spawn[1], z: spawn[2], yaw: 0, tier: 0, hp: 100, dead: false };
    this.players.set(id, state);

    // Tell the new player their own ID, spawn, and existing peers
    const peers = [...this.players.values()]
      .filter(p => p.id !== id)
      .map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, tier: p.tier }));
    send(ws, { t: 'welcome', id, spawn, tier: 0, players: peers });

    // Tell everyone else about the new player
    this.broadcast({ t: 'join', id, x: spawn[0], y: spawn[1], z: spawn[2], tier: 0 }, id);
    console.log(`[room ${this.id}] player ${id} joined (${this.players.size}/${MAX_PLAYERS})`);
    return state;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.broadcast({ t: 'leave', id });
    console.log(`[room ${this.id}] player ${id} left (${this.players.size}/${MAX_PLAYERS})`);
    if (this.players.size === 0) {
      clearInterval(this._tickId);
      rooms.delete(this.id);
      console.log(`[room ${this.id}] destroyed`);
    }
  }

  movePlayer(id, x, y, z, yaw) {
    const p = this.players.get(id);
    if (p) { p.x = x; p.y = y; p.z = z; p.yaw = yaw; }
  }

  handleHit(attackerId, victimId) {
    const atk = this.players.get(attackerId);
    const vic = this.players.get(victimId);
    if (!atk || !vic || vic.dead || atk.dead) return;

    // Validate: attacker must be in the same room (always true) and not be dead
    vic.hp -= 100;
    if (vic.hp > 0) return;

    vic.hp   = 0;
    vic.dead = true;

    const weaponSlot = GUN_TIERS[atk.tier];
    atk.tier++;

    if (atk.tier >= TIER_COUNT) {
      // Winner!
      console.log(`[room ${this.id}] player ${atk.id} wins!`);
      this.broadcast({ t: 'win', id: atk.id });
      setTimeout(() => this._reset(), 5000);
    } else {
      this.broadcast({
        t:      'kill',
        killer: atk.id,
        victim: vic.id,
        weapon: weaponSlot,
        weaponName: WEAPON_NAMES[weaponSlot],
        killerTier: atk.tier,
      });
    }

    // Respawn victim after 3 s (client shows 3-2-1 countdown)
    setTimeout(() => {
      if (!this.players.has(vic.id)) return;
      const spawn = randomSpawn();
      vic.hp   = 100;
      vic.dead = false;
      vic.x    = spawn[0]; vic.y = spawn[1]; vic.z = spawn[2];
      this.broadcast({ t: 'respawn', id: vic.id, x: spawn[0], y: spawn[1], z: spawn[2] });
    }, 3000);
  }

  _reset() {
    for (const p of this.players.values()) {
      p.tier = 0; p.hp = 100; p.dead = false;
      const spawn = randomSpawn();
      p.x = spawn[0]; p.y = spawn[1]; p.z = spawn[2];
    }
    this.broadcast({ t: 'reset' });
    console.log(`[room ${this.id}] game reset`);
  }

  get full() { return this.players.size >= MAX_PLAYERS; }
}

// ─── Room pool ────────────────────────────────────────────────────────────────

const rooms   = new Map();
const wsState = new Map(); // ws → { room, player }

function getRoom() {
  for (const r of rooms.values()) if (!r.full) return r;
  const r = new Room(_nextRoom++);
  rooms.set(r.id, r);
  return r;
}

// ─── uWebSockets server ───────────────────────────────────────────────────────

uWS.App()
  .ws('/*', {
    idleTimeout:      60,
    maxBackpressure:  8 * 1024,
    maxPayloadLength: 256,
    compression:      uWS.DISABLED,

    open(ws) {
      const room   = getRoom();
      const player = room.addPlayer(ws);
      wsState.set(ws, { room, player });
    },

    message(ws, msg, isBinary) {
      const ctx = wsState.get(ws);
      if (!ctx) return;
      const { room, player } = ctx;

      if (!isBinary) return; // all client→server messages are binary

      const buf  = Buffer.from(msg);
      const type = buf[0];

      // 0x01 — position update [x:f32 y:f32 z:f32 yaw:f32]  (17 bytes)
      if (type === 0x01 && buf.length >= 17) {
        room.movePlayer(
          player.id,
          buf.readFloatLE(1),
          buf.readFloatLE(5),
          buf.readFloatLE(9),
          buf.readFloatLE(13),
        );
      }

      // 0x02 — hit report [targetId:u8]  (2 bytes)
      else if (type === 0x02 && buf.length >= 2) {
        room.handleHit(player.id, buf[1]);
      }
    },

    close(ws) {
      const ctx = wsState.get(ws);
      if (ctx) {
        ctx.room.removePlayer(ctx.player.id);
        wsState.delete(ws);
      }
    },
  })
  .listen(PORT, token => {
    if (token) {
      console.log(`Gun Game server  →  ws://localhost:${PORT}`);
      console.log(`Tiers: ${GUN_TIERS.map(s => WEAPON_NAMES[s]).join(' → ')} → WIN`);
    } else {
      console.error(`Failed to bind port ${PORT}`);
      process.exit(1);
    }
  });
