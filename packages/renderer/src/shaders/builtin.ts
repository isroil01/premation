/**
 * Built-in shader sources. Each provides WGSL (WebGPU) and GLSL ES 3.0 (WebGL2)
 * so a backend can pick the matching one. Geometry is a unit quad in [0,1]²;
 * per-object data (transform, color, uv, opacity) arrives via a uniform block.
 *
 * Every 2D vertex shader emits `gl_Position = vec4(p.xy, 0.0, p.z)` after
 * `p = mvp * vec3(pos, 1.0)` — it passes p.z as the homogeneous w rather than
 * hardcoding 1.0. This is the Corner Pin hook: when `mvp` is a projective matrix
 * (an affine layer matrix composed with a corner-pin homography) the hardware
 * divides x,y by w and interpolates the UV/local varyings PERSPECTIVE-CORRECTLY
 * for free. For every AFFINE mvp — which is every path that has no corner pin —
 * p.z is identically 1, so this is byte-for-byte the old `vec4(p.xy, 0.0, 1.0)`.
 * The 3D shaders keep their own mat4 path (mvp3dFor) untouched.
 */

export interface ShaderSource {
  name: string;
  wgsl: string;
  glsl: { vertex: string; fragment: string };
}

// Lives in its own file — it is the one shader long enough that inlining it
// here would bury everything else.
import { GLASS_COMPOSITE } from './glass';
export { GLASS_COMPOSITE };

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
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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

// Textured quad with a per-channel colour LUT (Levels / Curves / Posterize).
// After the affine grade, each channel is remapped through a 256×1 lookup
// texture: texel i packs (r_lut[i], g_lut[i], b_lut[i]). Sampling at U = value
// and taking the matching channel gives that channel's remapped output.
const LUT_TEXTURED: ShaderSource = {
  name: 'lut-textured',
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
@group(0) @binding(3) var lutTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv) * obj.tint;
  let v = vec4<f32>(c.rgb, 1.0);
  var graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  let lr = textureSample(lutTex, smp, vec2<f32>(graded.r, 0.5)).r;
  let lg = textureSample(lutTex, smp, vec2<f32>(graded.g, 0.5)).g;
  let lb = textureSample(lutTex, smp, vec2<f32>(graded.b, 0.5)).b;
  graded = vec3<f32>(lr, lg, lb);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
