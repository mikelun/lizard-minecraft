// NEW: procedural block textures. The source repo fetches real Minecraft-style
// PNGs (textures/blocks/*.png) from a remote asset API (logic/preload/config/objects.ts)
// that isn't available here, so instead we bake small canvas-drawn textures into
// a THREE.DataArrayTexture at startup -- same shape as the original pipeline
// (one layer per texture, sampled by tex_id in the fragment shader) but fully
// self-contained.

import * as THREE from "three";
import { BType } from "../world/types";
import type { BlockDef } from "../world/chunkMesh.worker";

const TILE = 16;

// Layer indices into the DataArrayTexture.
const enum Tex {
  grassTop = 0,
  grassSide = 1,
  dirt = 2,
  stone = 3,
  sand = 4,
  snow = 5,
  logSide = 6,
  logTop = 7,
  leaf = 8,
  planks = 9,
  water = 10,
}
const LAYER_COUNT = 11;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(
  ctx: CanvasRenderingContext2D,
  base: [number, number, number],
  variance: number,
  seed: number,
) {
  const rand = mulberry32(seed);
  const img = ctx.getImageData(0, 0, TILE, TILE);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * variance;
    img.data[i] = clamp8(base[0] + n);
    img.data[i + 1] = clamp8(base[1] + n);
    img.data[i + 2] = clamp8(base[2] + n);
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function clamp8(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

function drawGrassTop(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [86, 158, 61], 18, 1);
  return ctx;
}

function drawGrassSide(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [117, 82, 51], 14, 2);
  ctx.fillStyle = "#5f9e3d";
  ctx.fillRect(0, 0, TILE, 4);
  for (let x = 0; x < TILE; x += 2) {
    const h = 3 + Math.floor(mulberry32(x + 100)() * 2);
    ctx.fillRect(x, 3, 2, h - 3);
  }
  return ctx;
}

function drawDirt(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [117, 82, 51], 16, 3);
  return ctx;
}

function drawStone(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [125, 125, 130], 14, 4);
  return ctx;
}

function drawSand(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [223, 208, 145], 10, 5);
  return ctx;
}

function drawSnow(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [240, 245, 250], 8, 6);
  return ctx;
}

function drawLogSide(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [92, 63, 40], 8, 7);
  ctx.strokeStyle = "rgba(60,40,25,0.6)";
  for (let x = 1; x < TILE; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TILE);
    ctx.stroke();
  }
  return ctx;
}

function drawLogTop(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [196, 158, 105], 8, 8);
  ctx.strokeStyle = "rgba(120,90,55,0.7)";
  const cx = TILE / 2, cy = TILE / 2;
  for (let r = 2; r < TILE; r += 3) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  return ctx;
}

function drawLeaf(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [45, 110, 45], 22, 9);
  return ctx;
}

function drawPlanks(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [176, 138, 84], 10, 10);
  ctx.strokeStyle = "rgba(110,80,45,0.5)";
  for (let y = 3; y < TILE; y += 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TILE, y);
    ctx.stroke();
  }
  return ctx;
}

function drawWater(): CanvasRenderingContext2D {
  const [, ctx] = makeCanvas();
  speckle(ctx, [58, 110, 196], 10, 11);
  return ctx;
}

export interface BlockTextureAtlas {
  texture: THREE.DataArrayTexture;
  blockDefs: Record<number, BlockDef>;
}

export function buildBlockTextureAtlas(): BlockTextureAtlas {
  const draws = [
    drawGrassTop, drawGrassSide, drawDirt, drawStone, drawSand, drawSnow,
    drawLogSide, drawLogTop, drawLeaf, drawPlanks, drawWater,
  ];

  const data = new Uint8Array(TILE * TILE * 4 * LAYER_COUNT);
  draws.forEach((draw, layer) => {
    const ctx = draw();
    const img = ctx.getImageData(0, 0, TILE, TILE);
    data.set(img.data, layer * TILE * TILE * 4);
  });

  const texture = new THREE.DataArrayTexture(data, TILE, TILE, LAYER_COUNT);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  const blockDefs: Record<number, BlockDef> = {
    [BType.grass]: { sides: [Tex.grassTop, Tex.dirt, Tex.grassSide, Tex.grassSide, Tex.grassSide, Tex.grassSide] },
    [BType.dirt]: { sides: Array(6).fill(Tex.dirt) },
    [BType.stone]: { sides: Array(6).fill(Tex.stone) },
    [BType.sand]: { sides: Array(6).fill(Tex.sand) },
    [BType.snow]: { sides: [Tex.snow, Tex.dirt, Tex.snow, Tex.snow, Tex.snow, Tex.snow] },
    [BType.log]: { sides: [Tex.logTop, Tex.logTop, Tex.logSide, Tex.logSide, Tex.logSide, Tex.logSide] },
    [BType.leaf]: { sides: Array(6).fill(Tex.leaf), isTransparent: true },
    [BType.planks]: { sides: Array(6).fill(Tex.planks) },
    [BType.water]: { sides: Array(6).fill(Tex.water), isTransparent: true },
  };

  return { texture, blockDefs };
}
