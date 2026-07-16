#!/usr/bin/env python3
"""
Extract ALL block_display entities from world 2 MCA files.
Correctly handles passenger/riding stacks by reading Passengers recursively.

Passenger stacks: all entities share the root's MC position.
  → one object per stack; all entities at pos=[0,0,0]; group at root MC pos + MC_TO_GAME
Independent entities: each has its own MC position.
  → spatially clustered; entities at positions relative to cluster min

Outputs: public/mc/models/all_objects.json
"""

import struct, zlib, gzip, json, os, math
from pathlib import Path
from collections import defaultdict

# Only use world 2 (world and world 2 are identical copies; scanning both causes duplicates)
WORLD_DIR = "/Users/mikelun/Downloads/world 2/entities/"
OUT_PATH  = "/Users/mikelun/Work/lizard-minecraft/public/mc/models/all_objects.json"

# ── NBT parser ────────────────────────────────────────────────────────────────

TAG_END=0; TAG_BYTE=1; TAG_SHORT=2; TAG_INT=3; TAG_LONG=4
TAG_FLOAT=5; TAG_DOUBLE=6; TAG_BYTE_ARRAY=7; TAG_STRING=8
TAG_LIST=9; TAG_COMPOUND=10; TAG_INT_ARRAY=11; TAG_LONG_ARRAY=12

def _rns(data, pos):
    l = struct.unpack_from('>H', data, pos)[0]; pos += 2
    return data[pos:pos+l].decode('utf-8', errors='replace'), pos + l

def _rnp(data, pos, tag_type):
    if tag_type == TAG_BYTE:        return struct.unpack_from('>b', data, pos)[0], pos+1
    if tag_type == TAG_SHORT:       return struct.unpack_from('>h', data, pos)[0], pos+2
    if tag_type == TAG_INT:         return struct.unpack_from('>i', data, pos)[0], pos+4
    if tag_type == TAG_LONG:        return struct.unpack_from('>q', data, pos)[0], pos+8
    if tag_type == TAG_FLOAT:       return struct.unpack_from('>f', data, pos)[0], pos+4
    if tag_type == TAG_DOUBLE:      return struct.unpack_from('>d', data, pos)[0], pos+8
    if tag_type == TAG_BYTE_ARRAY:
        l = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return list(data[pos:pos+l]), pos + l
    if tag_type == TAG_STRING:      return _rns(data, pos)
    if tag_type == TAG_LIST:
        et = data[pos]; pos += 1
        l  = struct.unpack_from('>i', data, pos)[0]; pos += 4
        items = []
        for _ in range(l):
            v, pos = _rnp(data, pos, et); items.append(v)
        return items, pos
    if tag_type == TAG_COMPOUND:
        r = {}
        while True:
            t = data[pos]; pos += 1
            if t == TAG_END: break
            n, pos = _rns(data, pos)
            v, pos = _rnp(data, pos, t)
            r[n] = v
        return r, pos
    if tag_type == TAG_INT_ARRAY:
        l = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return list(struct.unpack_from(f'>{l}i', data, pos)), pos + l*4
    if tag_type == TAG_LONG_ARRAY:
        l = struct.unpack_from('>i', data, pos)[0]; pos += 4
        return list(struct.unpack_from(f'>{l}q', data, pos)), pos + l*8
    raise ValueError(f"Unknown NBT tag {tag_type}")

def parse_mca(path):
    """Return list of top-level entity NBT compounds from an MCA file."""
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 8192:
        return []
    result = []
    for ci in range(1024):
        oe  = struct.unpack_from('>I', data, ci*4)[0]
        off = (oe >> 8) * 4096
        sc  = oe & 0xFF
        if off == 0 or sc == 0:
            continue
        try:
            length = struct.unpack_from('>I', data, off)[0]
            ctype  = data[off + 4]
            raw_c  = data[off + 5: off + 4 + length]
            raw    = zlib.decompress(raw_c) if ctype == 2 else gzip.decompress(raw_c)
            if raw[0] != TAG_COMPOUND:
                continue
            p = 1
            _, p = _rns(raw, p)
            compound, p = _rnp(raw, p, TAG_COMPOUND)
            if 'Entities' in compound:
                result.extend(compound['Entities'])
        except Exception:
            pass
    return result

# ── entity helpers ────────────────────────────────────────────────────────────

def get_block(entity):
    bs = entity.get('block_state', {})
    if isinstance(bs, dict):
        n = bs.get('Name', '')
        return n[10:] if n.startswith('minecraft:') else n
    return ''

def get_pos(entity):
    p = entity.get('Pos', [])
    if len(p) >= 3:
        return [float(p[0]), float(p[1]), float(p[2])]
    return None

def get_transform(entity):
    t = entity.get('transformation', {})
    def fl(v, default):
        return [float(x) for x in v] if isinstance(v, (list, tuple)) else default
    return {
        'translation':    fl(t.get('translation',    [0, 0, 0]),    [0.0, 0.0, 0.0]),
        'left_rotation':  fl(t.get('left_rotation',  [0, 0, 0, 1]), [0.0, 0.0, 0.0, 1.0]),
        'right_rotation': fl(t.get('right_rotation', [0, 0, 0, 1]), [0.0, 0.0, 0.0, 1.0]),
        'scale':          fl(t.get('scale',          [1, 1, 1]),    [1.0, 1.0, 1.0]),
    }

