#!/usr/bin/env python3
"""Convert Minecraft 1.20.1 world to lizard-minecraft binary.

Output: public/world/world.bin
Format:
  Header (32 bytes):
    [0:8]   magic "MCBIN001"
    [8:12]  minX int32  (min world X coordinate)
    [12:16] minZ int32  (min world Z coordinate)
    [16:20] sizeX uint32 (number of columns in X)
    [20:24] sizeZ uint32 (number of columns in Z)
    [24:28] mcYOffset int32 (mc_y + mcYOffset = game_y, so for mc_y=-64 → 64)
    [28:32] gameHeight uint32 (Y levels stored per column)
  Offset table (sizeX * sizeZ * 4 bytes):
    uint32 per column. 0 = all-air column. Non-zero = byte offset into data section.
  Data section:
    For each non-empty column: gameHeight uint16 values (block IDs)
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
}

# Java block name → game BType value (0 = air)
BLOCK_MAP = {
    # air / invisible
    'minecraft:air': 0, 'minecraft:cave_air': 0, 'minecraft:void_air': 0,
    'minecraft:barrier': 0, 'minecraft:light': 0,
    'minecraft:redstone_wire': 0, 'minecraft:repeater': 0,
    'minecraft:chain': 0, 'minecraft:iron_bars': 0, 'minecraft:glass_pane': 0,
    'minecraft:tinted_glass': 0, 'minecraft:ladder': 0,
    'minecraft:torch': 0, 'minecraft:wall_torch': 0,
    'minecraft:tripwire': 0, 'minecraft:tripwire_hook': 0,
    'minecraft:oak_fence': 0, 'minecraft:oak_fence_gate': 0,
    'minecraft:oak_door': 0, 'minecraft:dark_oak_door': 0,
    'minecraft:iron_door': 0, 'minecraft:mangrove_door': 0, 'minecraft:warped_door': 0,
    'minecraft:oak_trapdoor': 0, 'minecraft:spruce_trapdoor': 0,
    'minecraft:iron_trapdoor': 0, 'minecraft:mangrove_trapdoor': 0,
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
    'minecraft:composter': 0, 'minecraft:chest': 0, 'minecraft:smoker': 0,
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
    'minecraft:polished_deepslate_slab': BTYPE['stone'],
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
    'minecraft:barrel': BTYPE['log'],
    'minecraft:note_block': BTYPE['planks'],
    # leaves → 7
    'minecraft:oak_leaves': BTYPE['leaf'],
    'minecraft:jungle_leaves': BTYPE['leaf'],
    # planks → 8
    'minecraft:oak_planks': BTYPE['planks'],
    'minecraft:spruce_planks': BTYPE['planks'],
    'minecraft:dark_oak_planks': BTYPE['planks'],
    'minecraft:oak_slab': BTYPE['planks'],
    'minecraft:oak_stairs': BTYPE['planks'],
    'minecraft:spruce_slab': BTYPE['planks'],
    'minecraft:crafting_table': BTYPE['planks'],
    # water → 9
    'minecraft:water': BTYPE['water'],
    'minecraft:water_cauldron': BTYPE['water'],
    # smooth_sandstone → 19 (covers cut/smooth/plain sandstone)
    'minecraft:cut_sandstone': BTYPE['smooth_sandstone'],
    'minecraft:cut_sandstone_slab': BTYPE['smooth_sandstone'],
    'minecraft:smooth_sandstone': BTYPE['smooth_sandstone'],
    'minecraft:smooth_sandstone_slab': BTYPE['smooth_sandstone'],
    'minecraft:smooth_sandstone_stairs': BTYPE['smooth_sandstone'],
    'minecraft:sandstone_stairs': BTYPE['sandstone'],
    'minecraft:sandstone_wall': BTYPE['sandstone'],
    'minecraft:sandstone': BTYPE['sandstone'],
    # white_concrete → 20
    'minecraft:white_concrete': BTYPE['white_concrete'],
    # smooth_red_sandstone → 21
    'minecraft:smooth_red_sandstone': BTYPE['smooth_red_sandstone'],
    'minecraft:smooth_red_sandstone_slab': BTYPE['smooth_red_sandstone'],
    'minecraft:smooth_red_sandstone_stairs': BTYPE['smooth_red_sandstone'],
    # smooth_stone → 22
    'minecraft:smooth_stone': BTYPE['smooth_stone'],
    'minecraft:smooth_stone_slab': BTYPE['smooth_stone'],
    # light_gray_concrete → 23
    'minecraft:light_gray_concrete': BTYPE['light_gray_concrete'],
    # yellow_terracotta → 24
    'minecraft:yellow_terracotta': BTYPE['yellow_terracotta'],
    # stone_bricks → 25
    'minecraft:stone_bricks': BTYPE['stone_bricks'],
    'minecraft:stone_brick_slab': BTYPE['stone_bricks'],
    'minecraft:stone_brick_wall': BTYPE['stone_bricks'],
    'minecraft:stone_stairs': BTYPE['stone_bricks'],
    # prismarine_bricks → 27
    'minecraft:prismarine_bricks': BTYPE['prismarine_bricks'],
    'minecraft:prismarine_brick_slab': BTYPE['prismarine_bricks'],
    'minecraft:prismarine_brick_stairs': BTYPE['prismarine_bricks'],
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
    'minecraft:cobblestone_stairs': BTYPE['cobblestone'],
    'minecraft:cobblestone_wall': BTYPE['cobblestone'],
    # bricks → 35
    'minecraft:bricks': BTYPE['bricks'],
    'minecraft:brick_stairs': BTYPE['bricks'],
    # misc solid → stone
    'minecraft:gray_glazed_terracotta': BTYPE['stone'],
    'minecraft:light_gray_glazed_terracotta': BTYPE['stone'],
    'minecraft:light_blue_concrete': BTYPE['white_concrete'],
    'minecraft:cyan_concrete_powder': BTYPE['cyan_terracotta'],
}

DEFAULT_SOLID = BTYPE['stone']  # fallback for unmapped solid blocks

MC_Y_MIN = -64  # MC Y of bedrock = game Y 0
MC_Y_MAX = -17  # MC Y top of map = game Y 47
GAME_HEIGHT = MC_Y_MAX - MC_Y_MIN + 1  # 48
MC_Y_OFFSET = -MC_Y_MIN  # 64: game_y = mc_y + 64

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

def extract_column(chunk, col_lx, col_lz):
    """Extract GAME_HEIGHT block IDs for one 1×GAME_HEIGHT×1 column in a chunk."""
    out = [0] * GAME_HEIGHT  # default air
    sections = chunk.get('sections', [])
    for sec in sections:
        sy = sec.get('Y', 0)
        mc_y_base = sy * 16
        # Only process sections that overlap our Y range
        if mc_y_base + 15 < MC_Y_MIN or mc_y_base > MC_Y_MAX:
            continue
        bs = sec.get('block_states', {})
        palette = bs.get('palette', [])
        if not palette:
            continue
        data_longs = bs.get('data', [])
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
            block_name = palette[palette_idx].get('Name', 'minecraft:air')
            btype = BLOCK_MAP.get(block_name)
            if btype is None:
                # Unmapped solid block → use default solid
                if block_name not in ('minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'):
                    btype = DEFAULT_SOLID
                else:
                    btype = 0
            out[game_y] = btype
    return out

# ── Main conversion ──────────────────────────────────────────────────────────
def convert(world_dir, out_path):
    world_dir = Path(world_dir)
    region_dir = world_dir / 'region'

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
        data_buf += struct.pack(f'<{GAME_HEIGHT}H', *col)

    with open(out_path, 'wb') as f:
        f.write(b'MCBIN001')                       # 8 bytes
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
    print('Done!')
    return min_wx, min_wz

if __name__ == '__main__':
    world_dir = '/Users/mikelun/Downloads/world'
    out_dir   = Path('/Users/mikelun/Work/lizard-minecraft/public/world')
    out_dir.mkdir(parents=True, exist_ok=True)
    convert(world_dir, out_dir / 'world.bin')
