// © 2026 lizard.build — All rights reserved.
// GeckoLib 1.12.0 model builder + animator for Three.js.
// Ported from public/pointblank-test.html working JS implementation.

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GeoDescription {
  texture_width: number;
  texture_height: number;
}

interface PerFaceUV {
  uv: [number, number];
  uv_size: [number, number];
}

interface GeoCube {
  origin: [number, number, number];
  size: [number, number, number];
  uv?: [number, number] | Partial<Record<"north" | "south" | "east" | "west" | "up" | "down", PerFaceUV>>;
  inflate?: number;
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  mirror?: boolean;
}

interface GeoBone {
  name: string;
  parent?: string;
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  mirror?: boolean;
  cubes?: GeoCube[];
}

interface GeoGeometry {
  description: GeoDescription;
  bones: GeoBone[];
}

interface GeoData {
  "minecraft:geometry": GeoGeometry[];
}

interface Keyframe {
  t: number;
  vec: [number, number, number];
  easing: string;
}

interface ParsedBone {
  rotation: Keyframe[] | null;
  position: Keyframe[] | null;
  scale: Keyframe[] | null;
}

interface ParsedAnim {
  length: number;
  loop: boolean;
  bones: Record<string, ParsedBone>;
}

interface AnimBoneData {
  rotation?: unknown;
  position?: unknown;
  scale?: unknown;
}

interface AnimEntry {
  animation_length?: number;
  loop?: boolean;
  bones?: Record<string, AnimBoneData>;
}

interface AnimData {
  animations: Record<string, AnimEntry>;
}

export interface GunModel {
  root: THREE.Group;
  boneGroups: Record<string, THREE.Group>;
}

// ─────────────────────────────────────────────────────────────────────────────
// UV helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps GeckoLib 1.12.0 box UV to Three.js BoxGeometry UV attribute.
 *
 * Implements Blockbench's exact algorithm (canvas.js face_order + cube.js updateUV).
 * Three.js BoxGeometry vertex order is identical to Blockbench's setShape for all 6 faces,
 * so UV slots map directly.
 *
 * Face regions in texture texels (Blockbench face_list, offset by [uOff, vOff]):
 *   East:  u=[uOff,          uOff+sz],         v=[vOff+sz, vOff+sz+sy]
 *   West:  u=[uOff+sz+sx,    uOff+2sz+sx],     v=[vOff+sz, vOff+sz+sy]
 *   Up:    u=[uOff+sz+sx,    uOff+sz],          v=[vOff+sz, vOff]       ← BOTH reversed
 *   Down:  u=[uOff+sz+2sx,   uOff+sz+sx],       v=[vOff,    vOff+sz]   ← U reversed
 *   South: u=[uOff+2sz+sx,   uOff+2sz+2sx],     v=[vOff+sz, vOff+sz+sy]
 *   North: u=[uOff+sz,       uOff+sz+sx],        v=[vOff+sz, vOff+sz+sy]
 */
