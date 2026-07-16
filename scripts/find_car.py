#!/usr/bin/env python3
"""
Find block_display entities that form a car in Minecraft MCA files.
"""

import struct
import zlib
import json
import os
import sys
import math
from pathlib import Path
from collections import defaultdict

# NBT tag types
TAG_END = 0
TAG_BYTE = 1
TAG_SHORT = 2
TAG_INT = 3
TAG_LONG = 4
TAG_FLOAT = 5
TAG_DOUBLE = 6
TAG_BYTE_ARRAY = 7
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10
TAG_INT_ARRAY = 11
TAG_LONG_ARRAY = 12


def read_nbt(data, pos=0):
    """Parse NBT data starting at pos, returns (value, new_pos)."""
    tag_type = data[pos]
    pos += 1
    if tag_type == TAG_END:
        return None, pos
    name, pos = read_nbt_string(data, pos)
    value, pos = read_nbt_payload(data, pos, tag_type)
    return {name: value, '_type': tag_type}, pos


def read_nbt_string(data, pos):
    length = struct.unpack_from('>H', data, pos)[0]
    pos += 2
    s = data[pos:pos+length].decode('utf-8', errors='replace')
    return s, pos + length


def read_nbt_payload(data, pos, tag_type):
    if tag_type == TAG_BYTE:
        return struct.unpack_from('>b', data, pos)[0], pos + 1
    elif tag_type == TAG_SHORT:
        return struct.unpack_from('>h', data, pos)[0], pos + 2
    elif tag_type == TAG_INT:
        return struct.unpack_from('>i', data, pos)[0], pos + 4
    elif tag_type == TAG_LONG:
        return struct.unpack_from('>q', data, pos)[0], pos + 8
    elif tag_type == TAG_FLOAT:
        return struct.unpack_from('>f', data, pos)[0], pos + 4
    elif tag_type == TAG_DOUBLE:
        return struct.unpack_from('>d', data, pos)[0], pos + 8
    elif tag_type == TAG_BYTE_ARRAY:
        length = struct.unpack_from('>i', data, pos)[0]
        pos += 4
        return list(data[pos:pos+length]), pos + length
    elif tag_type == TAG_STRING:
        return read_nbt_string(data, pos)
    elif tag_type == TAG_LIST:
        elem_type = data[pos]
        pos += 1
        length = struct.unpack_from('>i', data, pos)[0]
        pos += 4
        items = []
        for _ in range(length):
            val, pos = read_nbt_payload(data, pos, elem_type)
            items.append(val)
        return items, pos
    elif tag_type == TAG_COMPOUND:
        result = {}
        while True:
            tag_type2 = data[pos]
            pos += 1
            if tag_type2 == TAG_END:
                break
            name, pos = read_nbt_string(data, pos)
            value, pos = read_nbt_payload(data, pos, tag_type2)
            result[name] = value
        return result, pos
    elif tag_type == TAG_INT_ARRAY:
        length = struct.unpack_from('>i', data, pos)[0]
        pos += 4
        arr = list(struct.unpack_from(f'>{length}i', data, pos))
        return arr, pos + length * 4
    elif tag_type == TAG_LONG_ARRAY:
        length = struct.unpack_from('>i', data, pos)[0]
        pos += 4
        arr = list(struct.unpack_from(f'>{length}q', data, pos))
        return arr, pos + length * 8
    else:
        raise ValueError(f"Unknown tag type {tag_type} at pos {pos}")


def parse_mca(path):
    """Parse an MCA file and yield all entity NBT compounds."""
    with open(path, 'rb') as f:
        data = f.read()

    if len(data) < 8192:
        return

    entities = []
    for chunk_idx in range(1024):
        offset_entry = struct.unpack_from('>I', data, chunk_idx * 4)[0]
        offset = (offset_entry >> 8) * 4096
        sector_count = offset_entry & 0xFF
        if offset == 0 or sector_count == 0:
            continue

        try:
            length = struct.unpack_from('>I', data, offset)[0]
            compression = data[offset + 4]
            compressed = data[offset + 5: offset + 4 + length]

            if compression == 2:
                raw = zlib.decompress(compressed)
            elif compression == 1:
                import gzip
                raw = gzip.decompress(compressed)
            else:
                continue

            # Parse NBT
            tag_type = raw[0]
            if tag_type != TAG_COMPOUND:
                continue
            pos = 1
            name, pos = read_nbt_string(raw, pos)
            compound, pos = read_nbt_payload(raw, pos, TAG_COMPOUND)

            # Entity region files have 'Entities' key
            if 'Entities' in compound:
                for entity in compound['Entities']:
                    entities.append(entity)
        except Exception as e:
            pass  # Skip bad chunks

    return entities


