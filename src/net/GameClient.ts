// Multiplayer client — built on Colyseus.js.
// Server state changes push snapshots into onSnapshot; infrequent game events
// (kill, respawn, etc.) arrive via onEvent.

import { Client as ColyseusClient, Room } from 'colyseus.js';

export interface RemotePlayerData {
  id:   string; // Colyseus sessionId
  x:    number;
  y:    number;
  z:    number;
  yaw:  number;
  tier: number;
}

export type GameEvent =
  | { t: 'welcome'; id: string; spawn: [number,number,number]; tier: number; players: RemotePlayerData[] }
  | { t: 'join';    id: string; x: number; y: number; z: number; tier: number }
  | { t: 'leave';   id: string }
  | { t: 'kill';    killer: string; victim: string; weapon: number; weaponName: string; victimTier: number }
  | { t: 'win';     id: string }
  | { t: 'reset' }
  | { t: 'respawn'; id: string; x: number; y: number; z: number }
  | { t: 'hp';      id: string; hp: number }
  | { t: 'shot';    id: string; dx: number; dy: number; dz: number };

export class GameClient {
  private _client: ColyseusClient;
  private _room:   Room | null = null;

  localId   = '';
  localTier = 0;
  connected = false;

  // Called with the tick's player positions and how stale the tick already was
  // (ms) by the time we finished processing it — Date.now() at receipt minus
  // the server's own Date.now() when it generated the broadcast. RemotePlayers
  // uses this to place the snapshot on ITS OWN performance.now() timeline
  // instead of trusting raw arrival time, which is noisy whenever ticks arrive
  // in a bursty (non-evenly-spaced) way — a real source of interpolation
  // stutter even when the underlying position data is perfectly fine.
  onSnapshot: (players: RemotePlayerData[], lagMs: number) => void = () => {};
  onEvent:    (event: GameEvent) => void            = () => {};

  constructor(url: string) {
    this._client = new ColyseusClient(url);
  }

  connect() {
    this._client.joinOrCreate('game').then((room: Room) => {
      this._room    = room;
      this.localId  = room.sessionId;
      this.connected = true;
      console.log('[GameClient] connected, sessionId:', room.sessionId);

      // ── Position snapshots via JSON tick broadcast ──────────────────
      room.onMessage('tick', (msg: { st: number; players: Array<{ id: string; x: number; y: number; z: number; yaw: number; tier: number }> }) => {
        const others = msg.players.filter(p => p.id !== this.localId);
        if (others.length > 0) this.onSnapshot(others, Date.now() - msg.st);
      });

      // ── Game events ─────────────────────────────────────────────────
      room.onMessage('welcome', (msg: any) => {
        this.localTier = msg.tier ?? 0;
        this.onEvent({ t: 'welcome', id: msg.id, spawn: msg.spawn, tier: msg.tier, players: msg.players ?? [] });
      });

      room.onMessage('join', (msg: any) => {
        this.onEvent({ t: 'join', id: msg.id, x: msg.x, y: msg.y, z: msg.z, tier: msg.tier });
      });

      room.onMessage('kill', (msg: any) => {
        if (msg.victim === this.localId) this.localTier = msg.victimTier;
        this.onEvent({ t: 'kill', killer: msg.killer, victim: msg.victim, weapon: msg.weapon, weaponName: msg.weaponName, victimTier: msg.victimTier });
      });

      room.onMessage('win', (msg: any) => {
        this.onEvent({ t: 'win', id: msg.id });
      });

      room.onMessage('reset', () => {
        this.localTier = 0;
        this.onEvent({ t: 'reset' });
      });

      room.onMessage('respawn', (msg: any) => {
        this.onEvent({ t: 'respawn', id: msg.id, x: msg.x, y: msg.y, z: msg.z });
      });

      room.onMessage('hp', (msg: any) => {
        this.onEvent({ t: 'hp', id: msg.id, hp: msg.hp });
      });

      room.onMessage('shot', (msg: any) => {
        this.onEvent({ t: 'shot', id: msg.id, dx: msg.dx, dy: msg.dy, dz: msg.dz });
      });

      room.onLeave(() => {
        this.connected = false;
        this._room = null;
        console.log('[GameClient] disconnected, retrying in 3s');
        // A dropped connection (server restart, network blip, etc.) only
        // stopped here before — the initial-attempt retry below never fires
        // for a room that HAD connected and then lost it. Reconnect the
        // same way: attempt a fresh joinOrCreate after a short delay.
        setTimeout(() => this.connect(), 3000);
      });

    }).catch((err: Error) => {
      console.error('[GameClient] connection failed:', err.message);
      // Retry after 3 s
      setTimeout(() => this.connect(), 3000);
    });
  }

  sendPosition(x: number, y: number, z: number, yaw: number) {
    if (!this._room || !this.connected) return;
    this._room.send('position', { x, y, z, yaw });
  }

  sendHit(targetId: string, zone: number) {
    if (!this._room || !this.connected) return;
    this._room.send('hit', { targetId, zone });
  }

  sendShot(dx: number, dy: number, dz: number) {
    if (!this._room || !this.connected) return;
    this._room.send('shot', { dx, dy, dz });
  }
}
