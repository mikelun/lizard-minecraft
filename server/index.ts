// Gun Game server — Colyseus
import { Server, Room, Client } from 'colyseus';
import { Schema, MapSchema, type } from '@colyseus/schema';
import { uWebSocketsTransport } from '@colyseus/uwebsockets-transport';

const PORT      = parseInt(process.env.PORT || '9001', 10);
const TICK_MS   = 16; // ~62 Hz

const SPAWNS: [number, number, number][] = [
  [-12, 5, 46], [-10, 5, 44], [-8,  5, 42],
  [-14, 5, 48], [-6,  5, 40], [-16, 5, 44],
  [-10, 5, 50], [-4,  5, 46], [-12, 5, 38], [-8, 5, 54],
];

// slot indices matching client's TIER_GUNS array
const GUN_TIERS    = [1, 2, 3, 0, 5, 4]; // Deagle→MP7→P90→M16→LAMG→Ballista
const TIER_COUNT   = GUN_TIERS.length;
const WEAPON_NAMES = ['M16A1', 'Deagle', 'MP7', 'P90', 'Ballista', 'LAMG'];
const WEAPON_DAMAGE= [35, 50, 25, 20, 100, 15]; // base dmg by slot
const ZONE_MULT    = [0.75, 1.0, 4.0];           // legs / body / head

function randomSpawn(): [number, number, number] {
  return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

// ── Schemas ───────────────────────────────────────────────────────────────────

class Player extends Schema {
  @type('float32') x    = 0;
  @type('float32') y    = 0;
  @type('float32') z    = 0;
  @type('float32') yaw  = 0;
  @type('uint8')   tier = 0;
  @type('uint8')   hp   = 100;
  @type('boolean') dead = false;
}

class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

// ── Room ──────────────────────────────────────────────────────────────────────

class GameRoom extends Room<GameState> {
  maxClients = 10;

  onCreate() {
    this.setState(new GameState());
    this.setPatchRate(TICK_MS);

    // Broadcast JSON tick — client uses this instead of schema state (simpler, no rootSchema needed)
    this.setSimulationInterval(() => {
      if (this.clients.length < 2) return;
      const positions: { id: string; x: number; y: number; z: number; yaw: number; tier: number }[] = [];
      this.state.players.forEach((p, id) => {
        positions.push({ id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, tier: p.tier });
      });
      this.broadcast('tick', positions);
    }, TICK_MS);

    this.onMessage('position', (client: Client, msg: { x: number; y: number; z: number; yaw: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && !p.dead) { p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw; }
    });

    this.onMessage('hit', (client: Client, msg: { targetId: string; zone: number }) => {
      this._handleHit(client.sessionId, msg.targetId, (msg.zone | 0) as 0 | 1 | 2);
    });
  }

  onJoin(client: Client) {
    const spawn = randomSpawn();
    const p     = new Player();
    p.x = spawn[0]; p.y = spawn[1]; p.z = spawn[2];
    this.state.players.set(client.sessionId, p);

    // Welcome: spawn coords + peer list for immediate display
    const peers = Array.from(this.state.players.entries())
      .filter(([id]) => id !== client.sessionId)
      .map(([id, q]) => ({ id, x: q.x, y: q.y, z: q.z, yaw: q.yaw, tier: q.tier }));
    client.send('welcome', { t: 'welcome', id: client.sessionId, spawn, tier: 0, players: peers });

    this.broadcast('join', { t: 'join', id: client.sessionId, x: spawn[0], y: spawn[1], z: spawn[2], tier: 0 }, { except: client });
    console.log(`[GameRoom] ${client.sessionId.slice(0,6)} joined (${this.clients.length}/${this.maxClients})`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.broadcast('leave', { t: 'leave', id: client.sessionId });
    console.log(`[GameRoom] ${client.sessionId.slice(0,6)} left`);
  }

  private _handleHit(attackerId: string, victimId: string, zone: 0 | 1 | 2) {
    const atk = this.state.players.get(attackerId);
    const vic = this.state.players.get(victimId);
    if (!atk || !vic || vic.dead || atk.dead) return;

    const slot = GUN_TIERS[atk.tier];
    vic.hp = Math.max(0, vic.hp - Math.round((WEAPON_DAMAGE[slot] ?? 25) * (ZONE_MULT[zone] ?? 1)));
    if (vic.hp > 0) return;

    vic.hp = 0; vic.dead = true;
    vic.tier++;

    if (vic.tier >= TIER_COUNT) {
      this.broadcast('win', { t: 'win', id: victimId });
      setTimeout(() => this._reset(), 5000);
    } else {
      this.broadcast('kill', {
        t: 'kill',
        killer: attackerId, victim: victimId,
        weapon: slot, weaponName: WEAPON_NAMES[slot],
        victimTier: vic.tier,
      });
    }

    setTimeout(() => {
      if (!this.state.players.has(victimId)) return;
      const s = randomSpawn();
      const v = this.state.players.get(victimId)!;
      v.hp = 100; v.dead = false;
      v.x = s[0]; v.y = s[1]; v.z = s[2];
      this.broadcast('respawn', { t: 'respawn', id: victimId, x: s[0], y: s[1], z: s[2] });
    }, 3000);
  }

  private _reset() {
    this.state.players.forEach(p => {
      p.tier = 0; p.hp = 100; p.dead = false;
      const s = randomSpawn();
      p.x = s[0]; p.y = s[1]; p.z = s[2];
    });
    this.broadcast('reset', { t: 'reset' });
    console.log('[GameRoom] round reset');
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const transport  = new uWebSocketsTransport();
const gameServer = new Server({ transport });
gameServer.define('game', GameRoom);
gameServer.listen(PORT)
  .then(() => console.log(`[Colyseus] listening on port ${PORT}  (${TICK_MS}ms patch rate)`))
  .catch(err => { console.error(err); process.exit(1); });