def get_block_state(entity):
    """Extract block state name from a block_display entity."""
    bs = entity.get('block_state', {})
    if isinstance(bs, dict):
        name = bs.get('Name', '')
        return name
    return ''


def get_position(entity):
    """Get entity position as [x, y, z]."""
    pos = entity.get('Pos', [])
    if len(pos) >= 3:
        return [float(pos[0]), float(pos[1]), float(pos[2])]
    return None


def get_transform(entity):
    """Extract transformation data from entity."""
    transform = entity.get('transformation', {})
    if not transform:
        return None
    return {
        'translation': transform.get('translation', [0, 0, 0]),
        'left_rotation': transform.get('left_rotation', [0, 0, 0, 1]),
        'right_rotation': transform.get('right_rotation', [0, 0, 0, 1]),
        'scale': transform.get('scale', [1, 1, 1]),
    }


# Car-relevant block types
CAR_BLOCKS = {
    # Body
    'minecraft:white_concrete', 'minecraft:white_terracotta',
    'minecraft:white_wool', 'minecraft:white_concrete_powder',
    # Tires / trim
    'minecraft:black_concrete', 'minecraft:black_terracotta',
    'minecraft:black_concrete_powder', 'minecraft:black_wool',
    # Windows
    'minecraft:light_blue_concrete', 'minecraft:light_blue_glass',
    'minecraft:blue_stained_glass', 'minecraft:light_blue_stained_glass',
    'minecraft:light_blue_glass_pane', 'minecraft:blue_glass',
    'minecraft:blue_concrete',
    # Headlights
    'minecraft:yellow_concrete', 'minecraft:yellow_terracotta',
    'minecraft:orange_concrete', 'minecraft:orange_terracotta',
    'minecraft:yellow_stained_glass', 'minecraft:yellow_glazed_terracotta',
    # Body panels
    'minecraft:gray_concrete', 'minecraft:light_gray_concrete',
    'minecraft:gray_terracotta', 'minecraft:light_gray_terracotta',
    # Other common car materials
    'minecraft:iron_block', 'minecraft:quartz_block',
    'minecraft:smooth_quartz', 'minecraft:calcite',
    'minecraft:white_glazed_terracotta',
}


def cluster_entities(entities, max_dist=15):
    """Group entities into spatial clusters."""
    clusters = []
    used = [False] * len(entities)

    for i, e in enumerate(entities):
        if used[i]:
            continue
        pos_i = e['_pos']
        cluster = [i]
        used[i] = True
        for j, f in enumerate(entities):
            if used[j]:
                continue
            pos_j = f['_pos']
            dx = pos_i[0] - pos_j[0]
            dy = pos_i[1] - pos_j[1]
            dz = pos_i[2] - pos_j[2]
            dist = math.sqrt(dx*dx + dy*dy + dz*dz)
            if dist <= max_dist:
                cluster.append(j)
                used[j] = True
        clusters.append(cluster)

    return clusters


def score_cluster(indices, entities):
    """Score a cluster by car-block variety."""
    blocks = set()
    for idx in indices:
        block = entities[idx].get('_block', '')
        # Strip minecraft: prefix
        short = block.replace('minecraft:', '')
        # Count only car-relevant
        if block in CAR_BLOCKS:
            blocks.add(short)
    return len(blocks)


