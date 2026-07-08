// Adapted from escape-tsuami-client/src/game/map/Chunk/shaders.ts.
// Trimmed: dropped the USE_LIGHTING (torch) and USE_MODIFIED (mining-vertex
// overlay) preprocessor branches, which this project has no use for. Kept:
// packed-vertex unpacking, per-vertex AO shading, greedy-quad UV scaling,
// chunk-position texture lookup (so all chunks share one draw call), and the
// day/night sky tint used by the fragment shader.

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

const float face_shading[6] = float[6](
    1.0, 0.7,
    0.7, 0.9,
    0.7, 0.9
);

// Floor raised from the source's (0.15, 0.35, 0.5, 1.0): this shader has no
// real lights (scene AmbientLight/DirectionalLight don't reach a custom
// ShaderMaterial), so shading is entirely face_shading * ao_values * dayLight.
// At 0.15 the innermost corners of narrow terrain crevices (this world's
// heightmap has no caves, but steep noise can still carve 1-2 block slot
// canyons between adjacent columns) multiplied against a 0.7 side-face
// factor land near 0.1 brightness -- reads as solid black on screen, easily
// mistaken for a missing-geometry hole even though the mesh is intact.
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

uniform float timeOfDay;

in float vY;

out vec4 fragColor;

float getTimeLighting(float timeOfDay) {
    float angle = timeOfDay * 6.2831853;
    float daylight = clamp(sin(angle) * 0.5 + 0.5, 0.3, 1.0);
    return daylight;
}

void main() {
    vec4 color = texture(uTextureArray, vec3(vuv, tex_id));

    color.rgb *= shading;

    float dayLight = getTimeLighting(timeOfDay);
    color.rgb *= dayLight;

    if (color.a < 0.1) {
        discard;
    }
    fragColor = color;
}
`;
