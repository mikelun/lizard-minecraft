// Ported from escape-tsuami-client/src/game/map/worker/types.ts, BType trimmed
// down to the blocks this project actually uses.

export enum BType {
  air = 0,
  grass = 1,
  dirt = 2,
  stone = 3,
  sand = 4,
  snow = 5,
  log = 6,
  leaf = 7,
  planks = 8,
  water = 9,
}

export interface Pos3 {
  x: number;
  y: number;
  z: number;
}

export interface Pos2 {
  x: number;
  z: number;
}

export interface Palette {
  default: Record<number, number>;
  reversed: Partial<Record<number, number>>;
  cnt: number;
}