export function setBoxUV(
  geo: THREE.BoxGeometry,
  uOff: number, vOff: number,
  sx: number, sy: number, sz: number,
  tw: number, th: number,
  mirror: boolean = false,
): void {
  const uvAttr = geo.getAttribute("uv") as THREE.BufferAttribute;
  const uvArr  = uvAttr.array as Float32Array;

  // [u0, v0, u1, v1] for each face in Three.js order (East, West, Up, Down, South, North)
  const F: [number, number, number, number][] = [
    [uOff,                  vOff + sz,      uOff + sz,              vOff + sz + sy], // East
    [uOff + sz + sx,        vOff + sz,      uOff + 2*sz + sx,       vOff + sz + sy], // West
    [uOff + sz + sx,        vOff + sz,      uOff + sz,              vOff],           // Up (both reversed)
    [uOff + sz + 2*sx,      vOff,           uOff + sz + sx,         vOff + sz],      // Down (U reversed)
    [uOff + 2*sz + sx,      vOff + sz,      uOff + 2*sz + 2*sx,    vOff + sz + sy], // South
    [uOff + sz,             vOff + sz,      uOff + sz + sx,         vOff + sz + sy], // North
  ];

  if (mirror) {
    // Flip U on every face: swap u0 ↔ u1
    for (const f of F) { const t = f[0]; f[0] = f[2]; f[2] = t; }
    // Then swap East (0) and West (1) entirely
    const [eu0, eu2] = [F[0][0], F[0][2]];
    F[0][0] = F[1][0]; F[0][2] = F[1][2];
    F[1][0] = eu0;     F[1][2] = eu2;
  }

  const M = 1 / 64; // Blockbench anti-bleeding margin (box UV only)

  for (let fi = 0; fi < 6; fi++) {
    let [u0, v0, u1, v1] = F[fi];
    // Pull each boundary inward by M, direction-aware
    if (u0 <= u1) { u0 += M; u1 -= M; } else { u0 -= M; u1 += M; }
    if (v0 <= v1) { v0 += M; v1 -= M; } else { v0 -= M; v1 += M; }
    // UV slot assignment matching Blockbench updateUV (canvas.js line 1399-1402):
    //   slot 0 = arr[0] = top-left (v0 = top of texture region)
    //   slot 2 = arr[1] = top-right
    //   slot 4 = arr[2] = bottom-left (v1 = bottom)
    //   slot 6 = arr[3] = bottom-right
    const b = fi * 8;
    uvArr[b + 0] = u0 / tw; uvArr[b + 1] = 1 - v0 / th; // top-left
    uvArr[b + 2] = u1 / tw; uvArr[b + 3] = 1 - v0 / th; // top-right
    uvArr[b + 4] = u0 / tw; uvArr[b + 5] = 1 - v1 / th; // bottom-left
    uvArr[b + 6] = u1 / tw; uvArr[b + 7] = 1 - v1 / th; // bottom-right
  }

  uvAttr.needsUpdate = true;
}

/**
 * Maps GeckoLib per-face UV (`{north: {uv, uv_size}, ...}`) to a Three.js
 * BoxGeometry UV attribute. Used by models exported with explicit per-face
 * texel rects (e.g. the player arm models) instead of the single [u,v]
 * box-UV corner.
 */