uniform sampler2D uTex;
uniform sampler2D uLutTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  float lr = texture(uLutTex, vec2(graded.r, 0.5)).r;
  float lg = texture(uLutTex, vec2(graded.g, 0.5)).g;
  float lb = texture(uLutTex, vec2(graded.b, 0.5)).b;
  graded = vec3(lr, lg, lb);
  frag = vec4(graded * c.a, c.a);
}
`,
  },
};

// Track matte combine: both the matted layer (uTex) and its matte source
// (uMatteTex) are rendered to full-comp targets, sampled here at the same
// screen uv. The matte value is the source's alpha (or luminance), optionally
// inverted — packed into cr0.x (luma flag) and cr0.y (invert flag). Output is
// premultiplied: the matted layer's premultiplied colour scaled by the matte.
const MATTE_COMBINE: ShaderSource = {
  name: 'matte-combine',
  wgsl: /* wgsl */ `
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = textureSample(tex, smp, uv);
  let s = textureSample(matteTex, smp, uv);
  let isLuma = obj.cr0.x > 0.5;
  let isInverted = obj.cr0.y > 0.5;
  var val : f32;
  if (isLuma) {
    let lumaVal = dot(s.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (isInverted) {
      val = (1.0 - lumaVal) * s.a;
    } else {
      val = lumaVal * s.a;
    }
  } else {
    if (isInverted) {
      val = 1.0 - s.a;
    } else {
      val = s.a;
    }
  }
  return vec4<f32>(m.rgb * val, m.a * val);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
uniform sampler2D uTex;
uniform sampler2D uMatteTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 m = texture(uTex, vUv);
  vec4 s = texture(uMatteTex, vUv);
  bool isLuma = cr0.x > 0.5;
  bool isInverted = cr0.y > 0.5;
  float val;
  if (isLuma) {
    float lumaVal = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    if (isInverted) {
      val = (1.0 - lumaVal) * s.a;
    } else {
      val = lumaVal * s.a;
    }
  } else {
    if (isInverted) {
      val = 1.0 - s.a;
    } else {
      val = s.a;
    }
  }
  frag = vec4(m.rgb * val, m.a * val);
}
`,
  },
};

// Advanced blend-mode combine. The layer (uTex, src) and the accumulated
// backdrop (uMaskTex, dst) are rendered to full-comp targets and sampled here;
// we compute the W3C blend B(cb,cs) in UNPREMULTIPLIED space then output the
// premultiplied source-over-with-blend composite. Mode id rides cr0.x:
// 1 multiply 2 screen 3 overlay 4 darken 5 lighten 6 color-dodge 7 color-burn
// 8 hard-light 9 soft-light 10 difference 11 exclusion 12 hue 13 saturation
// 14 color 15 luminosity.
/**
 * The Stencil / Silhouette coverage factor, in both dialects.
 *
 * Stencil keeps the backdrop where the matte layer is present; Silhouette is
 * its complement and cuts a hole. Alpha reads the layer's coverage; Luma reads
 * its brightness.
 *
 * Luma deliberately reads the PREMULTIPLIED rgb. Premultiplied luma is
 * alpha x colour-luma, so a fully transparent pixel weighs 0 — which is exactly
 * AE's "treat transparent areas as black" rule, obtained for free and without
 * an unpremultiply that would divide by zero on empty pixels.
 *
 * Kept as two strings rather than one because WGSL and GLSL are different
 * languages, but written together so the pair cannot drift: they are the same
 * four cases in the same order, and a render test compares their output.
 */
const MATTE_FACTOR_WGSL = /* wgsl */ `
fn matteFactor(mode : i32, s : vec4<f32>) -> f32 {
  if (mode == 31) { return clamp(s.a, 0.0, 1.0); }
  if (mode == 32) { return clamp(bLum(s.rgb), 0.0, 1.0); }
  if (mode == 33) { return clamp(1.0 - s.a, 0.0, 1.0); }
  return clamp(1.0 - bLum(s.rgb), 0.0, 1.0);
}
`;

const MATTE_FACTOR_GLSL = /* glsl */ `
float matteFactor(int mode, vec4 s) {
  if (mode == 31) return clamp(s.a, 0.0, 1.0);
  if (mode == 32) return clamp(bLum(s.rgb), 0.0, 1.0);
  if (mode == 33) return clamp(1.0 - s.a, 0.0, 1.0);
  return clamp(1.0 - bLum(s.rgb), 0.0, 1.0);
}
`;

const BLEND_COMBINE_GLSL_HELPERS = /* glsl */ `
float bChan(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;
  if (mode == 2) return cb + cs - cb * cs;
  if (mode == 3) return cb <= 0.5 ? 2.0 * cb * cs : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
  if (mode == 4) return min(cb, cs);
  if (mode == 5) return max(cb, cs);
  if (mode == 6) return cb <= 0.0 ? 0.0 : (cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs)));
  if (mode == 7) return cb >= 1.0 ? 1.0 : (cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs));
  if (mode == 8) return cs <= 0.5 ? 2.0 * cb * cs : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
  if (mode == 9) {
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb) : cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (mode == 10) return abs(cb - cs);
  if (mode == 11) return cb + cs - 2.0 * cb * cs;
  // ── M1 additions (16-26). Clamped where the formula can leave [0,1]. ──
  if (mode == 16) return clamp(cb + cs - 1.0, 0.0, 1.0);           // Linear Burn
  if (mode == 17) return clamp(cb + cs, 0.0, 1.0);                 // Linear Dodge
  if (mode == 18) return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0);     // Linear Light
  if (mode == 19) {                                                 // Vivid Light
    if (cs <= 0.5) { float d = 2.0 * cs; return d <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / d); }
    float d = 2.0 * (cs - 0.5);
    return d >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - d));
  }
  if (mode == 20) return cs <= 0.5 ? min(cb, 2.0 * cs) : max(cb, 2.0 * cs - 1.0); // Pin Light
  if (mode == 21) {                                                 // Hard Mix
    float v;
    if (cs <= 0.5) { float d = 2.0 * cs; v = d <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / d); }
    else { float d = 2.0 * (cs - 0.5); v = d >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - d)); }
    return v < 0.5 ? 0.0 : 1.0;
  }
  if (mode == 22) return clamp(cb - cs, 0.0, 1.0);                 // Subtract
  if (mode == 23) return cs <= 0.0 ? 1.0 : min(1.0, cb / cs);      // Divide
  // 24-26 are COMPATIBILITY ALIASES of Color Burn / Color Dodge / Difference.
  // They keep AE's mode names alive across import so a project round-trips, but
  // they are not distinct maths: the output clamp collapses the unclamped forms
  // back onto the modern ones. Verified by rendering both, not assumed. See F9.
  if (mode == 24) return clamp(1.0 - (1.0 - cb) / max(cs, 1e-6), 0.0, 1.0);  // Classic Color Burn
  if (mode == 25) return clamp(cb / max(1.0 - cs, 1e-6), 0.0, 1.0);          // Classic Color Dodge
  if (mode == 26) return abs(cb - cs);                             // Classic Difference
  return cs;
}
vec3 bSep(int mode, vec3 cb, vec3 cs) {
  return vec3(bChan(mode, cb.r, cs.r), bChan(mode, cb.g, cs.g), bChan(mode, cb.b, cs.b));
}
float bLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 bClip(vec3 c) {
  float l = bLum(c); float n = min(min(c.r, c.g), c.b); float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n + 1e-7);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l + 1e-7);
  return c;
}
vec3 bSetLum(vec3 c, float l) { return bClip(c + (l - bLum(c))); }
float bSat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 bSetSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b); float mx = max(max(c.r, c.g), c.b);
  return mx > mn ? (c - mn) / (mx - mn) * s : vec3(0.0);
}
vec3 bHSL(int mode, vec3 cb, vec3 cs) {
  if (mode == 12) return bSetLum(bSetSat(cs, bSat(cb)), bLum(cb));
  if (mode == 13) return bSetLum(bSetSat(cb, bSat(cs)), bLum(cb));
  if (mode == 14) return bSetLum(cs, bLum(cb));
  if (mode == 15) return bSetLum(cb, bLum(cs));
  // Darker/Lighter Color compare the WHOLE colour by luminance and pick one
  // outright — they never mix channels, which is why they cannot live in bChan.
  if (mode == 27) return bLum(cs) < bLum(cb) ? cs : cb;
  if (mode == 28) return bLum(cs) > bLum(cb) ? cs : cb;
  return cs;
}
${MATTE_FACTOR_GLSL}`;
const BLEND_COMBINE: ShaderSource = {
  name: 'blend-combine',
  wgsl: /* wgsl */ `
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var uMaskTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
fn bChan(mode : i32, cb : f32, cs : f32) -> f32 {
  if (mode == 1) { return cb * cs; }
  if (mode == 2) { return cb + cs - cb * cs; }
  if (mode == 3) { if (cb <= 0.5) { return 2.0 * cb * cs; } return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs); }
  if (mode == 4) { return min(cb, cs); }
  if (mode == 5) { return max(cb, cs); }
  if (mode == 6) { if (cb <= 0.0) { return 0.0; } if (cs >= 1.0) { return 1.0; } return min(1.0, cb / (1.0 - cs)); }
  if (mode == 7) { if (cb >= 1.0) { return 1.0; } if (cs <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - cb) / cs); }
  if (mode == 8) { if (cs <= 0.5) { return 2.0 * cb * cs; } return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs); }
  if (mode == 9) {
    var d : f32 = sqrt(cb);
    if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
    if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
    return cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (mode == 10) { return abs(cb - cs); }
  if (mode == 11) { return cb + cs - 2.0 * cb * cs; }
  // -- M1 additions (16-26). Clamped where the formula can leave [0,1]. --
  if (mode == 16) { return clamp(cb + cs - 1.0, 0.0, 1.0); }
  if (mode == 17) { return clamp(cb + cs, 0.0, 1.0); }
  if (mode == 18) { return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0); }
  if (mode == 19) {
    if (cs <= 0.5) {
      let d0 = 2.0 * cs;
      if (d0 <= 0.0) { return 0.0; }
      return 1.0 - min(1.0, (1.0 - cb) / d0);
    }
    let d1 = 2.0 * (cs - 0.5);
    if (d1 >= 1.0) { return 1.0; }
    return min(1.0, cb / (1.0 - d1));
  }
  if (mode == 20) {
    if (cs <= 0.5) { return min(cb, 2.0 * cs); }
    return max(cb, 2.0 * cs - 1.0);
  }
  if (mode == 21) {
    var v : f32;
    if (cs <= 0.5) {
      let d0 = 2.0 * cs;
      if (d0 <= 0.0) { v = 0.0; } else { v = 1.0 - min(1.0, (1.0 - cb) / d0); }
    } else {
      let d1 = 2.0 * (cs - 0.5);
      if (d1 >= 1.0) { v = 1.0; } else { v = min(1.0, cb / (1.0 - d1)); }
    }
    if (v < 0.5) { return 0.0; }
    return 1.0;
  }
  if (mode == 22) { return clamp(cb - cs, 0.0, 1.0); }
  if (mode == 23) { if (cs <= 0.0) { return 1.0; } return min(1.0, cb / cs); }
  if (mode == 24) { return clamp(1.0 - (1.0 - cb) / max(cs, 1e-6), 0.0, 1.0); }
  if (mode == 25) { return clamp(cb / max(1.0 - cs, 1e-6), 0.0, 1.0); }
  if (mode == 26) { return abs(cb - cs); }
  return cs;
}
fn bLum(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }
fn bClip(cin : vec3<f32>) -> vec3<f32> {
  var c = cin; let l = bLum(c); let n = min(min(c.r, c.g), c.b); let x = max(max(c.r, c.g), c.b);
  if (n < 0.0) { c = l + (c - l) * l / (l - n + 1e-7); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / (x - l + 1e-7); }
  return c;
}
fn bSetLum(c : vec3<f32>, l : f32) -> vec3<f32> { return bClip(c + (l - bLum(c))); }
fn bSat(c : vec3<f32>) -> f32 { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
fn bSetSat(c : vec3<f32>, s : f32) -> vec3<f32> {
  let mn = min(min(c.r, c.g), c.b); let mx = max(max(c.r, c.g), c.b);
  if (mx > mn) { return (c - mn) / (mx - mn) * s; }
  return vec3<f32>(0.0);
}
${MATTE_FACTOR_WGSL}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s = textureSample(tex, smp, uv);
  let d = textureSample(uMaskTex, smp, uv);
  let as1 = s.a; let ad = d.a;
  var cs = vec3<f32>(0.0); if (as1 > 0.0) { cs = s.rgb / as1; }
  var cb = vec3<f32>(0.0); if (ad > 0.0) { cb = d.rgb / ad; }
  let mode = i32(obj.cr0.x + 0.5);
  // Dispatch is by FAMILY, not by a >= threshold. The separable range is no
  // longer contiguous (1-11 and 16-26), so a bare mode >= 12 would have swept
  // every mode added after the HSL block into the non-separable branch.
  var B : vec3<f32>;
  if (mode >= 12 && mode <= 15) {
    if (mode == 12) { B = bSetLum(bSetSat(cs, bSat(cb)), bLum(cb)); }
    else if (mode == 13) { B = bSetLum(bSetSat(cb, bSat(cs)), bLum(cb)); }
    else if (mode == 14) { B = bSetLum(cs, bLum(cb)); }
    else { B = bSetLum(cb, bLum(cs)); }
  } else if (mode == 27) {
    if (bLum(cs) < bLum(cb)) { B = cs; } else { B = cb; }
  } else if (mode == 28) {
    if (bLum(cs) > bLum(cb)) { B = cs; } else { B = cb; }
  } else {
    B = vec3<f32>(bChan(mode, cb.r, cs.r), bChan(mode, cb.g, cs.g), bChan(mode, cb.b, cs.b));
  }
  var co = as1 * (1.0 - ad) * cs + as1 * ad * B + (1.0 - as1) * ad * cb;
  var ao = as1 + ad - as1 * ad;
  // ── Utility family (29-30): these write ALPHA, not just colour ──
  // They cannot be a bChan branch, because bChan only ever produces a blended
  // COLOUR that the standard Porter-Duff line above then composites. These two
  // change that line itself.
  if (mode == 29) {
    // Alpha Add. Standard alpha is as + ad - as*ad, which is exactly why two
    // touching anti-aliased 50% edges composite to 75% and leave a visible seam
    // down the join. Adding instead of union-ing closes it.
    ao = min(1.0, as1 + ad);
  } else if (mode == 30) {
    // Luminescent Premul. Treats the source as ALREADY premultiplied and adds it
    // rather than lerping, so colour that exceeds its own alpha is kept instead
    // of clipped — the glow/highlight case AE keeps this mode for.
    co = s.rgb + (1.0 - as1) * d.rgb;
  } else if (mode >= 31 && mode <= 34) {
    // ── Matte family (31-34): Stencil / Silhouette ──
    // Not blends. The layer contributes NO colour of its own; it scales the
    // coverage of the whole backdrop beneath it. So the output is the backdrop
    // times a factor, and the source appears only inside that factor.
    let k = matteFactor(mode, s);
    // Everything here is premultiplied, so scaling coverage means scaling all
    // four channels. Scaling alpha alone would leave colour behind where there
    // is no longer any coverage to carry it, which reads as a bright fringe.
    co = d.rgb * k;
    ao = ad * k;
  }
  // ── Preserve Underlying Transparency (cr0.y) ──
  // Independent of the blend mode, because it composes with every blend: the
  // layer is clipped to the coverage beneath it and may not ADD coverage.
  // source-atop, with the blended colour in place of the source colour:
  //     co = ad*( as*B + (1-as)*cb ),  ao = ad
  // The tempting shortcut — scale as by ad and keep the source-over line —
  // is wrong: at ad=0.5, as=1 it yields ao=0.75, so the layer adds opacity
  // exactly where it is meant to be clipped by it.
  // Not applied to the matte family (31-34): those contribute no colour of
  // their own and scale the whole backdrop, so "clip me to the backdrop" is not
  // a meaningful composition with them.
  if (obj.cr0.y > 0.5 && mode < 31) {
    co = ad * (as1 * B + (1.0 - as1) * cb);
    ao = ad;
  }
  return vec4<f32>(co, ao);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
in vec2 vUv;
out vec4 frag;
${BLEND_COMBINE_GLSL_HELPERS}
void main() {
  vec4 s = texture(uTex, vUv);
  vec4 d = texture(uMaskTex, vUv);
  float as1 = s.a, ad = d.a;
  vec3 cs = as1 > 0.0 ? s.rgb / as1 : vec3(0.0);
  vec3 cb = ad > 0.0 ? d.rgb / ad : vec3(0.0);
  int mode = int(cr0.x + 0.5);
  // Dispatch is by FAMILY, not by a >= threshold — the separable range is no
  // longer contiguous (1-11 and 16-26). Must match the WGSL branch above.
  bool nonSeparable = (mode >= 12 && mode <= 15) || mode == 27 || mode == 28;
  vec3 B = nonSeparable ? bHSL(mode, cb, cs) : bSep(mode, cb, cs);
  vec3 co = as1 * (1.0 - ad) * cs + as1 * ad * B + (1.0 - as1) * ad * cb;
  float ao = as1 + ad - as1 * ad;
  // Utility family (29-30): these write ALPHA, not just colour, so they change
  // the composite line itself rather than contributing a blended B.
  // Must match the WGSL branch above.
  if (mode == 29) {
    // Alpha Add — standard alpha (as + ad - as*ad) makes two touching
    // anti-aliased 50% edges composite to 75% and leave a seam. Adding closes it.
    ao = min(1.0, as1 + ad);
  } else if (mode == 30) {
    // Luminescent Premul — treat the source as already premultiplied and add,
    // keeping colour that exceeds its own alpha instead of clipping it.
    co = s.rgb + (1.0 - as1) * d.rgb;
  } else if (mode >= 31 && mode <= 34) {
    // Matte family (31-34): Stencil / Silhouette. The layer contributes no
    // colour; it scales the coverage of the whole backdrop beneath it.
    // Premultiplied throughout, so all four channels scale together — scaling
    // alpha alone would leave colour with no coverage to carry it.
    // Must match the WGSL branch above.
    float k = matteFactor(mode, s);
    co = d.rgb * k;
    ao = ad * k;
  }
  // ── Preserve Underlying Transparency (cr0.y) ──
  // Independent of the blend mode, because it composes with every blend: the
  // layer is clipped to the coverage beneath it and may not ADD coverage.
  // source-atop, with the blended colour in place of the source colour:
  //     co = ad*( as*B + (1-as)*cb ),  ao = ad
  // The tempting shortcut — scale as by ad and keep the source-over line —
  // is wrong: at ad=0.5, as=1 it yields ao=0.75, so the layer adds opacity
  // exactly where it is meant to be clipped by it.
  // Not applied to the matte family (31-34): those contribute no colour of
  // their own and scale the whole backdrop, so "clip me to the backdrop" is not
  // a meaningful composition with them.
  if (cr0.y > 0.5 && mode < 31) {
    co = ad * (as1 * B + (1.0 - as1) * cb);
    ao = ad;
  }
  frag = vec4(co, ao);
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
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
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

  // CSS blur semantics: the radius IS the Gaussian sigma (what Canvas2D's
  // filter uses, so both backends match). Taps span ±2.5σ; when that exceeds
  // the loop cap, taps spread out and linear filtering fills the gaps. The
  // old kernel used σ = r/2 truncated at ±r — visibly tighter than Canvas2D
  // at every radius (profiled: tail died 2–3× sooner).
  let sigma = r;
  let steps = 30;
  let spacing = max(1.0, (sigma * 2.5) / f32(steps));
  for(var i = -steps; i <= steps; i = i + 1) {
    let off = f32(i) * spacing;
    let w = exp(-0.5 * (off * off) / (sigma * sigma));
    c = c + textureSample(tex, smp, uv + dir * off) * w;
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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

  // CSS blur semantics: radius IS sigma (matches Canvas2D). ±2.5σ extent,
  // spaced taps under the loop cap — see the WGSL twin above.
  float sigma = r;
  const int steps = 30;
  float spacing = max(1.0, (sigma * 2.5) / float(steps));
  for(int i = -steps; i <= steps; i++) {
    float off = float(i) * spacing;
    float w = exp(-0.5 * (off * off) / (sigma * sigma));
    c += texture(uTex, vUv + dir * off) * w;
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
  // c.rgb is premultiplied; unpremultiply before mixing with straight rampColor,
  // then re-premultiply once so the output stays premultiplied.
  let straight = select(c.rgb / c.a, vec3<f32>(0.0), c.a == 0.0);
  let outColor = mix(straight, rampColor.rgb, rampColor.a * obj.blend);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  // c.rgb is premultiplied; unpremultiply before mixing with straight rampColor,
  // then re-premultiply once so the output stays premultiplied.
  vec3 straight = (c.a > 0.0) ? c.rgb / c.a : vec3(0.0);
  vec3 outColor = mix(straight, rampColor.rgb, rampColor.a * blend);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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

/**
 * Apply Color LUT — a 3D `.cube` lookup, on the GPU.
 *
 * The fourth member of the read-a-second-texture family. The second texture is
 * not another layer this time; it is the LUT itself, packed as a STRIP.
 *
 * ── Why a strip, and what it costs ──────────────────────────────────────────
 *
 * WebGPU has 3D textures and WebGL2 has them too, but nothing else in this
 * renderer allocates one and the backend abstraction has no 3D texture path. A
 * cube of edge N is therefore laid out as N slices of N×N side by side: width
 * N², height N. Slice z occupies x ∈ [z·N, (z+1)·N).
 *
 * The cost is that a LINEAR sampler does not know where a slice ends. Sampling
 * near x = z·N blends into slice z−1, which is a completely different blue
 * value — visible as banded fringing on smooth gradients. So the horizontal
 * coordinate is clamped to half a texel inside its own slice and the blue axis
 * is interpolated MANUALLY between two slice samples. Red and green still ride
 * the hardware's bilinear filter, which is the whole point of doing this on the
 * GPU rather than per pixel on the CPU.
 *
 * params.x — cube edge length N
 * params.y — 1 when the LUT is 1D (a strip of N×1, no blue axis to walk)
 * params.zw — domain min and max, applied to all three channels
 *
 * ── Premultiplied in, premultiplied out ─────────────────────────────────────
 *
 * A LUT is defined on straight colour, and this pipeline carries premultiplied.
 * The shader un-premultiplies before the lookup and re-premultiplies after —
 * skipping that grades the colour a transparent pixel does not have, and turns
 * a soft edge into a fringe of whatever the LUT maps black to.
 */
export const APPLY_COLOR_LUT: ShaderSource = {
  name: 'apply-color-lut',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var lutTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn sliceSample(rg : vec2<f32>, slice : f32, n : f32) -> vec3<f32> {
  // Half a texel in from each end of THIS slice, so the linear filter cannot
  // reach the neighbouring slice's very different blue.
  let xIn = clamp(rg.x * (n - 1.0) + 0.5, 0.5, n - 0.5);
  let u = (slice * n + xIn) / (n * n);
  let v = clamp(rg.y * (n - 1.0) + 0.5, 0.5, n - 0.5) / n;
  return textureSampleLevel(lutTex, smp, vec2<f32>(u, v), 0.0).rgb;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  if (src.a <= 0.0001) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  // Straight colour for the lookup; premultiplied again at the end.
  let straight = clamp(src.rgb / src.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let lo = obj.params.z;
  let hi = obj.params.w;
  let span = max(hi - lo, 0.0001);
  let c = clamp((straight - vec3<f32>(lo)) / span, vec3<f32>(0.0), vec3<f32>(1.0));
  let n = obj.params.x;
  var graded : vec3<f32>;
  if (obj.params.y > 0.5) {
    // 1D: one texel row, each channel looked up independently.
    let w = n;
    let rr = textureSampleLevel(lutTex, smp, vec2<f32>((c.r * (w - 1.0) + 0.5) / w, 0.5), 0.0).r;
    let gg = textureSampleLevel(lutTex, smp, vec2<f32>((c.g * (w - 1.0) + 0.5) / w, 0.5), 0.0).g;
    let bb = textureSampleLevel(lutTex, smp, vec2<f32>((c.b * (w - 1.0) + 0.5) / w, 0.5), 0.0).b;
    graded = vec3<f32>(rr, gg, bb);
  } else {
    let bz = c.b * (n - 1.0);
    let z0 = floor(bz);
    let z1 = min(z0 + 1.0, n - 1.0);
    let f = bz - z0;
    graded = mix(sliceSample(c.rg, z0, n), sliceSample(c.rg, z1, n), f);
  }
  return vec4<f32>(graded * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
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
vec3 sliceSample(vec2 rg, float slice, float n) {
  float xIn = clamp(rg.x * (n - 1.0) + 0.5, 0.5, n - 0.5);
  float u = (slice * n + xIn) / (n * n);
  float v = clamp(rg.y * (n - 1.0) + 0.5, 0.5, n - 0.5) / n;
  return textureLod(uMapTex, vec2(u, v), 0.0).rgb;
}
void main() {
  vec4 src = texture(uTex, vUv);
  if (src.a <= 0.0001) { frag = vec4(0.0); return; }
  vec3 straight = clamp(src.rgb / src.a, 0.0, 1.0);
  float lo = params.z;
  float hi = params.w;
  float span = max(hi - lo, 0.0001);
  vec3 c = clamp((straight - vec3(lo)) / span, 0.0, 1.0);
  float n = params.x;
  vec3 graded;
  if (params.y > 0.5) {
    float w = n;
    float rr = textureLod(uMapTex, vec2((c.r * (w - 1.0) + 0.5) / w, 0.5), 0.0).r;
    float gg = textureLod(uMapTex, vec2((c.g * (w - 1.0) + 0.5) / w, 0.5), 0.0).g;
    float bb = textureLod(uMapTex, vec2((c.b * (w - 1.0) + 0.5) / w, 0.5), 0.0).b;
    graded = vec3(rr, gg, bb);
  } else {
    float bz = c.b * (n - 1.0);
    float z0 = floor(bz);
    float z1 = min(z0 + 1.0, n - 1.0);
    float f = bz - z0;
    graded = mix(sliceSample(c.rg, z0, n), sliceSample(c.rg, z1, n), f);
  }
  frag = vec4(graded * src.a, src.a);
}
`
  }
};

/**
 * Compound Blur — blur this layer by ANOTHER layer's luminance.
 *
 * The third member of the read-a-second-layer family, after `displacement-map`
 * and `set-matte`: same shape (a second texture at binding 3, sampled with the
 * SAME target UV so orientation matches on both backends), different
 * arithmetic. Following that shape is deliberate — it is the established route
 * for an effect that reads another layer, and it inherits UV handling that took
 * real work to get right.
 *
 * params.x — max blur radius, in TEXELS of this target
 * params.y — 1 inverts the map (bright areas sharp instead of blurred)
 * params.zw — one texel, so the taps can step in uv space
 *
 * ── Why one pass with a scaled kernel, not a separable blur ─────────────────
 *
 * A separable Gaussian is two passes with a SHARED radius, and the whole point
 * of this effect is that the radius differs per pixel. There is no pair of 1D
 * passes that produces a spatially varying kernel — the horizontal pass would
 * have to know the vertical pass's radius at a neighbour it has not blurred yet.
 *
 * So this samples a fixed 13-tap rosette whose SPACING scales with the local
 * radius. Cost is constant; quality degrades at large radii into a slightly
 * ringed blur rather than a smooth one, which is the standard trade and is what
 * "Max Blur" being a ceiling rather than a promise means.
 *
 * The taps are a golden-angle spiral, not a grid. A grid at low tap counts
 * produces visible axis-aligned banding on soft gradients; a spiral spreads the
 * same 13 samples so the error looks like grain instead of structure.
 */
export const COMPOUND_BLUR: ShaderSource = {
  name: 'compound-blur',
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
  // Rec.709 luma. The map's own ALPHA is ignored on purpose: AE reads a
  // luminance map, and an unpremultiplied read would make a transparent map
  // blur by whatever colour happened to sit behind it.
  var lum = dot(mapC.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (obj.params.y > 0.5) { lum = 1.0 - lum; }
  let radius = obj.params.x * clamp(lum, 0.0, 1.0);
  let c0 = textureSample(tex, smp, uv);
  // Below a third of a texel the rosette collapses onto the centre and the
  // taps are 13 copies of one sample — cheaper and exact to return it.
  if (radius < 0.34) { return c0; }
  var acc = c0;
  var wsum = 1.0;
  for (var i = 0; i < 12; i = i + 1) {
    let fi = f32(i);
    // Golden angle, and sqrt so the samples spread by AREA rather than
    // clustering at the centre.
    let a = fi * 2.39996323;
    let r = radius * sqrt((fi + 0.5) / 12.0);
    let off = vec2<f32>(cos(a), sin(a)) * r * obj.params.zw;
    // textureSampleLEVEL, not textureSample. The plain form computes implicit
    // derivatives, which WGSL permits only in uniform control flow — and the
    // radius < 0.34 early return above makes this loop non-uniform. So the
    // shader failed to compile on WebGPU ("must only be called from uniform
    // control flow"), its pipeline was invalid, and Compound Blur drew NOTHING
    // on the primary backend while rendering correctly on WebGL2, whose GLSL
    // twin has no such rule.
    //
    // Explicit LOD 0 is not a compromise: every source here is a non-mipmapped
    // render target, so it is the level implicit sampling would have chosen.
    // The WebGL2 path is untouched.
    acc = acc + textureSampleLevel(tex, smp, uv + off, 0.0);
    wsum = wsum + 1.0;
  }
  return acc / wsum;
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  float lum = dot(mapC.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (params.y > 0.5) lum = 1.0 - lum;
  float radius = params.x * clamp(lum, 0.0, 1.0);
  vec4 c0 = texture(uTex, vUv);
  if (radius < 0.34) { frag = c0; return; }
  vec4 acc = c0;
  float wsum = 1.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = fi * 2.39996323;
    float r = radius * sqrt((fi + 0.5) / 12.0);
    vec2 off = vec2(cos(a), sin(a)) * r * params.zw;
    acc += texture(uTex, vUv + off);
    wsum += 1.0;
  }
  frag = acc / wsum;
}
`
  }
};

/**
 * Set Matte — take this layer's coverage from ANOTHER layer's pixels.
 *
 * The structural sibling of `displacement-map`: same shape (a second texture at
 * binding 3, sampled with the SAME target UV so orientation matches on both
 * backends), different arithmetic. Reusing that shape is deliberate — it is the
 * established route for an effect that reads another layer, and it inherits the
 * backend-correct UV handling that took real work to get right.
 *
 * Distinct from the TRACK MATTE path, which consumes the layer directly above
 * and removes it from the composite. This one names any layer, leaves it
 * visible, and occupies a POSITION IN THE EFFECT STACK — so it composes with the
 * effects above and below it, which a track matte cannot.
 *
 * params.x — 0 takes the matte's ALPHA, 1 takes its LUMINANCE.
 * params.y — 1 inverts.
 *
 * The pipeline is premultiplied, so scaling coverage means scaling all four
 * channels, not just `.a`. Scaling alpha alone would leave colour at full
 * strength behind a faded matte and read as a bright halo.
 */
export const SET_MATTE: ShaderSource = {
  name: 'set-matte',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = textureSample(matteTex, smp, uv);
  // Luminance is read from the PREMULTIPLIED sample deliberately: a transparent
  // region of the matte layer must read as zero coverage, not as whatever colour
  // happens to sit in its unused channels.
  var k = select(m.a, dot(m.rgb, vec3<f32>(0.299, 0.587, 0.114)), obj.params.x > 0.5);
  k = select(k, 1.0 - k, obj.params.y > 0.5);
  return textureSample(tex, smp, uv) * clamp(k, 0.0, 1.0);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  vec4 m = texture(uMapTex, vUv);
  float k = params.x > 0.5 ? dot(m.rgb, vec3(0.299, 0.587, 0.114)) : m.a;
  if (params.y > 0.5) k = 1.0 - k;
  frag = texture(uTex, vUv) * clamp(k, 0.0, 1.0);
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
  gl_Position = vec4(p.xy, 0.0, p.z);
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

export const FILL: ShaderSource = {
  name: 'fill',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, color: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv);
  return vec4<f32>(obj.color.rgb * c.a * obj.color.a, c.a * obj.color.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 color; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 color; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv);
  frag = vec4(color.rgb * c.a * color.a, c.a * color.a);
}
`
  }
};

export const STROKE: ShaderSource = {
  name: 'stroke',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, color: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv);
  let width = obj.params.x;
  let texelSize = obj.params.yz;
  var maxAlpha = c.a;
  let w = i32(clamp(width, 1.0, 16.0));
  for (var dy = -w; dy <= w; dy = dy + 1) {
    for (var dx = -w; dx <= w; dx = dx + 1) {
      if (f32(dx*dx + dy*dy) <= width*width) {
        let offsetUv = uv + vec2<f32>(f32(dx), f32(dy)) * texelSize;
        maxAlpha = max(maxAlpha, textureSample(tex, smp, clamp(offsetUv, vec2<f32>(0.0), vec2<f32>(1.0))).a);
      }
    }
  }
  let edge = maxAlpha - c.a;
  let strokeCol = vec4<f32>(obj.color.rgb * obj.color.a, obj.color.a);
  return mix(c, strokeCol, edge * strokeCol.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 color; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 color; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUv);
  float width = params.x;
  vec2 texelSize = params.yz;
  float maxAlpha = c.a;
  int w = int(clamp(width, 1.0, 16.0));
  for (int dy = -w; dy <= w; dy++) {
    for (int dx = -w; dx <= w; dx++) {
      if (float(dx*dx + dy*dy) <= width*width) {
        vec2 offsetUv = vUv + vec2(float(dx), float(dy)) * texelSize;
        maxAlpha = max(maxAlpha, texture(uTex, clamp(offsetUv, vec2(0.0), vec2(1.0))).a);
      }
    }
  }
  float edge = maxAlpha - c.a;
  vec4 strokeCol = vec4(color.rgb * color.a, color.a);
  frag = mix(c, strokeCol, edge * strokeCol.a);
}
`
  }
};

export const SHARPEN: ShaderSource = {
  name: 'sharpen',
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
  let c = textureSample(tex, smp, uv);
  let texelSize = obj.params.xy;
  let amount = obj.params.z;
  let neighborSum = 
    textureSample(tex, smp, uv + vec2<f32>(0.0, -1.0) * texelSize) +
    textureSample(tex, smp, uv + vec2<f32>(-1.0, 0.0) * texelSize) +
    textureSample(tex, smp, uv + vec2<f32>(1.0, 0.0) * texelSize) +
    textureSample(tex, smp, uv + vec2<f32>(0.0, 1.0) * texelSize);
  let sharp = c * 5.0 - neighborSum;
  return mix(c, vec4<f32>(sharp.rgb, c.a), amount);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
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
  vec4 c = texture(uTex, vUv);
  vec2 texelSize = params.xy;
  float amount = params.z;
  vec4 neighborSum = 
    texture(uTex, vUv + vec2(0.0, -1.0) * texelSize) +
    texture(uTex, vUv + vec2(-1.0, 0.0) * texelSize) +
    texture(uTex, vUv + vec2(1.0, 0.0) * texelSize) +
    texture(uTex, vUv + vec2(0.0, 1.0) * texelSize);
  vec4 sharp = c * 5.0 - neighborSum;
  frag = mix(c, vec4(sharp.rgb, c.a), amount);
}
`
  }
};

/**
 * Beam — a travelling pulse along a segment, drawn additively.
 *
 * The GPU twin of `applyBeam` (canvas2dEffects.ts), which strokes the segment
 * TWICE with `globalCompositeOperation = 'lighter'`: a wide soft pass at alpha
 * 0.35, then a narrow bright core at alpha 1, both round-capped and both faded
 * by a linear gradient running tail → head. This reproduces that exactly:
 *
 *   coverage  = capsule SDF against the segment (round caps ARE the capsule)
 *   ramp      = position along the segment, 0 at the tail and 1 at the head
 *   out       = src + colour · ramp · (0.35 · soft + 1.0 · core)
 *
 * ── The coordinate space, which is where a port like this goes wrong ────────
 *
 * The CPU version works in the LAYER's own pixels: `startX` is a percentage of
 * the layer's width. The 2D effect chain runs in a SCREEN-space buffer, so the
 * layer occupies a sub-rect of it — `box`, the same `fxBox` the gradient ramp
 * uses for exactly this reason. Endpoints are therefore box-relative, and
 * `thickness` (comp px) is converted to texels by the caller's kx/ky, so a
 * beam is the same width whichever route the chain took.
 *
 * Antialiasing is a 1-texel smoothstep. Canvas2D antialiases a stroke edge and
 * a hard `step` here would read as a jagged beam against a smooth reference —
 * the visible difference in a diff, and not a tolerance question.
 */
export const BEAM: ShaderSource = {
  name: 'beam',
  wgsl: `
struct Object {
  mvp: mat3x3<f32>,
  uvRect: vec4<f32>,
  ends: vec4<f32>,
  params: vec4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = obj.ends.xy;
  let b = obj.ends.zw;
  let core = obj.params.x;
  let soft = obj.params.y;
  let aa = obj.params.z;
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-12);
  let t = clamp(dot(uv - a, ab) / len2, 0.0, 1.0);
  let d = length(uv - (a + ab * t));
  let cov = 1.0 - smoothstep(core - aa, core + aa, d);
  let covSoft = 1.0 - smoothstep(soft - aa, soft + aa, d);
  let add = obj.color.rgb * t * (0.35 * covSoft + cov);
  return vec4<f32>(src.rgb + add, min(1.0, src.a + t * (0.35 * covSoft + cov)));
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 ends; vec4 params; vec4 color; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 ends; vec4 params; vec4 color; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 src = texture(uTex, vUv);
  vec2 a = ends.xy;
  vec2 b = ends.zw;
  float core = params.x;
  float soft = params.y;
  float aa = params.z;
  vec2 ab = b - a;
  float len2 = max(dot(ab, ab), 1e-12);
  float t = clamp(dot(vUv - a, ab) / len2, 0.0, 1.0);
  float d = length(vUv - (a + ab * t));
  float cov = 1.0 - smoothstep(core - aa, core + aa, d);
  float covSoft = 1.0 - smoothstep(soft - aa, soft + aa, d);
  vec3 add = color.rgb * t * (0.35 * covSoft + cov);
  frag = vec4(src.rgb + add, min(1.0, src.a + t * (0.35 * covSoft + cov)));
}
`
  }
};

export const NOISE: ShaderSource = {
  name: 'noise',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn rand(co: vec2<f32>) -> f32 {
  return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv);
  if (c.a == 0.0) { return c; }
  let amount = obj.params.x;
  let evolution = obj.params.y;
  let monochrome = obj.params.z;
  var rnd: vec3<f32>;
  if (monochrome > 0.5) {
    let r = rand(uv + evolution * 0.01) - 0.5;
    rnd = vec3<f32>(r);
  } else {
    rnd = vec3<f32>(
      rand(uv + evolution * 0.01) - 0.5,
      rand(uv * 1.3 + evolution * 0.02) - 0.5,
      rand(uv * 1.7 + evolution * 0.03) - 0.5
    );
  }
  // c.rgb is premultiplied; unpremultiply, add noise in straight-alpha space,
  // clamp, then re-premultiply so the output stays premultiplied.
  //
  // The guard is not cosmetic: a fully transparent pixel divides by zero, and
  // what that produces is DRIVER-DEPENDENT - NaN, Inf, or a flushed zero. NaN
  // survives the clamp on some hardware and NaN times 0.0 is still NaN, so the
  // premultiply cannot rescue it. Matches the gradient-ramp guard above.
  let straight = select(c.rgb / c.a, vec3<f32>(0.0), c.a == 0.0);
  let rgb = clamp(straight + rnd * amount, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb * c.a, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a == 0.0) {
    frag = c;
    return;
  }
  float amount = params.x;
  float evolution = params.y;
  float monochrome = params.z;
  vec3 rnd;
  if (monochrome > 0.5) {
    float r = rand(vUv + evolution * 0.01) - 0.5;
    rnd = vec3(r);
  } else {
    rnd = vec3(
      rand(vUv + evolution * 0.01) - 0.5,
      rand(vUv * 1.3 + evolution * 0.02) - 0.5,
      rand(vUv * 1.7 + evolution * 0.03) - 0.5
    );
  }
  // c.rgb is premultiplied; unpremultiply, add noise in straight-alpha space,
  // clamp, then re-premultiply so the output stays premultiplied.
  //
  // The guard is not cosmetic: a fully transparent pixel divides by zero, and
  // what that produces is DRIVER-DEPENDENT - NaN, Inf, or a flushed zero. NaN
  // survives the clamp on some hardware and NaN times 0.0 is still NaN, so the
  // premultiply cannot rescue it. Matches the gradient-ramp guard above.
  vec3 straight = (c.a > 0.0) ? c.rgb / c.a : vec3(0.0);
  vec3 rgb = clamp(straight + rnd * amount, vec3(0.0), vec3(1.0));
  frag = vec4(rgb * c.a, c.a);
}
`
  }
};

// ── mat4 (true 3D) shader variants ──────────────────────────────────────────
// The depth-tested 3D layer path. Same fragment logic as the 2D twins, but the
// vertex stage takes a full mat4 MVP and emits real clip-space (z and w), so
// the hardware does the perspective divide, perspective-correct interpolation,
// and depth testing. The mat3 shaders above are UNTOUCHED — 2D output stays
// bit-identical.
//
// Every 3d Object block ends with the SHADE TAIL (must match packShade3D in
// pipeline/uniforms.ts exactly): model (mat4, unit quad → 3D comp space),
// eyeLit (xyz camera eye, w = lit flag), shadeParams (light count, specular
// 0..1, shininess, metal) and lights (MAX_LIGHTS3D × 4 vec4s: pos+type,
// color+gain, radius/halfCone/aimX/aimY, aimZ/coneFeather/falloffMode/
// falloffDistance). When the lit flag is 0 the tail is
// all zeros and shading is a byte-exact identity — unlit layers render exactly
// as before. When lit, the fragment stage runs the SAME light model as
// lightShading.ts (two-sided Lambert, linear radius falloff, feathered 2D spot
// cone, gain clamped to 4) but PER-FRAGMENT — a near light shows a real
// hotspot across a plane — plus Blinn-Phong specular (specular 0 → Lambert
// only, matching the CPU per-quad fallback).
const SOLID3D: ShaderSource = {
  name: 'solid3d',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat4x4<f32>,
  color : vec4<f32>,
  shape : vec4<f32>,
  model : mat4x4<f32>,
  eyeLit : vec4<f32>,
  shadeParams : vec4<f32>,
  lights : array<vec4<f32>, 32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) world : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.local = pos;
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  return o;
}

