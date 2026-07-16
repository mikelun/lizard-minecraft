#!/usr/bin/env python3
"""
Extract and resolve Minecraft block models from the game jar.
Outputs pre-resolved model JSON files to public/mc/models/ so the
game can load them at runtime without needing the jar.

Usage:
  python3 scripts/extract_mc_models.py
  python3 scripts/extract_mc_models.py stairs slab trapdoor

Extracted JSON format:
  {
    "elements": [ ... ],     # resolved element array (from/to/faces)
    "textures":  { key: "/textures/blocks/<name>.png" }
  }
"""

import zipfile, json, os, sys, shutil, re

JAR = os.path.expanduser(
    '~/Library/Application Support/minecraft/versions/1.21.5/1.21.5.jar'
)
REPO_ROOT   = os.path.join(os.path.dirname(__file__), '..')
OUT_MODELS  = os.path.join(REPO_ROOT, 'public', 'mc', 'models')
OUT_TEXTURES = os.path.join(REPO_ROOT, 'public', 'mc', 'textures')

# Blocks to extract (mc block name -> output file stem).
# Add more as needed.
DEFAULT_BLOCKS = [
    'oak_stairs', 'oak_slab', 'oak_trapdoor',
    'stone_stairs', 'stone_slab',
    'cobblestone_stairs', 'cobblestone_slab',
    'stone_brick_stairs', 'stone_brick_slab',
    'sandstone_stairs', 'sandstone_slab',
    'smooth_stone_slab',
    'oak_fence', 'oak_fence_gate',
    'oak_door', 'oak_trapdoor',
    'lever', 'stone_button',
    'glass',
]

# ── jar helpers ───────────────────────────────────────────────────────────────

def jar_read(z: zipfile.ZipFile, path: str):
    try:
        return z.read(path)
    except KeyError:
        return None

def jar_json(z: zipfile.ZipFile, path: str):
    raw = jar_read(z, path)
    return json.loads(raw) if raw else None

# ── model resolution ──────────────────────────────────────────────────────────

def model_path(name: str) -> str:
    """'minecraft:block/stone' -> 'assets/minecraft/models/block/stone.json'"""
    if ':' in name:
        ns, rest = name.split(':', 1)
    else:
        ns, rest = 'minecraft', name
    return f'assets/{ns}/models/{rest}.json'

def resolve_model(z: zipfile.ZipFile, name: str, _seen=None) -> dict | None:
    """Load model and merge with parent chain (child overrides parent)."""
    if _seen is None:
        _seen = set()
    if name in _seen:
        return None
    _seen.add(name)

    data = jar_json(z, model_path(name))
    if data is None:
        return None

    if 'parent' in data:
        parent = resolve_model(z, data['parent'], _seen)
        if parent:
            merged = dict(parent)
            # child textures override parent
            if 'textures' in data:
                merged['textures'] = {**merged.get('textures', {}), **data['textures']}
            # child elements completely replace parent elements
            if 'elements' in data:
                merged['elements'] = data['elements']
            return merged

    return data

def resolve_tex_vars(textures: dict) -> dict:
    """Follow #ref chains until we reach a real texture path."""
    out = {}
    for k, v in textures.items():
        val, seen = v, set()
        while isinstance(val, str) and val.startswith('#') and val[1:] in textures:
            if val in seen:
                break
            seen.add(val)
            val = textures[val[1:]]
        out[k] = val
    return out

# ── texture path helpers ──────────────────────────────────────────────────────

def tex_ref_to_jar_path(ref: str) -> str:
    """'minecraft:block/stone' -> 'assets/minecraft/textures/block/stone.png'"""
    if ':' in ref:
        ns, rest = ref.split(':', 1)
    else:
        ns, rest = 'minecraft', ref
    return f'assets/{ns}/textures/{rest}.png'

def tex_ref_to_url(ref: str) -> str:
    """
    'minecraft:block/stone' -> '/mc/textures/block/stone.png'
    We store under /mc/textures/ preserving the namespace sub-path.
    """
    if ':' in ref:
        _, rest = ref.split(':', 1)
    else:
        rest = ref
    return f'/mc/textures/{rest}.png'

# ── extractor ─────────────────────────────────────────────────────────────────

