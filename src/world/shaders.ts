export const vsChunk = `
layout (location = 0) in uint packed_data;
layout (location = 1) in uint packed_greedy;
layout (location = 2) in uint chunk_id;

uniform vec3 playerPos;
uniform sampler2D uChunkPositions;

int ao_id;
float x, y, z;
float greedy_w, greedy_h;
int flip_id;

out float vY;
flat out int face_id;
out float shading;
out vec2 vuv;
flat out int tex_id;
flat out int vertex_id;
out vec2 vWorldXZ;

const float face_shading[6] = float[6](
    1.0, 0.7,
    0.7, 0.9,
    0.7, 0.9
);

const float ao_values[4] = float[4](0.45, 0.6, 0.75, 1.0);

vec2 uv_coords[4] = vec2[4](
    vec2(0, 0), vec2(0, 1),
    vec2(1, 0), vec2(1, 1)
);

const int uv_indices[24] = int[24](
    1, 0, 2, 1, 2, 3,
    3, 0, 2, 3, 1, 0,
    3, 1, 0, 3, 0, 2,
    1, 2, 3, 1, 0, 2
);

void unpack(uint packed_data) {
    uint data = packed_data;

    uint x_mask = 31u, y_mask = 31u, z_mask = 31u, f_mask = 7u, a_mask = 3u, l_mask = 1u, t_mask = 255u, v_mask = 7u;
    uint vo_bit = 3u;
    uint tvo_bit = 11u;
    uint ltvo_bit = 12u;
    uint altvo_bit = 14u;
    uint faltvo_bit = 17u;
    uint zfaltvo_bit = 22u;
    uint yzfaltvo_bit = 27u;

    x = float((data >> yzfaltvo_bit) & x_mask);
    y = float((data >> zfaltvo_bit) & y_mask);
    z = float((data >> faltvo_bit) & z_mask);
    face_id = int((data >> altvo_bit) & f_mask);
    ao_id = int((data >> ltvo_bit) & a_mask);
    flip_id = int((data >> tvo_bit) & l_mask);
    tex_id = int((data >> vo_bit) & t_mask);
    vertex_id = int((data >> 0u) & v_mask);
}

void unpack_greedy() {
    greedy_w = float((packed_greedy >> 13u) & 127u);
    greedy_h = float((packed_greedy >> 6u) & 127u);
    x += float((packed_greedy >> 4u) & 3u) * 32.0;
    y += float((packed_greedy >> 2u) & 3u) * 32.0;
    z += float(packed_greedy & 3u) * 32.0;
}

void main() {
    unpack(packed_data);

    shading = face_shading[face_id] * ao_values[ao_id];
    int uv_index = vertex_id % 6 + ((face_id & 1) + flip_id * 2) * 6;

    vuv = uv_coords[uv_indices[uv_index]];

    unpack_greedy();
    vuv *= vec2(greedy_w, greedy_h);

    vec3 in_position = vec3(x, y, z);

    vec3 chunkWorldPos = texelFetch(uChunkPositions, ivec2(int(chunk_id), 0), 0).xyz;
    in_position += chunkWorldPos;

    // World XZ passed to fragment shader for per-pixel biome color
    vWorldXZ = vec2(in_position.x, in_position.z);

    vec4 posView = modelViewMatrix * vec4(in_position, 1.0);

    vec3 dir = normalize(in_position - playerPos);
    vY = dir.y;

    gl_Position = projectionMatrix * posView;
}
`;