function setBoxUVPerFace(
  geo: THREE.BoxGeometry,
  uvSpec: Partial<Record<"north" | "south" | "east" | "west" | "up" | "down", PerFaceUV>>,
  tw: number, th: number,
  alphaData?: Uint8ClampedArray,
): void {
  const uvAttr  = geo.getAttribute("uv") as THREE.BufferAttribute;
  const uvArr   = uvAttr.array as Float32Array;
  const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
  const posArr  = posAttr.array as Float32Array;

  // Three.js BoxGeometry face order: +X(East), -X(West), +Y(Top/up), -Y(Bottom/down), +Z(South), -Z(North)
  const FACE_INDEX = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 } as const;

  const collapsePos = (fi: number) => {
    const pb = fi * 4 * 3;
    const x0 = posArr[pb], y0 = posArr[pb + 1], z0 = posArr[pb + 2];
    for (let v = 1; v < 4; v++) {
      posArr[pb + v * 3]     = x0;
      posArr[pb + v * 3 + 1] = y0;
      posArr[pb + v * 3 + 2] = z0;
    }
  };

  for (const faceName of Object.keys(FACE_INDEX) as (keyof typeof FACE_INDEX)[]) {
    const spec = uvSpec[faceName];
    const fi = FACE_INDEX[faceName];
    if (!spec) {
      // Bedrock geo files routinely omit faces that touch another cube and
      // are never visible (a texture-atlas-space optimization) — roughly 75%
      // of the M4A1's 1006 cubes have at least one omitted face. Leaving
      // Three.js's default box UV for that face samples an arbitrary, wrong
      // part of the texture (rather than "no face"), which alphaTest then
      // either discards as a visible hole or renders with the wrong color.
      // Collapse the face's 4 vertices to a single point instead — a
      // genuinely zero-area face, invisible regardless of texture content,
      // matching "this face doesn't exist" semantics exactly.
      collapsePos(fi);
      continue;
    }
    const [u0, v0] = spec.uv;
    const [w, h]   = spec.uv_size;
    const u1 = u0 + w, v1 = v0 + h;
    // If the specified UV region is also fully transparent, collapse it.
    if (alphaData) {
      const ix0 = Math.round(Math.min(u0, u1));
      const ix1 = Math.round(Math.max(u0, u1));
      const iy0 = Math.round(Math.min(v0, v1));
      const iy1 = Math.round(Math.max(v0, v1));
      let hasOpaque = false;
      outer: for (let y = iy0; y < iy1; y++) {
        for (let x = ix0; x < ix1; x++) {
          if (x >= 0 && x < tw && y >= 0 && y < th) {
            if (alphaData[(y * tw + x) * 4 + 3] > 12) { hasOpaque = true; break outer; }
          }
        }
      }
      if (!hasOpaque) { collapsePos(fi); continue; }
    }
    // No margin — Blockbench applies anti-bleeding only for box UV (1/64 texel),
    // never for per-face UV. Raw UV values used directly, matching Blockbench updateUV.
    const au0 = u0 / tw, au1 = u1 / tw;
    const av0 = 1 - v0 / th, av1 = 1 - v1 / th;
    const b = fi * 8;
    // Slot order matches Blockbench updateUV (canvas.js line 1399-1402):
    //   arr[0]=[u0,1-v0] → slot 0,1 (top);  arr[2]=[u0,1-v1] → slot 4,5 (bottom)
    uvArr[b + 0] = au0; uvArr[b + 1] = av0;
    uvArr[b + 2] = au1; uvArr[b + 3] = av0;
    uvArr[b + 4] = au0; uvArr[b + 5] = av1;
    uvArr[b + 6] = au1; uvArr[b + 7] = av1;
  }

  uvAttr.needsUpdate = true;
  posAttr.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry merge helpers (used by buildGeoModel to batch cubes per bone)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges an array of BufferGeometries (already transformed into bone-local
 * space via applyMatrix4) into one. Returns the single input unchanged when
 * there is only one, avoiding an unnecessary copy.
 */
function mergeGeoEntries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 1) return geos[0];

  const posArrs:  Float32Array[] = [];
  const normArrs: Float32Array[] = [];
  const uvArrs:   Float32Array[] = [];
  const idxParts: number[][] = [];
  let vertCount = 0;

  for (const g of geos) {
    const pos  = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const norm = (g.getAttribute("normal")   as THREE.BufferAttribute).array as Float32Array;
    const uv   = (g.getAttribute("uv")       as THREE.BufferAttribute).array as Float32Array;
    posArrs.push(pos);
    normArrs.push(norm);
    uvArrs.push(uv);
    const src = g.getIndex()!.array;
    const part: number[] = new Array(src.length);
    for (let i = 0; i < src.length; i++) part[i] = src[i] + vertCount;
    idxParts.push(part);
    vertCount += pos.length / 3;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(concatF32(posArrs),  3));
  out.setAttribute("normal",   new THREE.BufferAttribute(concatF32(normArrs), 3));
  out.setAttribute("uv",       new THREE.BufferAttribute(concatF32(uvArrs),   2));

  const totalIdx = idxParts.reduce((s, a) => s + a.length, 0);
  const IdxCtor  = vertCount > 65535 ? Uint32Array : Uint16Array;
  const idxOut   = new IdxCtor(totalIdx);
  let off = 0;
  for (const part of idxParts) for (const v of part) idxOut[off++] = v;
  out.setIndex(new THREE.BufferAttribute(idxOut, 1));

  return out;
}

