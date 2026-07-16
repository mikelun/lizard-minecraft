import * as THREE from "three";
import { BType } from "../world/types";
import type { BlockDef } from "../world/chunkMesh.worker";
import { loadTGA } from "./tgaLoader";

const TILE = 16;

const enum Tex {
  grassTop    = 0,
  grassSide   = 1,
  dirt        = 2,
  stone       = 3,
  sand        = 4,
  snow        = 5,
  logSide     = 6,
  logTop      = 7,
  leaf        = 8,
  planks      = 9,
  water       = 10,
  coalOre     = 11,
  ironOre     = 12,
  goldOre     = 13,
  diamondOre  = 14,
  emeraldOre  = 15,
  lapisOre    = 16,
  redstoneOre   = 17,
  snowGrassTop  = 18,
  snowGrassSide = 19,
  cherryLeaf    = 20,
  // Solid (alpha=255) variants for inner leaf faces (leaf-vs-leaf boundaries).
  // Same RGB as leaf/cherryLeaf but never discarded by the alpha-test in the shader.
  leafSolid       = 21,
  cherryLeafSolid = 22,
  // World import textures
  smoothSandstone     = 23,
  whiteConcrete       = 24,
  smoothRedSandstone  = 25,
  smoothStoneTop      = 26,
  smoothStoneSide     = 27,
  lightGrayConcrete   = 28,
  yellowTerracotta    = 29,
  stoneBricks         = 30,
  coalBlock           = 31,
  prismarineBricks    = 32,
  whiteTerracotta     = 33,
  cyanTerracotta      = 34,
  redTerracotta       = 35,
  greenTerracotta     = 36,
  limeTerracotta      = 37,
  cobblestone         = 38,
  sandstoneTop        = 39,
  sandstoneSide       = 40,
  sandstoneBottom     = 41,
  bricks              = 42,
  chestTop            = 43,
  chestSide           = 44,
  chestFront          = 45,
  chain               = 46,
}
const LAYER_COUNT = 47;

const TEXTURE_FILES: Record<Tex, string> = {
  [Tex.grassTop]:  "/textures/blocks/grass_top.png", // grayscale — tinted in shader
  [Tex.grassSide]: "",                              // loaded from grass_side.tga (alpha = biome tint mask)
  [Tex.dirt]:      "/textures/blocks/dirt.png",
  [Tex.stone]:     "/textures/blocks/stone.png",
  [Tex.sand]:      "/textures/blocks/sand.png",
  [Tex.snow]:      "/textures/blocks/snow.png",
  [Tex.logSide]:   "/textures/blocks/log_oak.png",
  [Tex.logTop]:    "/textures/blocks/log_oak_top.png",
  [Tex.leaf]:      "", // loaded separately as TGA
  [Tex.planks]:    "/textures/blocks/planks_oak.png",
  [Tex.water]:       "/textures/blocks/water_still.png",
  [Tex.coalOre]:     "/textures/blocks/coal_ore.png",
  [Tex.ironOre]:     "/textures/blocks/iron_ore.png",
  [Tex.goldOre]:     "/textures/blocks/gold_ore.png",
  [Tex.diamondOre]:  "/textures/blocks/diamond_ore.png",
  [Tex.emeraldOre]:  "/textures/blocks/emerald_ore.png",
  [Tex.lapisOre]:    "/textures/blocks/lapis_ore.png",
  [Tex.redstoneOre]:   "/textures/blocks/redstone_ore.png",
  [Tex.snowGrassTop]:  "/textures/blocks/grass_block_snow.png",
  [Tex.snowGrassSide]: "/textures/blocks/grass_side_snowed.png",
  [Tex.cherryLeaf]:        "", // loaded from same TGA as Tex.leaf
  [Tex.leafSolid]:         "", // loaded from same TGA — alpha forced to 255
  [Tex.cherryLeafSolid]:   "", // loaded from same TGA — alpha forced to 255
  // World import textures — all from MC 1.21 where available
  [Tex.smoothSandstone]:    "/mc/textures/block/cut_sandstone.png",   // cut_sandstone and smooth_sandstone both → this BType
  [Tex.whiteConcrete]:      "/mc/textures/block/white_concrete.png",
  [Tex.smoothRedSandstone]: "/mc/textures/block/red_sandstone_top.png",
  [Tex.smoothStoneTop]:     "/mc/textures/block/smooth_stone.png",
  [Tex.smoothStoneSide]:    "/mc/textures/block/smooth_stone_slab_side.png",
  [Tex.lightGrayConcrete]:  "/mc/textures/block/light_gray_concrete.png",
  [Tex.yellowTerracotta]:   "/textures/blocks/yellow_terracotta.png",  // not in mc/textures/block
  [Tex.stoneBricks]:        "/mc/textures/block/stone_bricks.png",
  [Tex.coalBlock]:          "/textures/blocks/coal_block_full.png",
  [Tex.prismarineBricks]:   "/textures/blocks/prismarine_bricks.png",  // not in mc/textures/block
  [Tex.whiteTerracotta]:    "/mc/textures/block/white_terracotta.png",
  [Tex.cyanTerracotta]:     "/textures/blocks/cyan_terracotta.png",    // not in mc/textures/block
  [Tex.redTerracotta]:      "/mc/textures/block/red_terracotta.png",
  [Tex.greenTerracotta]:    "/textures/blocks/green_terracotta.png",   // not in mc/textures/block
  [Tex.limeTerracotta]:     "/mc/textures/block/lime_terracotta.png",
  [Tex.cobblestone]:        "/mc/textures/block/cobblestone.png",
  [Tex.sandstoneTop]:       "/mc/textures/block/sandstone_top.png",
  [Tex.sandstoneSide]:      "/mc/textures/block/sandstone.png",
  [Tex.sandstoneBottom]:    "/mc/textures/block/sandstone_bottom.png",
  [Tex.bricks]:             "/mc/textures/block/bricks.png",
  [Tex.chestTop]:           "/textures/blocks/chest_top.png",
  [Tex.chestSide]:          "/textures/blocks/chest_side.png",
  [Tex.chestFront]:         "/textures/blocks/chest_front.png",
  [Tex.chain]:              "/textures/blocks/chain.png",
};

