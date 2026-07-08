// Ported verbatim from escape-tsuami-client/src/game/map/ChunkMegaBuffer.ts.
import * as THREE from "three";

const INITIAL_CAPACITY = 500_000;
const OVER_ALLOC = 1.5; // 1.5x over-allocation per chunk slot
const COMPACT_THRESHOLD = 0.3; // compact when 30% of buffer is gaps

/**
 * Manages merged GPU vertex buffers for all visible chunks.
 * Instead of rebuilding the entire buffer when one chunk changes,
 * each chunk is allocated a contiguous region with over-allocation.
 *
 * - If updated data fits in the existing allocation -> in-place overwrite,
 *   only that range is uploaded to the GPU.
 * - If it doesn't fit -> appended at the tail; old region becomes a gap
 *   (filled with zeros -> degenerate triangles, invisible).
 * - When gaps exceed 30% of the buffer -> full compaction.
 */

interface SlotAlloc {
  offset: number;
  capacity: number; // always a multiple of 3
  length: number;
}

export class ChunkMegaBuffer {
  private _chunkData = new Map<
    number,
    { packed: Uint32Array; greedy: Uint32Array }
  >();

  // Data saved for hidden chunks (not in buffer, but kept for re-show)
  private _hiddenData = new Map<
    number,
    { packed: Uint32Array; greedy: Uint32Array }
  >();

  private _slots = new Map<number, SlotAlloc>();
  private _tail = 0; // next free index at end of buffer
  private _gapTotal = 0; // total wasted vertices in gaps

  private _packedMerged = new Uint32Array(INITIAL_CAPACITY);
  private _greedyMerged = new Uint32Array(INITIAL_CAPACITY);
  private _chunkIdMerged = new Uint32Array(INITIAL_CAPACITY);

  private _packedAttr: THREE.BufferAttribute;
  private _greedyAttr: THREE.BufferAttribute;
  private _chunkIdAttr: THREE.BufferAttribute;

  readonly geometry: THREE.BufferGeometry;

  private _dirtyRanges: { start: number; count: number }[] = [];
  private _needsCompact = false;
  private _needsFullUpload = false;

  constructor() {
    this._packedAttr = new THREE.BufferAttribute(this._packedMerged, 1);
    this._packedAttr.setUsage(THREE.DynamicDrawUsage);

    this._greedyAttr = new THREE.BufferAttribute(this._greedyMerged, 1);
    this._greedyAttr.setUsage(THREE.DynamicDrawUsage);

    this._chunkIdAttr = new THREE.BufferAttribute(this._chunkIdMerged, 1);
    this._chunkIdAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("packed_data", this._packedAttr);
    this.geometry.setAttribute("packed_greedy", this._greedyAttr);
    this.geometry.setAttribute("chunk_id", this._chunkIdAttr);
    this.geometry.setDrawRange(0, 0);
  }

  private _ensureCapacity(needed: number) {
    if (needed <= this._packedMerged.length) return;
    const cap = Math.max(needed * 2, INITIAL_CAPACITY);

    const oldPacked = this._packedMerged;
    const oldGreedy = this._greedyMerged;
    const oldChunkId = this._chunkIdMerged;
    this._packedMerged = new Uint32Array(cap);
    this._greedyMerged = new Uint32Array(cap);
    this._chunkIdMerged = new Uint32Array(cap);
    this._packedMerged.set(oldPacked.subarray(0, this._tail));
    this._greedyMerged.set(oldGreedy.subarray(0, this._tail));
    this._chunkIdMerged.set(oldChunkId.subarray(0, this._tail));

    // Three.js r155+ throws if array.byteLength changes on an already-uploaded
    // attribute (it checks the cached GPU size). Recreating the BufferAttribute
    // makes Three.js treat it as brand-new and call gl.bufferData (not bufferSubData).
    this._packedAttr = new THREE.BufferAttribute(this._packedMerged, 1);
    this._packedAttr.setUsage(THREE.DynamicDrawUsage);
    this._greedyAttr = new THREE.BufferAttribute(this._greedyMerged, 1);
    this._greedyAttr.setUsage(THREE.DynamicDrawUsage);
    this._chunkIdAttr = new THREE.BufferAttribute(this._chunkIdMerged, 1);
    this._chunkIdAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("packed_data", this._packedAttr);
    this.geometry.setAttribute("packed_greedy", this._greedyAttr);
    this.geometry.setAttribute("chunk_id", this._chunkIdAttr);
    this._needsFullUpload = true;
  }

  private _allocCapacity(length: number): number {
    return Math.ceil((length * OVER_ALLOC) / 3) * 3;
  }

  private _writeSlot(
    offset: number,
    capacity: number,
    slotId: number,
    packed: Uint32Array,
    greedy: Uint32Array,
  ) {
    this._packedMerged.set(packed, offset);
    this._greedyMerged.set(greedy, offset);
    this._chunkIdMerged.fill(slotId, offset, offset + packed.length);
    // Zero out remaining capacity -> degenerate triangles
    const end = offset + packed.length;
    const capEnd = offset + capacity;
    if (end < capEnd) {
      this._packedMerged.fill(0, end, capEnd);
      this._greedyMerged.fill(0, end, capEnd);
      this._chunkIdMerged.fill(0, end, capEnd);
    }
  }