function concatF32(arrays: Float32Array[]): Float32Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation key-frame helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseKeys(obj: unknown): Keyframe[] {
  // Normalise keyframe data to [{t, vec, easing}] sorted by time
  if (Array.isArray(obj)) {
    return [{ t: 0, vec: [...(obj as number[])] as [number, number, number], easing: "linear" }];
  }
  return Object.entries(obj as Record<string, unknown>)
    .map(([k, v]) => {
      const t = parseFloat(k);
      const entry = v as { vector?: unknown; post?: unknown; pre?: unknown; easing?: string } | unknown[];
      // Some TACZ animations use {post, lerp_mode} Catmull-Rom format — treat
      // `post` as the keyframe vector (the value at this timestamp as time exits).
      let vec: unknown = Array.isArray(entry)
        ? entry
        : (entry as { vector?: unknown; post?: unknown }).vector
          ?? (entry as { post?: unknown }).post
          ?? [0, 0, 0];
      if (!Array.isArray(vec)) vec = [0, 0, 0];
      const easing = Array.isArray(entry) ? "linear" : ((entry as { easing?: string }).easing ?? "linear");
      return { t, vec: [...(vec as number[])] as [number, number, number], easing };
    })
    .sort((a, b) => a.t - b.t);
}

function lerpFrames(frames: Keyframe[], time: number, loopLen: number): [number, number, number] {
  if (!frames || frames.length === 0) return [0, 0, 0];
  if (frames.length === 1) return [...frames[0].vec] as [number, number, number];
  const t = loopLen > 0 ? time % loopLen : time;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (t >= a.t && t <= b.t) {
      let alpha = (t - a.t) / (b.t - a.t);
      if      (b.easing === "easeInSine")    alpha = 1 - Math.cos(alpha * Math.PI / 2);
      else if (b.easing === "easeOutSine")   alpha = Math.sin(alpha * Math.PI / 2);
      else if (b.easing === "easeInOutSine") alpha = -(Math.cos(Math.PI * alpha) - 1) / 2;
      else if (b.easing === "easeInCubic")   alpha = alpha * alpha * alpha;
      else if (b.easing === "easeOutCubic")  alpha = 1 - Math.pow(1 - alpha, 3);
      return a.vec.map((v, i) => v + (b.vec[i] - v) * alpha) as [number, number, number];
    }
  }
  return [...frames[frames.length - 1].vec] as [number, number, number];
}