def collect_passenger_stack(root, root_pos):
    """
    Recursively collect all block_display entities in the passenger chain
    rooted at `root`.  Returns a list of entity dicts, all assigned `root_pos`
    as their world position (since passengers share the mount's position).
    """
    stack = []
    def recurse(e):
        if e.get('id') != 'minecraft:block_display':
            return
        block = get_block(e)
        if not block or block == 'air':
            return
        transform = get_transform(e)
        scale = transform['scale']
        if scale[0] == 0 or scale[1] == 0 or scale[2] == 0:
            return
        stack.append({'block': block, 'transform': transform})
        for p in e.get('Passengers', []):
            recurse(p)
    recurse(root)
    return stack

# ── spatial clustering for independent entities ───────────────────────────────

def cluster_independent(entities, merge_dist=12.0):
    """
    Group entities that are spatially nearby.  Uses union-find on a 1-block grid.
    merge_dist: max distance (blocks) between position-grid cells to merge.
    """
    if not entities:
        return []

    # Snap to 1-block grid
    from collections import defaultdict
    grids = defaultdict(list)
    for e in entities:
        x, y, z = e['_pos']
        key = (round(x), round(y), round(z))
        grids[key].append(e)

    keys = list(grids.keys())
    n = len(keys)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    def union(a, b):
        a, b = find(a), find(b)
        if a != b: parent[a] = b

    for i in range(n):
        kx, ky, kz = keys[i]
        for j in range(i+1, n):
            if find(i) == find(j): continue
            jx, jy, jz = keys[j]
            if abs(kx-jx) > merge_dist or abs(ky-jy) > merge_dist or abs(kz-jz) > merge_dist:
                continue
            dist = math.sqrt((kx-jx)**2 + (ky-jy)**2 + (kz-jz)**2)
            if dist <= merge_dist:
                union(i, j)

    clusters = defaultdict(list)
    for i, key in enumerate(keys):
        clusters[find(i)].extend(grids[key])
    return list(clusters.values())

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    if not os.path.isdir(WORLD_DIR):
        print(f"[ERROR] World dir not found: {WORLD_DIR}")
        return

    mca_files = sorted(Path(WORLD_DIR).glob("*.mca"))
    print(f"Scanning {len(mca_files)} MCA files in {WORLD_DIR}")

    passenger_stacks = []   # list of (root_pos, [entity_dicts])
    independent      = []   # list of single entity dicts with _pos

    root_count   = 0
    stack_count  = 0
    indep_count  = 0

    for mca_file in mca_files:
        entities = parse_mca(str(mca_file))
        for root in entities:
            if root.get('id') != 'minecraft:block_display':
                continue
            root_count += 1
            root_pos = get_pos(root)
            if root_pos is None:
                continue

            if root.get('Passengers'):
                # Passenger stack: collect root + all descendants
                stack = collect_passenger_stack(root, root_pos)
                if stack:
                    passenger_stacks.append((root_pos, stack))
                    stack_count += 1
            else:
                # Truly independent entity
                block = get_block(root)
                if not block or block == 'air':
                    continue
                transform = get_transform(root)
                scale = transform['scale']
                if scale[0] == 0 or scale[1] == 0 or scale[2] == 0:
                    continue
                independent.append({
                    '_pos':      root_pos,
                    'block':     block,
                    'transform': transform,
                })
                indep_count += 1

    print(f"  Root entities: {root_count}")
    print(f"  Passenger stacks: {stack_count}")
    print(f"  Independent entities: {indep_count}")

    # Cluster independent entities spatially
    indep_clusters = cluster_independent(independent, merge_dist=12.0)
    print(f"  Independent clusters (merge_dist=12): {len(indep_clusters)}")

    # Build output objects list
    objects = []

    # 1) Passenger stacks — each stack is one object
    for i, (root_pos, stack_entities) in enumerate(passenger_stacks):
        entities_out = []
        for e in stack_entities:
            entities_out.append({
                'pos':       [0.0, 0.0, 0.0],
                'block':     e['block'],
                'transform': e['transform'],
            })
        objects.append({
            'id':           f'stack_{i}',
            'type':         'passenger_stack',
            'origin':       [round(root_pos[0], 4), round(root_pos[1], 4), round(root_pos[2], 4)],
            'entity_count': len(entities_out),
            'entities':     entities_out,
        })

    # 2) Independent entity clusters
    for i, cluster in enumerate(indep_clusters):
        positions = [e['_pos'] for e in cluster]
        xs = [p[0] for p in positions]
        ys = [p[1] for p in positions]
        zs = [p[2] for p in positions]
        origin = [min(xs), min(ys), min(zs)]

        entities_out = []
        for e in cluster:
            p = e['_pos']
            entities_out.append({
                'pos':       [round(p[0]-origin[0], 5), round(p[1]-origin[1], 5), round(p[2]-origin[2], 5)],
                'block':     e['block'],
                'transform': e['transform'],
            })
        objects.append({
            'id':           f'indep_{i}',
            'type':         'independent',
            'origin':       [round(origin[0], 4), round(origin[1], 4), round(origin[2], 4)],
            'entity_count': len(entities_out),
            'entities':     entities_out,
        })

    # Write output
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump({'objects': objects}, f, indent=2)

    total_entities = sum(o['entity_count'] for o in objects)
    print(f"\nOutput: {len(objects)} objects, {total_entities} entities total")
    print(f"  Passenger-stack objects: {stack_count}")
    print(f"  Independent clusters:    {len(indep_clusters)}")
    print(f"Written to: {OUT_PATH}")

    # Top objects by entity count
    top = sorted(objects, key=lambda o: -o['entity_count'])[:20]
    print(f"\nTop 20 by entity count:")
    for o in top:
        print(f"  {o['id']} [{o['type']}] @ {[round(x,1) for x in o['origin']]} entities={o['entity_count']}")


if __name__ == '__main__':
    main()