  private _zeroRange(offset: number, count: number) {
    this._packedMerged.fill(0, offset, offset + count);
    this._greedyMerged.fill(0, offset, offset + count);
    this._chunkIdMerged.fill(0, offset, offset + count);
  }

  setChunk(slotId: number, packed: Uint32Array, greedy: Uint32Array) {
    this._chunkData.set(slotId, { packed, greedy });

    const existing = this._slots.get(slotId);
    if (existing && packed.length <= existing.capacity) {
      // In-place update -> only this region is dirty
      this._writeSlot(existing.offset, existing.capacity, slotId, packed, greedy);
      existing.length = packed.length;
      this._dirtyRanges.push({ start: existing.offset, count: existing.capacity });
    } else {
      // Need new allocation
      if (existing) {
        // Old region becomes a gap
        this._zeroRange(existing.offset, existing.capacity);
        this._dirtyRanges.push({ start: existing.offset, count: existing.capacity });
        this._gapTotal += existing.capacity;
      }

      const capacity = this._allocCapacity(packed.length);
      this._ensureCapacity(this._tail + capacity);

      this._writeSlot(this._tail, capacity, slotId, packed, greedy);
      this._slots.set(slotId, { offset: this._tail, capacity, length: packed.length });
      this._dirtyRanges.push({ start: this._tail, count: capacity });
      this._tail += capacity;

      if (this._tail > 0 && this._gapTotal / this._tail > COMPACT_THRESHOLD) {
        this._needsCompact = true;
      }
    }
  }

  removeChunk(slotId: number) {
    const existing = this._slots.get(slotId);
    if (existing) {
      this._zeroRange(existing.offset, existing.capacity);
      this._dirtyRanges.push({ start: existing.offset, count: existing.capacity });
      this._gapTotal += existing.capacity;
      this._slots.delete(slotId);
    }
    this._chunkData.delete(slotId);

    if (this._tail > 0 && this._gapTotal / this._tail > COMPACT_THRESHOLD) {
      this._needsCompact = true;
    }
  }

  clear() {
    this._chunkData.clear();
    this._hiddenData.clear();
    this._slots.clear();
    this._tail = 0;
    this._gapTotal = 0;
    this._dirtyRanges = [];
    this._needsCompact = false;
    this._needsFullUpload = true;
  }

  private _compact() {
    this._tail = 0;
    this._gapTotal = 0;
    this._slots.clear();

    for (const [slotId, { packed, greedy }] of this._chunkData) {
      const capacity = this._allocCapacity(packed.length);
      this._ensureCapacity(this._tail + capacity);
      this._writeSlot(this._tail, capacity, slotId, packed, greedy);
      this._slots.set(slotId, { offset: this._tail, capacity, length: packed.length });
      this._tail += capacity;
    }
  }

  flush() {
    const hasDirty = this._dirtyRanges.length > 0 || this._needsCompact || this._needsFullUpload;
    if (!hasDirty) return;

    if (this._needsCompact) {
      this._compact();
      this._needsCompact = false;
      this._needsFullUpload = true;
      this._dirtyRanges = [];
    }

    if (this._needsFullUpload) {
      this._needsFullUpload = false;
      this._dirtyRanges = [];
      this._uploadAll();
    } else {
      // Merge overlapping/adjacent dirty ranges to minimize upload calls
      const merged = this._mergeDirtyRanges();
      this._dirtyRanges = [];
      this._packedAttr.clearUpdateRanges();
      this._greedyAttr.clearUpdateRanges();
      this._chunkIdAttr.clearUpdateRanges();
      for (const r of merged) {
        this._packedAttr.addUpdateRange(r.start, r.count);
        this._greedyAttr.addUpdateRange(r.start, r.count);
        this._chunkIdAttr.addUpdateRange(r.start, r.count);
      }
      this._packedAttr.needsUpdate = true;
      this._greedyAttr.needsUpdate = true;
      this._chunkIdAttr.needsUpdate = true;
    }

    this.geometry.setDrawRange(0, this._tail);
  }

  private _uploadAll() {
    // Do NOT use addUpdateRange here: Three.js uses bufferSubData for ranged updates
    // which fails silently when the TypedArray has been resized (bufferData needed).
    // With no update ranges, Three.js automatically calls gl.bufferData which handles
    // both the initial upload and any subsequent TypedArray size changes correctly.
    this._packedAttr.clearUpdateRanges();
    this._greedyAttr.clearUpdateRanges();
    this._chunkIdAttr.clearUpdateRanges();
    this._packedAttr.needsUpdate = true;
    this._greedyAttr.needsUpdate = true;
    this._chunkIdAttr.needsUpdate = true;
  }

  private _mergeDirtyRanges(): { start: number; count: number }[] {
    if (this._dirtyRanges.length === 0) return [];
    const sorted = this._dirtyRanges.slice().sort((a, b) => a.start - b.start);
    const merged: { start: number; count: number }[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = sorted[i];
      const prevEnd = prev.start + prev.count;
      if (cur.start <= prevEnd) {
        const newEnd = Math.max(prevEnd, cur.start + cur.count);
        prev.count = newEnd - prev.start;
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  dispose() {
    this.geometry.dispose();
  }
}