fn shade3d(world : vec3<f32>, baseRgb : vec3<f32>) -> vec3<f32> {
  if (obj.eyeLit.w < 0.5) { return baseRgb; }
  let N = normalize(obj.model[2].xyz);
  let count = i32(obj.shadeParams.x + 0.5);
  let specI = obj.shadeParams.y;
  let metal = obj.shadeParams.w;
  let shin = max(obj.shadeParams.z, 1.0);
  var diff = vec3<f32>(0.0);
  var spec = vec3<f32>(0.0);
  for (var i = 0; i < 8; i = i + 1) {
    if (i >= count) { break; }
    let posType = obj.lights[i * 4];
    let colGain = obj.lights[i * 4 + 1];
    let misc = obj.lights[i * 4 + 2];
    let misc2 = obj.lights[i * 4 + 3];
    let lType = i32(posType.w + 0.5);
    let gain = colGain.w;
    if (lType == 0) { diff = diff + colGain.rgb * gain; continue; }
    var toLight = vec3<f32>(0.0, 0.0, -1.0);
    var atten = 1.0;
    var lambert = 1.0;
    var skip = false;
    // The aim arrives RESOLVED (Point of Interest, or this type's legacy
    // 2D-angle fallback) and unit-length, so there is no per-type fallback to
    // keep in step with the CPU here — see toShaderLights.
    let aim = vec3<f32>(misc.z, misc.w, misc2.x);
    if (lType == 3) {
      lambert = abs(dot(N, aim));
      toLight = -aim;
    } else {
      let Lvec = posType.xyz - world;
      let d = length(Lvec);
      let radius = misc.x;
      let fMode = i32(misc2.z + 0.5);
      if (fMode == 0) {
        // Legacy: hard cutoff at the radius, linear ramp inside it.
        if (radius > 0.0 && d >= radius) { skip = true; }
        if (!skip) { atten = select(1.0, 1.0 - d / radius, radius > 0.0); }
      } else {
        // AE falloff curves reach PAST the radius, so the cutoff moves out with
        // them — mirrors lightFalloffAt exactly, including its max(1, radius).
        let r = max(1.0, radius);
        var curve = 1.0;
        if (d > r) {
          if (fMode == 1) { curve = max(0.0, 1.0 - (d - r) / max(1.0, misc2.w)); }
          else { curve = (r * r) / (d * d); }
        }
        if (curve <= 0.001) { skip = true; }
        if (!skip) { atten = curve; }
      }
      if (!skip && d > 1e-6) {
        toLight = Lvec / d;
        lambert = abs(dot(N, toLight));
        if (lType == 2) {
          // Full 3D cone test: with a POI the aim has a z, which the old
          // 2D-only dot product could not express.
          let cosA = dot(aim, -Lvec / d);
          let halfCone = max(misc.y, 1e-3);
          let ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang > halfCone) { skip = true; }
          let feather = misc2.y;
          if (!skip && feather > 1e-6 && ang > halfCone - feather) { atten = atten * (halfCone - ang) / feather; }
        }
      }
    }
    if (skip) { continue; }
    let k = gain * lambert * atten;
    diff = diff + colGain.rgb * k;
    if (specI > 0.0) {
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      spec = spec + colGain.rgb * (gain * atten * pow(abs(dot(N, H)), shin));
    }
  }
  diff = clamp(diff, vec3<f32>(0.0), vec3<f32>(4.0));
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return baseRgb * diff + spec * specI * mix(vec3<f32>(1.0), baseRgb, metal);
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
fn fs(@location(0) local : vec2<f32>, @location(1) world : vec3<f32>) -> @location(0) vec4<f32> {
  let a = obj.color.a * shapeAlpha(local);
  let rgb = shade3d(world, obj.color.rgb);
  return vec4<f32>(rgb * a, a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat4 mvp; vec4 color; vec4 shape; mat4 model; vec4 eyeLit; vec4 shadeParams; vec4 lights[32]; };
out vec2 vLocal;
out vec3 vWorld;
void main() {
  gl_Position = mvp * vec4(pos, 0.0, 1.0);
  vLocal = pos;
  vWorld = (model * vec4(pos, 0.0, 1.0)).xyz;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat4 mvp; vec4 color; vec4 shape; mat4 model; vec4 eyeLit; vec4 shadeParams; vec4 lights[32]; };
in vec2 vLocal;
in vec3 vWorld;
out vec4 frag;
vec3 shade3d(vec3 world, vec3 baseRgb) {
  if (eyeLit.w < 0.5) return baseRgb;
  vec3 N = normalize(model[2].xyz);
  int count = int(shadeParams.x + 0.5);
  float specI = shadeParams.y;
  float metal = shadeParams.w;
  float shin = max(shadeParams.z, 1.0);
  vec3 diff = vec3(0.0);
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec4 posType = lights[i * 4];
    vec4 colGain = lights[i * 4 + 1];
    vec4 misc = lights[i * 4 + 2];
    vec4 misc2 = lights[i * 4 + 3];
    int lType = int(posType.w + 0.5);
    float gain = colGain.w;
    if (lType == 0) { diff += colGain.rgb * gain; continue; }
    vec3 toLight = vec3(0.0, 0.0, -1.0);
    float atten = 1.0;
    float lambert = 1.0;
    // The aim arrives RESOLVED (Point of Interest, or this type's legacy
    // 2D-angle fallback) and unit-length — see toShaderLights.
    vec3 aim = vec3(misc.z, misc.w, misc2.x);
    if (lType == 3) {
      lambert = abs(dot(N, aim));
      toLight = -aim;
    } else {
      vec3 Lvec = posType.xyz - world;
      float d = length(Lvec);
      float radius = misc.x;
      int fMode = int(misc2.z + 0.5);
      if (fMode == 0) {
        // Legacy: hard cutoff at the radius, linear ramp inside it.
        if (radius > 0.0 && d >= radius) continue;
        atten = radius > 0.0 ? 1.0 - d / radius : 1.0;
      } else {
        // AE falloff curves reach PAST the radius, so the cutoff moves out with
        // them — mirrors lightFalloffAt exactly, including its max(1, radius).
        float r = max(1.0, radius);
        float curve = 1.0;
        if (d > r) {
          curve = fMode == 1 ? max(0.0, 1.0 - (d - r) / max(1.0, misc2.w)) : (r * r) / (d * d);
        }
        if (curve <= 0.001) continue;
        atten = curve;
      }
      if (d > 1e-6) {
        toLight = Lvec / d;
        lambert = abs(dot(N, toLight));
        if (lType == 2) {
          // Full 3D cone test: with a POI the aim has a z, which the old
          // 2D-only dot product could not express.
          float cosA = dot(aim, -Lvec / d);
          float halfCone = max(misc.y, 1e-3);
          float ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang > halfCone) continue;
          float feather = misc2.y;
          if (feather > 1e-6 && ang > halfCone - feather) atten *= (halfCone - ang) / feather;
        }
      }
    }
    float k = gain * lambert * atten;
    diff += colGain.rgb * k;
    if (specI > 0.0) {
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      spec += colGain.rgb * (gain * atten * pow(abs(dot(N, H)), shin));
    }
  }
  diff = clamp(diff, vec3(0.0), vec3(4.0));
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return baseRgb * diff + spec * specI * mix(vec3(1.0), baseRgb, metal);
}
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
  vec3 rgb = shade3d(vWorld, color.rgb);
  frag = vec4(rgb * a, a);
}
`,
  },
};

// WGSL shade tail + per-fragment light model, shared verbatim by the textured
// 3d shaders (the Object block layout after the 2D-twin fields is identical).
const WGSL_TEX3D_OBJECT = /* wgsl */ `
struct Object {
  mvp : mat4x4<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
  model : mat4x4<f32>,
  eyeLit : vec4<f32>,
  shadeParams : vec4<f32>,
  lights : array<vec4<f32>, 32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
`;

const WGSL_SHADE3D_FN = /* wgsl */ `
fn shade3d(world : vec3<f32>, baseRgb : vec3<f32>) -> vec3<f32> {
  if (obj.eyeLit.w < 0.5) { return baseRgb; }
  let N = normalize(obj.model[2].xyz);
  let count = i32(obj.shadeParams.x + 0.5);
  let specI = obj.shadeParams.y;
  let metal = obj.shadeParams.w;
  let shin = max(obj.shadeParams.z, 1.0);
  var diff = vec3<f32>(0.0);
  var spec = vec3<f32>(0.0);
  for (var i = 0; i < 8; i = i + 1) {
    if (i >= count) { break; }
    let posType = obj.lights[i * 4];
    let colGain = obj.lights[i * 4 + 1];
    let misc = obj.lights[i * 4 + 2];
    let misc2 = obj.lights[i * 4 + 3];
    let lType = i32(posType.w + 0.5);
    let gain = colGain.w;
    if (lType == 0) { diff = diff + colGain.rgb * gain; continue; }
    var toLight = vec3<f32>(0.0, 0.0, -1.0);
    var atten = 1.0;
    var lambert = 1.0;
    var skip = false;
    // The aim arrives RESOLVED (Point of Interest, or this type's legacy
    // 2D-angle fallback) and unit-length, so there is no per-type fallback to
    // keep in step with the CPU here — see toShaderLights.
    let aim = vec3<f32>(misc.z, misc.w, misc2.x);
    if (lType == 3) {
      lambert = abs(dot(N, aim));
      toLight = -aim;
    } else {
      let Lvec = posType.xyz - world;
      let d = length(Lvec);
      let radius = misc.x;
      let fMode = i32(misc2.z + 0.5);
      if (fMode == 0) {
        // Legacy: hard cutoff at the radius, linear ramp inside it.
        if (radius > 0.0 && d >= radius) { skip = true; }
        if (!skip) { atten = select(1.0, 1.0 - d / radius, radius > 0.0); }
      } else {
        // AE falloff curves reach PAST the radius, so the cutoff moves out with
        // them — mirrors lightFalloffAt exactly, including its max(1, radius).
        let r = max(1.0, radius);
        var curve = 1.0;
        if (d > r) {
          if (fMode == 1) { curve = max(0.0, 1.0 - (d - r) / max(1.0, misc2.w)); }
          else { curve = (r * r) / (d * d); }
        }
        if (curve <= 0.001) { skip = true; }
        if (!skip) { atten = curve; }
      }
      if (!skip && d > 1e-6) {
        toLight = Lvec / d;
        lambert = abs(dot(N, toLight));
        if (lType == 2) {
          // Full 3D cone test: with a POI the aim has a z, which the old
          // 2D-only dot product could not express.
          let cosA = dot(aim, -Lvec / d);
          let halfCone = max(misc.y, 1e-3);
          let ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang > halfCone) { skip = true; }
          let feather = misc2.y;
          if (!skip && feather > 1e-6 && ang > halfCone - feather) { atten = atten * (halfCone - ang) / feather; }
        }
      }
    }
    if (skip) { continue; }
    let k = gain * lambert * atten;
    diff = diff + colGain.rgb * k;
    if (specI > 0.0) {
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      spec = spec + colGain.rgb * (gain * atten * pow(abs(dot(N, H)), shin));
    }
  }
  diff = clamp(diff, vec3<f32>(0.0), vec3<f32>(4.0));
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return baseRgb * diff + spec * specI * mix(vec3<f32>(1.0), baseRgb, metal);
}
`;

// GLSL twins of the above (UBO tail + light model), same layout contract.
const GLSL_TEX3D_UBO = `layout(std140) uniform Object { mat4 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; mat4 model; vec4 eyeLit; vec4 shadeParams; vec4 lights[32]; };`;

const GLSL_SHADE3D_FN = /* glsl */ `
vec3 shade3d(vec3 world, vec3 baseRgb) {
  if (eyeLit.w < 0.5) return baseRgb;
  vec3 N = normalize(model[2].xyz);
  int count = int(shadeParams.x + 0.5);
  float specI = shadeParams.y;
  float metal = shadeParams.w;
  float shin = max(shadeParams.z, 1.0);
  vec3 diff = vec3(0.0);
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec4 posType = lights[i * 4];
    vec4 colGain = lights[i * 4 + 1];
    vec4 misc = lights[i * 4 + 2];
    vec4 misc2 = lights[i * 4 + 3];
    int lType = int(posType.w + 0.5);
    float gain = colGain.w;
    if (lType == 0) { diff += colGain.rgb * gain; continue; }
    vec3 toLight = vec3(0.0, 0.0, -1.0);
    float atten = 1.0;
    float lambert = 1.0;
    // The aim arrives RESOLVED (Point of Interest, or this type's legacy
    // 2D-angle fallback) and unit-length — see toShaderLights.
    vec3 aim = vec3(misc.z, misc.w, misc2.x);
    if (lType == 3) {
      lambert = abs(dot(N, aim));
      toLight = -aim;
    } else {
      vec3 Lvec = posType.xyz - world;
      float d = length(Lvec);
      float radius = misc.x;
      int fMode = int(misc2.z + 0.5);
      if (fMode == 0) {
        // Legacy: hard cutoff at the radius, linear ramp inside it.
        if (radius > 0.0 && d >= radius) continue;
        atten = radius > 0.0 ? 1.0 - d / radius : 1.0;
      } else {
        // AE falloff curves reach PAST the radius, so the cutoff moves out with
        // them — mirrors lightFalloffAt exactly, including its max(1, radius).
        float r = max(1.0, radius);
        float curve = 1.0;
        if (d > r) {
          curve = fMode == 1 ? max(0.0, 1.0 - (d - r) / max(1.0, misc2.w)) : (r * r) / (d * d);
        }
        if (curve <= 0.001) continue;
        atten = curve;
      }
      if (d > 1e-6) {
        toLight = Lvec / d;
        lambert = abs(dot(N, toLight));
        if (lType == 2) {
          // Full 3D cone test: with a POI the aim has a z, which the old
          // 2D-only dot product could not express.
          float cosA = dot(aim, -Lvec / d);
          float halfCone = max(misc.y, 1e-3);
          float ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang > halfCone) continue;
          float feather = misc2.y;
          if (feather > 1e-6 && ang > halfCone - feather) atten *= (halfCone - ang) / feather;
        }
      }
    }
    float k = gain * lambert * atten;
    diff += colGain.rgb * k;
    if (specI > 0.0) {
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      spec += colGain.rgb * (gain * atten * pow(abs(dot(N, H)), shin));
    }
  }
  diff = clamp(diff, vec3(0.0), vec3(4.0));
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return baseRgb * diff + spec * specI * mix(vec3(1.0), baseRgb, metal);
}
`;

const TEXTURED3D: ShaderSource = {
  name: 'textured3d',
  wgsl: /* wgsl */ `
