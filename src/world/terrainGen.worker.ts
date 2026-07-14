import { generateColumn } from "./terrain";
import { WORLD_HEIGHT } from "../config";

export interface InTerrainWorker {
  jobId: number;
  /** Columns that aren't yet cached on the main thread */
  columns: Array<{ x: number; z: number }>;
}

export interface OutTerrainWorker {
  jobId: number;
  columns: Array<{ x: number; z: number; data: ArrayBuffer }>;
}

self.onmessage = (e: MessageEvent<InTerrainWorker>) => {
  const { jobId, columns } = e.data;
  const results: Array<{ x: number; z: number; data: ArrayBuffer }> = [];
  const transferList: ArrayBuffer[] = [];

  for (const { x, z } of columns) {
    const col = new Uint16Array(WORLD_HEIGHT);
    generateColumn(x, z, col);
    results.push({ x, z, data: col.buffer });
    transferList.push(col.buffer);
  }

  (self as any).postMessage(
    { jobId, columns: results } as OutTerrainWorker,
    transferList,
  );
};
