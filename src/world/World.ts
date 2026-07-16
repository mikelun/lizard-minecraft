// NEW orchestrator, modeled on escape-tsuami-client/src/game/map/World.ts's
// responsibilities (chunk streaming by player position, slot allocation for
// the uChunkPositions lookup texture, get/set/place block) but decoupled from
// `game`, the Zustand store and the websocket -- and simplified:
//  - chunks are meshed one-vertical-chunk-at-a-time (16x16x16), keyed by "cx,cy,cz"
//  - terrain is regenerated on demand from terrain.ts instead of cached/evicted
//    with RLE (chunkRLE.ts is ported and available, but regenerating a
//    deterministic noise column is cheap enough that eviction caching isn't
//    needed for a single-player game at this render distance)
//  - player edits (breaks/places) live in a sparse overlay map that is never
//    evicted, and always wins over freshly-generated terrain

import * as THREE from "three";
import {
  CACHED_RENDER_DISTANCE,
  CHUNK_SIZE,
  MAX_HEIGHT_IN_CHUNKS,
  RENDER_DISTANCE,
  SEA_LEVEL,
  WORLD_HEIGHT,
} from "../config";
import { BType } from "./types";
import { ChunkMeshPool } from "./ChunkMeshPool";
import { vsChunk, fsChunk } from "./shaders";
import type { BlockTextureAtlas } from "../textures/blockTextures";
import type { InChunkMeshWorker, OutChunkMeshWorker } from "./chunkMesh.worker";
import ChunkMeshWorker from "./chunkMesh.worker?worker";
import type { InTerrainWorker, OutTerrainWorker } from "./terrainGen.worker";
import TerrainGenWorker from "./terrainGen.worker?worker";
import type { ModelLayer } from "./ModelLayer";
import type { ChainBlockLayer } from "./ChainBlockLayer";
import { SLAB_BTYPES } from "./SlabLayer";
import type { SlabLayer } from "./SlabLayer";
import { CROSS_POST_BTYPES } from "./CrossPostLayer";
import type { CrossPostLayer } from "./CrossPostLayer";
import { DOOR_BTYPES } from "./DoorLayer";
import type { DoorLayer } from "./DoorLayer";
import { STAIR_ID_MIN, STAIR_ID_MAX } from "./StairLayer";
import type { StairLayer } from "./StairLayer";

const S = CHUNK_SIZE;
const SP = S + 4;
const WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
// Per-column main-thread cost dropped ~7x once dispatchMesh stopped doing
// per-voxel Map lookups (see dispatchMesh), so streaming can afford to load
// more columns/tick -- keeps mountain columns (which mesh up to
// MAX_HEIGHT_IN_CHUNKS chunks each) from lagging visibly behind the player.
const LOADS_PER_TICK = 10;

function columnKey(cx: number, cz: number) {
  return `${cx},${cz}`;
}
function chunkKey(cx: number, cy: number, cz: number) {
  return `${cx},${cy},${cz}`;
}
function blockKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

interface ChunkEntry {
  slotId: number;
  meshed: boolean;
}

export class World {
  readonly material: THREE.ShaderMaterial;

  private meshPool!: ChunkMeshPool;
  private readonly atlas: BlockTextureAtlas;

  private readonly terrainColumns = new Map<string, Uint16Array>();
  private readonly edits = new Map<string, BType>();
  // Which columns have at least one edit -- lets dispatchMesh skip the
  // per-voxel edits.get() lookup entirely for the (overwhelming majority of)
  // untouched columns instead of doing a Map.get() with a freshly-allocated
  // string key for every single voxel it samples.
  private readonly editedColumns = new Set<string>();

  private readonly chunks = new Map<string, ChunkEntry>();
  private readonly loadedColumns = new Set<string>();

  private readonly freeSlots: number[] = [];
  private nextSlot = 0;

  private readonly workers: Worker[] = [];
  private nextWorker = 0;
  private readonly inFlight = new Set<string>();