// ─────────────────────────────────────────────────────────────────────────────
// Model builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a GeckoLib `.geo.json` file and builds a Three.js scene graph.
 *
 * Coordinate system notes (verified against Blockbench's own bedrock.js
 * importer/exporter — the canonical implementation for this format, since
 * Blockbench IS the tool these files are authored and previewed in):
 * - GeckoLib bone/cube pivots are ABSOLUTE positions in model space. Only the
 *   X component is negated when converting to Three.js space (Bedrock→Three.js
 *   X flip); Y and Z pass through unchanged. Since that negation is applied
 *   uniformly to every raw coordinate and distributes linearly through
 *   subtraction, "child bone local X = -(childPivotX - parentPivotX)" while Y/Z
 *   stay as plain differences — i.e. negate the FINAL X delta, not each input.
 * - Rotation: negate X and Y components; Z is left UNCHANGED. Rotation order
 *   is 'ZYX' (Blockbench's default euler_order for this format).
 * - S defaults to 1/16 (one pixel = 1/16 block = standard Minecraft texel scale).
 *
 * @returns { root, boneGroups } — root is the scene-graph root Group;
 *   boneGroups maps bone name → its Three.js Group (for animation).
 */
export function buildGeoModel(
  geoData: GeoData,
  tex: THREE.Texture,
  S: number = 1 / 16,
  alphaData?: Uint8ClampedArray,
): GunModel {
  const g    = geoData["minecraft:geometry"][0];
  const desc = g.description;
  const tw   = desc.texture_width;
  const th   = desc.texture_height;

  // Index all bones by name
  const boneDefs: Record<string, GeoBone> = {};
  for (const b of g.bones) boneDefs[b.name] = b;

  const boneGroups: Record<string, THREE.Group> = {};
  const root = new THREE.Group();
  root.name  = "geckoRoot";

  // Create a Group per bone
  for (const name of Object.keys(boneDefs)) {
    boneGroups[name]      = new THREE.Group();
    boneGroups[name].name = name;
  }

  // One material shared by every cube in this model — all cubes use the same
  // texture atlas, and sharing a material instance lets Three.js avoid redundant
  // GL program switches and uniform uploads between bones.
  // Cutout render mode (alphaTest, no blending) keeps correct Z-buffer behaviour
  // for models with 1000+ cubes — transparent: true would put them all into
  // Three.js's distance-sorted queue which breaks per-pixel depth ordering.
  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    transparent: false,
    alphaTest: 0.05,
    side: THREE.DoubleSide,
  });

  const _scale1 = new THREE.Vector3(1, 1, 1); // reused for Matrix4.compose calls

  // Position each bone relative to its parent's pivot, add meshes
  for (const [name, bone] of Object.entries(boneDefs)) {
    const grp       = boneGroups[name];
    const pivot     = bone.pivot ?? [0, 0, 0];
    const parentPiv = bone.parent
      ? (boneDefs[bone.parent]?.pivot ?? [0, 0, 0])
      : [0, 0, 0];

    // GeckoLib pivots are absolute; local pos = (childPivot - parentPivot) * S,
    // with X negated (Bedrock→Three.js X flip; Y/Z unchanged — see file header).
    grp.position.set(
      -(pivot[0] - parentPiv[0]) * S,
      (pivot[1] - parentPiv[1]) * S,
      (pivot[2] - parentPiv[2]) * S,
    );

    // Static rest-pose bone rotation (separate from per-cube rotation and from
    // animation-driven rotation) — some rigs orient sub-parts (e.g. a sight ring
    // rotated 90°) this way in their bind pose. Same negate-X/Y-only, 'ZYX'-order
    // convention as everywhere else. ALWAYS stored as restRotation (defaulting to
    // zero when the bone has no static rotation) — GeckoAnimator adds animated
    // rotation deltas on top of this rest value (matching Blockbench's own
    // BoneAnimator, which applies both position AND rotation keyframes as
    // additive deltas over the rest pose, not as absolute replacements — see
    // GeckoAnimator.update()) rather than overwriting it outright, which would
    // silently discard this rest rotation on any bone an animation also touches.
    const rest: [number, number, number] = bone.rotation
      ? [
          THREE.MathUtils.degToRad(-bone.rotation[0]),
          THREE.MathUtils.degToRad(-bone.rotation[1]),
          THREE.MathUtils.degToRad(bone.rotation[2]),
        ]
      : [0, 0, 0];
    grp.rotation.order = "ZYX";
    grp.rotation.set(rest[0], rest[1], rest[2]);
    grp.userData.restRotation = rest;

    if (bone.parent && boneGroups[bone.parent]) {
      boneGroups[bone.parent].add(grp);
    } else {
      root.add(grp);
    }

    if (!bone.cubes) continue;

    // Collect all cube geometries for this bone, bake each cube's local-to-bone
    // transform into the vertex data, then merge them into one Mesh per bone.
    // This cuts draw calls from (total cubes across all bones) down to (total
    // bones with cubes) — a ~5-7× reduction for a typical gun model.
    const boneGeos: THREE.BufferGeometry[] = [];

    for (const cube of bone.cubes) {
      const [ox, oy, oz] = cube.origin;
      const [csx, csy, csz] = cube.size;
      const inf = cube.inflate ?? 0;
      const asx = (csx + 2 * inf) * S;
      const asy = (csy + 2 * inf) * S;
      const asz = (csz + 2 * inf) * S;

      const geo = new THREE.BoxGeometry(asx, asy, asz);
      if (cube.uv) {
        if (Array.isArray(cube.uv)) {
          const cubeMirror = cube.mirror !== undefined ? cube.mirror : (bone.mirror ?? false);
          setBoxUV(geo, cube.uv[0], cube.uv[1], csx, csy, csz, tw, th, cubeMirror);
        } else {
          setBoxUVPerFace(geo, cube.uv, tw, th, alphaData);
        }
      }

      // Compute the cube's matrix in bone-local space and bake it in.
      // inflate expands the box symmetrically — center stays at (ox+sx/2, oy+sy/2, oz+sz/2).
      let m4: THREE.Matrix4;
      if (cube.pivot && cube.rotation) {
        const cp  = cube.pivot;
        const rot = cube.rotation;
        // Pivot group: translation + ZYX rotation (same convention as bone rest-pose)
        const pgPos  = new THREE.Vector3(
          -(cp[0] - pivot[0]) * S,
          (cp[1] - pivot[1]) * S,
          (cp[2] - pivot[2]) * S,
        );
        const pgQuat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            THREE.MathUtils.degToRad(-rot[0]),
            THREE.MathUtils.degToRad(-rot[1]),
            THREE.MathUtils.degToRad(rot[2]),
            "ZYX",
          ),
        );
        m4 = new THREE.Matrix4().compose(pgPos, pgQuat, _scale1);
        // Right-multiply by the mesh's local translation inside the pivot group
        m4.multiply(
          new THREE.Matrix4().makeTranslation(
            -(ox + csx / 2 - cp[0]) * S,
            (oy + csy / 2 - cp[1]) * S,
            (oz + csz / 2 - cp[2]) * S,
          ),
        );
      } else {
        m4 = new THREE.Matrix4().makeTranslation(
          -(ox + csx / 2 - pivot[0]) * S,
          (oy + csy / 2 - pivot[1]) * S,
          (oz + csz / 2 - pivot[2]) * S,
        );
      }
      geo.applyMatrix4(m4);
      boneGeos.push(geo);
    }

    if (boneGeos.length > 0) {
      grp.add(new THREE.Mesh(mergeGeoEntries(boneGeos), mat));
    }
  }

  return { root, boneGroups };
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayerAnimator — applies only rotations from player_rifle animations to Steve
// ─────────────────────────────────────────────────────────────────────────────