def extract_block(z: zipfile.ZipFile, block_name: str):
    """
    Extract a block's resolved model.
    Returns dict with {elements, textures} or None on failure.
    """
    # Read blockstate to get model name
    bs = jar_json(z, f'assets/minecraft/blockstates/{block_name}.json')
    if bs is None:
        print(f'  [skip] no blockstate: {block_name}')
        return None

    # Pick the first variant / multipart apply
    model_ref = None
    if 'variants' in bs:
        first = list(bs['variants'].values())[0]
        if isinstance(first, list):
            first = first[0]
        model_ref = first.get('model')
    elif 'multipart' in bs:
        apply = bs['multipart'][0].get('apply', {})
        if isinstance(apply, list):
            apply = apply[0]
        model_ref = apply.get('model')

    if not model_ref:
        print(f'  [skip] no model ref: {block_name}')
        return None

    model = resolve_model(z, model_ref)
    if model is None:
        print(f'  [skip] could not resolve model: {model_ref}')
        return None

    if 'elements' not in model:
        print(f'  [skip] no elements: {block_name} ({model_ref})')
        return None

    # Resolve texture variables
    raw_textures = resolve_tex_vars(model.get('textures', {}))

    # Build {key -> URL} map and copy PNGs
    tex_urls = {}
    for key, ref in raw_textures.items():
        if ref.startswith('#'):
            continue  # unresolved variable — skip
        url = tex_ref_to_url(ref)
        tex_urls[key] = url

        # Copy PNG into public/mc/textures/
        jar_path = tex_ref_to_jar_path(ref)
        png_data = jar_read(z, jar_path)
        if png_data:
            dest = os.path.join(REPO_ROOT, 'public', url.lstrip('/'))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as f:
                f.write(png_data)

    return {
        'elements': model['elements'],
        'textures': tex_urls,
    }

# ── chest special case ────────────────────────────────────────────────────────
# The Minecraft chest uses an entity renderer (no block model elements).
# We create a synthetic block-model-style JSON matching its shape.

def write_chest_model():
    """
    Write a hand-authored chest model using the textures already in
    public/textures/blocks/ (chest_top.png, chest_side.png, chest_front.png).
    """
    model = {
        "textures": {
            "top":   "/textures/blocks/chest_top.png",
            "side":  "/textures/blocks/chest_side.png",
            "front": "/textures/blocks/chest_front.png"
        },
        "elements": [
            {
                "from": [1, 0, 1], "to": [15, 10, 15],
                "faces": {
                    "up":    {"uv": [0,0,14,14], "texture": "#top"},
                    "down":  {"uv": [0,0,14,14], "texture": "#top"},
                    "north": {"uv": [0,0,14,10], "texture": "#front"},
                    "south": {"uv": [0,0,14,10], "texture": "#side"},
                    "east":  {"uv": [0,0,14,10], "texture": "#side"},
                    "west":  {"uv": [0,0,14,10], "texture": "#side"}
                }
            },
            {
                "from": [1, 10, 1], "to": [15, 14, 15],
                "faces": {
                    "up":    {"uv": [0,0,14,14], "texture": "#top"},
                    "down":  {"uv": [0,0,14,14], "texture": "#top"},
                    "north": {"uv": [0,0,14, 4], "texture": "#front"},
                    "south": {"uv": [0,0,14, 4], "texture": "#side"},
                    "east":  {"uv": [0,0,14, 4], "texture": "#side"},
                    "west":  {"uv": [0,0,14, 4], "texture": "#side"}
                }
            }
        ]
    }
    dest = os.path.join(OUT_MODELS, 'chest.json')
    os.makedirs(OUT_MODELS, exist_ok=True)
    with open(dest, 'w') as f:
        json.dump(model, f, indent=2)
    print('  wrote chest.json (synthetic)')

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    blocks = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_BLOCKS

    os.makedirs(OUT_MODELS, exist_ok=True)
    os.makedirs(OUT_TEXTURES, exist_ok=True)

    # Always write the chest synthetic model
    write_chest_model()

    with zipfile.ZipFile(JAR) as z:
        for block in blocks:
            print(f'{block}:')
            result = extract_block(z, block)
            if result is None:
                continue
            dest = os.path.join(OUT_MODELS, f'{block}.json')
            with open(dest, 'w') as f:
                json.dump(result, f, indent=2)
            n_tex = len(result['textures'])
            n_el  = len(result['elements'])
            print(f'  -> {n_el} elements, {n_tex} textures -> {dest}')

    print('Done.')

if __name__ == '__main__':
    main()
