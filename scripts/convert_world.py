#!/usr/bin/env python3
"""Convert Minecraft 1.20.1 world to lizard-minecraft binary.

Output: public/world/world.bin  (then gzip → world.bin.gz)
Format MCBIN002 — sparse column encoding:
  Header (32 bytes):
    [0:8]   magic "MCBIN002"
    [8:12]  minX int32  (min world X coordinate)
    [12:16] minZ int32  (min world Z coordinate)
    [16:20] sizeX uint32 (number of columns in X)
    [20:24] sizeZ uint32 (number of columns in Z)
    [24:28] mcYOffset int32 (mc_y + mcYOffset = game_y, so for mc_y=-64 → 64)
    [28:32] gameHeight uint32 (Y levels stored per column)
  Offset table (sizeX * sizeZ * 4 bytes):
    uint32 per column. 0 = all-air column. Non-zero = byte offset into data section.
  Data section — sparse: only non-air (y, blockID) pairs per column:
    uint8   count          number of non-air blocks in this column
    count × { uint8 y, uint16 blockID }
  This cuts raw size ~6x vs dense MCBIN001 (avg 4 non-air blocks out of 56 Y slots).
  Gzipped: ~766 KB vs ~1.5 MB for the dense format.
"""
import struct, zlib, gzip, os, sys, math
from pathlib import Path

# ── Block ID mapping ────────────────────────────────────────────────────────
# Values 0-18 match existing BType enum. 19+ are new types added for this world.
BTYPE = {
    'air':                0,
    'grass':              1,
    'dirt':               2,
    'stone':              3,
    'sand':               4,
    'snow':               5,
    'log':                6,
    'leaf':               7,
    'planks':             8,
    'water':              9,
    'coal_ore':          10,
    'iron_ore':          11,
    'gold_ore':          12,
    'diamond_ore':       13,
    'emerald_ore':       14,
    'lapis_ore':         15,
    'redstone_ore':      16,
    'cherry_log':        17,
    'cherry_leaf':       18,
    # New types
    'smooth_sandstone':  19,
    'white_concrete':    20,
    'smooth_red_sandstone': 21,
    'smooth_stone':      22,
    'light_gray_concrete': 23,
    'yellow_terracotta': 24,
    'stone_bricks':      25,
    'coal_block':        26,
    'prismarine_bricks': 27,
    'white_terracotta':  28,
    'cyan_terracotta':   29,
    'red_terracotta':    30,
    'green_terracotta':  31,
    'lime_terracotta':   32,
    'cobblestone':       33,
    'sandstone':         34,
    'bricks':            35,
    'chest':             36,
    'chain':             37,
    # Half-height slab types (bottom half)
    'cut_sandstone_slab':        38,
    'smooth_sandstone_slab':     39,
    'smooth_stone_slab':         40,
    'smooth_red_sandstone_slab': 41,
    'oak_slab':                  42,
    'stone_brick_slab':          43,
    'prismarine_brick_slab':     44,
    # Top-half slab types (bottom_id + 140)
    'cut_sandstone_slab_top':        178,
    'smooth_sandstone_slab_top':     179,
    'smooth_stone_slab_top':         180,
    'smooth_red_sandstone_slab_top': 181,
    'oak_slab_top':                  182,
    'stone_brick_slab_top':          183,
    'prismarine_brick_slab_top':     184,
    # Cross-post types (thin/post geometry)
    'iron_bars':                 45,
    'glass_pane':                46,
    'oak_fence':                 47,
    # Door types
    'oak_door':                  48,
    # Trapdoor types
    'oak_trapdoor':              49,
    # Door facing IDs (185=north, 186=south, 187=east, 188=west)
    'door_north': 185, 'door_south': 186, 'door_east': 187, 'door_west': 188,
    # Stair base IDs (orientation added per-block in BLOCK_MAP processing)
    'stone_brick_stairs':          50,
    'smooth_sandstone_stairs':     58,
    'sandstone_stairs':            66,
    'smooth_red_sandstone_stairs': 74,
    'oak_stairs':                  82,
    'prismarine_brick_stairs':     90,
    'cobblestone_stairs':          98,
    'brick_stairs':               106,
}

