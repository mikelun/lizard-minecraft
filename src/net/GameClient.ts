// WebSocket client for the Gun Game server.
// Binary protocol (client → server):
//   0x01  position: [x:f32le y:f32le z:f32le yaw:f32le]  17 bytes
//   0x02  hit:      [targetId:u8]                          2 bytes
//
// Binary protocol (server → client):
//   0x01  tick: [count:u8, per-player: id(1)+x(4)+y(4)+z(4)+yaw(4)+tier(1) = 18 bytes]
//
// JSON events (server → client, text frames):
//   welcome | join | leave | kill | win | reset | respawn

export interface RemotePlayerData {
  id:   number;
  x:    number;
  y:    number;
  z:    number;
  yaw:  number;
  tier: number;
}

export type GameEvent =
  | { t: 'welcome'; id: number; spawn: [number,number,number]; tier: number; players: RemotePlayerData[] }
  | { t: 'join';    id: number; x: number; y: number; z: number; tier: number }
  | { t: 'leave';   id: number }
  | { t: 'kill';    killer: number; victim: number; weapon: number; weaponName: string; killerTier: number }
  | { t: 'win';     id: number }
  | { t: 'reset' }
  | { t: 'respawn'; id: number; x: number; y: number; z: number };

export class GameClient {
  private ws:         WebSocket | null = null;
  private _posBuf  = new ArrayBuffer(17);
  private _posView: DataView;
  private _hitBuf  = new ArrayBuffer(3); // [0x02, targetId, zone]
  private _hitView: DataView;

  localId   = -1;
  localTier =  0;
  connected = false;

  onTick:  (players: RemotePlayerData[]) => void = () => {};
  onEvent: (event: GameEvent) => void            = () => {};

  constructor(private readonly url: string) {
    this._posView = new DataView(this._posBuf);
    this._hitView = new DataView(this._hitBuf);
    this._hitView.setUint8(0, 0x02);
  }

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      console.log('[GameClient] connected');
    };

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        this._parseTick(e.data);
      } else {
        const ev = JSON.parse(e.data as string) as GameEvent;
        if (ev.t === 'welcome') {
          this.localId   = ev.id;
          this.localTier = ev.tier;
        } else if (ev.t === 'kill' && ev.killer === this.localId) {
          this.localTier = ev.killerTier;
        } else if (ev.t === 'reset') {
          this.localTier = 0;
        }
        this.onEvent(ev);
      }
    };

    ws.onclose  = () => { this.connected = false; console.log('[GameClient] disconnected'); };
    ws.onerror  = () => { this.connected = false; };
  }

  private _parseTick(buf: ArrayBuffer) {
    const v = new DataView(buf);
    if (v.getUint8(0) !== 0x01) return;
    const count = v.getUint8(1);
    const out: RemotePlayerData[] = [];
    let off = 2;
    for (let i = 0; i < count; i++, off += 18) {
      const id = v.getUint8(off);
      if (id === this.localId) continue; // skip self
      out.push({
        id,
        x:    v.getFloat32(off + 1,  true),
        y:    v.getFloat32(off + 5,  true),
        z:    v.getFloat32(off + 9,  true),
        yaw:  v.getFloat32(off + 13, true),
        tier: v.getUint8(off + 17),
      });
    }
    if (out.length) this.onTick(out);
  }

  sendPosition(x: number, y: number, z: number, yaw: number) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._posView.setUint8(0,    0x01);
    this._posView.setFloat32(1,  x,   true);
    this._posView.setFloat32(5,  y,   true);
    this._posView.setFloat32(9,  z,   true);
    this._posView.setFloat32(13, yaw, true);
    this.ws.send(this._posBuf);
  }

  sendHit(targetId: number, zone: number) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._hitView.setUint8(1, targetId);
    this._hitView.setUint8(2, zone);
    this.ws.send(this._hitBuf);
  }
}