// Base arm positions at animation t=0 (idle / start of every clip).
// Deltas from these are applied as scaled offsets in Three.js camera space.
const PLAYER_ARM_BASE_POS: Record<string, [number, number, number]> = {
  right_arm: [0.175, -1.325, 1.35],
  left_arm:  [-0.75, 0, -2],
};
const PLAYER_POS_SCALE = 0.08; // GeckoLib player units → Three.js camera units

/**
 * Applies GeckoLib player_rifle animations to Steve's skeleton.
 * Rotations are negated (GeckoLib→Three.js handedness flip).
 * Position deltas from the base idle pose are applied scaled by PLAYER_POS_SCALE,
 * with Z negated (GeckoLib +Z = toward player = Three.js −Z = toward camera).
 */
export class PlayerAnimator {
  private data:    Record<string, AnimEntry>;
  private bones:   Record<string, THREE.Group>;
  private current: ParsedAnim | null;
  private time:    number;
  private _parsed: Record<string, ParsedAnim>;

  constructor(animData: AnimData, boneGroups: Record<string, THREE.Group>) {
    this.data    = animData.animations;
    this.bones   = boneGroups;
    this.current = null;
    this.time    = 0;
    this._parsed = {};
  }

  private _parseAnim(name: string): ParsedAnim | null {
    if (this._parsed[name]) return this._parsed[name];
    const anim = this.data[name];
    if (!anim) return null;
    const parsed: ParsedAnim = {
      length: anim.animation_length ?? 1,
      loop: anim.loop ?? false,
      bones: {},
    };
    for (const [bname, bdata] of Object.entries(anim.bones ?? {})) {
      parsed.bones[bname] = {
        rotation: bdata.rotation ? parseKeys(bdata.rotation) : null,
        position: null, // position animation not used (arm positions are set via parenting)
        scale: null,
      };
    }
    this._parsed[name] = parsed;
    return parsed;
  }

  play(name: string): void {
    const full = "animation.model." + name;
    if (!this.data[full]) { console.warn("[PlayerAnimator] No animation:", full); return; }
    this.current = this._parseAnim(full);
    this.time    = 0;
  }

