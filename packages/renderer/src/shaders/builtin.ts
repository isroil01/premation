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

// Solid-colored quad with an optional SDF mask so shapes render with real
// geometry, not just flat rectangles. `shape` = (kind, radiusPx, worldW, worldH):
//   kind 0 = plain rect (alpha 1 — unchanged; used by masks & default solids)
//   kind 1 = rounded rect (isotropic rounded-box SDF in world px → circular corners)
//   kind 2 = ellipse inscribed in the box
// Edges are antialiased via screen-space derivatives (fwidth).
const SOLID: ShaderSource = {
  name: 'solid',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  color : vec4<f32>,
  shape : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, 1.0);
  o.local = pos;
  return o;
}

fn shapeAlpha(local : vec2<f32>) -> f32 {
  let kind = i32(obj.shape.x + 0.5);
  if (kind == 2) {
    let p = (local - vec2<f32>(0.5)) * 2.0;
    let d = length(p) - 1.0;
    let aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  if (kind == 1) {
    let r = obj.shape.y;
    let sz = obj.shape.zw;
    let p = (local - vec2<f32>(0.5)) * sz;
    let b = sz * 0.5 - r;
    let q = abs(p) - b;
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
    let aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  return 1.0;
}

@fragment
fn fs(@location(0) local : vec2<f32>) -> @location(0) vec4<f32> {
  let a = obj.color.a * shapeAlpha(local);
  return vec4<f32>(obj.color.rgb * a, a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 color; vec4 shape; };
out vec2 vLocal;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vLocal = pos;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 color; vec4 shape; };
in vec2 vLocal;
out vec4 frag;
float shapeAlpha(vec2 local) {
  int kind = int(shape.x + 0.5);
  if (kind == 2) {
    vec2 p = (local - 0.5) * 2.0;
    float d = length(p) - 1.0;
    float aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  if (kind == 1) {
    float r = shape.y;
    vec2 sz = shape.zw;
    vec2 p = (local - 0.5) * sz;
    vec2 b = sz * 0.5 - r;
    vec2 q = abs(p) - b;
    float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    float aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  return 1.0;
}
void main() {
  float a = color.a * shapeAlpha(vLocal);
  frag = vec4(color.rgb * a, a);
}
`,
  },
};

// Textured quad with an optional colour-grade transform (from colour effects):
// cr0/cr1/cr2 are the rows of `(M | offset)`, so graded.rgb = (dot(crᵢ, vec4(rgb,1)))
// — convention-free (no row/column-major transpose). Identity rows = no grade.
const TEXTURED: ShaderSource = {
  name: 'textured',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
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
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(graded * c.a, c.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  frag = vec4(graded * c.a, c.a);
}
`,
  },
};

const MASKED_TEXTURED: ShaderSource = {
  name: 'masked-textured',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var maskTex : texture_2d<f32>;

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
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  let maskAlpha = textureSample(maskTex, smp, uv).a;
  let a = c.a * maskAlpha;
  return vec4<f32>(graded * a, a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  float maskAlpha = texture(uMaskTex, vUv).a;
  float a = c.a * maskAlpha;
  frag = vec4(graded * a, a);
}
`,
  },
};

const BLUR: ShaderSource = {
  name: 'blur',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  blurParams : vec4<f32>,
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
  let r = obj.blurParams.z;
  if (r <= 0.0) {
    return textureSample(tex, smp, uv);
  }
  let dir = obj.blurParams.xy;
  var c = vec4<f32>(0.0);
  var total = 0.0;
  
  // Approximate Gaussian blur. For a large radius, a proper implementation would use
  // two passes and potentially downsampling, but this is a 2D exact-radius pass.
  let steps = min(i32(ceil(r)), 30);
  for(var i = -steps; i <= steps; i = i + 1) {
    let fi = f32(i);
    let w = exp(-0.5 * (fi * fi) / (r * r * 0.25));
    c = c + textureSample(tex, smp, uv + dir * fi) * w;
    total = total + w;
  }
  return c / total;
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 blurParams; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 blurParams; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  float r = blurParams.z;
  if (r <= 0.0) {
    frag = texture(uTex, vUv);
    return;
  }
  vec2 dir = blurParams.xy;
  vec4 c = vec4(0.0);
  float total = 0.0;
  
  int steps = min(int(ceil(r)), 30);
  for(int i = -steps; i <= steps; i++) {
    float fi = float(i);
    float w = exp(-0.5 * (fi * fi) / (r * r * 0.25));
    c += texture(uTex, vUv + dir * fi) * w;
    total += w;
  }
  frag = c / total;
}
`,
  },
};


export const GRADIENT_RAMP: ShaderSource = {
  name: 'gradient-ramp',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, colors: mat4x4<f32>, points: vec4<f32>, blend: f32 };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let p0 = obj.points.xy; let p1 = obj.points.zw;
  let dir = p1 - p0; let len2 = dot(dir, dir);
  let t = clamp(dot(uv - p0, dir) / max(len2, 0.0001), 0.0, 1.0);
  let rampColor = mix(obj.colors[0], obj.colors[1], t);
  let c = textureSample(tex, smp, uv);
  let outColor = mix(c.rgb, rampColor.rgb, rampColor.a * obj.blend);
  return vec4<f32>(outColor * c.a, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; mat4 colors; vec4 points; float blend; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; mat4 colors; vec4 points; float blend; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec2 p0 = points.xy; vec2 p1 = points.zw;
  vec2 dir = p1 - p0; float len2 = dot(dir, dir);
  float t = clamp(dot(vUv - p0, dir) / max(len2, 0.0001), 0.0, 1.0);
  vec4 rampColor = mix(colors[0], colors[1], t);
  vec4 c = texture(uTex, vUv);
  vec3 outColor = mix(c.rgb, rampColor.rgb, rampColor.a * blend);
  frag = vec4(outColor * c.a, c.a);
}
`
  }
};

export const FRACTAL_NOISE: ShaderSource = {
  name: 'fractal-noise',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn hash22(p: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(.1031, .1030, .0973));
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
fn perlin(p: vec2<f32>) -> f32 {
  let pi = floor(p); let pf = fract(p);
  let w = pf * pf * (3.0 - 2.0 * pf);
  return mix(
    mix(dot(hash22(pi + vec2<f32>(0.0, 0.0)), pf - vec2<f32>(0.0, 0.0)),
        dot(hash22(pi + vec2<f32>(1.0, 0.0)), pf - vec2<f32>(1.0, 0.0)), w.x),
    mix(dot(hash22(pi + vec2<f32>(0.0, 1.0)), pf - vec2<f32>(0.0, 1.0)),
        dot(hash22(pi + vec2<f32>(1.0, 1.0)), pf - vec2<f32>(1.0, 1.0)), w.x), w.y);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let scale = obj.params.x; let offset = obj.params.yz; let octaves = i32(obj.params.w);
  var n = 0.0; var amp = 0.5; var p = uv * scale + offset;
  for (var i = 0; i < 4; i = i + 1) {
    if (i >= octaves) { break; }
    n = n + perlin(p) * amp;
    p = p * 2.0; amp = amp * 0.5;
  }
  let c = textureSample(tex, smp, uv);
  n = n * 0.5 + 0.5;
  return vec4<f32>(vec3<f32>(n), 1.0) * c.a;
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
float perlin(vec2 p) {
  vec2 pi = floor(p); vec2 pf = fract(p);
  vec2 w = pf * pf * (3.0 - 2.0 * pf);
  return mix(
    mix(dot(hash22(pi + vec2(0.0, 0.0)), pf - vec2(0.0, 0.0)),
        dot(hash22(pi + vec2(1.0, 0.0)), pf - vec2(1.0, 0.0)), w.x),
    mix(dot(hash22(pi + vec2(0.0, 1.0)), pf - vec2(0.0, 1.0)),
        dot(hash22(pi + vec2(1.0, 1.0)), pf - vec2(1.0, 1.0)), w.x), w.y);
}
void main() {
  float scale = params.x; vec2 offset = params.yz; int octaves = int(params.w);
  float n = 0.0; float amp = 0.5; vec2 p = vUv * scale + offset;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    n += perlin(p) * amp;
    p *= 2.0; amp *= 0.5;
  }
  vec4 c = texture(uTex, vUv);
  n = n * 0.5 + 0.5;
  frag = vec4(vec3(n), 1.0) * c.a;
}
`
  }
};

