// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Ported from escape-tsuami-client/src/game/map/config.ts, render distance tuned
// down since terrain now generates on the fly (no server/back-end feeding chunks).

export const CHUNK_SIZE = 16;
// Trimmed from 8: with no occlusion/frustum culling of individual chunks
// (World.ts sets mesh.frustumCulled = false, relying on the single mega-buffer
// draw call), every loaded column costs streaming + GPU buffer space whether
// or not it's ever on screen. 6 chunks (96 blocks) is still a sizeable view
// distance but cuts the loaded column count by ~41% ((13^2 vs 17^2)).
export const RENDER_DISTANCE = 6;
export const CACHED_RENDER_DISTANCE = RENDER_DISTANCE + 3;

export const MAX_HEIGHT_IN_CHUNKS = 6;
export const WORLD_HEIGHT = MAX_HEIGHT_IN_CHUNKS * CHUNK_SIZE;

export const SNOW_LVL = 78;
export const STONE_LVL = 68;
export const DIRT_LVL = 58;
export const GRASS_LVL = 40;
export const SAND_LVL = 37; // only 1 block above sea level → thin shoreline, no big sand pools

export const SEA_LEVEL = 36;

export const TREE_PROBABILITY = 0.01;
