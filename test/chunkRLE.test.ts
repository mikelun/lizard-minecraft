import { describe, expect, it } from "vitest";
import { rleDecode, rleEncode } from "../src/world/chunkRLE";
import { CHUNK_SIZE } from "../src/config";

const VOLUME = CHUNK_SIZE ** 3;

describe("chunkRLE", () => {
  it("round-trips an empty chunk as a single run", () => {
    const chunk = new Uint8Array(VOLUME);
    const rle = rleEncode(chunk);
    expect(rle.values.length).toBe(1);
    expect(rle.runs[0]).toBe(VOLUME - 1);
    expect(rleDecode(rle)).toEqual(chunk);
  });

  it("round-trips a layered chunk", () => {
    const chunk = new Uint8Array(VOLUME);
    for (let i = 0; i < VOLUME; i++) chunk[i] = Math.floor(i / 256) % 4;
    const rle = rleEncode(chunk);
    expect(rle.values.length).toBe(VOLUME / 256);
    expect(rleDecode(rle)).toEqual(chunk);
  });

  it("round-trips random noise", () => {
    const chunk = new Uint8Array(VOLUME);
    for (let i = 0; i < VOLUME; i++) chunk[i] = (i * 2654435761) % 20;
    expect(rleDecode(rleEncode(chunk))).toEqual(chunk);
  });
});