# Java block name → game BType value (0 = air)
BLOCK_MAP = {
    # air / invisible
    'minecraft:air': 0, 'minecraft:cave_air': 0, 'minecraft:void_air': 0,
    'minecraft:barrier': 0, 'minecraft:light': 0,
    'minecraft:redstone_wire': 0, 'minecraft:repeater': 0,
    'minecraft:chain': BTYPE['chain'],
    'minecraft:iron_bars': BTYPE['iron_bars'],
    'minecraft:glass_pane': BTYPE['glass_pane'],
    'minecraft:tinted_glass': BTYPE['glass_pane'],
    'minecraft:ladder': 0,
    'minecraft:torch': 0, 'minecraft:wall_torch': 0,
    'minecraft:tripwire': 0, 'minecraft:tripwire_hook': 0,
    'minecraft:oak_fence': BTYPE['oak_fence'], 'minecraft:oak_fence_gate': 0,
    # door entries removed — handled per-block in extract_column() with facing encoding
    # trapdoor entries removed — handled per-block in extract_column() with full state encoding
    'minecraft:oak_wall_sign': 0, 'minecraft:birch_sign': 0,
    'minecraft:acacia_wall_sign': 0, 'minecraft:dark_oak_wall_sign': 0,
    'minecraft:spruce_wall_sign': 0,
    'minecraft:oak_pressure_plate': 0, 'minecraft:stone_pressure_plate': 0,
    'minecraft:heavy_weighted_pressure_plate': 0,
    'minecraft:oak_button': 0, 'minecraft:stone_button': 0,
    'minecraft:birch_button': 0, 'minecraft:bamboo_button': 0,
    'minecraft:polished_blackstone_button': 0,
    'minecraft:cobweb': 0,
    'minecraft:white_carpet': 0, 'minecraft:green_carpet': 0,
    'minecraft:white_bed': 0, 'minecraft:yellow_bed': 0,
    'minecraft:dandelion': 0, 'minecraft:poppy': 0, 'minecraft:cornflower': 0,
    'minecraft:azure_bluet': 0, 'minecraft:oxeye_daisy': 0, 'minecraft:tall_grass': 0,
    'minecraft:grass': 0,
    'minecraft:potted_azure_bluet': 0, 'minecraft:potted_cornflower': 0,
    'minecraft:potted_dandelion': 0, 'minecraft:potted_lily_of_the_valley': 0,
    'minecraft:wheat': 0, 'minecraft:carrots': 0, 'minecraft:potatoes': 0,
    'minecraft:beetroots': 0,
    'minecraft:composter': 0, 'minecraft:smoker': 0,
    'minecraft:chest': BTYPE['chest'], 'minecraft:trapped_chest': BTYPE['chest'],
    'minecraft:ender_chest': BTYPE['chest'],
    'minecraft:hopper': 0, 'minecraft:dispenser': 0, 'minecraft:decorated_pot': 0,
    'minecraft:bell': 0, 'minecraft:player_head': 0, 'minecraft:player_wall_head': 0,
    # grass_block → 1
    'minecraft:grass_block': BTYPE['grass'],
    # dirt variants → 2
    'minecraft:dirt': BTYPE['dirt'],
    'minecraft:dirt_path': BTYPE['dirt'],
    'minecraft:farmland': BTYPE['dirt'],
    # stone variants → 3
    'minecraft:stone': BTYPE['stone'],
    'minecraft:bedrock': BTYPE['stone'],
    'minecraft:deepslate': BTYPE['stone'],
    'minecraft:iron_block': BTYPE['stone'],
    'minecraft:gold_block': BTYPE['stone'],
    'minecraft:end_stone': BTYPE['stone'],
    'minecraft:command_block': BTYPE['stone'],
    'minecraft:repeating_command_block': BTYPE['stone'],
    'minecraft:hay_block': BTYPE['stone'],
    'minecraft:coal_block': BTYPE['coal_block'],
    # sand → 4
    'minecraft:sand': BTYPE['sand'],
    # log → 6
    'minecraft:oak_log': BTYPE['log'],
    'minecraft:stripped_oak_log': BTYPE['log'],
    'minecraft:oak_wood': BTYPE['log'],
    'minecraft:stripped_oak_wood': BTYPE['log'],
    'minecraft:jungle_log': BTYPE['log'],
    'minecraft:barrel': BTYPE['planks'],     # barrel → planks (wooden crate look)
    'minecraft:note_block': BTYPE['planks'],
    # leaves → 7
    'minecraft:oak_leaves': BTYPE['leaf'],
    'minecraft:jungle_leaves': BTYPE['leaf'],
    # planks → 8
    'minecraft:oak_planks': BTYPE['planks'],
    'minecraft:spruce_planks': BTYPE['planks'],
    'minecraft:dark_oak_planks': BTYPE['planks'],
    'minecraft:oak_slab': BTYPE['oak_slab'],
    'minecraft:spruce_slab': BTYPE['oak_slab'],
    'minecraft:spruce_slab': BTYPE['planks'],
    'minecraft:crafting_table': BTYPE['planks'],
    # water → 9
    'minecraft:water': BTYPE['water'],
    'minecraft:water_cauldron': BTYPE['water'],
    # smooth_sandstone → 19 (covers cut/smooth/plain sandstone)
    'minecraft:cut_sandstone': BTYPE['smooth_sandstone'],
    'minecraft:cut_sandstone_slab': BTYPE['cut_sandstone_slab'],
    'minecraft:smooth_sandstone': BTYPE['smooth_sandstone'],
    'minecraft:smooth_sandstone_slab': BTYPE['smooth_sandstone_slab'],
    'minecraft:sandstone_wall': BTYPE['sandstone'],
    'minecraft:sandstone': BTYPE['sandstone'],
    # white_concrete → 20
    'minecraft:white_concrete': BTYPE['white_concrete'],
    # smooth_red_sandstone → 21
    'minecraft:smooth_red_sandstone': BTYPE['smooth_red_sandstone'],
    'minecraft:smooth_red_sandstone_slab': BTYPE['smooth_red_sandstone_slab'],
    # smooth_stone → 22
    'minecraft:smooth_stone': BTYPE['smooth_stone'],
    'minecraft:smooth_stone_slab': BTYPE['smooth_stone_slab'],
    # light_gray_concrete → 23
    'minecraft:light_gray_concrete': BTYPE['light_gray_concrete'],
    # yellow_terracotta → 24
    'minecraft:yellow_terracotta': BTYPE['yellow_terracotta'],
    # stone_bricks → 25
    'minecraft:stone_bricks': BTYPE['stone_bricks'],
    'minecraft:stone_brick_slab': BTYPE['stone_brick_slab'],
    'minecraft:stone_brick_wall': BTYPE['stone_bricks'],
    # prismarine_bricks → 27
    'minecraft:prismarine_bricks': BTYPE['prismarine_bricks'],
    'minecraft:prismarine_brick_slab': BTYPE['prismarine_brick_slab'],
    # white_terracotta → 28
    'minecraft:white_terracotta': BTYPE['white_terracotta'],
    # cyan_terracotta → 29
    'minecraft:cyan_terracotta': BTYPE['cyan_terracotta'],
    # red_terracotta → 30
    'minecraft:red_terracotta': BTYPE['red_terracotta'],
    # green_terracotta → 31
    'minecraft:green_terracotta': BTYPE['green_terracotta'],
    # lime_terracotta → 32
    'minecraft:lime_terracotta': BTYPE['lime_terracotta'],
    # cobblestone → 33
    'minecraft:cobblestone': BTYPE['cobblestone'],
    'minecraft:mossy_cobblestone': BTYPE['cobblestone'],
    'minecraft:cobblestone_wall': BTYPE['cobblestone'],
    # bricks → 35
    'minecraft:bricks': BTYPE['bricks'],
    # misc solid → stone
    'minecraft:gray_glazed_terracotta': BTYPE['stone'],
    'minecraft:light_gray_glazed_terracotta': BTYPE['stone'],
    'minecraft:light_blue_concrete': BTYPE['white_concrete'],
    'minecraft:cyan_concrete_powder': BTYPE['cyan_terracotta'],
}