  // Terrain generation worker — runs generateColumn off the main thread so
  // chunk loading never blocks the render loop.
  private readonly terrainWorker: Worker;
  private terrainJobCounter = 0;
  // jobId → column key of the chunk column waiting on this job
  private readonly terrainJobs = new Map<number, string>();

  private startChunkX = 0;
  private startChunkZ = 0;
  private loadQueue: { cx: number; cz: number; dist: number }[] = [];

  /** Optional model layer; set from outside before the game loop starts. */
  modelLayer: ModelLayer | null = null;
  /** Optional chain block layer; set from outside before the game loop starts. */
  chainLayer: ChainBlockLayer | null = null;
  /** Optional slab layer; set from outside before the game loop starts. */
  slabLayer: SlabLayer | null = null;
  /** Optional cross-post layer (iron bars, glass pane, fence). */
  crossPostLayer: CrossPostLayer | null = null;
  /** Optional door layer (doors, trapdoors). */
  doorLayer: DoorLayer | null = null;
  /** Optional stair layer (L-shaped stair blocks). */
  stairLayer: StairLayer | null = null;

  // World binary loaded on the main thread for synchronous collision queries.
  private binBuffer: ArrayBuffer | null = null; // raw buffer for fast Uint16Array views
  private binView: DataView | null = null;
  private binOffsets: Uint32Array | null = null;
  private binSparse = false;
  private binMinX = 0;
  private binMinZ = 0;
  private binSizeX = 0;
  private binSizeZ = 0;
  private binGameHeight = 0;

  // Columns whose terrain data is ready but whose mesh hasn't been dispatched
  // yet. Processed N-per-tick in update() to avoid frame spikes when the
  // terrain worker flushes many jobs at once.
  private readonly pendingColumnMesh: string[] = [];
  private static readonly MESH_DISPATCHES_PER_TICK = 3;

  // Raw mesh results from workers, queued so we never process more than N per
  // frame — prevents a burst of worker completions from spiking frame time.
  private readonly pendingMeshResults: OutChunkMeshWorker[] = [];
  private static readonly MESH_RESULTS_PER_TICK = 6;
  // Column GPU rebuilds per frame — batches all slice updates for a column
  // into one rebuildColumn() call instead of one per arriving slice.
  private static readonly COLUMN_FLUSHES_PER_TICK = 4;

