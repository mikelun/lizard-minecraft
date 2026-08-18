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
  | { t: 'hp';      id: string; hp: number };

export class GameClient {
  private _client: ColyseusClient;
  private _room:   Room | null = null;

  localId   = '';
  localTier = 0;
  connected = false;

  // Called with an array of 1 player whenever that player's schema state changes.
  onSnapshot: (players: RemotePlayerData[]) => void = () => {};
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
      room.onMessage('tick', (positions: Array<{ id: string; x: number; y: number; z: number; yaw: number; tier: number }>) => {
        const others = positions.filter(p => p.id !== this.localId);
        if (others.length > 0) this.onSnapshot(others);
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

      room.onLeave(() => {
        this.connected = false;
        console.log('[GameClient] disconnected');
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
}