export const DISPLACEMENT_MAP: ShaderSource = {
  name: 'displacement-map',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var mapTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mapC = textureSample(mapTex, smp, uv);
  let d = (mapC.rg - 0.5) * 2.0 * obj.params.xy;
  let nuv = clamp(uv + d, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSample(tex, smp, nuv);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
uniform sampler2D uMapTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 mapC = texture(uMapTex, vUv);
  vec2 d = (mapC.rg - 0.5) * 2.0 * params.xy;
  vec2 nuv = clamp(vUv + d, vec2(0.0), vec2(1.0));
  frag = texture(uTex, nuv);
}
`
  }
};

export const MOTION_TILE: ShaderSource = {
  name: 'motion-tile',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let scale = obj.params.xy; let offset = obj.params.zw;
  var p = uv * scale + offset;
  p = p - floor(p);
  return textureSample(tex, smp, p);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec2 scale = params.xy; vec2 offset = params.zw;
  vec2 p = vUv * scale + offset;
  p -= floor(p);
  frag = texture(uTex, p);
}
`
  }
};

export const BUILTIN_SHADERS: readonly ShaderSource[] = [SOLID, TEXTURED, MASKED_TEXTURED, BLUR, GRADIENT_RAMP, FRACTAL_NOISE, DISPLACEMENT_MAP, MOTION_TILE];