${WGSL_TEX3D_OBJECT}
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) world : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  return o;
}
${WGSL_SHADE3D_FN}
@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) world : vec3<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv) * obj.tint;
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  let lit = shade3d(world, graded);
  return vec4<f32>(lit * c.a, c.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
${GLSL_TEX3D_UBO}
out vec2 vUv;
out vec3 vWorld;
void main() {
  gl_Position = mvp * vec4(pos, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
  vWorld = (model * vec4(pos, 0.0, 1.0)).xyz;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
${GLSL_TEX3D_UBO}
uniform sampler2D uTex;
in vec2 vUv;
in vec3 vWorld;
out vec4 frag;
${GLSL_SHADE3D_FN}
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  vec3 lit = shade3d(vWorld, graded);
  frag = vec4(lit * c.a, c.a);
}
`,
  },
};

const MASKED_TEXTURED3D: ShaderSource = {
  name: 'masked-textured3d',
  wgsl: /* wgsl */ `
${WGSL_TEX3D_OBJECT}
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var maskTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) world : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  return o;
}
${WGSL_SHADE3D_FN}
@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) world : vec3<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv) * obj.tint;
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  let maskAlpha = textureSample(maskTex, smp, uv).a;
  let a = c.a * maskAlpha;
  let lit = shade3d(world, graded);
  return vec4<f32>(lit * a, a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
${GLSL_TEX3D_UBO}
out vec2 vUv;
out vec3 vWorld;
void main() {
  gl_Position = mvp * vec4(pos, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
  vWorld = (model * vec4(pos, 0.0, 1.0)).xyz;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
${GLSL_TEX3D_UBO}
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
in vec2 vUv;
in vec3 vWorld;
out vec4 frag;
${GLSL_SHADE3D_FN}
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  float maskAlpha = texture(uMaskTex, vUv).a;
  float a = c.a * maskAlpha;
  vec3 lit = shade3d(vWorld, graded);
  frag = vec4(lit * a, a);
}
`,
  },
};

const DEFORMED_MESH: ShaderSource = {
  name: 'deformed-mesh',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
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
fn vs(@location(0) pos : vec2<f32>, @location(1) uv : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = uv;
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
layout(location = 1) in vec2 uv;
layout(std140) uniform Object { mat3 mvp; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uv;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; };
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

// ── Silhouette fill ─────────────────────────────────────────────────────────
//
// Takes a texture's ALPHA and fills it with a solid colour, discarding the
// texture's RGB entirely. This is what an outward layer style is: Photoshop's
// Outer Glow and Drop Shadow are a blurred silhouette FILLED with the style's
// colour, not a blurred copy of the artwork.
//
// ## The bug this exists to fix
//
// Both styles used to composite the blurred layer through `TEXTURED` with the
// style colour as the TINT — and a tint MULTIPLIES. So the output was
// `layerRGB × styleRGB`, which is the style's colour only when the layer is
// white:
//
//   white glow, blue layer     white × blue   = BLUE   (the layer's colour)
//   green glow, blue layer     green × blue   = BLACK  (no shared channel)
//   red shadow, blue layer     red × blue     = BLACK
//   black shadow, ANY layer    anything × 0   = BLACK  ← correct, by accident
//
// The last line is why drop shadow appeared to work and outer glow did not:
// black is the absorbing element of a multiply, so the DEFAULT shadow colour is
// a fixed point and every non-black shadow colour was broken in exactly the same
// way. Measured before the fix on a blue layer: a green glow moved the pixel
// 7,7,125 → 3,3,60 (darker blue, no green anywhere) and a red shadow moved it
// 3,3,196 → 2,2,117 (darker blue, no red).
//
// Note that INNER glow and inner shadow were never affected: they run through
// `applyInterior` on the Canvas2D path, which does `source-in` with a
// `fillStyle` — already a replace-RGB-keep-alpha fill, i.e. the correct
// operation spelled in Canvas terms.
//
// ## Why a shader variant rather than a uniform
//
// Same reasoning as the premultiplied variants below: one behaviour switch is
// cheaper as a variant than as an extension to the shared std140 `Object` block,
// and this one needs no new uniform at all — it reinterprets `tint` that is
// already there. It is also alpha-only, so it is INVARIANT-AGNOSTIC: it never
// reads the texture's RGB, and alpha is identical in straight and premultiplied
// space, so unlike the textured shaders it needs no premultiplied twin.
//
// Proven by: packages/render-tests/scripts/verify-3d-styles.mjs
// (`outer glow is the GLOW's colour, not the layer's` and the red-shadow twin).
const SILHOUETTE_SUFFIX = '-silhouette';

/**
 * Derive the silhouette-fill twin of a textured shader.
 *
 * Substitutes the sample line so `c` becomes `(tint.rgb, texel.a × tint.a)`
 * instead of `texel × tint`. Everything downstream — the colour matrix, the
 * `graded * c.a` premultiply on the way out — is untouched, so the fill
 * composites exactly like any other draw.
 *
 * Throws at module load if a site is missing, for the same reason `premulOf`
 * does: a silent no-op would yield a variant identical to its base, which is a
 * wrong-colour bug that renders plausible pixels and trips no type or test.
 */
function silhouetteOf(base: ShaderSource): ShaderSource {
  const sub = (code: string, from: string, to: string, where: string): string => {
    if (!code.includes(from)) {
      throw new Error(`silhouetteOf(${base.name}): no ${where} site matching ${JSON.stringify(from)}`);
    }
    return code.split(from).join(to);
  };
  const wgsl = sub(
    base.wgsl,
    'textureSample(tex, smp, uv) * obj.tint',
    'vec4<f32>(obj.tint.rgb, textureSample(tex, smp, uv).a * obj.tint.a)',
    'wgsl sample',
  );
  const fragment = sub(
    base.glsl.fragment,
    'texture(uTex, vUv) * tint',
    'vec4(tint.rgb, texture(uTex, vUv).a * tint.a)',
    'glsl sample',
  );
  return { name: `${base.name}${SILHOUETTE_SUFFIX}`, wgsl, glsl: { ...base.glsl, fragment } };
}

// ── Un-premultiply at the sample: the BASE, not a variant ───────────────────
//
// THE ALPHA INVARIANT (stated in full on `TextureSource`, ../gpu/types.ts):
// every texture this renderer samples holds PREMULTIPLIED alpha. Uploaded
// footage, canvas rasters, video frames and intermediate render targets alike.
//
// So every textured shader divides the premultiplication back out at the
// sample, grades straight colour, and re-multiplies on the way out. There is no
// straight-input path any more, and no per-draw flag selecting between them.
//
// ## Why premultiplied, and not straight
//
// Straight is the wrong space to FILTER in: bilinear and mipmap sampling average
// transparent texels whose RGB is arbitrary — or zero, for anything that came
// off a canvas — so soft edges pick up a halo toward that arbitrary colour.
// Premultiplied is the correct space to filter in, because the weighting the
// filter applies is exactly the weighting the compositor wants.
//
// Measured, on the magnified hard alpha edge in `alpha-filter-hard-edge`: under
// the straight invariant the half-covered column read red 181 where correct
// filtering predicts 243.8 — a 63-of-255-level dark halo. That number is the
// reason this flipped.
//
// ## Why the divide is here and not on the CPU
//
// Dividing at the sample keeps FILTERING in premultiplied space and converts
// only for the grade, which is the whole point — un-premultiplying at upload
// would put a straight texture back in the sampler and reintroduce the halo. It
// is also far cheaper: the CPU route needs a full-frame readback per video frame
// (~230 ms at 1080p, ~900 ms at 4K on this machine) and the `<video>` element
// uploads straight to the GPU with no pixel buffer in the path at all.
//
// ## Where the FILE's alpha mode is handled instead
//
// `FootageInterpretation.alpha` used to select a shader variant. It no longer
// reaches the fragment stage at all: it decides whether the UPLOAD multiplies,
// which is the only place the question can be answered once per file rather than
// once per draw. A straight file gets multiplied on upload; a file that is
// already premultiplied is passed through untouched. Both arrive premultiplied,
// which is what makes one shader path sufficient.
//
// That also removes the asymmetry that made the previous arrangement fragile:
// WebGL2's `UNPACK_PREMULTIPLY_ALPHA_WEBGL` can only MULTIPLY, never divide, so
// under a straight invariant it was necessary but not sufficient and the real
// work had to happen at decode. Under this invariant multiplying is the only
// direction anyone needs, so the flag alone does the job on both backends.
//
// ## Why derived rather than six hand-written copies
//
// The six families sample identically, so this is one substitution applied
// twelve times. Written out it would be twelve copies of one idea, and the day
// someone edits a sample site the copies rot silently. The derivation throws at
// module load if a site goes missing, because a silent no-op would leave a
// shader that double-multiplies — plausible pixels, no type error, no test
// signature to catch it.

/** Below one 8-bit alpha quantum a texel is indistinguishable from empty. */
const ALPHA_FLOOR = '0.00392156862745098'; // 1.0 / 255.0

/**
 * Un-premultiply, guarded.
 *
 * A THRESHOLD, not merely an epsilon. `max(a, eps)` bounds the divide but not
 * the amplification: at alpha 1/255 the divide multiplies RGB by 255, so
 * quantisation noise in nearly-transparent texels becomes visible specks and
 * banding along feathered masks, motion-blurred edges and glow falloff. Below
 * one alpha quantum there is no recoverable colour to begin with, so the texel
 * resolves to empty instead of to amplified noise.
 *
 * The `min(…, 1.0)` repairs invalid data: in valid premultiplied colour every
 * channel is ≤ alpha, so a quotient above 1 means the source was not really
 * premultiplied. Clamping there stops one bad texel entering the colour matrix
 * as a wild value and coming back out as a bright speck.
 */
const UNPREMUL_WGSL = `fn unpremul(t : vec4<f32>) -> vec4<f32> {
  if (t.a < ${ALPHA_FLOOR}) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(min(t.rgb / t.a, vec3<f32>(1.0)), t.a);
}

`;

const UNPREMUL_GLSL = `vec4 unpremul(vec4 t) {
  if (t.a < ${ALPHA_FLOOR}) return vec4(0.0);
  return vec4(min(t.rgb / t.a, vec3(1.0)), t.a);
}

`;

/**
 * Rewrite a textured shader to un-premultiply at the sample.
 *
 * Keeps the base NAME — the result IS the shader, not an alternative to it. That
 * is the whole change: there is no `-premul` suffix any more, because there is
 * nothing to distinguish it from.
 *
 * Throws at module load if a substitution site is missing. A silent no-op would
 * leave a shader that double-multiplies every premultiplied texture, which is
 * plausible-looking wrong output that no type or test signature would catch.
 * Failing at import turns it into a boot failure, which `editorBoot.smoke.test`
 * already guards.
 */
function unpremultiplyingSample(base: ShaderSource): ShaderSource {
  const sub = (code: string, from: string, to: string, where: string): string => {
    if (!code.includes(from)) {
      throw new Error(`unpremultiplyingSample(${base.name}): no ${where} site matching ${JSON.stringify(from)}`);
    }
    return code.split(from).join(to);
  };
  const wgsl = sub(
    sub(base.wgsl, '@fragment', `${UNPREMUL_WGSL}@fragment`, 'wgsl fragment entry'),
    'textureSample(tex, smp, uv) * obj.tint',
    'unpremul(textureSample(tex, smp, uv)) * obj.tint',
    'wgsl sample',
  );
  const fragment = sub(
    sub(base.glsl.fragment, 'void main()', `${UNPREMUL_GLSL}void main()`, 'glsl main'),
    'texture(uTex, vUv) * tint',
    'unpremul(texture(uTex, vUv)) * tint',
    'glsl sample',
  );
  return { name: base.name, wgsl, glsl: { ...base.glsl, fragment } };
}

// The silhouette fill is derived from the STRAIGHT-sampling source on purpose:
// it discards the texture's RGB and reads only alpha, which is the same value in
// either alpha space, so an un-premultiply in front of it would be dead code
// operating on a channel it never uses.
const TEXTURED_SILHOUETTE = silhouetteOf(TEXTURED);

export const BUILTIN_SHADERS: readonly ShaderSource[] = [
  SOLID, MATTE_COMBINE, BLEND_COMBINE, BLUR, GRADIENT_RAMP, FRACTAL_NOISE, DISPLACEMENT_MAP, COMPOUND_BLUR, APPLY_COLOR_LUT, MOTION_TILE,
  FILL, STROKE, SHARPEN, NOISE, SET_MATTE, BEAM,
  SOLID3D,
  // The six families that sample a layer texture. Every one un-premultiplies.
  unpremultiplyingSample(TEXTURED),
  unpremultiplyingSample(MASKED_TEXTURED),
  unpremultiplyingSample(LUT_TEXTURED),
  unpremultiplyingSample(DEFORMED_MESH),
  unpremultiplyingSample(TEXTURED3D),
  unpremultiplyingSample(MASKED_TEXTURED3D),
  TEXTURED_SILHOUETTE,
  GLASS_COMPOSITE,
];
