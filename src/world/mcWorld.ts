// MC world data loader — replaces procedural terrain generation.
// Reads public/world/world.bin on first access.

const MAGIC = 'MCBIN001';
let worldData: {
  minX: number; minZ: number; sizeX: number; sizeZ: number;
  mcYOffset: number; gameHeight: number;
  offsets: Uint32Array;
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
    if (magic !== MAGIC) throw new Error('Bad world binary magic');
    const minX       = view.getInt32(8,  true);
    const minZ       = view.getInt32(12, true);
    const sizeX      = view.getUint32(16, true);
    const sizeZ      = view.getUint32(20, true);
    const mcYOffset  = view.getInt32(24, true);
    const gameHeight = view.getUint32(28, true);
    const offsetTable = new Uint32Array(buf, 32, sizeX * sizeZ);
    worldData = { minX, minZ, sizeX, sizeZ, mcYOffset, gameHeight,
                  offsets: offsetTable, buffer: buf, view };
    console.log(`MC world loaded: ${sizeX}×${sizeZ} columns, Y offset ${mcYOffset}`);
  })();
  return loadPromise;
}

export function getWorldColumn(worldX: number, worldZ: number, out: Uint16Array): boolean {
  if (!worldData) return false;
  const { minX, minZ, sizeX, sizeZ, gameHeight, view, offsets } = worldData;
  const tx = worldX - minX;
  const tz = worldZ - minZ;
  if (tx < 0 || tz < 0 || tx >= sizeX || tz >= sizeZ) {
    out.fill(0); return true;
  }
  const idx = tz * sizeX + tx;
  const offset = offsets[idx];
  if (!offset) { out.fill(0); return true; }
  out.fill(0);
  const h = Math.min(gameHeight, out.length);
  for (let y = 0; y < h; y++) {
    out[y] = view.getUint16(offset + y * 2, true);
  }
  return true;
}

export function isWorldLoaded(): boolean { return !!worldData; }