export interface BlockTextureAtlas {
  texture: THREE.DataArrayTexture;
  blockDefs: Record<number, BlockDef>;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawImageToLayer(img: HTMLImageElement, data: Uint8Array, layer: number) {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, TILE, TILE);
  const pixels = ctx.getImageData(0, 0, TILE, TILE);
  data.set(pixels.data, layer * TILE * TILE * 4);
}

export async function buildBlockTextureAtlas(): Promise<BlockTextureAtlas> {
  const data = new Uint8Array(TILE * TILE * 4 * LAYER_COUNT);

  await Promise.all([
    // PNG layers
    ...(Object.entries(TEXTURE_FILES) as [string, string][])
      .filter(([, src]) => src !== "")
      .map(async ([layerStr, src]) => {
        const layer = Number(layerStr) as Tex;
        const img = await loadImage(src);
        drawImageToLayer(img, data, layer);
      }),
    // TGA: grass side — RGB is the texture, alpha marks the biome-tintable green strip
    loadTGA("/textures/blocks/grass_side.tga").then(({ data: px }) => {
      data.set(px.subarray(0, TILE * TILE * 4), Tex.grassSide * TILE * TILE * 4);
    }),
    // TGA leaf — outer faces use original alpha (transparent); inner leaf-vs-leaf
    // faces use the solid variant (alpha forced to 255, same RGB).
    loadTGA("/textures/blocks/leaves_oak.tga").then(({ data: px }) => {
      const leafPx = px.subarray(0, TILE * TILE * 4);
      data.set(leafPx, Tex.leaf       * TILE * TILE * 4);
      data.set(leafPx, Tex.cherryLeaf * TILE * TILE * 4);
      const solidPx = leafPx.slice();
      for (let i = 3; i < solidPx.length; i += 4) solidPx[i] = 255;
      data.set(solidPx, Tex.leafSolid       * TILE * TILE * 4);
      data.set(solidPx, Tex.cherryLeafSolid * TILE * TILE * 4);
    }),
  ]);

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
    [BType.grass]:  { sides: [Tex.grassTop, Tex.dirt, Tex.grassSide, Tex.grassSide, Tex.grassSide, Tex.grassSide] },
    [BType.dirt]:   { sides: Array(6).fill(Tex.dirt) },
    [BType.stone]:  { sides: Array(6).fill(Tex.stone) },
    [BType.sand]:   { sides: Array(6).fill(Tex.sand) },
    [BType.snow]:   { sides: [Tex.snow, Tex.dirt, Tex.snowGrassSide, Tex.snowGrassSide, Tex.snowGrassSide, Tex.snowGrassSide] },
    [BType.log]:    { sides: [Tex.logTop, Tex.logTop, Tex.logSide, Tex.logSide, Tex.logSide, Tex.logSide] },
    [BType.leaf]:   { sides: Array(6).fill(Tex.leaf), isTransparent: true, isLeaf: true, solidSides: Array(6).fill(Tex.leafSolid) },
    [BType.planks]:       { sides: Array(6).fill(Tex.planks) },
    [BType.water]:        { sides: Array(6).fill(Tex.water), isTransparent: true, topFaceOnly: true },
    [BType.coal_ore]:     { sides: Array(6).fill(Tex.coalOre) },
    [BType.iron_ore]:     { sides: Array(6).fill(Tex.ironOre) },
    [BType.gold_ore]:     { sides: Array(6).fill(Tex.goldOre) },
    [BType.diamond_ore]:  { sides: Array(6).fill(Tex.diamondOre) },
    [BType.emerald_ore]:  { sides: Array(6).fill(Tex.emeraldOre) },
    [BType.lapis_ore]:    { sides: Array(6).fill(Tex.lapisOre) },
    [BType.redstone_ore]: { sides: Array(6).fill(Tex.redstoneOre) },
    [BType.cherry_log]:  { sides: [Tex.logTop, Tex.logTop, Tex.logSide, Tex.logSide, Tex.logSide, Tex.logSide] },
    [BType.cherry_leaf]: { sides: Array(6).fill(Tex.cherryLeaf), isTransparent: true, isLeaf: true, solidSides: Array(6).fill(Tex.cherryLeafSolid) },
    // World import block types
    [BType.smooth_sandstone]:    { sides: Array(6).fill(Tex.smoothSandstone) },
    [BType.white_concrete]:      { sides: Array(6).fill(Tex.whiteConcrete) },
    [BType.smooth_red_sandstone]: { sides: Array(6).fill(Tex.smoothRedSandstone) },
    [BType.smooth_stone]:        { sides: [Tex.smoothStoneTop, Tex.smoothStoneTop, Tex.smoothStoneSide, Tex.smoothStoneSide, Tex.smoothStoneSide, Tex.smoothStoneSide] },
    [BType.light_gray_concrete]: { sides: Array(6).fill(Tex.lightGrayConcrete) },
    [BType.yellow_terracotta]:   { sides: Array(6).fill(Tex.yellowTerracotta) },
    [BType.stone_bricks]:        { sides: Array(6).fill(Tex.stoneBricks) },
    [BType.coal_block]:          { sides: Array(6).fill(Tex.coalBlock) },
    [BType.prismarine_bricks]:   { sides: Array(6).fill(Tex.prismarineBricks) },
    [BType.white_terracotta]:    { sides: Array(6).fill(Tex.whiteTerracotta) },
    [BType.cyan_terracotta]:     { sides: Array(6).fill(Tex.cyanTerracotta) },
    [BType.red_terracotta]:      { sides: Array(6).fill(Tex.redTerracotta) },
    [BType.green_terracotta]:    { sides: Array(6).fill(Tex.greenTerracotta) },
    [BType.lime_terracotta]:     { sides: Array(6).fill(Tex.limeTerracotta) },
    [BType.cobblestone]:         { sides: Array(6).fill(Tex.cobblestone) },
    [BType.sandstone]:           { sides: [Tex.sandstoneTop, Tex.sandstoneBottom, Tex.sandstoneSide, Tex.sandstoneSide, Tex.sandstoneSide, Tex.sandstoneSide] },
    [BType.bricks]:              { sides: Array(6).fill(Tex.bricks) },
    // chain is intentionally absent — ChainBlockLayer renders it as thin cross planes.
    // chest is intentionally absent — ModelLayer renders it as a proper 3D model.
  };

  return { texture, blockDefs };
}
