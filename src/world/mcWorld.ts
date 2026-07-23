// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// MC world data loader — replaces procedural terrain generation.
// Reads public/world/world.bin on first access.

let worldData: {
  minX: number; minZ: number; sizeX: number; sizeZ: number;
  mcYOffset: number; gameHeight: number;
  sparse: boolean;
  offsets: Uint32Array;
  bytes: Uint8Array;
  buffer: ArrayBuffer;
  view: DataView;
} | null = null;

let loadPromise: Promise<void> | null = null;

export async function ensureWorldLoaded(): Promise<void> {
  if (worldData) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const resp = await fetch('/world/world.bin');
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
    if (magic !== 'MCBIN001' && magic !== 'MCBIN002') throw new Error('Bad world binary magic');
    const sparse     = magic === 'MCBIN002';
    const minX       = view.getInt32(8,  true);
    const minZ       = view.getInt32(12, true);
    const sizeX      = view.getUint32(16, true);
    const sizeZ      = view.getUint32(20, true);
    const mcYOffset  = view.getInt32(24, true);
    const gameHeight = view.getUint32(28, true);
    const offsetTable = new Uint32Array(buf, 32, sizeX * sizeZ);
    const bytes = new Uint8Array(buf);
    worldData = { minX, minZ, sizeX, sizeZ, mcYOffset, gameHeight, sparse,
                  offsets: offsetTable, bytes, buffer: buf, view };
    console.log(`MC world loaded: ${sizeX}×${sizeZ} columns, Y offset ${mcYOffset}`);
  })();
  return loadPromise;
}

export function getWorldColumn(worldX: number, worldZ: number, out: Uint16Array): boolean {
  if (!worldData) return false;
  const { minX, minZ, sizeX, sizeZ, gameHeight, sparse, view, offsets, bytes } = worldData;
  const tx = worldX - minX;
  const tz = worldZ - minZ;
  if (tx < 0 || tz < 0 || tx >= sizeX || tz >= sizeZ) {
    out.fill(0); return true;
  }
  const idx = tz * sizeX + tx;
  const offset = offsets[idx];
  if (!offset) { out.fill(0); return true; }
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
  return true;
}

export function isWorldLoaded(): boolean { return !!worldData; }
