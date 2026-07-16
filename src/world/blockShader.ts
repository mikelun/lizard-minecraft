/**
 * Shared ShaderMaterial factory for all custom block layers
 * (SlabLayer, StairLayer, CrossPostLayer, ChainBlockLayer, DoorLayer, AllObjectsLoader).
 *
 * Matches the terrain chunk shader's discrete face-direction shading exactly:
 *   face_shading[6] = { +X:1.0, -X:0.7, +Y:0.7, -Y:0.9, +Z:0.7, -Z:0.9 }
 *
 * World-space normals are used so rotated geometry (display entities) shades
 * correctly regardless of transform.  For layers whose mesh has an identity
 * model matrix (SlabLayer, StairLayer, etc.) mat3(modelMatrix)*normal = normal.
 *
 * Texture colorSpace must be THREE.NoColorSpace so the GPU samples raw sRGB
 * bytes, matching the DataArrayTexture behaviour of the terrain shader.
 */

import * as THREE from "three";

export const vsBlock = /* glsl */`
varying vec3 vWorldNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
#ifdef USE_INSTANCING
  // instanceMatrix: per-instance model transform provided by Three.js for InstancedMesh.
  // modelMatrix is identity (InstancedMesh has no base transform), so the instance
  // world matrix is just instanceMatrix.
  mat4 iModel = modelMatrix * instanceMatrix;
  // Normal matrix: transpose-inverse of the instance world matrix (handles non-uniform scale).
  vWorldNormal = normalize(transpose(inverse(mat3(iModel))) * normal);
  gl_Position  = projectionMatrix * viewMatrix * iModel * vec4(position, 1.0);
#else
  // normalMatrix = transpose(inverse(mat3(modelViewMatrix))).
  // Undo the view rotation to get world-space normals.
  vWorldNormal = normalize(mat3(transpose(viewMatrix)) * (normalMatrix * normal));
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#endif
}
`;

export const fsBlock = /* glsl */`
uniform sampler2D map;
varying vec3 vWorldNormal;
varying vec2 vUv;

// Matches face_shading[6] in shaders.ts (terrain chunk vertex shader).
// Face IDs from chunkMesh.worker.ts FACE_DEFS:
//   0=+Y(top):1.0  1=-Y(bot):0.7  2=+X:0.7  3=-X:0.9  4=-Z(N):0.7  5=+Z(S):0.9
float faceShading(vec3 n) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? 1.0 : 0.7;  // +Y:1.0  -Y:0.7
  if (a.x >= a.z)                return n.x > 0.0 ? 0.7 : 0.9;  // +X:0.7  -X:0.9
  return n.z > 0.0 ? 0.9 : 0.7;                                   // +Z:0.9  -Z:0.7
}

void main() {
  vec4 color = texture2D(map, vUv);
  if (color.a < 0.1) discard;
  color.rgb *= faceShading(normalize(vWorldNormal));
  gl_FragColor = color;
}
`;

// ── AO-aware shader variant ──────────────────────────────────────────────────
// Same as vsBlock/fsBlock but multiplies the face shading by a per-vertex AO
// value (attribute a_ao) that ranges 0.45–1.0, matching the terrain shader's
// ao_values[4] = {0.45, 0.6, 0.75, 1.0}.

export const vsBlockAO = /* glsl */`
attribute float a_ao;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vAO;
void main() {
  vWorldNormal = normalize(mat3(transpose(viewMatrix)) * (normalMatrix * normal));
  vUv = uv;
  vAO = a_ao;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fsBlockAO = /* glsl */`
uniform sampler2D map;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vAO;

float faceShading(vec3 n) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? 1.0 : 0.7;
  if (a.x >= a.z)                return n.x > 0.0 ? 0.7 : 0.9;
  return n.z > 0.0 ? 0.9 : 0.7;
}

void main() {
  vec4 color = texture2D(map, vUv);
  if (color.a < 0.1) discard;
  color.rgb *= faceShading(normalize(vWorldNormal)) * vAO;
  gl_FragColor = color;
}
`;

/**
 * Fragment shader for blocks with different side / top / bottom textures.
 * Uses the world-space normal to pick the right sampler, so a single
 * ShaderMaterial replaces the 6-element material array (which forces one
 * draw call per face group).  Works with USE_INSTANCING via vsBlock.
 */
export const fsDirBlock = /* glsl */`
uniform sampler2D mapSide;
uniform sampler2D mapTop;
uniform sampler2D mapBot;
varying vec3 vWorldNormal;
varying vec2 vUv;

float faceShading(vec3 n) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? 1.0 : 0.7;
  if (a.x >= a.z)                return n.x > 0.0 ? 0.7 : 0.9;
  return n.z > 0.0 ? 0.9 : 0.7;
}

void main() {
  vec3 a = abs(normalize(vWorldNormal));
  vec4 color;
  if (a.y >= a.x && a.y >= a.z)
    color = vWorldNormal.y > 0.0 ? texture2D(mapTop, vUv) : texture2D(mapBot, vUv);
  else
    color = texture2D(mapSide, vUv);
  if (color.a < 0.1) discard;
  color.rgb *= faceShading(normalize(vWorldNormal));
  gl_FragColor = color;
}
`;

const matCache = new Map<string, THREE.ShaderMaterial>();

/**
 * Returns a cached ShaderMaterial for the given texture path.
 * @param texPath  absolute URL (e.g. "/mc/textures/block/cut_sandstone.png")
 * @param opts.transparent  enable alpha blending (for glass, iron bars)
 * @param opts.doubleSide   render both faces (for thin geometry)
 */
export function makeBlockMat(
  texPath: string,
  opts: {
    transparent?:   boolean;
    doubleSide?:    boolean;
    polygonOffset?: boolean;
  } = {},
): THREE.ShaderMaterial {
  const key = `${texPath}|${opts.transparent}|${opts.doubleSide}|${opts.polygonOffset}`;
  if (matCache.has(key)) return matCache.get(key)!;

  const tex = new THREE.TextureLoader().load(texPath);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  // Must be NoColorSpace: DataArrayTexture (terrain) has no colorSpace so the
  // GPU treats it as raw sRGB bytes.  We do the same here for consistency.
  tex.colorSpace = THREE.NoColorSpace;

  const mat = new THREE.ShaderMaterial({
    vertexShader:   vsBlock,
    fragmentShader: fsBlock,
    uniforms: { map: { value: tex } },
    transparent: opts.transparent ?? false,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset:       opts.polygonOffset ?? false,
    polygonOffsetFactor: opts.polygonOffset ? -1 : 0,
    polygonOffsetUnits:  opts.polygonOffset ? -4 : 0,
  });
  matCache.set(key, mat);
  return mat;
}

const dirMatCache = new Map<string, THREE.ShaderMaterial>();

/**
 * Single-material replacement for the old 6-element dirMat array.
 * Uses fsDirBlock to pick side/top/bottom texture based on world-space normal,
 * so the mesh can be batched into a single InstancedMesh draw call.
 */
export function makeDirBlockMat(
  sidePath: string,
  topPath: string,
  botPath: string,
): THREE.ShaderMaterial {
  const key = `${sidePath}|${topPath}|${botPath}`;
  if (dirMatCache.has(key)) return dirMatCache.get(key)!;

  function tex(path: string) {
    const t = new THREE.TextureLoader().load(path);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: vsBlock,
    fragmentShader: fsDirBlock,
    uniforms: {
      mapSide: { value: tex(sidePath) },
      mapTop:  { value: tex(topPath) },
      mapBot:  { value: tex(botPath) },
    },
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits:  -4,
  });
  dirMatCache.set(key, mat);
  return mat;
}
