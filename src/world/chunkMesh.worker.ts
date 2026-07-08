// Ported from escape-tsuami-client/src/game/map/worker/chunkRendererMesh.ts
// (the confirmed-live greedy mesher used by ChunkRenderer.ts's BaseInstance).
// Algorithm is unchanged; only the message field names are adapted from the
// "instance" framing (instanceId/slotId) to this project's chunk-streaming
// framing (chunkKey/slotId).

import { CHUNK_SIZE } from "../config";
import { packData, packGreedy, pushToBuffer } from "./packing";

const S = CHUNK_SIZE;
const SP = S + 4; // void map side length (2-block padding each side)

const FACE_DEFS = [
  { faceId: 0, nx: 0, ny: 1, nz: 0, texSlot: 0, plane: "y" as const },
  { faceId: 1, nx: 0, ny: -1, nz: 0, texSlot: 1, plane: "y" as const },
  { faceId: 2, nx: 1, ny: 0, nz: 0, texSlot: 2, plane: "x" as const },
  { faceId: 3, nx: -1, ny: 0, nz: 0, texSlot: 3, plane: "x" as const },
  { faceId: 4, nx: 0, ny: 0, nz: -1, texSlot: 4, plane: "z" as const },
  { faceId: 5, nx: 0, ny: 0, nz: 1, texSlot: 5, plane: "z" as const },
];

export interface BlockDef {
  sides: number[]; // [top, bottom, +x, -x, -z, +z] texture-array layer indices
  isTransparent?: boolean;
}

export interface InChunkMeshWorker {
  chunkKey: string;
  slotId: number;
  /** Uint16Array[S^3] block IDs for this chunk only */
  chunkBlocks: ArrayBuffer;
  /** Uint8Array[(S+4)^3], 1 = void/transparent, base = chunk origin - 2 */
  voidMap: ArrayBuffer;
  blockDefs: Record<number, BlockDef>;
}

export interface OutChunkMeshWorker {
  chunkKey: string;
  slotId: number;
  buf: ArrayBuffer;
  gbuf: ArrayBuffer;
}

