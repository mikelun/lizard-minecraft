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
import { generateColumn, surfaceHeight, TREE_HEIGHT } from "./terrain";
import { ChunkMegaBuffer } from "./ChunkMegaBuffer";
import { vsChunk, fsChunk } from "./shaders";
import type { BlockTextureAtlas } from "../textures/blockTextures";
import type { InChunkMeshWorker, OutChunkMeshWorker } from "./chunkMesh.worker";
import ChunkMeshWorker from "./chunkMesh.worker?worker";
import type { InTerrainWorker, OutTerrainWorker } from "./terrainGen.worker";
import TerrainGenWorker from "./terrainGen.worker?worker";

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
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private readonly megaBuf = new ChunkMegaBuffer();
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
  private readonly slotCapacity: number;
  private readonly chunkPosData: Float32Array;
  private readonly chunkPosTex: THREE.DataTexture;

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

  constructor(atlas: BlockTextureAtlas) {
    this.atlas = atlas;
    const vt = new Uint8Array(32);
    for (let id = 0; id < vt.length; id++) vt[id] = this.isVoidBlock(id) ? 1 : 0;
    this.voidLookup = vt;
    const ll = new Uint8Array(32);
    ll[BType.leaf] = 1;
    ll[BType.cherry_leaf] = 1;
    this.leafLookup = ll;
    const columnsSpan = RENDER_DISTANCE * 2 + 5;
    this.slotCapacity = columnsSpan * columnsSpan * MAX_HEIGHT_IN_CHUNKS;

    this.chunkPosData = new Float32Array(this.slotCapacity * 4);
    this.chunkPosTex = new THREE.DataTexture(
      this.chunkPosData,
      this.slotCapacity,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.chunkPosTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vsChunk,
      fragmentShader: fsChunk,
      uniforms: {
        playerPos:      { value: new THREE.Vector3() },
        uChunkPositions:{ value: this.chunkPosTex },
        uTextureArray:  { value: this.atlas.texture },
        timeOfDay:      { value: 0.28 },
        // Minecraft colormap tints — plains grass / oak foliage defaults
      },
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.megaBuf.geometry, this.material);
    this.mesh.frustumCulled = false;

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
    return surfaceHeight(Math.floor(worldX), Math.floor(worldZ));
  }

  // ---- terrain / edits -------------------------------------------------

  private getTerrainColumn(x: number, z: number): Uint16Array {
    const key = columnKey(x, z);
    let col = this.terrainColumns.get(key);
    if (!col) {
      col = new Uint16Array(WORLD_HEIGHT);
      generateColumn(x, z, col);
      this.terrainColumns.set(key, col);
      if (this.terrainColumns.size > 6000) {
        const oldest = this.terrainColumns.keys().next().value;
        if (oldest !== undefined) this.terrainColumns.delete(oldest);
      }
    }
    return col;
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
    const id = this.freeSlots.pop();
    if (id !== undefined) return id;
    if (this.nextSlot >= this.slotCapacity) {
      // Grow generously rather than crash if a session wanders far with a huge render distance.
      return this.nextSlot++;
    }
    return this.nextSlot++;
  }

  private freeSlot(id: number) {
    this.freeSlots.push(id);
  }

  private setSlotPos(slotId: number, x: number, y: number, z: number) {
    if (slotId * 4 + 3 >= this.chunkPosData.length) return;
    this.chunkPosData[slotId * 4] = x;
    this.chunkPosData[slotId * 4 + 1] = y;
    this.chunkPosData[slotId * 4 + 2] = z;
    this.chunkPosData[slotId * 4 + 3] = 1;
    this.chunkPosTex.needsUpdate = true;
  }

  // ---- meshing ------------------------------------------------------------

  private remeshChunk(cx: number, cy: number, cz: number) {
    if (cy < 0 || cy >= MAX_HEIGHT_IN_CHUNKS) return;
    const key = chunkKey(cx, cy, cz);
    const entry = this.chunks.get(key);
    if (!entry) return; // not currently loaded -> will be generated fresh when it streams in
    this.dispatchMesh(cx, cy, cz, entry.slotId);
  }

  // Surface-height-only bounds (no full column generation) over a chunk-
  // column's padded neighborhood. Only depends on (cx, cz), not cy, so
  // loadColumn() computes it once and reuses it across all MAX_HEIGHT_IN_CHUNKS
  // vertical dispatches for that column instead of recomputing per chunk.
  private columnHeightBounds(cx: number, cz: number): { minH: number; maxH: number } {
    const originX = cx * S, originZ = cz * S;
    let minH = Infinity, maxH = -Infinity;
    for (let vx = -2; vx < S + 2; vx++) {
      const wx = originX + vx;
      for (let vz = -2; vz < S + 2; vz++) {
        const h = surfaceHeight(wx, originZ + vz);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    return { minH, maxH };
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
      // bounds.maxH is raw ground height only -- trees (trunk + canopy) can
      // stick up to TREE_HEIGHT blocks above that, so a chunk whose y-range
      // starts just above maxH can still contain solid log/leaf blocks. Not
      // accounting for this previously caused tree geometry to be silently
      // skipped from meshing (invisible, but still solid for collision --
      // player-visible as unexplained walls/voids near trees).
      const allAir = originY > bounds.maxH + TREE_HEIGHT && originY > SEA_LEVEL;
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
    this.inFlight.delete(out.chunkKey);
    const entry = this.chunks.get(out.chunkKey);
    if (!entry) return; // chunk was unloaded while meshing was in flight

    const packed = new Uint32Array(out.buf);
    const greedy = new Uint32Array(out.gbuf);
    this.megaBuf.setChunk(entry.slotId, packed, greedy);
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
      // Everything cached — dispatch mesh workers right away
      this.dispatchColumnMesh(cx, cz);
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
      if (!this.terrainColumns.has(k)) {
        this.terrainColumns.set(k, col);
        // LRU eviction — keep the same 6 000-entry cap as before
        if (this.terrainColumns.size > 6000) {
          const oldest = this.terrainColumns.keys().next().value;
          if (oldest !== undefined) this.terrainColumns.delete(oldest);
        }
      }
    }

    const colKey = this.terrainJobs.get(out.jobId);
    this.terrainJobs.delete(out.jobId);
    if (!colKey || !this.loadedColumns.has(colKey)) return; // unloaded while in-flight

    const [cx, cz] = colKey.split(",").map(Number);
    this.dispatchColumnMesh(cx, cz);
  }

  /** Allocate chunk slots and fire mesh workers for every vertical slice of a column. */
  private dispatchColumnMesh(cx: number, cz: number) {
    const bounds = this.editedColumns.size === 0 ? this.columnHeightBounds(cx, cz) : null;
    for (let cy = 0; cy < MAX_HEIGHT_IN_CHUNKS; cy++) {
      const ck = chunkKey(cx, cy, cz);
      if (this.chunks.has(ck)) continue;
      const slotId = this.allocSlot();
      this.chunks.set(ck, { slotId, meshed: false });
      this.setSlotPos(slotId, cx * S, cy * S, cz * S);
      this.dispatchMesh(cx, cy, cz, slotId, bounds);
    }
  }

  private unloadColumn(cx: number, cz: number) {
    const key = columnKey(cx, cz);
    if (!this.loadedColumns.has(key)) return;
    this.loadedColumns.delete(key);

    for (let cy = 0; cy < MAX_HEIGHT_IN_CHUNKS; cy++) {
      const ck = chunkKey(cx, cy, cz);
      const entry = this.chunks.get(ck);
      if (!entry) continue;
      this.megaBuf.removeChunk(entry.slotId);
      this.freeSlot(entry.slotId);
      this.chunks.delete(ck);
      this.inFlight.delete(ck);
    }
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

    this.megaBuf.flush();
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