def main():
    world_dirs = [
        "/Users/mikelun/Downloads/world 2/entities/",
        "/Users/mikelun/Downloads/world/entities/",
    ]

    all_car_entities = []
    all_entities_by_block = defaultdict(list)

    for world_dir in world_dirs:
        if not os.path.isdir(world_dir):
            print(f"[SKIP] {world_dir} does not exist")
            continue

        mca_files = list(Path(world_dir).glob("*.mca"))
        print(f"\n=== Processing {world_dir} ({len(mca_files)} MCA files) ===")

        total_display = 0
        for mca_file in sorted(mca_files):
            entities = parse_mca(str(mca_file))
            if not entities:
                continue

            for entity in entities:
                eid = entity.get('id', '')
                if eid != 'minecraft:block_display':
                    continue
                total_display += 1

                block = get_block_state(entity)
                pos = get_position(entity)
                if pos is None:
                    continue

                all_entities_by_block[block].append(pos)

                if block in CAR_BLOCKS:
                    entity['_block'] = block
                    entity['_pos'] = pos
                    entity['_world'] = world_dir
                    all_car_entities.append(entity)

        print(f"  Total block_display entities: {total_display}")

    print(f"\n=== ALL BLOCK TYPES FOUND ===")
    for block, positions in sorted(all_entities_by_block.items(), key=lambda x: -len(x[1])):
        print(f"  {block}: {len(positions)} entities")

    print(f"\n=== CAR-RELEVANT BLOCKS ===")
    car_blocks_found = defaultdict(list)
    for e in all_car_entities:
        car_blocks_found[e['_block']].append(e['_pos'])

    for block, positions in sorted(car_blocks_found.items()):
        print(f"\n  {block}: {len(positions)} entities")
        for pos in positions[:50]:  # Show up to 50
            print(f"    [{pos[0]:.1f}, {pos[1]:.1f}, {pos[2]:.1f}]")
        if len(positions) > 50:
            print(f"    ... and {len(positions)-50} more")

    print(f"\n=== white_concrete positions ===")
    wc = car_blocks_found.get('minecraft:white_concrete', [])
    for p in wc:
        print(f"  [{p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f}]")

    print(f"\n=== black_concrete positions ===")
    bc = car_blocks_found.get('minecraft:black_concrete', [])
    for p in bc:
        print(f"  [{p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f}]")

    if not all_car_entities:
        print("\nNo car-like block_display entities found!")
        return

    print(f"\n=== CLUSTERING {len(all_car_entities)} car-like entities (max_dist=15) ===")
    clusters = cluster_entities(all_car_entities, max_dist=15)
    print(f"  Found {len(clusters)} clusters")

    for i, cluster in enumerate(sorted(clusters, key=lambda c: -len(c))):
        block_set = defaultdict(int)
        positions = []
        for idx in cluster:
            e = all_car_entities[idx]
            block_set[e['_block'].replace('minecraft:', '')] += 1
            positions.append(e['_pos'])

        xs = [p[0] for p in positions]
        ys = [p[1] for p in positions]
        zs = [p[2] for p in positions]
        cx = sum(xs)/len(xs)
        cy = sum(ys)/len(ys)
        cz = sum(zs)/len(zs)

        score = score_cluster(cluster, all_car_entities)
        print(f"\n  Cluster {i}: {len(cluster)} entities, score={score}, center=({cx:.1f},{cy:.1f},{cz:.1f})")
        for block, count in sorted(block_set.items()):
            print(f"    {block}: {count}")

    # Find best cluster
    best_cluster = max(clusters, key=lambda c: (score_cluster(c, all_car_entities), len(c)))
    print(f"\n=== BEST CLUSTER: {len(best_cluster)} entities ===")

    best_entities = [all_car_entities[idx] for idx in best_cluster]
    positions = [e['_pos'] for e in best_entities]
    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    zs = [p[2] for p in positions]
    min_x, min_y, min_z = min(xs), min(ys), min(zs)

    print(f"  Origin: [{min_x}, {min_y}, {min_z}]")
    print(f"  Bounding box: x=[{min_x:.1f},{max(xs):.1f}] y=[{min_y:.1f},{max(ys):.1f}] z=[{min_z:.1f},{max(zs):.1f}]")

    # Build output JSON
    output_entities = []
    for e in best_entities:
        pos = e['_pos']
        rx = pos[0] - min_x
        ry = pos[1] - min_y
        rz = pos[2] - min_z

        block = e.get('_block', '')
        transform = get_transform(e)
        if transform is None:
            transform = {
                'translation': [0, 0, 0],
                'left_rotation': [0, 0, 0, 1],
                'right_rotation': [0, 0, 0, 1],
                'scale': [1, 1, 1],
            }

        output_entities.append({
            'pos': [round(rx, 6), round(ry, 6), round(rz, 6)],
            'block': block,
            'transform': transform,
        })

    car_json = {
        'type': 'block_display_group',
        'origin': [min_x, min_y, min_z],
        'entities': output_entities,
    }

    out_path = '/Users/mikelun/Work/lizard-minecraft/public/mc/models/car.json'
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(car_json, f, indent=2)

    print(f"\n  Written to: {out_path}")

    # Summary
    block_counts = defaultdict(int)
    for e in best_entities:
        block_counts[e['_block'].replace('minecraft:', '')] += 1
    print(f"\n=== FINAL SUMMARY ===")
    print(f"  Total entities in car: {len(best_entities)}")
    print(f"  Block types:")
    for block, count in sorted(block_counts.items()):
        print(f"    {block}: {count}")


if __name__ == '__main__':
    main()