DEFAULT_SOLID = BTYPE['stone']  # fallback for unmapped solid blocks

# Door blocks — ID = 185 + type*4 + facing  (type 0-11, facing N=0 S=1 E=2 W=3)
# Max door ID = 185 + 11*4 + 3 = 232  (fits in LOOKUP_SIZE=256)
DOOR_BASE = 185
DOOR_FACING_IDX = {'north': 0, 'south': 1, 'east': 2, 'west': 3}
DOOR_TYPE_IDX = {
    'minecraft:oak_door':       0,
    'minecraft:warped_door':    1,
    'minecraft:iron_door':      2,
    'minecraft:mangrove_door':  3,
    'minecraft:spruce_door':    4,
    'minecraft:birch_door':     5,
    'minecraft:dark_oak_door':  6,
    'minecraft:jungle_door':    7,
    'minecraft:acacia_door':    8,
    'minecraft:bamboo_door':    9,
    'minecraft:cherry_door':   10,
    'minecraft:copper_door':   11,
}

STAIR_BLOCKS = {
    'minecraft:stone_brick_stairs':           50,
    'minecraft:stone_stairs':                 50,
    'minecraft:smooth_sandstone_stairs':      58,
    'minecraft:sandstone_stairs':             66,
    'minecraft:smooth_red_sandstone_stairs':  74,
    'minecraft:oak_stairs':                   82,
    'minecraft:spruce_stairs':                82,
    'minecraft:dark_oak_stairs':              82,
    'minecraft:prismarine_brick_stairs':      90,
    'minecraft:cobblestone_stairs':           98,
    'minecraft:brick_stairs':               106,
}
FACING_IDX = {'north': 0, 'south': 1, 'east': 2, 'west': 3}