function emitFace(
  x: number, y: number, z: number,
  faceId: number, du: number, dv: number,
  texId: number, ao: number[], flip: number,
  b: number[], gb: number[],
) {
  let x0 = x, y0 = y, z0 = z, x1 = x, y1 = y, z1 = z, x2 = x, y2 = y, z2 = z, x3 = x, y3 = y, z3 = z;

  if (faceId === 0) {
    x0 = x; y0 = y + 1; z0 = z; x1 = x + du; y1 = y + 1; z1 = z;
    x2 = x + du; y2 = y + 1; z2 = z + dv; x3 = x; y3 = y + 1; z3 = z + dv;
  } else if (faceId === 1) {
    x0 = x; y0 = y; z0 = z; x1 = x + du; y1 = y; z1 = z;
    x2 = x + du; y2 = y; z2 = z + dv; x3 = x; y3 = y; z3 = z + dv;
  } else if (faceId === 2) {
    x0 = x + 1; y0 = y; z0 = z; x1 = x + 1; y1 = y + dv; z1 = z;
    x2 = x + 1; y2 = y + dv; z2 = z + du; x3 = x + 1; y3 = y; z3 = z + du;
  } else if (faceId === 3) {
    x0 = x; y0 = y; z0 = z; x1 = x; y1 = y + dv; z1 = z;
    x2 = x; y2 = y + dv; z2 = z + du; x3 = x; y3 = y; z3 = z + du;
  } else if (faceId === 4) {
    x0 = x; y0 = y; z0 = z; x1 = x; y1 = y + dv; z1 = z;
    x2 = x + du; y2 = y + dv; z2 = z; x3 = x + du; y3 = y; z3 = z;
  } else {
    x0 = x; y0 = y; z0 = z + 1; x1 = x; y1 = y + dv; z1 = z + 1;
    x2 = x + du; y2 = y + dv; z2 = z + 1; x3 = x + du; y3 = y; z3 = z + 1;
  }

  const v0 = packData(x0, y0, z0, faceId, ao[0], flip, texId);
  const v1 = packData(x1, y1, z1, faceId, ao[1], flip, texId);
  const v2 = packData(x2, y2, z2, faceId, ao[2], flip, texId);
  const v3 = packData(x3, y3, z3, faceId, ao[3], flip, texId);
  const g0 = packGreedy(du, dv, x0, y0, z0);
  const g1 = packGreedy(du, dv, x1, y1, z1);
  const g2 = packGreedy(du, dv, x2, y2, z2);
  const g3 = packGreedy(du, dv, x3, y3, z3);

  if (faceId === 0) {
    if (flip) { pushToBuffer(b, [v1, v0, v3, v1, v3, v2]); gb.push(g1, g0, g3, g1, g3, g2); }
    else { pushToBuffer(b, [v0, v3, v2, v0, v2, v1]); gb.push(g0, g3, g2, g0, g2, g1); }
  } else if (faceId === 1) {
    if (flip) { pushToBuffer(b, [v1, v3, v0, v1, v2, v3]); gb.push(g1, g3, g0, g1, g2, g3); }
    else { pushToBuffer(b, [v0, v2, v3, v0, v1, v2]); gb.push(g0, g2, g3, g0, g1, g2); }
  } else if (faceId === 2) {
    if (flip) { pushToBuffer(b, [v3, v0, v1, v3, v1, v2]); gb.push(g3, g0, g1, g3, g1, g2); }
    else { pushToBuffer(b, [v0, v1, v2, v0, v2, v3]); gb.push(g0, g1, g2, g0, g2, g3); }
  } else if (faceId === 3) {
    if (flip) { pushToBuffer(b, [v3, v1, v0, v3, v2, v1]); gb.push(g3, g1, g0, g3, g2, g1); }
    else { pushToBuffer(b, [v0, v2, v1, v0, v3, v2]); gb.push(g0, g2, g1, g0, g3, g2); }
  } else if (faceId === 4) {
    if (flip) { pushToBuffer(b, [v3, v0, v1, v3, v1, v2]); gb.push(g3, g0, g1, g3, g1, g2); }
    else { pushToBuffer(b, [v0, v1, v2, v0, v2, v3]); gb.push(g0, g1, g2, g0, g2, g3); }
  } else {
    if (flip) { pushToBuffer(b, [v3, v1, v0, v3, v2, v1]); gb.push(g3, g1, g0, g3, g2, g1); }
    else { pushToBuffer(b, [v0, v2, v1, v0, v3, v2]); gb.push(g0, g2, g1, g0, g3, g2); }
  }
}