  update(dt: number): void {
    if (!this.current) return;
    this.time += dt;
    const { length, loop, bones } = this.current;
    const t = loop ? this.time % length : Math.min(this.time, length);
    for (const [bname, bdata] of Object.entries(bones)) {
      const grp = this.bones[bname];
      if (!grp || !bdata.rotation) continue;
      const [rx, ry, rz] = lerpFrames(bdata.rotation, t, loop ? length : 0);
      grp.rotation.order = "XYZ";
      grp.rotation.x = THREE.MathUtils.degToRad(-rx);
      grp.rotation.y = THREE.MathUtils.degToRad(-ry);
      grp.rotation.z = THREE.MathUtils.degToRad(-rz);

      // Apply position delta from base idle pose (only for bones with base defined).
      if (bdata.position) {
        const [px, py, pz] = lerpFrames(bdata.position, t, loop ? length : 0);
        const base = PLAYER_ARM_BASE_POS[bname];
        if (base) {
          grp.position.set(
            (px - base[0]) * PLAYER_POS_SCALE,
            (py - base[1]) * PLAYER_POS_SCALE,
            -(pz - base[2]) * PLAYER_POS_SCALE, // Z flip: GeckoLib +Z = toward player = Three.js −Z
          );
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GeckoAnimator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plays GeckoLib animations from a `.animation.json` file onto boneGroups.
 *
 * Rotation conversion: negate all three components (GeckoLib→Three.js)
 * because Z-axis flip inverts handedness. Rotation order: 'XYZ'.
 *
 * Position animation: px and py keep sign, pz is negated (Z-axis flip).
 * Base positions are read from `grp.userData.basePos` (set after buildGeoModel).
 */
export class GeckoAnimator {
  private data:       Record<string, AnimEntry>;
  private boneGroups: Record<string, THREE.Group>;
  private S:          number;
  private current:    ParsedAnim | null;
  private time:       number;
  private _parsed:    Record<string, ParsedAnim>;

  constructor(
    animData: AnimData,
    boneGroups: Record<string, THREE.Group>,
    S: number = 1 / 16,
  ) {
    this.data       = animData.animations;
    this.boneGroups = boneGroups;
    this.S          = S;
    this.current    = null;
    this.time       = 0;
    this._parsed    = {};
  }

  private _parseAnim(name: string): ParsedAnim | null {
    if (this._parsed[name]) return this._parsed[name];
    const anim = this.data[name];
    if (!anim) return null;
    const parsed: ParsedAnim = {
      length: anim.animation_length ?? 1,
      loop:   anim.loop ?? false,
      bones:  {},
    };
    for (const [bname, bdata] of Object.entries(anim.bones ?? {})) {
      parsed.bones[bname] = {
        rotation: bdata.rotation ? parseKeys(bdata.rotation) : null,
        position: bdata.position ? parseKeys(bdata.position) : null,
        scale:    bdata.scale    ? parseKeys(bdata.scale)    : null,
      };
    }
    this._parsed[name] = parsed;
    return parsed;
  }

  /**
   * Play animation by short name (e.g. 'idle', 'fire', 'reload', 'draw').
   * Tries the Point Blank-style "animation.model.<name>" key first, then
   * falls back to the bare name directly (TACZ's animation.json files key
   * animations as plain names like "static_idle", "shoot", with no prefix).
   *
   * `loopOverride` forces play/hold behavior regardless of the clip's own
   * `loop` flag, WITHOUT mutating the cached parsed animation (so other
   * callers still see its real loop value) — needed for clips like Point
   * Blank's "draw" (flagged loop:true in the JSON, but its actual keyframes
   * go from a dramatic holstered pose to a neutral rest pose once, not a
   * repeating sway; wrapping it via modulo snaps back to "holstered" every
   * cycle). Passing `false` here plays it once and holds the final frame.
   */
  play(name: string, loopOverride?: boolean): void {
    const prefixed = "animation.model." + name;
    const full = this.data[prefixed] ? prefixed : name;
    if (!this.data[full]) {
      console.warn("[GeckoAnimator] No animation:", name);
      return;
    }
    const parsed = this._parseAnim(full);
    const next = parsed && loopOverride !== undefined ? { ...parsed, loop: loopOverride } : parsed;
    // Reset bones that were in the previous animation but are absent in the new one.
    // Without this, e.g. rightarm would stay stuck at its last reload rotation when
    // switching back to idle (which has no rightarm keyframe).
    if (this.current && next) {
      for (const bname of Object.keys(this.current.bones)) {
        if (!next.bones[bname]) {
          const grp = this.boneGroups[bname];
          if (!grp) continue;
          const rest = grp.userData.restRotation as [number, number, number] | undefined;
          grp.rotation.order = "ZYX";
          grp.rotation.set(rest ? rest[0] : 0, rest ? rest[1] : 0, rest ? rest[2] : 0);
        }
      }
    }
    this.current = next;
    this.time    = 0;
  }

  /** Advance animation by dt seconds and apply to boneGroups. */
  update(dt: number): void {
    if (!this.current) return;
    this.time += dt;
    const { length, loop, bones } = this.current;
    const S = this.S;
    const t = loop
      ? this.time % length
      : Math.min(this.time, length);

    for (const [bname, bdata] of Object.entries(bones)) {
      const grp = this.boneGroups[bname];
      if (!grp) continue;

      if (bdata.rotation) {
        const [rx, ry, rz] = lerpFrames(bdata.rotation, t, loop ? length : 0);
        // GeckoLib→Three.js: negate X and Y only, Z unchanged (verified against
        // Blockbench's own bedrock.js importer/exporter — see buildGeoModel's
        // header comment). Added ON TOP of the bone's rest rotation, not
        // replacing it — matching Blockbench's own BoneAnimator, which applies
        // rotation keyframes as a delta over the rest pose (same treatment
        // position keyframes already get via basePos below). Replacing outright
        // silently discarded any static rest rotation (buildGeoModel's
        // restRotation) on bones an animation also touches — e.g. a rig where a
        // sight-ring bone has both a static 90° bind rotation AND animated
        // keyframes would render un-rotated, looking detached from the model.
        const rest = (grp.userData.restRotation as [number, number, number]) ?? [0, 0, 0];
        // Animated keyframe rotations use Euler order XYZ, NOT the ZYX order
        // Blockbench's bedrock.js uses for static bind-pose bone rotations —
        // these are two different systems (static parser vs. GeckoLib's runtime
        // animation player) and conflating them was a real bug: invisible for
        // this rig's static bones (none have a nonzero rest rotation) but wrong
        // for the animated righthand/lefthand bones, which carry a large
        // (~96°/9°/-179°) multi-axis rotation where order actually matters —
        // verified empirically (righthand_pos ends up in front of the camera
        // with XYZ, behind it with ZYX).
        grp.rotation.order = "XYZ";
        grp.rotation.x = rest[0] + THREE.MathUtils.degToRad(-rx);
        grp.rotation.y = rest[1] + THREE.MathUtils.degToRad(-ry);
        grp.rotation.z = rest[2] + THREE.MathUtils.degToRad(rz);
      }

      if (bdata.position && !grp.userData.ignoreGeckoPosition) {
        const [px, py, pz] = lerpFrames(bdata.position, t, loop ? length : 0);
        // X negated, Y/Z unchanged — same convention as buildGeoModel's pivots.
        const bp = (grp.userData.basePos as [number, number, number]) ?? [0, 0, 0];
        grp.position.set(
          bp[0] - px * S,
          bp[1] + py * S,
          bp[2] + pz * S,
        );
      }

      if (bdata.scale) {
        // Scale is a dimensionless multiplier (1 = unchanged) — no S conversion needed.
        const [sx, sy, sz] = lerpFrames(bdata.scale, t, loop ? length : 0);
        grp.scale.set(sx, sy, sz);
      }
    }
  }
}