# Slab block names → bottom-half BType (for type=bottom/double lookup)
SLAB_BLOCKS = {
    'minecraft:cut_sandstone_slab':        38,
    'minecraft:smooth_sandstone_slab':     39,
    'minecraft:smooth_stone_slab':         40,
    'minecraft:smooth_red_sandstone_slab': 41,
    'minecraft:oak_slab':                  42,
    'minecraft:spruce_slab':               42,  # treat spruce as oak
    'minecraft:stone_brick_slab':          43,
    'minecraft:prismarine_brick_slab':     44,
    # Deepslate variants → reuse smooth_stone_slab (40) — similar gray
    'minecraft:polished_deepslate_slab':   40,
    'minecraft:deepslate_brick_slab':      40,
    'minecraft:deepslate_tile_slab':       40,
    'minecraft:cobbled_deepslate_slab':    40,
    # Other common stone slabs → smooth_stone_slab
    'minecraft:stone_slab':                40,
    'minecraft:andesite_slab':             40,
    'minecraft:polished_andesite_slab':    40,
    'minecraft:cobblestone_slab':          40,
    # Wood variants → oak_slab
    'minecraft:dark_oak_slab':             42,
    'minecraft:birch_slab':                42,
    'minecraft:acacia_slab':               42,
    'minecraft:mangrove_slab':             42,
    'minecraft:jungle_slab':               42,
}
TOP_SLAB_OFFSET = 140  # bottom_btype + 140 = top_btype (178-184)
# double slab → solid block BType equivalent
SLAB_DOUBLE_SOLID = {
    'minecraft:cut_sandstone_slab':        19,  # smooth_sandstone
    'minecraft:smooth_sandstone_slab':     19,
    'minecraft:smooth_stone_slab':         22,  # smooth_stone
    'minecraft:smooth_red_sandstone_slab': 21,  # smooth_red_sandstone
    'minecraft:oak_slab':                   8,  # planks
    'minecraft:spruce_slab':                8,
    'minecraft:stone_brick_slab':          25,  # stone_bricks
    'minecraft:prismarine_brick_slab':     27,  # prismarine_bricks
    # Deepslate / stone variants → smooth_stone
    'minecraft:polished_deepslate_slab':   22,
    'minecraft:deepslate_brick_slab':      22,
    'minecraft:deepslate_tile_slab':       22,
    'minecraft:cobbled_deepslate_slab':    22,
    'minecraft:stone_slab':                22,
    'minecraft:andesite_slab':             22,
    'minecraft:polished_andesite_slab':    22,
    'minecraft:cobblestone_slab':          33,  # cobblestone
    # Wood variants → planks
    'minecraft:dark_oak_slab':              8,
    'minecraft:birch_slab':                 8,
    'minecraft:acacia_slab':                8,
    'minecraft:mangrove_slab':              8,
    'minecraft:jungle_slab':                8,
}

TRAPDOOR_BASE = 114
TRAPDOOR_TYPE = {
    'minecraft:oak_trapdoor':      0,
    'minecraft:iron_trapdoor':     1,
    'minecraft:mangrove_trapdoor': 2,
    'minecraft:spruce_trapdoor':   3,
}
TRAP_FACING_IDX = {'north': 0, 'south': 1, 'east': 2, 'west': 3}

# Y range — overridden per-world in convert()
MC_Y_MIN    = -64
MC_Y_MAX    = -17
GAME_HEIGHT = MC_Y_MAX - MC_Y_MIN + 1
MC_Y_OFFSET = -MC_Y_MIN