export const fsChunk = `
in float shading;
flat in int face_id;
uniform sampler2DArray uTextureArray;
in vec2 vuv;
flat in int tex_id;
in vec2 vWorldXZ;

uniform float timeOfDay;

out vec4 fragColor;

// Tex layer indices — must match the Tex enum in blockTextures.ts
const int TEX_GRASS_TOP        = 0;
const int TEX_GRASS_SIDE       = 1;
const int TEX_LEAF             = 8;
const int TEX_CHERRY_LEAF      = 20;
const int TEX_LEAF_SOLID       = 21; // inner leaf face — same RGB, alpha forced to 1
const int TEX_CHERRY_LEAF_SOLID= 22;

// ---------------------------------------------------------------------------
// Value noise — integer hash, no lookup tables, works for any world position.
// Two independent seeds for temperature (2u) and humidity (3u), matching the
// offset pattern used in terrain.ts (SEED+2, SEED+3).
// ---------------------------------------------------------------------------
float hash2(uvec2 q, uint seed) {
    q += seed;
    q *= uvec2(1597334673u, 3812015801u);
    uint n = (q.x ^ q.y) * 2246822519u;
    n ^= n >> 13u;
    return float(n >> 8u) / 16777216.0; // [0, 1)
}

float valueNoise(vec2 p, uint seed) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep
    uvec2 iq = uvec2(ivec2(i));
    float a = hash2(iq,                  seed);
    float b = hash2(iq + uvec2(1u, 0u),  seed);
    float c = hash2(iq + uvec2(0u, 1u),  seed);
    float d = hash2(iq + uvec2(1u, 1u),  seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0; // [-1, 1]
}

// ---------------------------------------------------------------------------
// Mineways barycentric grass color from temperature + rainfall.
// Corners match biomes.cpp exactly.
// ---------------------------------------------------------------------------
vec3 barycentricGrass(float temp, float humid) {
    float t = clamp(temp  * 0.5 + 0.5, 0.0, 1.0);
    float r = clamp(humid * 0.5 + 0.5, 0.0, 1.0) * t; // rainfall *= temperature
    float l0 = t - r;
    float l1 = 1.0 - t;
    float l2 = r;
    vec3 c0 = vec3(191.0, 183.0,  85.0) / 255.0; // warm/dry
    vec3 c1 = vec3(128.0, 180.0, 151.0) / 255.0; // cool
    vec3 c2 = vec3( 71.0, 205.0,  51.0) / 255.0; // wet/lush
    return clamp(l0 * c0 + l1 * c1 + l2 * c2, 0.0, 1.0);
}

vec3 barycentricFoliage(float temp, float humid) {
    float t = clamp(temp  * 0.5 + 0.5, 0.0, 1.0);
    float r = clamp(humid * 0.5 + 0.5, 0.0, 1.0) * t;
    float l0 = t - r;
    float l1 = 1.0 - t;
    float l2 = r;
    vec3 c0 = vec3(174.0, 164.0,  42.0) / 255.0;
    vec3 c1 = vec3( 96.0, 161.0, 123.0) / 255.0;
    vec3 c2 = vec3( 26.0, 191.0,   0.0) / 255.0;
    return clamp(l0 * c0 + l1 * c1 + l2 * c2, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Biome weights — mirrors terrain.ts getBiomeWeights logic.
// ---------------------------------------------------------------------------
void getBiomeInfo(vec2 wxz, out float temp, out float humid, out float sakW) {
    temp  = valueNoise(wxz * 0.0018, 2u);
    humid = valueNoise(wxz * 0.0022, 3u);
    float rawSak = max(0.0, -temp)  * max(0.0,  humid) * 4.0;
    float rawDes = max(0.0,  temp)  * max(0.0, -humid) * 4.0;
    sakW = rawSak / (rawSak + rawDes + 1.0);
}

vec3 biomeGrassColor(vec2 wxz) {
    float temp, humid, sakW;
    getBiomeInfo(wxz, temp, humid, sakW);
    vec3 base = barycentricGrass(temp, humid);
    vec3 cherryGrass = vec3(182.0, 219.0, 97.0) / 255.0; // Cherry Grove #B6DB61
    return mix(base, cherryGrass, sakW);
}

vec3 biomeFoliageColor(vec2 wxz) {
    float temp, humid, sakW;
    getBiomeInfo(wxz, temp, humid, sakW);
    return barycentricFoliage(temp, humid);
}

float getTimeLighting(float timeOfDay) {
    float angle = timeOfDay * 6.2831853;
    float daylight = clamp(sin(angle) * 0.5 + 0.5, 0.3, 1.0);
    return daylight;
}

void main() {
    vec4 color = texture(uTextureArray, vec3(vuv, tex_id));

    if (tex_id == TEX_GRASS_TOP) {
        // grass_top.png is grayscale — multiply by per-pixel biome grass color
        color.rgb *= biomeGrassColor(vWorldXZ);
    } else if (tex_id == TEX_GRASS_SIDE) {
        // grass_side.tga: alpha channel marks the green strip (1=tintable, 0=dirt).
        // Tint only the green strip; dirt pixels pass through unchanged.
        vec3 biomeColor = biomeGrassColor(vWorldXZ);
        color.rgb = mix(color.rgb, color.rgb * biomeColor, color.a);
        color.a = 1.0;
    } else if (tex_id == TEX_LEAF) {
        color.rgb *= biomeFoliageColor(vWorldXZ);
        // keep TGA alpha → outer faces are alpha-tested by the discard below
    } else if (tex_id == TEX_LEAF_SOLID) {
        color.rgb *= biomeFoliageColor(vWorldXZ);
        color.a = 1.0; // inner leaf face — always solid
    } else if (tex_id == TEX_CHERRY_LEAF) {
        color.rgb *= vec3(1.0, 0.55, 0.72);
        // keep TGA alpha → outer faces are alpha-tested
    } else if (tex_id == TEX_CHERRY_LEAF_SOLID) {
        color.rgb *= vec3(1.0, 0.55, 0.72);
        color.a = 1.0; // inner leaf face — always solid
    }

    color.rgb *= shading;

    float dayLight = getTimeLighting(timeOfDay);
    color.rgb *= dayLight;

    if (color.a < 0.1) {
        discard;
    }
    fragColor = color;
}
`;