  constructor(atlas: BlockTextureAtlas, scene: THREE.Scene) {
    this.atlas = atlas;
    // Size must cover all BType values including stair IDs up to 113,
    // trapdoor encoded IDs up to 177, and top-slab IDs up to 184.
    const LOOKUP_SIZE = 256;
    const vt = new Uint8Array(LOOKUP_SIZE);
    for (let id = 0; id < LOOKUP_SIZE; id++) vt[id] = this.isVoidBlock(id) ? 1 : 0;
    // Chest is handled by ModelLayer — treat as void so adjacent blocks show
    // faces in the 1/16 gap around the chest model.
    vt[BType.chest] = 1;
    // Chain is handled by ChainBlockLayer — treat as void so neighbour faces render.
    vt[BType.chain] = 1;
    // Slabs are handled by SlabLayer — treat as void so neighbour faces render.
    for (const id of SLAB_BTYPES) vt[id] = 1;
    // Cross-post blocks (iron bars, glass pane, fence) — treat as void.
    for (const id of CROSS_POST_BTYPES) vt[id] = 1;
    // Door/trapdoor blocks — treat as void.
    for (const id of DOOR_BTYPES) vt[id] = 1;
    // New encoded trapdoor range 114-177 — treat as void.
    for (let id = 114; id <= 177; id++) vt[id] = 1;
    // Stair blocks — treat as void so StairLayer handles rendering.
    for (let id = STAIR_ID_MIN; id <= STAIR_ID_MAX; id++) vt[id] = 1;
    // Encoded door blocks 185-232 (type*4 + facing, 12 door types × 4 facings).
    for (let id = 185; id <= 232; id++) vt[id] = 1;
    this.voidLookup = vt;
    const ll = new Uint8Array(LOOKUP_SIZE);
    ll[BType.leaf] = 1;
    ll[BType.cherry_leaf] = 1;
    this.leafLookup = ll;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vsChunk,
      fragmentShader: fsChunk,
      uniforms: {
        playerPos:     { value: new THREE.Vector3() },
        uTextureArray: { value: this.atlas.texture },
        timeOfDay:     { value: 0.28 },
      },
      side: THREE.DoubleSide,
    });

    this.meshPool = new ChunkMeshPool(this.material, scene);

    for (let i = 0; i < WORKER_COUNT; i++) {
      const w = new ChunkMeshWorker();
      w.onmessage = (e: MessageEvent<OutChunkMeshWorker>) => this.onMeshResult(e.data);
      this.workers.push(w);
    }

    this.terrainWorker = new TerrainGenWorker();
    this.terrainWorker.onmessage = (e: MessageEvent<OutTerrainWorker>) =>
      this.onTerrainResult(e.data);
  }

  setTimeOfDay(t: number) {
    (this.material.uniforms.timeOfDay.value as number) = t;
  }

  surfaceHeightAt(worldX: number, worldZ: number): number {
    // For the MC world the map is all in game Y 0-47 (MC Y -64 to -17).
    // Return the topmost non-air block in the cached column, or 40 as fallback.
    const col = this.getTerrainColumn(Math.floor(worldX), Math.floor(worldZ));
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (col[y] !== BType.air) return y;
    }
    return 40;
  }

  // ---- terrain / edits -------------------------------------------------

  private static readonly EMPTY_COLUMN = new Uint16Array(WORLD_HEIGHT);

  /** Fetch world.bin on the main thread so getTerrainColumn can read it
   *  synchronously — no worker round-trip needed for collision queries. */
  async loadBin(): Promise<void> {
    try {
      const resp = await fetch(`/world/world.bin.gz?v=${Date.now()}`);
      const ds   = new DecompressionStream('gzip');
      resp.body!.pipeTo(ds.writable);
      const buf  = await new Response(ds.readable).arrayBuffer();
      const view = new DataView(buf);
      const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
      if (magic !== 'MCBIN001' && magic !== 'MCBIN002') { console.warn('loadBin: bad magic', magic); return; }
      this.binSparse    = magic === 'MCBIN002';
      this.binMinX      = view.getInt32(8,  true);
      this.binMinZ      = view.getInt32(12, true);
      this.binSizeX     = view.getUint32(16, true);
      this.binSizeZ     = view.getUint32(20, true);
      this.binGameHeight= view.getUint32(28, true);
      this.binOffsets   = new Uint32Array(buf, 32, this.binSizeX * this.binSizeZ);
      this.binView      = view;
      this.binBuffer    = buf;
      console.log(`[World] bin loaded (${magic}, ${(buf.byteLength/1024).toFixed(0)} KB decompressed)`);
    } catch (e) {
      console.warn('[World] loadBin failed:', e);
    }
  }

  /** Read one column synchronously from the binary and cache it. */
  private loadColumnFromBin(x: number, z: number): Uint16Array {
    const col = new Uint16Array(WORLD_HEIGHT);
    if (this.binBuffer && this.binOffsets) {
      const tx = x - this.binMinX;
      const tz = z - this.binMinZ;
      if (tx >= 0 && tz >= 0 && tx < this.binSizeX && tz < this.binSizeZ) {
        const offset = this.binOffsets[tz * this.binSizeX + tx];
        if (offset) {
          if (this.binSparse) {
            // MCBIN002: uint8 count + count×(uint8 y, uint16 blockID)
            const bytes = new Uint8Array(this.binBuffer!, offset);
            const count = bytes[0];
            const dv    = this.binView!;
            for (let i = 0; i < count; i++) {
              const y   = bytes[1 + i * 3];
              const bid = dv.getUint16(offset + 1 + i * 3 + 1, true);
              if (y < WORLD_HEIGHT) col[y] = bid;
            }
          } else {
            // MCBIN001: dense array of gameHeight uint16 values
            const h = Math.min(this.binGameHeight, WORLD_HEIGHT);
            col.set(new Uint16Array(this.binBuffer!, offset, h));
          }
        }
      }
    }
    const k = columnKey(x, z);
    this.terrainColumns.set(k, col);
    return col;
  }

  private getTerrainColumn(x: number, z: number): Uint16Array {
    const k = columnKey(x, z);
    const cached = this.terrainColumns.get(k);
    if (cached) return cached;
    // If the binary is loaded, read synchronously so physics never sees stale air.
    if (this.binView) return this.loadColumnFromBin(x, z);
    return World.EMPTY_COLUMN;
  }

  getBlock(worldX: number, worldY: number, worldZ: number): BType {
    worldX = Math.floor(worldX);
    worldY = Math.floor(worldY);
    worldZ = Math.floor(worldZ);
    if (worldY < 0 || worldY >= WORLD_HEIGHT) return BType.air;

    const edit = this.edits.get(blockKey(worldX, worldY, worldZ));
    if (edit !== undefined) return edit;

    return this.getTerrainColumn(worldX, worldZ)[worldY] as BType;
  }

  isSolid(worldX: number, worldY: number, worldZ: number): boolean {
    if (worldY < 0) return true;
    const id = this.getBlock(worldX, worldY, worldZ);
    return id !== BType.air && id !== BType.water;
  }

  private isVoidBlock(id: number): boolean {
    // Water treated as solid — cross-chunk water-above-water culled correctly.
    // Leaves have isTransparent:true so other blocks show faces at leaf boundaries,
    // and cross-chunk leaf faces are emitted (leafMap then decides solid vs transparent).
    if (id === BType.water) return false;
    return id === BType.air || this.atlas.blockDefs[id]?.isTransparent === true;
  }

  // Precomputed id -> void(1)/solid(0) table so the voidMap inner loop is a
  // plain array index instead of a function call + optional-chaining lookup
  // into blockDefs for every one of the (S+4)^3 samples per chunk.
  // Initialized in constructor after atlas is set (field initializers run
  // before the constructor body, so atlas would be undefined here).
  private readonly voidLookup: Uint8Array;
  private readonly leafLookup: Uint8Array;

  setBlock(worldX: number, worldY: number, worldZ: number, id: BType) {
    worldX = Math.floor(worldX);
    worldY = Math.floor(worldY);
    worldZ = Math.floor(worldZ);
    if (worldY < 0 || worldY >= WORLD_HEIGHT) return;

    this.edits.set(blockKey(worldX, worldY, worldZ), id);
    this.editedColumns.add(columnKey(worldX, worldZ));
    this.modelLayer?.onBlockChanged(worldX, worldY, worldZ, id);

    const cx = worldX >> 4, cy = worldY >> 4, cz = worldZ >> 4;
    this.remeshChunk(cx, cy, cz);

    const lx = worldX & 15, ly = worldY & 15, lz = worldZ & 15;
    if (lx === 0) this.remeshChunk(cx - 1, cy, cz);
    if (lx === 15) this.remeshChunk(cx + 1, cy, cz);
    if (ly === 0) this.remeshChunk(cx, cy - 1, cz);
    if (ly === 15) this.remeshChunk(cx, cy + 1, cz);
    if (lz === 0) this.remeshChunk(cx, cy, cz - 1);
    if (lz === 15) this.remeshChunk(cx, cy, cz + 1);
  }

  // ---- slot management ---------------------------------------------------

  private allocSlot(): number {
    return this.freeSlots.pop() ?? this.nextSlot++;
  }

  private freeSlot(id: number) {
    this.freeSlots.push(id);
  }

  // ---- meshing ------------------------------------------------------------

  private remeshChunk(cx: number, cy: number, cz: number) {
    if (cy < 0 || cy >= MAX_HEIGHT_IN_CHUNKS) return;
    const key = chunkKey(cx, cy, cz);
    const entry = this.chunks.get(key);
    if (!entry) return; // not currently loaded -> will be generated fresh when it streams in
    this.dispatchMesh(cx, cy, cz, entry.slotId);
  }

  // Surface-height bounds over a chunk-column's padded neighborhood.
  // Scans the already-cached terrain columns for the topmost non-air block.
  private columnHeightBounds(cx: number, cz: number): { minH: number; maxH: number } {
    const originX = cx * S, originZ = cz * S;
    let minH = Infinity, maxH = -Infinity;
    for (let vx = -2; vx < S + 2; vx++) {
      const wx = originX + vx;
      for (let vz = -2; vz < S + 2; vz++) {
        const col = this.getTerrainColumn(wx, originZ + vz);
        let h = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (col[y] !== BType.air) { h = y; break; }
        }
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    return { minH: minH === Infinity ? 0 : minH, maxH: maxH === -Infinity ? 0 : maxH };
  }

  private dispatchMesh(
    cx: number,
    cy: number,
    cz: number,
    slotId: number,
    bounds: { minH: number; maxH: number } | null = null,
  ) {
    const key = chunkKey(cx, cy, cz);
    if (this.inFlight.has(key)) return;

    const originX = cx * S, originY = cy * S, originZ = cz * S;

    // Most of a tall column's vertical chunks are either deep-underground
    // solid stone or empty sky -- both guaranteed to mesh to zero exposed
    // faces. `bounds` (only ever passed while there are no player edits
    // anywhere, see loadColumn) lets us skip the worker round-trip for those
    // entirely instead of building+sending a mesh job we already know comes
    // back empty. Once any block is edited, loadColumn stops passing bounds
    // and every chunk goes back to always being (re)meshed, so a skipped
    // chunk is still correctly picked up if a later edit exposes it.
    if (bounds) {
      const topY = originY + S - 1;
      // For the MC world there are no procedural trees, so maxH is the true
      // topmost solid block.  Skip chunks entirely above it (all-air) or
      // entirely below the minimum (all-solid, no exposed faces).
      const allAir = originY > bounds.maxH && originY > SEA_LEVEL;
      const allSolid = topY < bounds.minH - 1;
      if (allAir || allSolid) return;
    }

    this.inFlight.add(key);
    const hasAnyEdits = this.editedColumns.size > 0;

    // Sampled per-column (not per-voxel): fetch each column's already-generated
    // terrain array once and index straight into it, instead of calling
    // getBlock() -- which does two Map.get()s with a freshly-allocated
    // template-string key -- for every single one of the thousands of voxels
    // a chunk mesh needs. That per-voxel Map traffic was the dominant
    // main-thread cost during chunk streaming (worse the taller the visible
    // terrain, since more vertical chunks have to be sampled).
    const chunkBlocks = new Uint16Array(S * S * S);
    for (let lx = 0; lx < S; lx++) {
      const wx = originX + lx;
      for (let lz = 0; lz < S; lz++) {
        const wz = originZ + lz;
        const col = this.getTerrainColumn(wx, wz);
        const edited = hasAnyEdits && this.editedColumns.has(columnKey(wx, wz));
        // Must match chunkMesh.worker.ts's getChunkBlock indexing
        // (lx + ly*S + lz*S*S) -- this used to be lx*S*S + ly*S + lz, which
        // transposed X and Z between what's written here and what the worker
        // reads. Collision (isSolid/getBlock) reads world data directly and
        // was never affected, so the mesh silently drifted out of sync with
        // where blocks actually are: faces culled/exposed wrong, worst right
        // at chunk edges, and the player's real (collision) position ending
        // up visually "inside"/"under" the mirrored geometry.
        const base = lx + lz * S * S;
        for (let ly = 0; ly < S; ly++) {
          const wy = originY + ly;
          let id: number = wy >= 0 && wy < WORLD_HEIGHT ? col[wy] : BType.air;
          if (edited) {
            const e = this.edits.get(blockKey(wx, wy, wz));
            if (e !== undefined) id = e;
          }
          chunkBlocks[base + ly * S] = id;
        }
      }
    }

    const voidMap = new Uint8Array(SP * SP * SP);
    for (let vx = 0; vx < SP; vx++) {
      const wx = originX + vx - 2;
      for (let vz = 0; vz < SP; vz++) {
        const wz = originZ + vz - 2;
        const col = this.getTerrainColumn(wx, wz);
        const edited = hasAnyEdits && this.editedColumns.has(columnKey(wx, wz));
        const base = vx + vz * SP * SP;
        for (let vy = 0; vy < SP; vy++) {
          const wy = originY + vy - 2;
          let id: number = wy >= 0 && wy < WORLD_HEIGHT ? col[wy] : BType.air;
          if (edited) {
            const e = this.edits.get(blockKey(wx, wy, wz));
            if (e !== undefined) id = e;
          }
          voidMap[base + vy * SP] = this.voidLookup[id] ?? 1;
        }
      }
    }

    const leafMap = new Uint8Array(SP * SP * SP);
    for (let vx = 0; vx < SP; vx++) {
      const wx = originX + vx - 2;
      for (let vz = 0; vz < SP; vz++) {
        const wz = originZ + vz - 2;
        const col = this.getTerrainColumn(wx, wz);
        const edited = hasAnyEdits && this.editedColumns.has(columnKey(wx, wz));
        const base = vx + vz * SP * SP;
        for (let vy = 0; vy < SP; vy++) {
          const wy = originY + vy - 2;
          let id: number = wy >= 0 && wy < WORLD_HEIGHT ? col[wy] : BType.air;
          if (edited) {
            const e = this.edits.get(blockKey(wx, wy, wz));
            if (e !== undefined) id = e;
          }
          leafMap[base + vy * SP] = this.leafLookup[id] ?? 0;
        }
      }
    }

    const msg: InChunkMeshWorker = {
      chunkKey: key,
      slotId,
      chunkBlocks: chunkBlocks.buffer,
      voidMap: voidMap.buffer,
      leafMap: leafMap.buffer,
      blockDefs: this.atlas.blockDefs,
    };

    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    worker.postMessage(msg, [chunkBlocks.buffer, voidMap.buffer, leafMap.buffer]);
  }

  private onMeshResult(out: OutChunkMeshWorker) {
    // Remove from inFlight immediately so re-meshing can be triggered if needed.
    this.inFlight.delete(out.chunkKey);
    // Queue for rate-limited processing in update() — prevents worker bursts
    // from running rebuildColumn (large array alloc + GPU buffer prep) all in
    // one frame and spiking render time.
    this.pendingMeshResults.push(out);
  }

  private applyMeshResult(out: OutChunkMeshWorker) {
    const entry = this.chunks.get(out.chunkKey);
    if (!entry) return; // chunk was unloaded while result was queued
    const packed = new Uint32Array(out.buf);
    const greedy = new Uint32Array(out.gbuf);
    const [cx, cy, cz] = out.chunkKey.split(",").map(Number);
    this.meshPool.setChunk(entry.slotId, cx * S, cy * S, cz * S, packed, greedy);
    entry.meshed = true;
  }

  // ---- streaming ------------------------------------------------------------

  private loadColumn(cx: number, cz: number) {
    const key = columnKey(cx, cz);
    if (this.loadedColumns.has(key)) return;
    this.loadedColumns.add(key);

    // Find which neighbourhood columns (chunk blocks + voidMap padding) aren't
    // cached yet.  We send only those to the terrain worker; already-cached ones
    // are skipped so we never duplicate work.
    const originX = cx * S, originZ = cz * S;
    const needed: Array<{ x: number; z: number }> = [];
    for (let vx = -2; vx < S + 2; vx++) {
      for (let vz = -2; vz < S + 2; vz++) {
        const wx = originX + vx, wz = originZ + vz;
        if (!this.terrainColumns.has(columnKey(wx, wz))) {
          needed.push({ x: wx, z: wz });
        }
      }
    }

    if (needed.length === 0) {
      // Everything cached — queue for mesh dispatch (rate-limited in update())
      this.pendingColumnMesh.push(key);
      return;
    }

    // Off-load terrain generation to the dedicated worker so the main thread
    // never blocks.  Mesh dispatch happens in onTerrainResult once the worker
    // sends the data back.
    const jobId = ++this.terrainJobCounter;
    this.terrainJobs.set(jobId, key);
    const msg: InTerrainWorker = { jobId, columns: needed };
    this.terrainWorker.postMessage(msg);
  }

  private onTerrainResult(out: OutTerrainWorker) {
    // Cache every column the worker generated
    for (const { x, z, data } of out.columns) {
      const col = new Uint16Array(data);
      const k = columnKey(x, z);
      this.terrainColumns.set(k, col);
      // LRU eviction — keep the same 6 000-entry cap as before
      if (this.terrainColumns.size > 6000) {
        const oldest = this.terrainColumns.keys().next().value;
        if (oldest !== undefined) this.terrainColumns.delete(oldest);
      }
    }

    const colKey = this.terrainJobs.get(out.jobId);
    this.terrainJobs.delete(out.jobId);
    if (!colKey || !this.loadedColumns.has(colKey)) return; // unloaded while in-flight

    // Queue rather than dispatch immediately — update() drains N per tick to
    // prevent frame spikes when the worker flushes a batch of jobs at once.
    this.pendingColumnMesh.push(colKey);
  }

  /** Preload all terrain columns in a radius around a world position.
   * Returns a promise that resolves once the worker has sent back the data,
   * so callers can await this before starting the game loop. */
  preloadSpawn(worldX: number, worldZ: number, radius = 2): Promise<void> {
    const cx = Math.floor(worldX / S);
    const cz = Math.floor(worldZ / S);
    const needed: Array<{ x: number; z: number }> = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const ocx = cx + dx, ocz = cz + dz;
        const ox = ocx * S, oz = ocz * S;
        for (let vx = -2; vx < S + 2; vx++) {
          for (let vz = -2; vz < S + 2; vz++) {
            const wx = ox + vx, wz = oz + vz;
            const k = columnKey(wx, wz);
            if (!this.terrainColumns.has(k)) needed.push({ x: wx, z: wz });
          }
        }
      }
    }
    if (needed.length === 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const jobId = ++this.terrainJobCounter;
      // Use a sentinel key that won't be matched by the normal job handler
      this.terrainJobs.set(jobId, '__preload__');
      const origHandler = this.terrainWorker.onmessage as ((e: MessageEvent) => void) | null;
      this.terrainWorker.onmessage = (e: MessageEvent<OutTerrainWorker>) => {
        // Let normal handler process it for caching, then intercept our job
        this.onTerrainResult(e.data);
        if (e.data.jobId === jobId) {
          this.terrainWorker.onmessage = origHandler;
          resolve();
        }
      };
      this.terrainWorker.postMessage({ jobId, columns: needed } as InTerrainWorker);
    });
  }

  /** Allocate chunk slots and fire mesh workers for every vertical slice of a column. */
  private dispatchColumnMesh(cx: number, cz: number) {
    const bounds = this.editedColumns.size === 0 ? this.columnHeightBounds(cx, cz) : null;
    for (let cy = 0; cy < MAX_HEIGHT_IN_CHUNKS; cy++) {
      const ck = chunkKey(cx, cy, cz);
      if (this.chunks.has(ck)) continue;
      const slotId = this.allocSlot();
      this.chunks.set(ck, { slotId, meshed: false });
      this.dispatchMesh(cx, cy, cz, slotId, bounds);
    }
    // Fast getBlock for secondary layer scans: caches the Uint16Array per (wx,wz)
    // so each (x,z) column is looked up only once regardless of how many Y
    // values the layer iterates — avoids allocating a columnKey string on every
    // single getBlock(wx, y, wz) call (saves ~147k string allocs per column).
    const colCache = new Map<string, Uint16Array>();
    const fastGet = (wx: number, wy: number, wz: number): BType => {
      if (wy < 0 || wy >= WORLD_HEIGHT) return BType.air;
      const k = `${wx},${wz}`;
      let col = colCache.get(k);
      if (!col) { col = this.getTerrainColumn(wx, wz); colCache.set(k, col); }
      return col[wy] as BType;
    };
    // Notify custom layers so they can render their block types.
    this.modelLayer?.onColumnLoaded(cx, cz, fastGet);
    this.chainLayer?.onColumnLoaded(cx, cz, fastGet);
    this.slabLayer?.onColumnLoaded(cx, cz, fastGet);
    this.crossPostLayer?.onColumnLoaded(cx, cz, fastGet);
    this.doorLayer?.onColumnLoaded(cx, cz, fastGet);
    this.stairLayer?.onColumnLoaded(cx, cz, fastGet);
  }

  private unloadColumn(cx: number, cz: number) {
    const key = columnKey(cx, cz);
    if (!this.loadedColumns.has(key)) return;
    this.loadedColumns.delete(key);

    for (let cy = 0; cy < MAX_HEIGHT_IN_CHUNKS; cy++) {
      const ck = chunkKey(cx, cy, cz);
      const entry = this.chunks.get(ck);
      if (!entry) continue;
      this.meshPool.removeChunk(entry.slotId);
      this.freeSlot(entry.slotId);
      this.chunks.delete(ck);
      this.inFlight.delete(ck);
    }
    this.modelLayer?.onColumnUnloaded(cx, cz);
    this.chainLayer?.onColumnUnloaded(cx, cz);
    this.slabLayer?.onColumnUnloaded(cx, cz);
    this.crossPostLayer?.onColumnUnloaded(cx, cz);
    this.doorLayer?.onColumnUnloaded(cx, cz);
    this.stairLayer?.onColumnUnloaded(cx, cz);
  }

  update(playerPos: THREE.Vector3) {
    (this.material.uniforms.playerPos.value as THREE.Vector3).copy(playerPos);

    const pcx = Math.floor(playerPos.x / S);
    const pcz = Math.floor(playerPos.z / S);

    if (pcx !== this.startChunkX || pcz !== this.startChunkZ || this.loadQueue.length === 0) {
      this.startChunkX = pcx;
      this.startChunkZ = pcz;
      this.rebuildLoadQueue(pcx, pcz);

      for (const key of this.loadedColumns) {
        const [cx, cz] = key.split(",").map(Number);
        if (Math.abs(cx - pcx) > CACHED_RENDER_DISTANCE || Math.abs(cz - pcz) > CACHED_RENDER_DISTANCE) {
          this.unloadColumn(cx, cz);
        }
      }
    }

    let loaded = 0;
    while (loaded < LOADS_PER_TICK && this.loadQueue.length > 0) {
      const next = this.loadQueue.shift()!;
      if (!this.loadedColumns.has(columnKey(next.cx, next.cz))) {
        this.loadColumn(next.cx, next.cz);
        loaded++;
      }
    }

    // Drain pending column mesh dispatches — N per tick so a burst of terrain
    // worker responses doesn't spike the frame time.
    let meshed = 0;
    while (meshed < World.MESH_DISPATCHES_PER_TICK && this.pendingColumnMesh.length > 0) {
      const colKey = this.pendingColumnMesh.shift()!;
      if (this.loadedColumns.has(colKey)) {
        const [cx, cz] = colKey.split(",").map(Number);
        this.dispatchColumnMesh(cx, cz);
        meshed++;
      }
    }

    // Apply queued mesh worker results — N per tick so bursts of worker
    // completions don't all call bakeYOffset + mark-dirty in one frame.
    let applied = 0;
    while (applied < World.MESH_RESULTS_PER_TICK && this.pendingMeshResults.length > 0) {
      this.applyMeshResult(this.pendingMeshResults.shift()!);
      applied++;
    }

    // Flush dirty column GPU buffers — N per tick to bound the number of
    // large Uint32Array merges and GPU buffer uploads per render call.
    this.meshPool.flushDirty(World.COLUMN_FLUSHES_PER_TICK);
  }

  private rebuildLoadQueue(pcx: number, pcz: number) {
    const list: { cx: number; cz: number; dist: number }[] = [];
    for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
      for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
        const cx = pcx + dx, cz = pcz + dz;
        if (this.loadedColumns.has(columnKey(cx, cz))) continue;
        list.push({ cx, cz, dist: dx * dx + dz * dz });
      }
    }
    list.sort((a, b) => a.dist - b.dist);
    this.loadQueue = list;
  }
}