# ── Region / chunk parsing ───────────────────────────────────────────────────
def read_region(path):
    """Return list of (local_cx, local_cz, nbt_bytes)."""
    with open(path, 'rb') as f: data = f.read()
    chunks = []
    for i in range(1024):
        entry = struct.unpack_from('>I', data, i*4)[0]
        offset = (entry >> 8) * 4096
        if not offset: continue
        length = struct.unpack_from('>I', data, offset)[0]
        ctype  = data[offset+4]
        raw    = data[offset+5:offset+4+length]
        try:
            nb = zlib.decompress(raw) if ctype == 2 else gzip.decompress(raw)
            chunks.append((i % 32, i // 32, nb))
        except Exception as e:
            print(f'  warn: decompress error at slot {i}: {e}')
    return chunks

def parse_tag(data, pos, tt):
    if tt == 1:
        v = data[pos]; return (v if v < 128 else v-256), pos+1
    if tt == 2: return struct.unpack_from('>h', data, pos)[0], pos+2
    if tt == 3: return struct.unpack_from('>i', data, pos)[0], pos+4
    if tt == 4: return struct.unpack_from('>q', data, pos)[0], pos+8
    if tt == 5: return None, pos+4
    if tt == 6: return None, pos+8
    if tt == 7:
        n = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return None, pos+n
    if tt == 8:
        n = struct.unpack_from('>H', data, pos)[0]; pos += 2
        return data[pos:pos+n].decode('utf-8','replace'), pos+n
    if tt == 9:
        et = data[pos]; pos += 1
        n  = struct.unpack_from('>i', data, pos)[0]; pos += 4
        lst = []
        for _ in range(n):
            v, pos = parse_tag(data, pos, et); lst.append(v)
        return lst, pos
    if tt == 10:
        d = {}
        while True:
            nt = data[pos]; pos += 1
            if nt == 0: break
            nl = struct.unpack_from('>H', data, pos)[0]; pos += 2
            nm = data[pos:pos+nl].decode('utf-8','replace'); pos += nl
            v, pos = parse_tag(data, pos, nt); d[nm] = v
        return d, pos
    if tt == 11:
        n = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return None, pos+n*4
    if tt == 12:
        n = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return list(struct.unpack_from(f'>{n}q', data, pos)), pos+n*8
    raise ValueError(f'Unknown NBT tag type {tt}')

def parse_chunk(raw):
    pos = 0
    tt = raw[pos]; pos += 1
    nl = struct.unpack_from('>H', raw, pos)[0]; pos += 2+nl
    chunk, _ = parse_tag(raw, pos, tt)
    return chunk

def decode_section_blocks(palette, data_longs):
    """Return list of 4096 palette indices."""
    n = len(palette)
    if n <= 1:
        return [0]*4096
    bits = max(4, (n-1).bit_length())
    per_long = 64 // bits
    mask = (1 << bits) - 1
    result = []
    for lng in data_longs:
        # handle signed 64-bit
        if lng < 0: lng += (1 << 64)
        for j in range(per_long):
            if len(result) >= 4096: break
            result.append((lng >> (j*bits)) & mask)
        if len(result) >= 4096: break
    while len(result) < 4096:
        result.append(0)
    return result[:4096]

def get_sections(chunk):
    """Return (sections_list, palette_key, data_key) for 1.16.x and 1.18+ formats.
    1.18+:  chunk["sections"],          section["block_states"]["palette"], section["block_states"]["data"]
    1.16.x: chunk["Level"]["Sections"], section["Palette"],                 section["BlockStates"]
    """
    if 'sections' in chunk:
        return chunk['sections'], None, None  # new format
    if 'Level' in chunk:
        return chunk['Level'].get('Sections', []), 'old', 'old'  # old format
    return [], None, None

def extract_column(chunk, col_lx, col_lz):
    """Extract GAME_HEIGHT block IDs for one 1×GAME_HEIGHT×1 column in a chunk."""
    out = [0] * GAME_HEIGHT  # default air
    sections, fmt, _ = get_sections(chunk)
    old_format = (fmt == 'old')

    for sec in sections:
        sy = sec.get('Y', 0)
        mc_y_base = sy * 16
        # Only process sections that overlap our Y range
        if mc_y_base + 15 < MC_Y_MIN or mc_y_base > MC_Y_MAX:
            continue

        if old_format:
            # 1.16.x: palette and block states directly on section
            palette = sec.get('Palette', [])
            data_longs = sec.get('BlockStates') or []
        else:
            # 1.18+: nested under block_states
            bs = sec.get('block_states', {})
            palette = bs.get('palette', [])
            data_longs = bs.get('data') or []

        if not palette:
            continue

        if data_longs:
            indices = decode_section_blocks(palette, data_longs)
        else:
            indices = [0] * 4096  # single palette entry

        for local_y in range(16):
            mc_y = mc_y_base + local_y
            if mc_y < MC_Y_MIN or mc_y > MC_Y_MAX:
                continue
            game_y = mc_y + MC_Y_OFFSET
            idx = local_y*16*16 + col_lz*16 + col_lx
            palette_idx = indices[idx] if indices else 0
            if palette_idx >= len(palette):
                palette_idx = 0
            entry = palette[palette_idx]
            block_name = entry.get('Name', 'minecraft:air') if isinstance(entry, dict) else 'minecraft:air'
            props = entry.get('Properties', {}) if isinstance(entry, dict) else {}
            # Check if it's a slab (handle top/double variants)
            if block_name in SLAB_BLOCKS:
                slab_type = props.get('type', 'bottom') if isinstance(props, dict) else 'bottom'
                if slab_type == 'double':
                    btype = SLAB_DOUBLE_SOLID.get(block_name, DEFAULT_SOLID)
                elif slab_type == 'top':
                    btype = SLAB_BLOCKS[block_name] + TOP_SLAB_OFFSET
                else:  # bottom
                    btype = SLAB_BLOCKS[block_name]
            # Check if it's a door block (encode type + facing: ID = base + type*4 + facing)
            elif block_name in DOOR_TYPE_IDX:
                facing_s = props.get('facing', 'south') if isinstance(props, dict) else 'south'
                fi   = DOOR_FACING_IDX.get(facing_s, 1)
                ti   = DOOR_TYPE_IDX[block_name]
                btype = DOOR_BASE + ti * 4 + fi
            # Check if it's a trapdoor block
            elif block_name in TRAPDOOR_TYPE:
                ttype = TRAPDOOR_TYPE[block_name]
                is_open  = 1 if (props.get('open')  == 'true'  if isinstance(props, dict) else False) else 0
                facing_s = props.get('facing', 'north') if isinstance(props, dict) else 'north'
                half_s   = props.get('half',   'bottom') if isinstance(props, dict) else 'bottom'
                facing_idx = TRAP_FACING_IDX.get(facing_s, 0)
                half_idx   = 1 if half_s == 'top' else 0
                btype = TRAPDOOR_BASE + ttype*16 + is_open*8 + facing_idx*2 + half_idx
            # Check if it's a stair block
            elif block_name in STAIR_BLOCKS:
                base = STAIR_BLOCKS[block_name]
                facing = props.get('facing', 'north') if isinstance(props, dict) else 'north'
                half = props.get('half', 'bottom') if isinstance(props, dict) else 'bottom'
                facing_idx = FACING_IDX.get(facing, 0)
                half_idx = 0 if half == 'bottom' else 1
                btype = base + facing_idx * 2 + half_idx
            else:
                btype = BLOCK_MAP.get(block_name)
                if btype is None:
                    if block_name not in ('minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'):
                        btype = DEFAULT_SOLID
                    else:
                        btype = 0
            out[game_y] = btype
    return out

# ── Main conversion ──────────────────────────────────────────────────────────
def convert(world_dir, out_path, ymin_arg=None, ymax_arg=None, pad=8):
    global MC_Y_MIN, MC_Y_MAX, GAME_HEIGHT, MC_Y_OFFSET

    world_dir = Path(world_dir)
    region_dir = world_dir / 'region'

    # Auto-detect Y range if not given
    if ymin_arg is None or ymax_arg is None:
        print('Auto-detecting Y range...')
        det_min, det_max = 999, -999
        for fname in sorted(os.listdir(region_dir)):
            if not fname.endswith('.mca'): continue
            with open(region_dir / fname, 'rb') as f: rd = f.read()
            for i in range(1024):
                entry = struct.unpack_from('>I', rd, i*4)[0]
                offset = (entry >> 8) * 4096
                if not offset: continue
                length = struct.unpack_from('>I', rd, offset)[0]
                ctype  = rd[offset+4]
                raw    = rd[offset+5:offset+4+length]
                try:
                    nb = zlib.decompress(raw) if ctype == 2 else gzip.decompress(raw)
                    chunk = parse_chunk(nb)
                    sections, fmt, _ = get_sections(chunk)
                    for sec in (sections or []):
                        if not isinstance(sec, dict): continue
                        sy = sec.get('Y', 0)
                        palette = sec.get('Palette', []) if fmt == 'old' else (sec.get('block_states') or {}).get('palette', [])
                        AIR = {'minecraft:air','minecraft:cave_air','minecraft:void_air'}
                        if any(isinstance(e,dict) and e.get('Name','') not in AIR for e in (palette or [])):
                            det_min = min(det_min, sy * 16)
                            det_max = max(det_max, sy * 16 + 15)
                except: continue
        if det_min > det_max:
            det_min, det_max = -64, 319  # fallback
        ymin_use = (ymin_arg if ymin_arg is not None else max(det_min - pad, -64))
        ymax_use = (ymax_arg if ymax_arg is not None else min(det_max + pad, 319))
        print(f'  Detected content Y: {det_min}–{det_max}, using {ymin_use}–{ymax_use} (pad={pad})')
    else:
        ymin_use, ymax_use = ymin_arg, ymax_arg
        print(f'  Using Y range: {ymin_use}–{ymax_use}')

    MC_Y_MIN    = ymin_use
    MC_Y_MAX    = ymax_use
    GAME_HEIGHT = MC_Y_MAX - MC_Y_MIN + 1
    MC_Y_OFFSET = -MC_Y_MIN

    # Pass 1: collect all chunk data, find bounds
    print('Pass 1: reading regions...')
    all_columns = {}  # (world_x, world_z) → [GAME_HEIGHT block IDs]

    min_cx = min_cz = 999999
    max_cx = max_cz = -999999

    for fname in sorted(os.listdir(region_dir)):
        if not fname.endswith('.mca'): continue
        parts = fname[2:-4].split('.')
        rx, rz = int(parts[0]), int(parts[1])
        print(f'  {fname}...')

        for lcx, lcz, raw in read_region(world_dir / 'region' / fname):
            world_cx = rx*32 + lcx
            world_cz = rz*32 + lcz

            try:
                chunk = parse_chunk(raw)
            except Exception as e:
                print(f'    warn: parse error chunk ({world_cx},{world_cz}): {e}')
                continue

            # Extract all 16×16 columns in this chunk
            chunk_cols = {}
            for col_lx in range(16):
                for col_lz in range(16):
                    col = extract_column(chunk, col_lx, col_lz)
                    if any(b != 0 for b in col):
                        world_x = world_cx*16 + col_lx
                        world_z = world_cz*16 + col_lz
                        chunk_cols[(world_x, world_z)] = col

            if chunk_cols:
                all_columns.update(chunk_cols)
                min_cx = min(min_cx, world_cx)
                min_cz = min(min_cz, world_cz)
                max_cx = max(max_cx, world_cx)
                max_cz = max(max_cz, world_cz)

    print(f'  Found {len(all_columns)} non-empty columns')
    print(f'  Chunk bounds: CX [{min_cx},{max_cx}], CZ [{min_cz},{max_cz}]')

    # Convert chunk bounds to world-column bounds
    min_wx = min_cx * 16
    min_wz = min_cz * 16
    max_wx = max_cx * 16 + 15
    max_wz = max_cz * 16 + 15
    size_wx = max_wx - min_wx + 1
    size_wz = max_wz - min_wz + 1

    print(f'  World column bounds: X [{min_wx},{max_wx}] ({size_wx} cols), Z [{min_wz},{max_wz}] ({size_wz} cols)')
    print(f'  Offset table entries: {size_wx * size_wz}')

    # Pass 2: write binary
    print('Pass 2: writing binary...')

    HEADER_SIZE = 32
    TABLE_SIZE  = size_wx * size_wz * 4
    DATA_OFFSET = HEADER_SIZE + TABLE_SIZE

    offsets = [0] * (size_wx * size_wz)
    data_buf = bytearray()

    for (wx, wz), col in sorted(all_columns.items()):
        tx = wx - min_wx
        tz = wz - min_wz
        idx = tz * size_wx + tx
        offset = DATA_OFFSET + len(data_buf)
        offsets[idx] = offset
        # Sparse encoding: count + (y, blockID) pairs for non-air only
        pairs = [(y, bid) for y, bid in enumerate(col) if bid != 0]
        data_buf.append(len(pairs))
        for y, bid in pairs:
            data_buf.append(y)
            data_buf += struct.pack('<H', bid)

    with open(out_path, 'wb') as f:
        f.write(b'MCBIN002')                       # 8 bytes
        f.write(struct.pack('<i', min_wx))          # 4: minX
        f.write(struct.pack('<i', min_wz))          # 4: minZ
        f.write(struct.pack('<I', size_wx))         # 4: sizeX
        f.write(struct.pack('<I', size_wz))         # 4: sizeZ
        f.write(struct.pack('<i', MC_Y_OFFSET))     # 4: mc_y + offset = game_y
        f.write(struct.pack('<I', GAME_HEIGHT))     # 4: gameHeight
        # Total header: 32 bytes

        # Offset table
        f.write(struct.pack(f'<{len(offsets)}I', *offsets))

        # Column data
        f.write(data_buf)

    size_bytes = os.path.getsize(out_path)
    print(f'  Written: {out_path} ({size_bytes/1024/1024:.1f} MB, {len(all_columns)} columns)')
    # Gzip the output
    gz_path = Path(str(out_path) + '.gz')
    with open(out_path, 'rb') as f_in, gzip.open(gz_path, 'wb', compresslevel=9) as f_out:
        f_out.write(f_in.read())
    gz_bytes = os.path.getsize(gz_path)
    print(f'  Gzipped: {gz_path} ({gz_bytes/1024:.0f} KB)')

    # Write spawn.json — spawn above the surface near the centroid.
    # The simple centroid of all columns can land in empty space (e.g. a
    # void above a hollow map).  Instead, find the column nearest the
    # centroid that has a solid block at a "floor-like" height (20–35 game Y)
    # and spawn 2 blocks above it.
    if all_columns:
        cx = sum(wx for wx, wz in all_columns) / len(all_columns)
        cz = sum(wz for wx, wz in all_columns) / len(all_columns)
        # Gather columns with a reasonable floor height
        floor_cols = [
            (wx, wz, col)
            for (wx, wz), col in all_columns.items()
        ]
        # Find top_y for each
        def top_y(col):
            for y in range(len(col) - 1, -1, -1):
                if col[y] != 0:
                    return y
            return -1
        # Sort by distance to centroid, pick first one with top_y > 0
        floor_cols.sort(key=lambda t: (t[0] - cx) ** 2 + (t[1] - cz) ** 2)
        best_wx, best_wz, best_col = floor_cols[0]
        best_top = top_y(best_col)
        # If the nearest column is empty or underground, scan outward
        if best_top <= 0:
            for wx, wz, col in floor_cols[1:]:
                t = top_y(col)
                if t > 0:
                    best_wx, best_wz, best_top = wx, wz, t
                    break
        spawn_x = best_wx + 0.5
        spawn_z = best_wz + 0.5
        spawn_y = float(best_top + 2)
    else:
        spawn_x = (min_wx + max_wx) / 2.0
        spawn_z = (min_wz + max_wz) / 2.0
        spawn_y = float(MC_Y_MAX + MC_Y_OFFSET + 2)
    import json
    spawn_path = out_path.parent / 'spawn.json'
    with open(spawn_path, 'w') as f:
        json.dump({'x': spawn_x, 'y': spawn_y, 'z': spawn_z,
                   'note': f'MC Y range {MC_Y_MIN}..{MC_Y_MAX}, game Y 0..{GAME_HEIGHT-1}'}, f, indent=2)
    print(f'  Spawn: ({spawn_x:.1f}, {spawn_y:.1f}, {spawn_z:.1f})  →  {spawn_path}')
    print('Done!')
    return min_wx, min_wz

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Convert Minecraft world to lizard-minecraft binary')
    parser.add_argument('world_dir', nargs='?', default='/Users/mikelun/Downloads/world',
                        help='Path to Minecraft world directory')
    parser.add_argument('--ymin', type=int, default=None,
                        help='MC Y min (inclusive). Auto-detected if not given.')
    parser.add_argument('--ymax', type=int, default=None,
                        help='MC Y max (inclusive). Auto-detected if not given.')
    parser.add_argument('--pad', type=int, default=8,
                        help='Extra Y padding blocks above/below detected range (default 8)')
    args = parser.parse_args()

    out_dir = Path('/Users/mikelun/Work/lizard-minecraft/public/world')
    out_dir.mkdir(parents=True, exist_ok=True)
    convert(args.world_dir, out_dir / 'world.bin', args.ymin, args.ymax, args.pad)
