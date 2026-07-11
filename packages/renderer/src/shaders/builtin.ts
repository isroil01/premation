/**
 * Built-in shader sources. Each provides WGSL (WebGPU) and GLSL ES 3.0 (WebGL2)
 * so a backend can pick the matching one. Geometry is a unit quad in [0,1]²;
 * per-object data (transform, color, uv, opacity) arrives via a uniform block.
 */

export interface ShaderSource {
  name: string;
  wgsl: string;
  glsl: { vertex: string; fragment: string };
}

const SOLID: ShaderSource = {
  name: 'solid',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  color : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

@vertex
fn vs(@location(0) pos : vec2<f32>) -> @builtin(position) vec4<f32> {
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  return vec4<f32>(p.xy, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(obj.color.rgb * obj.color.a, obj.color.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 color; };
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 color; };
out vec4 frag;
void main() {
  frag = vec4(color.rgb * color.a, color.a);
}
`,
  },
};

const TEXTURED: ShaderSource = {
  name: 'textured',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, 1.0);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv) * obj.tint;
  return vec4<f32>(c.rgb * c.a, c.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  frag = vec4(c.rgb * c.a, c.a);
}
`,
  },
};

export const BUILTIN_SHADERS: readonly ShaderSource[] = [SOLID, TEXTURED];
