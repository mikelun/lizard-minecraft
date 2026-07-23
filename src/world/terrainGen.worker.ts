// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
import { WORLD_HEIGHT } from "../config";

let world: {
  minX: number; minZ: number; sizeX: number; sizeZ: number;
  mcYOffset: number; gameHeight: number;
  sparse: boolean;
  offsets: Uint32Array; bytes: Uint8Array; view: DataView;
} | null = null;

async function loadWorld() {
  const resp = await fetch('/world/world.bin.gz');
  const raw  = await resp.arrayBuffer();
  const hdr  = new Uint8Array(raw, 0, 2);
  let buf: ArrayBuffer;
  if (hdr[0] === 0x1f && hdr[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const w  = ds.writable.getWriter();
    w.write(new Uint8Array(raw));
    w.close();
    buf = await new Response(ds.readable).arrayBuffer();
  } else {
    buf = raw;
  }
  const view = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== 'MCBIN001' && magic !== 'MCBIN002')
    throw new Error('Bad world binary magic: ' + magic);
  const sparse     = magic === 'MCBIN002';
  const minX       = view.getInt32(8,  true);
  const minZ       = view.getInt32(12, true);
  const sizeX      = view.getUint32(16, true);
  const sizeZ      = view.getUint32(20, true);
  const mcYOffset  = view.getInt32(24, true);
  const gameHeight = view.getUint32(28, true);
  const offsets    = new Uint32Array(buf, 32, sizeX * sizeZ);
  const bytes      = new Uint8Array(buf);
  world = { minX, minZ, sizeX, sizeZ, mcYOffset, gameHeight, sparse, offsets, bytes, view };
  console.log('[terrain worker] MC world loaded (' + magic + ')');
}

function getColumn(worldX: number, worldZ: number, out: Uint16Array) {
  if (!world) { out.fill(0); return; }
  const { minX, minZ, sizeX, sizeZ, gameHeight, sparse, view, offsets, bytes } = world;
  const tx = worldX - minX;
  const tz = worldZ - minZ;
  if (tx < 0 || tz < 0 || tx >= sizeX || tz >= sizeZ) { out.fill(0); return; }
  const offset = offsets[tz * sizeX + tx];
  if (!offset) { out.fill(0); return; }
  out.fill(0);
  if (sparse) {
    // MCBIN002: uint8 count + count × (uint8 y, uint16 blockID)
    const count = bytes[offset];
    for (let i = 0; i < count; i++) {
      const y   = bytes[offset + 1 + i * 3];
      const bid = view.getUint16(offset + 1 + i * 3 + 1, true);
      if (y < out.length) out[y] = bid;
    }
  } else {
    // MCBIN001: dense array of gameHeight uint16 values
    const h = Math.min(gameHeight, out.length);
    for (let y = 0; y < h; y++) {
      out[y] = view.getUint16(offset + y * 2, true);
    }
  }
}

export interface InTerrainWorker {
  jobId: number;
  columns: Array<{ x: number; z: number }>;
}

export interface OutTerrainWorker {
  jobId: number;
  columns: Array<{ x: number; z: number; data: ArrayBuffer }>;
}

// Load world binary on startup
const worldReady = loadWorld().catch(e => console.error('World load failed:', e));

self.onmessage = async (e: MessageEvent<InTerrainWorker>) => {
  await worldReady;
  const { jobId, columns } = e.data;
  const results: Array<{ x: number; z: number; data: ArrayBuffer }> = [];
  const transferList: ArrayBuffer[] = [];

  for (const { x, z } of columns) {
    const col = new Uint16Array(WORLD_HEIGHT);
    getColumn(x, z, col);
    results.push({ x, z, data: col.buffer });
    transferList.push(col.buffer);
  }

  (self as any).postMessage(
    { jobId, columns: results } as OutTerrainWorker,
    transferList,
  );
};