self.onmessage = (e: MessageEvent<InChunkMeshWorker>) => {
  const { chunkKey, slotId, blockDefs } = e.data;
  const chunkBlocks = new Uint16Array(e.data.chunkBlocks);
  const voidMap = new Uint8Array(e.data.voidMap);

  const baseX = -2;
  const baseY = -2;
  const baseZ = -2;

  /** 1 = void/transparent, 0 = solid */
  const voidAt = (lx: number, ly: number, lz: number): number => {
    const vx = lx - baseX;
    const vy = ly - baseY;
    const vz = lz - baseZ;
    if (vx < 0 || vy < 0 || vz < 0 || vx >= SP || vy >= SP || vz >= SP) return 1;
    return voidMap[vx + vy * SP + vz * SP * SP];
  };

  const getChunkBlock = (lx: number, ly: number, lz: number): number => {
    if (lx < 0 || ly < 0 || lz < 0 || lx >= S || ly >= S || lz >= S) return 0;
    return chunkBlocks[lx + ly * S + lz * S * S];
  };

  const getAO = (lx: number, ly: number, lz: number, plane: "x" | "y" | "z"): number[] => {
    const v = voidAt;
    let a: number, b: number, c: number, d: number, ee: number, f: number, g: number, h: number;
    if (plane === "y") {
      a = v(lx, ly, lz - 1); b = v(lx - 1, ly, lz - 1); c = v(lx - 1, ly, lz);
      d = v(lx - 1, ly, lz + 1); ee = v(lx, ly, lz + 1); f = v(lx + 1, ly, lz + 1);
      g = v(lx + 1, ly, lz); h = v(lx + 1, ly, lz - 1);
    } else if (plane === "x") {
      a = v(lx, ly, lz - 1); b = v(lx, ly - 1, lz - 1); c = v(lx, ly - 1, lz);
      d = v(lx, ly - 1, lz + 1); ee = v(lx, ly, lz + 1); f = v(lx, ly + 1, lz + 1);
      g = v(lx, ly + 1, lz); h = v(lx, ly + 1, lz - 1);
    } else {
      a = v(lx - 1, ly, lz); b = v(lx - 1, ly - 1, lz); c = v(lx, ly - 1, lz);
      d = v(lx + 1, ly - 1, lz); ee = v(lx + 1, ly, lz); f = v(lx + 1, ly + 1, lz);
      g = v(lx, ly + 1, lz); h = v(lx - 1, ly + 1, lz);
    }
    const ao = [a + b + c, g + h + a, ee + f + g, c + d + ee];
    return [...ao, ao[1] + ao[3] > ao[0] + ao[2] ? 1 : 0];
  };

  const buf: number[] = [];
  const gbuf: number[] = [];

  for (const { faceId, nx, ny, nz, texSlot, plane } of FACE_DEFS) {
    for (let n = 0; n < S; n++) {
      type FaceCell = { texId: number; ao: number[]; flip: number } | null;
      const mask: FaceCell[] = new Array(S * S).fill(null);

      for (let u = 0; u < S; u++) {
        for (let v = 0; v < S; v++) {
          let lx: number, ly: number, lz: number;
          if (plane === "y") { lx = u; ly = n; lz = v; }
          else if (plane === "x") { lx = n; ly = v; lz = u; }
          else { lx = u; ly = v; lz = n; }

          const blockId = getChunkBlock(lx, ly, lz);
          if (!blockId || !blockDefs[blockId]) continue;

          const nlx = lx + nx, nly = ly + ny, nlz = lz + nz;
          let neighborVoid: number;
          if (nlx >= 0 && nly >= 0 && nlz >= 0 && nlx < S && nly < S && nlz < S) {
            const nid = getChunkBlock(nlx, nly, nlz);
            neighborVoid = (!nid || !blockDefs[nid] || blockDefs[nid].isTransparent) ? 1 : 0;
          } else {
            neighborVoid = voidAt(lx + nx, ly + ny, lz + nz);
          }
          if (!neighborVoid) continue;

          const sides = blockDefs[blockId].sides;
          const texId = sides[texSlot] ?? 0;
          const ao = getAO(lx + nx, ly + ny, lz + nz, plane);

          mask[u * S + v] = { texId, ao, flip: ao[4] };
        }
      }

      const used = new Uint8Array(S * S);
      for (let u = 0; u < S; u++) {
        for (let v = 0; v < S; v++) {
          const idx = u * S + v;
          if (used[idx] || !mask[idx]) continue;
          const { texId, ao, flip } = mask[idx]!;

          let dv = 1;
          while (v + dv < S) {
            const m = mask[u * S + (v + dv)];
            if (used[u * S + (v + dv)] || !m || m.texId !== texId ||
              m.ao[0] !== ao[0] || m.ao[1] !== ao[1] || m.ao[2] !== ao[2] || m.ao[3] !== ao[3]) break;
            dv++;
          }

          let du = 1;
          outer: while (u + du < S) {
            for (let dv2 = 0; dv2 < dv; dv2++) {
              const nidx = (u + du) * S + (v + dv2);
              const m = mask[nidx];
              if (used[nidx] || !m || m.texId !== texId ||
                m.ao[0] !== ao[0] || m.ao[1] !== ao[1] || m.ao[2] !== ao[2] || m.ao[3] !== ao[3]) break outer;
            }
            du++;
          }

          for (let du2 = 0; du2 < du; du2++)
            for (let dv2 = 0; dv2 < dv; dv2++)
              used[(u + du2) * S + (v + dv2)] = 1;

          let lx: number, ly: number, lz: number;
          if (plane === "y") { lx = u; ly = n; lz = v; }
          else if (plane === "x") { lx = n; ly = v; lz = u; }
          else { lx = u; ly = v; lz = n; }

          emitFace(lx, ly, lz, faceId, du, dv, texId, ao, flip, buf, gbuf);
        }
      }
    }
  }

  const outBuf = new Uint32Array(buf).buffer;
  const outGbuf = new Uint32Array(gbuf).buffer;
  (self as any).postMessage(
    { chunkKey, slotId, buf: outBuf, gbuf: outGbuf } as OutChunkMeshWorker,
    [outBuf, outGbuf],
  );
};
