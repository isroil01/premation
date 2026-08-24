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
import { FX_ROUND_SIX_SHADERS } from './fxRoundSix';
export { GLASS_COMPOSITE };

import {
  LINEAR_INTERMEDIATE_STORAGE,
  SRGB_TRANSFER_GLSL,
  SRGB_TRANSFER_WGSL,
} from './linearWorkingSpace';
export { LINEAR_WORKING_SPACE, LINEAR_INTERMEDIATE_STORAGE } from './linearWorkingSpace';

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
  srcSpace : vec4<f32>,
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
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
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
  srcSpace : vec4<f32>,
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
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
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
  srcSpace : vec4<f32>,
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
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
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
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32>, srcSpace : vec4<f32> };
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
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
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
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32>, srcSpace : vec4<f32> };
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
${SRGB_TRANSFER_WGSL}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s = textureSample(tex, smp, uv);
  let d = textureSample(uMaskTex, smp, uv);
  let as1 = s.a; let ad = d.a;
  var cs = vec3<f32>(0.0); if (as1 > 0.0) { cs = storageToWorking(min(s.rgb / as1, vec3<f32>(1.0))); }
  var cb = vec3<f32>(0.0); if (ad > 0.0) { cb = storageToWorking(min(d.rgb / ad, vec3<f32>(1.0))); }
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
  var skipEncode = false;
  if (mode == 29) {
    // Alpha Add. Standard alpha is as + ad - as*ad, which is exactly why two
    // touching anti-aliased 50% edges composite to 75% and leave a visible seam
    // down the join. Adding instead of union-ing closes it.
    ao = min(1.0, as1 + ad);
  } else if (mode == 30) {
    // Luminescent Premul. Treats the source as ALREADY premultiplied and adds it
    // rather than lerping, so colour that exceeds its own alpha is kept instead
    // of clipped — the glow/highlight case AE keeps this mode for.
    // Work in linear premul, then encode with the common path below.
    var sLin = s.rgb;
    var dLin = d.rgb;
    if (as1 > 0.0) { sLin = storageToWorking(min(s.rgb / as1, vec3<f32>(1.0))) * as1; }
    if (ad > 0.0) { dLin = storageToWorking(min(d.rgb / ad, vec3<f32>(1.0))) * ad; }
    co = sLin + (1.0 - as1) * dLin;
  } else if (mode >= 31 && mode <= 34) {
    // ── Matte family (31-34): Stencil / Silhouette ──
    // Not blends. The layer contributes NO colour of its own; it scales the
    // coverage of the whole backdrop beneath it. So the output is the backdrop
    // times a factor, and the source appears only inside that factor.
    let k = matteFactor(mode, s);
    // Everything here is premultiplied, so scaling coverage means scaling all
    // four channels. Scaling alpha alone would leave colour behind where there
    // is no longer any coverage to carry it, which reads as a bright fringe.
    // Backdrop stays display-referred — no linear round-trip.
    co = d.rgb * k;
    ao = ad * k;
    skipEncode = true;
  } else if (mode == 35 || mode == 36) {
    // ── M5 (35-36): Dissolve / Dancing Dissolve ──
    // Not a blend: coverage becomes a COIN FLIP. Each comp-grid pixel shows
    // the source at full opacity with probability equal to its coverage (as1,
    // which already folds texture alpha × layer opacity), else the backdrop
    // passes through untouched. The hash is the same integer mix Roughen uses
    // — deterministic, no clock in the shader — and the grid is the COMP's
    // (comp size on cr1.xy), so a zoomed preview and the export speckle
    // identically. cr0.z is 0 for Dissolve (a pattern that holds still) and
    // the frame index for Dancing (a pattern that boils).
    let px = u32(clamp(floor(uv.x * obj.cr1.x), 0.0, 16777215.0));
    let py = u32(clamp(floor(uv.y * obj.cr1.y), 0.0, 16777215.0));
    let dk = u32(max(obj.cr0.z, 0.0) + 0.5);
    var h : u32 = (px + 1u) * 374761393u + (py + 1u) * 668265263u + dk * 2246822519u;
    h = (h ^ (h >> 13u)) * 1274126177u;
    h = h ^ (h >> 16u);
    let n = f32(h) / 4294967296.0;
    if (n < as1) {
      // Shown: the source's own colour, hard and opaque — dissolve trades
      // translucency for speckle density. Straight colour in STORAGE space,
      // so no linear round-trip and no encode below.
      co = min(s.rgb / max(as1, 1e-6), vec3<f32>(1.0));
      ao = 1.0;
      // Preserve Underlying Transparency composes here too: the speckle is
      // clipped to the backdrop's coverage instead of adding opacity.
      if (obj.cr0.y > 0.5) {
        co = co * ad;
        ao = ad;
      }
    } else {
      co = d.rgb;
      ao = ad;
    }
    skipEncode = true;
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
  // a meaningful composition with them — nor to dissolve (35-36), which
  // composed it inside its own branch.
  if (obj.cr0.y > 0.5 && mode < 31) {
    co = ad * (as1 * B + (1.0 - as1) * cb);
    ao = ad;
  }
  // Encode linear premul → storage space (identity when RTs already store linear).
  if (!skipEncode && ao > 0.0001) {
    let straight = min(co / ao, vec3<f32>(1.0));
    co = workingToStorage(straight) * ao;
  }
  return vec4<f32>(co, ao);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
in vec2 vUv;
out vec4 frag;
${BLEND_COMBINE_GLSL_HELPERS}
${SRGB_TRANSFER_GLSL}
void main() {
  vec4 s = texture(uTex, vUv);
  vec4 d = texture(uMaskTex, vUv);
  float as1 = s.a, ad = d.a;
  vec3 cs = as1 > 0.0 ? storageToWorking(min(s.rgb / as1, vec3(1.0))) : vec3(0.0);
  vec3 cb = ad > 0.0 ? storageToWorking(min(d.rgb / ad, vec3(1.0))) : vec3(0.0);
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
  bool skipEncode = false;
  if (mode == 29) {
    // Alpha Add — standard alpha (as + ad - as*ad) makes two touching
    // anti-aliased 50% edges composite to 75% and leave a seam. Adding closes it.
    ao = min(1.0, as1 + ad);
  } else if (mode == 30) {
    // Luminescent Premul — treat the source as already premultiplied and add,
    // keeping colour that exceeds its own alpha instead of clipping it.
    vec3 sLin = s.rgb;
    vec3 dLin = d.rgb;
    if (as1 > 0.0) sLin = storageToWorking(min(s.rgb / as1, vec3(1.0))) * as1;
    if (ad > 0.0) dLin = storageToWorking(min(d.rgb / ad, vec3(1.0))) * ad;
    co = sLin + (1.0 - as1) * dLin;
  } else if (mode >= 31 && mode <= 34) {
    // Matte family (31-34): Stencil / Silhouette. The layer contributes no
    // colour; it scales the coverage of the whole backdrop beneath it.
    // Premultiplied throughout, so all four channels scale together — scaling
    // alpha alone would leave colour with no coverage to carry it.
    // Must match the WGSL branch above.
    float k = matteFactor(mode, s);
    co = d.rgb * k;
    ao = ad * k;
    skipEncode = true;
  } else if (mode == 35 || mode == 36) {
    // ── M5 (35-36): Dissolve / Dancing Dissolve ──
    // Coverage becomes a per-pixel coin flip on the COMP grid (comp size on
    // cr1.xy); cr0.z is 0 for Dissolve, the frame index for Dancing. Integer
    // hash, so both dialects and every zoom agree. Must match the WGSL branch
    // above.
    uint px = uint(clamp(floor(vUv.x * cr1.x), 0.0, 16777215.0));
    uint py = uint(clamp(floor(vUv.y * cr1.y), 0.0, 16777215.0));
    uint dk = uint(max(cr0.z, 0.0) + 0.5);
    uint h = (px + 1u) * 374761393u + (py + 1u) * 668265263u + dk * 2246822519u;
    h = (h ^ (h >> 13u)) * 1274126177u;
    h = h ^ (h >> 16u);
    float n = float(h) / 4294967296.0;
    if (n < as1) {
      // Shown: hard, opaque source colour in storage space — no encode below.
      co = min(s.rgb / max(as1, 1e-6), vec3(1.0));
      ao = 1.0;
      // Preserve Underlying Transparency clips the speckle to the backdrop.
      if (cr0.y > 0.5) {
        co = co * ad;
        ao = ad;
      }
    } else {
      co = d.rgb;
      ao = ad;
    }
    skipEncode = true;
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
  // a meaningful composition with them — nor to dissolve (35-36), which
  // composed it inside its own branch.
  if (cr0.y > 0.5 && mode < 31) {
    co = ad * (as1 * B + (1.0 - as1) * cb);
    ao = ad;
  }
  if (!skipEncode && ao > 0.0001) {
    vec3 straight = min(co / ao, vec3(1.0));
    co = workingToStorage(straight) * ao;
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

${SRGB_TRANSFER_WGSL}
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
  //
  // Accumulate in linear-premul so glow/blur falloff matches lit light rather
  // than gamma-space grey. Helpers are identity when LINEAR_WORKING_SPACE is off.
  let sigma = r;
  let steps = 30;
  let spacing = max(1.0, (sigma * 2.5) / f32(steps));
  for(var i = -steps; i <= steps; i = i + 1) {
    let off = f32(i) * spacing;
    let w = exp(-0.5 * (off * off) / (sigma * sigma));
    let t = textureSample(tex, smp, uv + dir * off);
    var lin = t;
    if (t.a > 0.0001) {
      let straight = min(t.rgb / t.a, vec3<f32>(1.0));
      lin = vec4<f32>(storageToWorking(straight) * t.a, t.a);
    }
    c = c + lin * w;
    total = total + w;
  }
  let avg = c / total;
  if (avg.a > 0.0001) {
    let straight = min(avg.rgb / avg.a, vec3<f32>(1.0));
    return vec4<f32>(workingToStorage(straight) * avg.a, avg.a);
  }
  return avg;
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
${SRGB_TRANSFER_GLSL}
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
  // Linear-premul accumulate; helpers are identity when the kill switch is off.
  float sigma = r;
  const int steps = 30;
  float spacing = max(1.0, (sigma * 2.5) / float(steps));
  for(int i = -steps; i <= steps; i++) {
    float off = float(i) * spacing;
    float w = exp(-0.5 * (off * off) / (sigma * sigma));
    vec4 t = texture(uTex, vUv + dir * off);
    vec4 lin = t;
    if (t.a > 0.0001) {
      vec3 straight = min(t.rgb / t.a, vec3(1.0));
      lin = vec4(storageToWorking(straight) * t.a, t.a);
    }
    c += lin * w;
    total += w;
  }
  vec4 avg = c / total;
  if (avg.a > 0.0001) {
    vec3 straight = min(avg.rgb / avg.a, vec3(1.0));
    frag = vec4(workingToStorage(straight) * avg.a, avg.a);
  } else {
    frag = avg;
  }
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

/**
 * Bend — AE's CC Bender: curl the layer around an axis, like bending a strip.
 *
 * ── Why this is one sample and no iteration ──────────────────────────────────
 *
 * A warp shader is an INVERSE map: for the pixel being written, find where in
 * the source it came from. Most bend implementations approximate that with a
 * fixed-point solve because the profile makes the forward map hard to invert.
 * It does not have to be. Model the bend as a circular arc and every step has a
 * closed form:
 *
 *   forward   x = (R - v)·sin(θ·w),  y = R - (R - v)·cos(θ·w)
 *   inverse   r = |(x, R - y)|,  v = R - r,  φ = atan2(x, R - y),  w = φ/θ
 *
 * with R = L/θ the arc radius for total angle θ over span L. The only remaining
 * piece is undoing the STYLE profile w = f(t), and all three of AE's are
 * analytically invertible — see `bendProfileInv`. So the whole effect is one
 * `textureSample` per pixel.
 *
 * Outside the bend span the map stays exact rather than clamping: before the
 * start the layer is untouched, and past the end it is a RIGID rotation by θ
 * about the arc's end point. Clamping there instead would smear the last row of
 * the bend across everything below it.
 */
export const BEND: ShaderSource = {
  name: 'bend',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
// Undo the style profile: given how far through the bend a pixel is, recover
// how far along the SOURCE strip it came from. Exact for all three styles.
fn bendProfileInv(w : f32, style : f32) -> f32 {
  if (style < 0.5) {
    // Marilyn — smoothstep 3t²−2t³. Its real root, via the trigonometric
    // solution of the depressed cubic.
    return 0.5 - sin(asin(clamp(1.0 - 2.0 * w, -1.0, 1.0)) / 3.0);
  }
  if (style < 1.5) { return w; }            // Sharp — linear ramp, a crease
  return asin(clamp(w, 0.0, 1.0)) * 0.63661977;  // Circular — sin(t·π/2), ×2/π
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let theta   = obj.p0.x;
  let style   = obj.p0.y;
  let aspect  = obj.p0.z;
  let outside = obj.p0.w;   // 0 = carry the remainder, 1 = hold it still
  let top     = obj.p1.xy;  // bend line start, aspect-corrected layer units
  let base    = obj.p1.zw;  // bend line end

  /*
    LAYER-LOCAL via fxBox, NOT uvRect.

    On the 2D route the chain's buffer is SCREEN SPACE and the layer is a
    sub-rect of it. uvRect addresses the quad within that buffer, which is not
    the same thing. Deriving layer coordinates from uvRect therefore bends the
    whole buffer instead of the layer: content sweeps hundreds of pixels
    outside the layer box, which is exactly what it did. fxBox is the layer's
    box within the buffer, and it is the quantity Beam and Gradient Ramp
    already resolve against for this same reason.

    Then ASPECT-CORRECTED: UV is anisotropic on a non-square layer, which would
    shear any bend line that is not exactly axis-aligned. Working in units of
    the layer's HEIGHT makes distance mean the same thing on both axes.

    Outside the layer box there is nothing to bend, so those pixels pass
    through untouched rather than being dragged into the arc.
  */
  let box = obj.fxBox;
  let l = (uv - box.xy) / max(box.zw, vec2<f32>(0.000001, 0.000001));
  let q = vec2<f32>(l.x * aspect, l.y);

  // The two points ARE the bend: direction and span both come from them, so
  // there is no separate axis or extent to disagree with them.
  let axis = base - top;
  let L    = length(axis);

  var srcQ = q;
  if (abs(theta) > 0.0001 && L > 0.0001) {
    let d = axis / L;
    let n = vec2<f32>(-d.y, d.x);
    let rel = q - top;
    let a = dot(rel, d);      // 0 at Top, L at Base
    /*
      MIRROR a negative bend rather than signing the arc.

      A negative angle puts the arc centre on the OTHER side of the strip, so
      R = L/theta goes negative, dy = R - b with it, and atan2(a, dy)/theta
      comes out NEGATIVE for the whole band — which lands in the untouched
      "before Top" case below. The result is that a negative Amount did
      nothing at all, and because nothing ever reached the past-Base region,
      Style and Past Base looked dead too.

      Solving the POSITIVE problem in a frame flipped across the bend line, and
      flipping the answer back, keeps one code path and makes the two
      directions exactly symmetric.
    */
    let sgn = select(-1.0, 1.0, theta >= 0.0);
    let th = abs(theta);
    let b = dot(rel, n) * sgn;
    let R = L / th;
    let dy = R - b;
    let r  = length(vec2<f32>(a, dy));
    let w  = atan2(a, dy) / th;
    var sa = a;
    var sb = b;
    if (w > 1.0 && outside < 0.5) {
      /*
        CARRY (AE's CC Bender): past Base the remainder is rigid, rotated by the
        full bend — the object hinges and everything below the hinge swings.
      */
      let ce = cos(th); let se = sin(th);
      let ex = R * se; let ey = R - R * ce;
      let rx = a - ex;  let ry = b - ey;
      sa = L + (rx * ce + ry * se);
      sb = -rx * se + ry * ce;
    } else if (w > 1.0) {
      /*
        HOLD: past Base the layer is left exactly where it was, so the bend is
        confined to the Top→Base band and nothing else in the object moves.
        sa/sb are already a/b, so this branch deliberately does nothing — it
        exists to stop the carry branch above from claiming this region.
      */
    } else if (w >= 0.0) {
      sa = bendProfileInv(w, style) * L;
      sb = R - r;
    }
    // Before Top (w < 0) the layer is untouched, which is sa/sb as initialised.
    srcQ = top + d * sa + n * (sb * sgn);
  }

  let src = vec2<f32>(srcQ.x / aspect, srcQ.y);
  // A bend pulls source coordinates off the layer; those pixels are empty, not
  // the edge smeared outwards, so this reads transparent rather than clamping.
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  // Back to BUFFER uv through the layer's box — the inverse of the mapping at
  // the top. Going back through uvRect instead would place the sampled pixel
  // in a different part of the buffer than it was read from.
  let bufUv = box.xy + src * box.zw;
  // textureSampleLEVEL, not textureSample. The plain form computes implicit
  // derivatives, and WGSL requires UNIFORM CONTROL FLOW for those — the bounds
  // check above is an early return, which makes this call non-uniform. Tint
  // rejects the module, pipeline creation fails, the effect pass draws nothing,
  // and because the chain relies on a draw to composite the layer back out the
  // LAYER DISAPPEARS. apply-color-lut and compound-blur hit this first; see the
  // note in compound-blur.
  return textureSampleLevel(tex, smp, bufUv, 0.0);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
// MUST match the fragment stage's block exactly, member for member. Two stages
// declaring the same uniform block name with different members is a LINK error
// in GLSL ES 300 — so a stale copy here does not fail locally, the whole
// PROGRAM fails to build and the effect silently does nothing on WebGL2, while
// WebGPU (which has no such rule) renders it perfectly. Guarded by
// glslStageBlockParity.test.ts.
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
float bendProfileInv(float w, float style) {
  if (style < 0.5) return 0.5 - sin(asin(clamp(1.0 - 2.0 * w, -1.0, 1.0)) / 3.0);
  if (style < 1.5) return w;
  return asin(clamp(w, 0.0, 1.0)) * 0.63661977;
}
void main() {
  float theta   = p0.x;
  float style   = p0.y;
  float aspect  = p0.z;
  float outside = p0.w;
  vec2  top     = p1.xy;
  vec2  base    = p1.zw;

  // fxBox, NOT uvRect — see the WGSL note. uvRect addresses the quad within a
  // screen-space buffer; fxBox is the layer's own box inside it.
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  vec2 q = vec2(l.x * aspect, l.y);

  vec2  axis = base - top;
  float L    = length(axis);

  vec2 srcQ = q;
  if (abs(theta) > 0.0001 && L > 0.0001) {
    vec2  d = axis / L;
    vec2  n = vec2(-d.y, d.x);
    vec2  rel = q - top;
    float a = dot(rel, d);
    // Mirror a negative bend — see the WGSL note. Without this a negative
    // Amount fell into the untouched branch and did nothing.
    float sgn = (theta >= 0.0) ? 1.0 : -1.0;
    float th = abs(theta);
    float b = dot(rel, n) * sgn;
    float R = L / th;
    float dy = R - b;
    float r  = length(vec2(a, dy));
    float w  = atan(a, dy) / th;
    float sa = a;
    float sb = b;
    if (w > 1.0 && outside < 0.5) {
      // CARRY — the remainder swings with the hinge.
      float ce = cos(th); float se = sin(th);
      float ex = R * se; float ey = R - R * ce;
      float rx = a - ex;  float ry = b - ey;
      sa = L + (rx * ce + ry * se);
      sb = -rx * se + ry * ce;
    } else if (w > 1.0) {
      // HOLD — confine the bend to the Top→Base band; sa/sb stay as a/b.
    } else if (w >= 0.0) {
      sa = bendProfileInv(w, style) * L;
      sb = R - r;
    }
    srcQ = top + d * sa + n * (sb * sgn);
  }

  vec2 src = vec2(srcQ.x / aspect, srcQ.y);
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) { frag = vec4(0.0); return; }
  frag = texture(uTex, fxBox.xy + src * fxBox.zw);
}
`
  }
};

/*
 * ── Perspective family ──────────────────────────────────────────────────────
 *
 * Five effects that give a flat layer the appearance of a lit surface. Two
 * light an edge (Bevel Alpha, Bevel Edges), two map the layer onto a solid
 * (Sphere, Cylinder), one throws a cone across it (Spotlight).
 *
 * The two mapping shaders are INVERSE maps like Bend, and like Bend they are
 * exact rather than iterative: ray-casting a unit sphere or cylinder from an
 * orthographic camera is a quadratic with a closed-form root, so `z` falls out
 * as one `sqrt` and the surface normal with it. That normal then does double
 * duty — it is both where to sample the source and how much light the point
 * receives, which is why neither needs a separate lighting pass.
 *
 * Shared uniform convention across all five: `p0`/`p1` carry the geometry and
 * `lightColor` the tint, so they can share one packer shape and one material.
 */

/** Bevel Alpha — chisel the ALPHA boundary and light it from an angle. */
export const BEVEL_ALPHA: ShaderSource = {
  name: 'bevel-alpha',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let thick = max(obj.p0.x, 0.0001);
  let lightDir = vec2<f32>(obj.p0.y, obj.p0.z);
  let intensity = obj.p0.w;
  let texel = obj.p1.xy * thick;

  let c = textureSample(tex, smp, uv);
  // Central differences on ALPHA: the gradient points into the shape, so it is
  // the 2D part of the surface normal of a chamfer around the silhouette.
  let ax = textureSample(tex, smp, uv + vec2<f32>(texel.x, 0.0)).a
         - textureSample(tex, smp, uv - vec2<f32>(texel.x, 0.0)).a;
  let ay = textureSample(tex, smp, uv + vec2<f32>(0.0, texel.y)).a
         - textureSample(tex, smp, uv - vec2<f32>(0.0, texel.y)).a;
  let g = vec2<f32>(ax, ay);
  let mag = length(g);
  // Flat interior has no gradient and must stay untouched, or the whole layer
  // tints instead of just its rim.
  if (mag < 0.0001 || c.a <= 0.0) { return c; }
  let lambert = dot(g / mag, lightDir);
  // Rim strength rides the gradient magnitude, so a soft edge bevels softly.
  let shade = lambert * clamp(mag, 0.0, 1.0) * intensity;
  // Premultiplied in, premultiplied out: scale by the pixel's own alpha so the
  // highlight cannot exceed coverage (see project-motion-alpha-invariant).
  let lit = obj.lightColor.rgb * max(shade, 0.0) * c.a;
  let dark = 1.0 - clamp(-shade, 0.0, 1.0);
  return vec4<f32>(c.rgb * dark + lit, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  float thick = max(p0.x, 0.0001);
  vec2 lightDir = vec2(p0.y, p0.z);
  float intensity = p0.w;
  vec2 texel = p1.xy * thick;
  vec4 c = texture(uTex, vUv);
  float ax = texture(uTex, vUv + vec2(texel.x, 0.0)).a - texture(uTex, vUv - vec2(texel.x, 0.0)).a;
  float ay = texture(uTex, vUv + vec2(0.0, texel.y)).a - texture(uTex, vUv - vec2(0.0, texel.y)).a;
  vec2 g = vec2(ax, ay);
  float mag = length(g);
  if (mag < 0.0001 || c.a <= 0.0) { frag = c; return; }
  float lambert = dot(g / mag, lightDir);
  float shade = lambert * clamp(mag, 0.0, 1.0) * intensity;
  vec3 lit = lightColor.rgb * max(shade, 0.0) * c.a;
  float dark = 1.0 - clamp(-shade, 0.0, 1.0);
  frag = vec4(c.rgb * dark + lit, c.a);
}
`
  }
};

/** Bevel Edges — the same chisel, but on the layer's RECTANGULAR border. */
export const BEVEL_EDGES: ShaderSource = {
  name: 'bevel-edges',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let thick = max(obj.p0.x, 0.0001);
  let lightDir = vec2<f32>(obj.p0.y, obj.p0.z);
  let intensity = obj.p0.w;
  let c = textureSample(tex, smp, uv);
  // Local coordinates INSIDE the layer box, so the bevel follows the frame
  // rather than the content — that is the whole difference from Bevel Alpha.
  let l = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let dl = l.x; let dr = 1.0 - l.x; let dt = l.y; let db = 1.0 - l.y;
  let d = min(min(dl, dr), min(dt, db));
  if (d > thick) { return c; }
  // The nearest border decides which way the chamfer faces.
  var n = vec2<f32>(0.0, 0.0);
  if (d == dl) { n = vec2<f32>(-1.0, 0.0); }
  else if (d == dr) { n = vec2<f32>(1.0, 0.0); }
  else if (d == dt) { n = vec2<f32>(0.0, -1.0); }
  else { n = vec2<f32>(0.0, 1.0); }
  // Ramp to zero at the inner limit of the bevel so it does not end in a line.
  let ramp = 1.0 - d / thick;
  let shade = dot(n, lightDir) * ramp * intensity;
  let lit = obj.lightColor.rgb * max(shade, 0.0) * c.a;
  let dark = 1.0 - clamp(-shade, 0.0, 1.0);
  return vec4<f32>(c.rgb * dark + lit, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  float thick = max(p0.x, 0.0001);
  vec2 lightDir = vec2(p0.y, p0.z);
  float intensity = p0.w;
  vec4 c = texture(uTex, vUv);
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  float dl = l.x, dr = 1.0 - l.x, dt = l.y, db = 1.0 - l.y;
  float d = min(min(dl, dr), min(dt, db));
  if (d > thick) { frag = c; return; }
  vec2 n = vec2(0.0);
  if (d == dl) n = vec2(-1.0, 0.0);
  else if (d == dr) n = vec2(1.0, 0.0);
  else if (d == dt) n = vec2(0.0, -1.0);
  else n = vec2(0.0, 1.0);
  float ramp = 1.0 - d / thick;
  float shade = dot(n, lightDir) * ramp * intensity;
  vec3 lit = lightColor.rgb * max(shade, 0.0) * c.a;
  float dark = 1.0 - clamp(-shade, 0.0, 1.0);
  frag = vec4(c.rgb * dark + lit, c.a);
}
`
  }
};

/**
 * Spotlight — AE's CC Spotlight: a cone thrown across the layer.
 *
 * FROM and TO are point controls, and between them they carry the light's
 * position, its aim and its reach — "the light changes shape as they move".
 * An earlier version here used a centre plus an angle plus a radius, which
 * cannot express "shine from off-frame at that corner" without the user
 * solving for the angle themselves.
 *
 * Distances are aspect-corrected (units of the layer's height) so the cone is a
 * real cone on a non-square layer rather than an ellipse.
 */
export const SPOTLIGHT: ShaderSource = {
  name: 'spotlight',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // 'from' is a RESERVED WORD in WGSL (fine in GLSL) — naming this binding
  // 'from' failed CreateShaderModule, which invalidated the pipeline and then
  // the whole frame's command buffer: ONE spotlight blanked the ENTIRE scene.
  let fromPt    = obj.p0.xy;
  let to        = obj.p0.zw;
  let coneHalf  = max(obj.p1.x, 0.0001);
  let softness  = clamp(obj.p1.y, 0.0, 1.0);
  let intensity = obj.p1.z;
  let ambient   = obj.p1.w;
  let aspect    = obj.p2.x;
  let lightOnly = obj.p2.y;
  let reachCtl  = max(obj.p2.z, 0.0001);

  let c = textureSample(tex, smp, uv);
  let l = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let q = vec2<f32>(l.x * aspect, l.y);

  let axis = to - fromPt;
  let reach = length(axis);
  let p = q - fromPt;
  let dist = length(p);

  var cone = 1.0;
  if (reach > 0.0001 && dist > 0.00001) {
    // Angle off the From→To axis, via the dot product rather than atan2 — no
    // ±π seam to tear on.
    let ang = acos(clamp(dot(p / dist, axis / reach), -1.0, 1.0));
    /*
      Softness widens the falloff INWARD from the cone edge: 0 is a hard edge,
      1 fades from the axis outward. The inner limit is held strictly below the
      outer one — at softness 0 they would be equal, and smoothstep with
      low == high divides by zero, giving NaN for every pixel in the cone.
    */
    let inner = min(coneHalf * (1.0 - softness), coneHalf - 0.0001);
    cone = 1.0 - smoothstep(inner, coneHalf, ang);
  }
  /*
    Reach is its OWN control (AE's Height), not the From→To distance.

    Welding it to the handles is what made this effect look like it deleted the
    layer: the default handles sit half a layer-height apart, so everything
    further than that from the lamp fell to ambient — and a layer at low ambient
    on a dark composition is indistinguishable from a layer that is not there.

    Falloff plateaus through most of the reach, then softens at the edge — a
    linear decline from the lamp (smoothstep from 0) darkened the subject even
    inside the cone.
  */
  let fallInner = reachCtl * 0.65;
  let falloff = 1.0 - smoothstep(min(fallInner, reachCtl - 0.0001), reachCtl, dist);
  // var, not let - WGSL lets are immutable and the floor below reassigns.
  var lightAmt = ambient + cone * falloff * intensity;
  // Floor at ambient so the beam can only BRIGHTEN relative to the outside
  // level — never punch a hole darker than the user asked for. With the
  // default ambient of 1 the layer is unchanged outside the cone (and on an
  // adjustment layer that means the rest of the scene stays visible).
  lightAmt = max(lightAmt, ambient);
  // Multiplies the layer: a spotlight reveals what is there. Light Only drops
  // the layer's colour and keeps the beam (AE's second Render mode).
  let base = select(c.rgb, vec3<f32>(c.a, c.a, c.a), lightOnly > 0.5);
  return vec4<f32>(base * obj.lightColor.rgb * lightAmt, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; vec4 fxBox; vec4 lightColor; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; vec4 fxBox; vec4 lightColor; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec2  from = p0.xy;
  vec2  to = p0.zw;
  float coneHalf = max(p1.x, 0.0001);
  float softness = clamp(p1.y, 0.0, 1.0);
  float intensity = p1.z;
  float ambient = p1.w;
  float aspect = p2.x;
  float lightOnly = p2.y;
  // Its OWN control (AE's Height), not the From→To distance — see the WGSL note.
  float reachCtl = max(p2.z, 0.0001);

  vec4 c = texture(uTex, vUv);
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  vec2 q = vec2(l.x * aspect, l.y);

  vec2  axis = to - from;
  float reach = length(axis);
  vec2  p = q - from;
  float dist = length(p);

  float cone = 1.0;
  if (reach > 0.0001 && dist > 0.00001) {
    float ang = acos(clamp(dot(p / dist, axis / reach), -1.0, 1.0));
    float inner = min(coneHalf * (1.0 - softness), coneHalf - 0.0001);
    cone = 1.0 - smoothstep(inner, coneHalf, ang);
  }
  float fallInner = reachCtl * 0.65;
  float falloff = 1.0 - smoothstep(min(fallInner, reachCtl - 0.0001), reachCtl, dist);
  float lightAmt = ambient + cone * falloff * intensity;
  lightAmt = max(lightAmt, ambient);
  vec3 base = (lightOnly > 0.5) ? vec3(c.a) : c.rgb;
  frag = vec4(base * lightColor.rgb * lightAmt, c.a);
}
`
  }
};

/**
 * Sphere — map the layer onto a sphere (AE's CC Sphere).
 *
 * Orthographic ray-cast, so the depth is a closed form: a ray down -z hitting
 * a unit sphere solves `x² + y² + z² = 1` for the near root, i.e. one `sqrt`
 * and no iteration. The resulting vector IS the surface normal, which then does
 * double duty — inverse-rotated it gives the equirectangular source coordinate,
 * and its z component is the Lambert term for a head-on light. That is why
 * there is no separate lighting pass here.
 *
 * Rotation is applied as the INVERSE to the normal rather than forward to the
 * texture: this shader is asked "what belongs at this pixel", and spinning the
 * sphere one way means looking up the other way.
 */
export const SPHERE: ShaderSource = {
  name: 'sphere',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let radius = max(obj.p0.x, 0.0001);
  let rotX = obj.p0.y;
  let rotY = obj.p0.z;
  let shading = obj.p0.w;
  let aspect = max(obj.p1.x, 0.0001);
  let rotZ = obj.p1.y;

  // ASPECT-CORRECTED, or the sphere is an ellipse on a non-square layer: raw
  // UV compresses x by w/h, so the silhouette test below describes an oval.
  // Distances are taken in units of the layer's SHORT side, so a radius of 1
  // touches the nearer pair of edges whatever the layer's shape.
  let l = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let scale = vec2<f32>(max(aspect, 1.0), max(1.0 / aspect, 1.0));
  var p = (l - vec2<f32>(0.5, 0.5)) * 2.0 * scale / radius;
  // Rotation about the viewing axis spins the map in the plane of the screen —
  // AE's third rotation, which this shader shipped without.
  let cz = cos(-rotZ); let sz = sin(-rotZ);
  p = vec2<f32>(p.x * cz - p.y * sz, p.x * sz + p.y * cz);
  let r2 = dot(p, p);
  // Off the silhouette there is no surface, so nothing is drawn. Clamping
  // instead would smear the limb pixels across the rest of the frame.
  if (r2 > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let z = sqrt(1.0 - r2);

  // Inverse-rotate the normal: about X first, then Y, undoing the forward order.
  let cx = cos(-rotX); let sx = sin(-rotX);
  let y1 = p.y * cx - z * sx;
  let z1 = p.y * sx + z * cx;
  let cy = cos(-rotY); let sy = sin(-rotY);
  let x2 = p.x * cy + z1 * sy;
  let z2 = -p.x * sy + z1 * cy;

  // Equirectangular: longitude from atan2, latitude from asin.
  let su = fract(0.5 + atan2(x2, z2) * 0.15915494);           // ÷2π
  let sv = clamp(0.5 - asin(clamp(y1, -1.0, 1.0)) * 0.31830989, 0.0, 1.0); // ÷π
  // textureSampleLEVEL: the silhouette test above is an early return, so this
  // is non-uniform control flow and the derivative-computing form is invalid
  // WGSL. See the note in compound-blur.
  let c = textureSampleLevel(tex, smp, obj.uvRect.xy + vec2<f32>(su, sv) * obj.uvRect.zw, 0.0);
  // shading at 0 is a flat unlit map; at 1 the limb falls fully dark.
  let lam = mix(1.0, z, shading);
  return vec4<f32>(c.rgb * obj.lightColor.rgb * lam, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  float radius = max(p0.x, 0.0001);
  float rotX = p0.y, rotY = p0.z, shading = p0.w;
  float aspect = max(p1.x, 0.0001);
  float rotZ = p1.y;
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  vec2 scale = vec2(max(aspect, 1.0), max(1.0 / aspect, 1.0));
  vec2 p = (l - vec2(0.5)) * 2.0 * scale / radius;
  float cz = cos(-rotZ), sz = sin(-rotZ);
  p = vec2(p.x * cz - p.y * sz, p.x * sz + p.y * cz);
  float r2 = dot(p, p);
  if (r2 > 1.0) { frag = vec4(0.0); return; }
  float z = sqrt(1.0 - r2);
  float cx = cos(-rotX), sx = sin(-rotX);
  float y1 = p.y * cx - z * sx;
  float z1 = p.y * sx + z * cx;
  float cy = cos(-rotY), sy = sin(-rotY);
  float x2 = p.x * cy + z1 * sy;
  float z2 = -p.x * sy + z1 * cy;
  float su = fract(0.5 + atan(x2, z2) * 0.15915494);
  float sv = clamp(0.5 - asin(clamp(y1, -1.0, 1.0)) * 0.31830989, 0.0, 1.0);
  vec4 c = texture(uTex, uvRect.xy + vec2(su, sv) * uvRect.zw);
  float lam = mix(1.0, z, shading);
  frag = vec4(c.rgb * lightColor.rgb * lam, c.a);
}
`
  }
};

/**
 * Cylinder — wrap the layer around a vertical cylinder (AE's CC Cylinder).
 *
 * The same closed-form cast as Sphere reduced by one dimension: only x is
 * curved, so `z = sqrt(1 - x²)` and the axis coordinate passes straight
 * through. Source u is proportional to the surface ANGLE, not to x — that is
 * what makes the texture compress towards the limb the way a real wrap does
 * rather than merely being squashed.
 */
export const CYLINDER: ShaderSource = {
  name: 'cylinder',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let radius = max(obj.p0.x, 0.0001);
  let rot = obj.p0.y;
  let shading = obj.p0.z;

  let l = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let px = (l.x - 0.5) * 2.0 / radius;
  if (abs(px) > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let z = sqrt(1.0 - px * px);
  // Angle across the visible front half maps to the FULL texture width, so
  // rotating spins the whole image past the viewer.
  let su = fract(0.5 + asin(px) * 0.31830989 + rot * 0.15915494);
  // textureSampleLEVEL — non-uniform control flow after the silhouette test.
  let c = textureSampleLevel(tex, smp, obj.uvRect.xy + vec2<f32>(su, l.y) * obj.uvRect.zw, 0.0);
  let lam = mix(1.0, z, shading);
  return vec4<f32>(c.rgb * obj.lightColor.rgb * lam, c.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; vec4 lightColor; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  float radius = max(p0.x, 0.0001);
  float rot = p0.y, shading = p0.z;
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  float px = (l.x - 0.5) * 2.0 / radius;
  if (abs(px) > 1.0) { frag = vec4(0.0); return; }
  float z = sqrt(1.0 - px * px);
  float su = fract(0.5 + asin(px) * 0.31830989 + rot * 0.15915494);
  vec4 c = texture(uTex, uvRect.xy + vec2(su, l.y) * uvRect.zw);
  float lam = mix(1.0, z, shading);
  frag = vec4(c.rgb * lightColor.rgb * lam, c.a);
}
`
  }
};

/**
 * Arithmetic — AE's Channel ▸ Arithmetic: one operator applied per channel
 * against a constant.
 *
 * Operates on UNPREMULTIPLIED colour and re-premultiplies at the end. The
 * chain's textures are premultiplied, so applying the operator directly would
 * make every result depend on the pixel's own alpha — Multiply against a
 * half-transparent pixel would darken twice, and Difference would key off
 * coverage rather than colour.
 *
 * The three bitwise operators are AE's, and they are the reason the values are
 * authored 0..255: And/Or/Xor on a normalised float is meaningless, so they
 * round-trip through 8-bit integers exactly as AE does.
 */
export const ARITHMETIC: ShaderSource = {
  name: 'arithmetic',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn bits(x : f32) -> u32 { return u32(clamp(x, 0.0, 1.0) * 255.0 + 0.5); }
fn unbits(x : u32) -> f32 { return f32(x) / 255.0; }
fn arith(c : f32, v : f32, op : f32) -> f32 {
  if (op < 0.5)  { return c + v; }                       // Add
  if (op < 1.5)  { return c - v; }                       // Subtract
  if (op < 2.5)  { return c * v; }                       // Multiply
  if (op < 3.5)  { return abs(c - v); }                  // Difference
  if (op < 4.5)  { return max(c, v); }                   // Max
  if (op < 5.5)  { return min(c, v); }                   // Min
  if (op < 6.5)  { return select(c, 0.0, c > v); }       // Block Above
  if (op < 7.5)  { return select(c, 0.0, c < v); }       // Block Below
  if (op < 8.5)  { return unbits(bits(c) & bits(v)); }   // And
  if (op < 9.5)  { return unbits(bits(c) | bits(v)); }   // Or
  return unbits(bits(c) ^ bits(v));                      // Xor
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let op = obj.p0.x;
  let v = obj.p0.yzw;
  let clipResult = obj.p1.x;

  let src = textureSample(tex, smp, uv);
  // Straight colour: the operators describe COLOUR, not coverage.
  let a = max(src.a, 0.00001);
  let c = select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0);

  var outC = vec3<f32>(arith(c.r, v.x, op), arith(c.g, v.y, op), arith(c.b, v.z, op));
  // Clipping OFF keeps out-of-range results, which is what lets Add then
  // Subtract round-trip; ON is AE's default and matches 8-bpc behaviour.
  outC = select(outC, clamp(outC, vec3<f32>(0.0), vec3<f32>(1.0)), clipResult > 0.5);
  return vec4<f32>(outC * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
uint bits(float x) { return uint(clamp(x, 0.0, 1.0) * 255.0 + 0.5); }
float unbits(uint x) { return float(x) / 255.0; }
float arith(float c, float v, float op) {
  if (op < 0.5)  return c + v;
  if (op < 1.5)  return c - v;
  if (op < 2.5)  return c * v;
  if (op < 3.5)  return abs(c - v);
  if (op < 4.5)  return max(c, v);
  if (op < 5.5)  return min(c, v);
  if (op < 6.5)  return (c > v) ? 0.0 : c;
  if (op < 7.5)  return (c < v) ? 0.0 : c;
  if (op < 8.5)  return unbits(bits(c) & bits(v));
  if (op < 9.5)  return unbits(bits(c) | bits(v));
  return unbits(bits(c) ^ bits(v));
}
void main() {
  float op = p0.x;
  vec3 v = p0.yzw;
  float clipResult = p1.x;
  vec4 src = texture(uTex, vUv);
  float a = max(src.a, 0.00001);
  vec3 c = (src.a <= 0.0) ? vec3(0.0) : src.rgb / a;
  vec3 outC = vec3(arith(c.r, v.x, op), arith(c.g, v.y, op), arith(c.b, v.z, op));
  if (clipResult > 0.5) outC = clamp(outC, vec3(0.0), vec3(1.0));
  frag = vec4(outC * src.a, src.a);
}
`
  }
};

/*
 * ── Round-six per-pixel colour ports ─────────────────────────────────
 *
 * Six passes ported off the CPU bake. Shared rules, all inherited from
 * ARITHMETIC above:
 *   • unpremultiply → operate on STRAIGHT colour → repremultiply. The CPU
 *     kernels (the parity references, still shipped in canvas2dEffects) work
 *     on straight sRGB bytes; skipping the unpremul distorts every soft edge.
 *   • colours and levels arrive as RAW sRGB fractions, no working-space
 *     conversion, for the same parity reason.
 *   • no WGSL reserved words as identifiers, and `var` for anything
 *     reassigned — one bad shader invalidates the whole frame's submit
 *     (see the Spotlight incident note on that shader).
 */

export const VIGNETTE_FX: ShaderSource = {
  name: 'vignette',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let amount   = obj.p0.x;
  let inner    = obj.p0.y;
  let feather  = max(obj.p0.z, 0.001);
  let round    = obj.p0.w;
  let center   = obj.p1.xy;
  let aspect   = max(obj.p1.z, 0.0001);

  let src = textureSample(tex, smp, uv);
  // Layer-box coordinates, like Bend/Beam: the chain buffer is not the layer.
  let l = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let d = l - center;
  // Elliptical: per-axis normalised so the box edge midpoints sit at d = 1.
  let dEllipse = length(d * 2.0);
  // Circular: physical distance over the half-diagonal.
  let dCircle = length(vec2<f32>(d.x * aspect, d.y)) * 2.0 / length(vec2<f32>(aspect, 1.0));
  let dist = mix(dEllipse, dCircle, round);
  let t = clamp((dist - inner) / feather, 0.0, 1.0);
  let s = t * t * (3.0 - 2.0 * t);
  let k = clamp(1.0 - amount * s, 0.0, 4.0);
  // Display-referred, like the CPU kernel: decode storage, scale, re-encode.
  let aV = max(src.a, 0.00001);
  let cV = select(src.rgb / aV, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0);
  let outD = clamp(linearToSrgbRgb(cV) * k, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(srgbToLinearRgb(outD) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 fxBox; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
void main() {
  float amount = p0.x; float inner = p0.y; float feather = max(p0.z, 0.001); float roundK = p0.w;
  vec2 center = p1.xy; float aspect = max(p1.z, 0.0001);
  vec4 src = texture(uTex, vUv);
  vec2 l = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001));
  vec2 d = l - center;
  float dEllipse = length(d * 2.0);
  float dCircle = length(vec2(d.x * aspect, d.y)) * 2.0 / length(vec2(aspect, 1.0));
  float dist = mix(dEllipse, dCircle, roundK);
  float t = clamp((dist - inner) / feather, 0.0, 1.0);
  float s = t * t * (3.0 - 2.0 * t);
  float k = clamp(1.0 - amount * s, 0.0, 4.0);
  float aV = max(src.a, 0.00001);
  vec3 cV = (src.a <= 0.0) ? vec3(0.0) : src.rgb / aV;
  vec3 outD = clamp(linearToSrgbRgb(cV) * k, vec3(0.0), vec3(1.0));
  frag = vec4(srgbToLinearRgb(outD) * src.a, src.a);
}
`
  }
};

export const BLACK_AND_WHITE_FX: ShaderSource = {
  name: 'black-and-white',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn hue2rgb(p : f32, q : f32, tIn : f32) -> f32 {
  var t = tIn;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = max(src.a, 0.00001);
  let c = linearToSrgbRgb(select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0));

  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let md = c.r + c.g + c.b - mx - mn;
  // Primary weight = the channel holding the max; secondary = the pair that
  // excludes the min. Same tie behaviour as the CPU kernel (ties multiply 0).
  var wPrimary = obj.p1.x;                       // blues
  if (mx == c.r) { wPrimary = obj.p0.x; }        // reds
  else if (mx == c.g) { wPrimary = obj.p0.z; }   // greens
  var wSecondary = obj.p1.y;                     // magentas
  if (mn == c.b) { wSecondary = obj.p0.y; }      // yellows
  else if (mn == c.r) { wSecondary = obj.p0.w; } // cyans
  let grey = clamp(mn + (md - mn) * wSecondary + (mx - md) * wPrimary, 0.0, 1.0);

  var outC = vec3<f32>(grey, grey, grey);
  if (obj.p1.z > 0.5) {
    let hIn = obj.p1.w;
    let sIn = obj.p2.x;
    let q = select(grey + sIn - grey * sIn, grey * (1.0 + sIn), grey < 0.5);
    let p = 2.0 * grey - q;
    outC = vec3<f32>(hue2rgb(p, q, hIn + 1.0 / 3.0), hue2rgb(p, q, hIn), hue2rgb(p, q, hIn - 1.0 / 3.0));
  }
  return vec4<f32>(srgbToLinearRgb(outC) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
void main() {
  vec4 src = texture(uTex, vUv);
  float a = max(src.a, 0.00001);
  vec3 c = linearToSrgbRgb((src.a <= 0.0) ? vec3(0.0) : src.rgb / a);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  float wPrimary = (mx == c.r) ? p0.x : (mx == c.g) ? p0.z : p1.x;
  float wSecondary = (mn == c.b) ? p0.y : (mn == c.r) ? p0.w : p1.y;
  float grey = clamp(mn + (md - mn) * wSecondary + (mx - md) * wPrimary, 0.0, 1.0);
  vec3 outC = vec3(grey);
  if (p1.z > 0.5) {
    float hIn = p1.w; float sIn = p2.x;
    float q = (grey < 0.5) ? grey * (1.0 + sIn) : grey + sIn - grey * sIn;
    float p = 2.0 * grey - q;
    outC = vec3(hue2rgb(p, q, hIn + 1.0 / 3.0), hue2rgb(p, q, hIn), hue2rgb(p, q, hIn - 1.0 / 3.0));
  }
  frag = vec4(srgbToLinearRgb(outC) * src.a, src.a);
}
`
  }
};

export const TRITONE_FX: ShaderSource = {
  name: 'tritone',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = max(src.a, 0.00001);
  let c = linearToSrgbRgb(select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0));
  // Rec.601 — aeColor imports colorEffects.luma, and CPU parity is the contract.
  let t = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let shadows = obj.p0.xyz;
  let mid     = obj.p1.xyz;
  let high    = obj.p2.xyz;
  var mapped : vec3<f32>;
  if (t <= 0.5) { mapped = mix(shadows, mid, t * 2.0); }
  else { mapped = mix(mid, high, (t - 0.5) * 2.0); }
  let keep = obj.p0.w;
  let outC = mix(mapped, c, keep);
  return vec4<f32>(srgbToLinearRgb(clamp(outC, vec3<f32>(0.0), vec3<f32>(1.0))) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
void main() {
  vec4 src = texture(uTex, vUv);
  float a = max(src.a, 0.00001);
  vec3 c = linearToSrgbRgb((src.a <= 0.0) ? vec3(0.0) : src.rgb / a);
  float t = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 mapped = (t <= 0.5) ? mix(p0.xyz, p1.xyz, t * 2.0) : mix(p1.xyz, p2.xyz, (t - 0.5) * 2.0);
  vec3 outC = mix(mapped, c, p0.w);
  frag = vec4(srgbToLinearRgb(clamp(outC, vec3(0.0), vec3(1.0))) * src.a, src.a);
}
`
  }
};

export const PHOTO_FILTER_FX: ShaderSource = {
  name: 'photo-filter',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = max(src.a, 0.00001);
  let c = linearToSrgbRgb(select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0));
  let gel = obj.p0.xyz;
  let density = obj.p0.w;
  var outC = mix(c, c * gel, density);
  if (obj.p1.x > 0.5) {
    let lumaW = vec3<f32>(0.299, 0.587, 0.114);
    let before = dot(c, lumaW);
    let after = dot(outC, lumaW);
    // Guard the divisor: black is black under any gel.
    if (after > 0.0001) { outC = outC * (before / after); }
  }
  return vec4<f32>(srgbToLinearRgb(clamp(outC, vec3<f32>(0.0), vec3<f32>(1.0))) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
void main() {
  vec4 src = texture(uTex, vUv);
  float a = max(src.a, 0.00001);
  vec3 c = linearToSrgbRgb((src.a <= 0.0) ? vec3(0.0) : src.rgb / a);
  vec3 outC = mix(c, c * p0.xyz, p0.w);
  if (p1.x > 0.5) {
    vec3 lumaW = vec3(0.299, 0.587, 0.114);
    float before = dot(c, lumaW);
    float after = dot(outC, lumaW);
    if (after > 0.0001) outC *= before / after;
  }
  frag = vec4(srgbToLinearRgb(clamp(outC, vec3(0.0), vec3(1.0))) * src.a, src.a);
}
`
  }
};

export const THRESHOLD_FX: ShaderSource = {
  name: 'threshold',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = max(src.a, 0.00001);
  let c = linearToSrgbRgb(select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0));
  let lum = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let v = select(0.0, 1.0, lum >= obj.p0.x);
  return vec4<f32>(srgbToLinearRgb(vec3<f32>(v, v, v)) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
void main() {
  vec4 src = texture(uTex, vUv);
  float a = max(src.a, 0.00001);
  vec3 c = linearToSrgbRgb((src.a <= 0.0) ? vec3(0.0) : src.rgb / a);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float v = (lum >= p0.x) ? 1.0 : 0.0;
  frag = vec4(srgbToLinearRgb(vec3(v)) * src.a, src.a);
}
`
  }
};

export const VIBRANCE_FX: ShaderSource = {
  name: 'vibrance',
  wgsl: `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
${SRGB_TRANSFER_WGSL}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  if (src.a <= 0.0) { return src; } // invisible pixels keep their bytes (CPU parity)
  let a = max(src.a, 0.00001);
  let c = linearToSrgbRgb(src.rgb / a);
  // Rec.601 — vibrance's CPU kernel uses colorEffects.luma, not colorSpace's.
  let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let current = select((mx - mn), 0.0, mx <= 0.0);
  let amount = 1.0 + obj.p0.y + obj.p0.x * (1.0 - current);
  let outC = clamp(vec3<f32>(l, l, l) + (c - vec3<f32>(l, l, l)) * amount, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(srgbToLinearRgb(outC) * src.a, src.a);
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${SRGB_TRANSFER_GLSL}
void main() {
  vec4 src = texture(uTex, vUv);
  if (src.a <= 0.0) { frag = src; return; }
  float a = max(src.a, 0.00001);
  vec3 c = linearToSrgbRgb(src.rgb / a);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float current = (mx <= 0.0) ? 0.0 : (mx - mn);
  float amount = 1.0 + p0.y + p0.x * (1.0 - current);
  vec3 outC = clamp(vec3(l) + (c - vec3(l)) * amount, vec3(0.0), vec3(1.0));
  frag = vec4(srgbToLinearRgb(outC) * src.a, src.a);
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

/**
 * Light Sweep — soft band of light travelling across the layer.
 *
 * Matches `drawLightSweep`: a linear gradient across a band of width
 * `sweepWidth`, centred at `position` along the angle's normal. Softness
 * moves the colour-stop shoulders toward the middle. Composite modes mirror
 * the Canvas2D helper (default source-atop clips the shine to the silhouette).
 */
export const LIGHT_SWEEP: ShaderSource = {
  name: 'light-sweep',
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
  let soft = obj.params.x;
  let inten = obj.params.y;
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-12);
  let t = clamp(dot(uv - a, ab) / len2, 0.0, 1.0);
  // Approximate the soft-shouldered band with a smoothstep falloff from the
  // centre. Matches drawLightSweep visually; avoids a piecewise profile that
  // has disagreed across backends.
  let u = abs(t - 0.5) * 2.0;
  let p = inten * (1.0 - smoothstep(max(0.001, 1.0 - soft), 1.0, u));
  let add = obj.color.rgb * p;
  return vec4<f32>(src.rgb + add * src.a, src.a);
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
  vec2 a0 = ends.xy;
  vec2 a1 = ends.zw;
  vec2 ab = a1 - a0;
  float len2 = max(dot(ab, ab), 1e-12);
  float t = clamp(dot(vUv - a0, ab) / len2, 0.0, 1.0);
  float soft = params.x;
  float inten = params.y;
  float u = abs(t - 0.5) * 2.0;
  float p = inten * (1.0 - smoothstep(max(0.001, 1.0 - soft), 1.0, u));
  vec3 add = color.rgb * p;
  frag = vec4(src.rgb + add * src.a, src.a);
}
`
  }
};

/**
 * Lens Flare — source halo/core, streak, and ghosts along the optical axis
 * through the frame centre. Ghost positions/sizes match generateText.ts.
 *
 * Additive (lighter): light adds. ends = (center, mid); params =
 * (brightness, coreR, haloR, streakHalfH).
 */
export const LENS_FLARE: ShaderSource = {
  name: 'lens-flare',
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
fn ghostAlpha(d: f32, gr: f32, alpha: f32) -> f32 {
  return (1.0 - smoothstep(0.0, gr * 0.7, d)) * alpha
    + (1.0 - smoothstep(gr * 0.7, gr, d)) * alpha * 0.5;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let c = obj.ends.xy;
  let mid = obj.ends.zw;
  let b = obj.params.x;
  let coreR = obj.params.y;
  let haloR = obj.params.z;
  let streakH = obj.params.w;
  let hue = obj.color.rgb;
  var add = vec3<f32>(0.0);

  let d = length(uv - c);
  let haloT = clamp(d / max(haloR, 1e-6), 0.0, 1.0);
  let halo = select(
    mix(0.18 * b, 0.0, (haloT - 0.25) / 0.75),
    mix(0.55 * b, 0.18 * b, haloT / 0.25),
    haloT <= 0.25,
  );
  add += hue * halo;

  let coreW = (1.0 - smoothstep(0.0, coreR * 0.5, d)) * 0.95 * b;
  let coreH = (1.0 - smoothstep(coreR * 0.5, coreR, d)) * 0.5 * b;
  add += vec3<f32>(1.0) * coreW + hue * coreH;

  let sx = abs(uv.x - c.x) / max(haloR, 1e-6);
  let sy = abs(uv.y - c.y) / max(streakH, 1e-6);
  let streak = (1.0 - smoothstep(0.0, 1.0, sx)) * (1.0 - smoothstep(0.0, 1.0, sy)) * 0.35 * b;
  add += hue * streak;

  let axis = mid - c;
  let gp = array<f32, 7>(-0.35, 0.25, 0.55, 0.8, 1.15, 1.45, 1.9);
  let gs = array<f32, 7>(0.09, 0.05, 0.13, 0.07, 0.045, 0.1, 0.06);
  let span = max(haloR / 0.35, 1e-6);
  for (var i = 0; i < 7; i++) {
    let t = gp[i];
    let gxy = c + axis * (2.0 * t);
    let gr = max(span * gs[i], 1e-6);
    let alpha = 0.14 * b * (1.0 - min(1.0, abs(t) / 2.2));
    add += hue * ghostAlpha(length(uv - gxy), gr, alpha);
  }

  return vec4<f32>(src.rgb + add, min(1.0, src.a + max(add.r, max(add.g, add.b))));
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
  vec2 c = ends.xy;
  vec2 mid = ends.zw;
  float b = params.x;
  float coreR = params.y;
  float haloR = params.z;
  float streakH = params.w;
  vec3 hue = color.rgb;
  vec3 add = vec3(0.0);

  float d = length(vUv - c);
  float haloT = clamp(d / max(haloR, 1e-6), 0.0, 1.0);
  float halo = haloT <= 0.25
    ? mix(0.55 * b, 0.18 * b, haloT / 0.25)
    : mix(0.18 * b, 0.0, (haloT - 0.25) / 0.75);
  add += hue * halo;

  float coreW = (1.0 - smoothstep(0.0, coreR * 0.5, d)) * 0.95 * b;
  float coreH = (1.0 - smoothstep(coreR * 0.5, coreR, d)) * 0.5 * b;
  add += vec3(1.0) * coreW + hue * coreH;

  float sx = abs(vUv.x - c.x) / max(haloR, 1e-6);
  float sy = abs(vUv.y - c.y) / max(streakH, 1e-6);
  float streak = (1.0 - smoothstep(0.0, 1.0, sx)) * (1.0 - smoothstep(0.0, 1.0, sy)) * 0.35 * b;
  add += hue * streak;

  vec2 axis = mid - c;
  float gp[7] = float[](-0.35, 0.25, 0.55, 0.8, 1.15, 1.45, 1.9);
  float gs[7] = float[](0.09, 0.05, 0.13, 0.07, 0.045, 0.1, 0.06);
  float span = max(haloR / 0.35, 1e-6);
  for (int i = 0; i < 7; i++) {
    float t = gp[i];
    vec2 gxy = c + axis * 2.0 * t;
    float gr = max(span * gs[i], 1e-6);
    float alpha = 0.14 * b * (1.0 - min(1.0, abs(t) / 2.2));
    float gd = length(vUv - gxy);
    float ga = (1.0 - smoothstep(0.0, gr * 0.7, gd)) * alpha
      + (1.0 - smoothstep(gr * 0.7, gr, gd)) * alpha * 0.5;
    add += hue * ga;
  }

  frag = vec4(src.rgb + add, min(1.0, src.a + max(add.r, max(add.g, add.b))));
}
`
  }
};

/**
 * Light Rays — wedges from a centre with the same LCG as drawLightRays.
 *
 * centre = ends.xy; rayLengthUV = ends.z; rayCount = ends.w;
 * params = (opacity, falloff, rotationRad, spreadArc);
 * seedComp = (seed, composite, 0, 0).
 */
export const LIGHT_RAYS: ShaderSource = {
  name: 'light-rays',
  wgsl: `
struct Object {
  mvp: mat3x3<f32>,
  uvRect: vec4<f32>,
  ends: vec4<f32>,
  params: vec4<f32>,
  seedComp: vec4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn nextRand(state: ptr<function, u32>) -> f32 {
  *state = (*state) * 22695477u + 1u;
  return f32(*state) * (1.0 / 4294967296.0);
}
fn angDiff(a: f32, b: f32) -> f32 {
  var d = a - b;
  d = d - 6.28318530718 * floor((d + 3.14159265359) / 6.28318530718);
  return d;
}
fn radialFalloff(t: f32, falloff: f32, a: f32) -> f32 {
  let mid = max(0.001, 1.0 - falloff);
  let r0 = mix(a, a * 0.35, t / mid);
  let r1 = mix(a * 0.35, 0.0, (t - mid) / max(1.0 - mid, 1e-5));
  return select(r1, r0, t <= mid);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let c = obj.ends.xy;
  let maxLen = max(obj.ends.z, 1e-6);
  let n = i32(clamp(obj.ends.w, 1.0, 128.0));
  let opac = obj.params.x;
  let falloff = obj.params.y;
  let rot = obj.params.z;
  var arc = obj.params.w;
  if (arc <= 1e-5) { arc = 6.28318530718; }
  let hue = obj.color.rgb;
  var state: u32 = u32(obj.seedComp.x) * 22695477u + 1u;
  let delta = uv - c;
  let dist = length(delta);
  let pang = atan2(delta.y, delta.x);
  var add = 0.0;
  let nf = f32(n);
  for (var i = 0; i < 128; i++) {
    if (i >= n) { break; }
    let fi = f32(i);
    let jitter = (nextRand(&state) - 0.5) * (arc / nf) * 0.6;
    let ang = rot + (fi / nf) * arc - arc * 0.5 + jitter;
    let len = maxLen * (0.55 + nextRand(&state) * 0.45);
    let halfW = (arc / nf) * 0.35;
    let da = abs(angDiff(pang, ang));
    if (da < halfW && dist < len) {
      let lat = 1.0 - da / max(halfW, 1e-5);
      let t = clamp(dist / len, 0.0, 1.0);
      add += lat * radialFalloff(t, falloff, opac);
    }
  }
  let rgb = hue * add;
  let mode = obj.seedComp.y;
  if (mode < 0.5) {
    let outA = add + src.a * (1.0 - add);
    return vec4<f32>(rgb * add + src.rgb * src.a * (1.0 - add), outA);
  }
  // Default lighter (1) and other modes — additive shine.
  return vec4<f32>(src.rgb + rgb, min(1.0, src.a + add));
}
`,
  glsl: {
    vertex: `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object {
  mat3 mvp; vec4 uvRect; vec4 ends; vec4 params; vec4 seedComp; vec4 color;
};
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: `#version 300 es
precision highp float;
layout(std140) uniform Object {
  mat3 mvp; vec4 uvRect; vec4 ends; vec4 params; vec4 seedComp; vec4 color;
};
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
uint nextRand(inout uint state) {
  state = state * 22695477u + 1u;
  return state;
}
float rand01(inout uint state) {
  return float(nextRand(state)) / 4294967296.0;
}
float angDiff(float a, float b) {
  float d = a - b;
  d = d - 6.28318530718 * floor((d + 3.14159265359) / 6.28318530718);
  return d;
}
float radialFalloff(float t, float falloff, float a) {
  float mid = max(0.001, 1.0 - falloff);
  if (t <= mid) return mix(a, a * 0.35, t / mid);
  return mix(a * 0.35, 0.0, (t - mid) / max(1.0 - mid, 1e-5));
}
void main() {
  vec4 src = texture(uTex, vUv);
  vec2 c = ends.xy;
  float maxLen = max(ends.z, 1e-6);
  int n = int(clamp(ends.w, 1.0, 128.0));
  float opac = params.x;
  float falloff = params.y;
  float rot = params.z;
  float arc = params.w;
  if (arc <= 1e-5) arc = 6.28318530718;
  vec3 hue = color.rgb;
  uint state = uint(seedComp.x) * 22695477u + 1u;
  vec2 delta = vUv - c;
  float dist = length(delta);
  float pang = atan(delta.y, delta.x);
  float add = 0.0;
  float nf = float(n);
  for (int i = 0; i < 128; i++) {
    if (i >= n) break;
    float fi = float(i);
    float jitter = (rand01(state) - 0.5) * (arc / nf) * 0.6;
    float ang = rot + (fi / nf) * arc - arc * 0.5 + jitter;
    float len = maxLen * (0.55 + rand01(state) * 0.45);
    float halfW = (arc / nf) * 0.35;
    float da = abs(angDiff(pang, ang));
    if (da < halfW && dist < len) {
      float lat = 1.0 - da / max(halfW, 1e-5);
      float t = clamp(dist / len, 0.0, 1.0);
      add += lat * radialFalloff(t, falloff, opac);
    }
  }
  vec3 rgb = hue * add;
  float mode = seedComp.y;
  if (mode < 0.5) {
    float outA = add + src.a * (1.0 - add);
    frag = vec4(rgb * add + src.rgb * src.a * (1.0 - add), outA);
  } else {
    frag = vec4(src.rgb + rgb, min(1.0, src.a + add));
  }
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
  /*
    Two-sided or one-sided, from the lit flag.

    eyeLit.w: 0 = unlit, 1 = lit TWO-SIDED, 2 = lit ONE-SIDED. Encoded in the
    existing flag rather than a new uniform slot, so the shade tail's std140
    layout is untouched.

    Two-sided (abs) is right for the app's primitive — a 2D layer in space has
    no inside, and a layer seen from behind should still light. It is wrong for
    a face that BOUNDS A VOLUME: with abs(), a box lit hard from one side comes
    out lit identically on both, which is what "it doesn't read as a solid"
    actually was. Only an extrusion's walls and back cap set 2.
  */
  let twoSided = select(1.0, 0.0, obj.eyeLit.w > 1.5);
  let N = normalize(obj.model[2].xyz);
  let count = i32(obj.shadeParams.x + 0.5);
  let specI = obj.shadeParams.y;
  let metal = obj.shadeParams.w;
  // shadeParams.z is Blinn-Phong shininess when positive, and −roughness when
  // the PBR model is selected (see packShade3D). Same slot, same layout.
  let pbr = obj.shadeParams.z < 0.0;
  let rough = clamp(-obj.shadeParams.z, 0.02, 1.0);
  let alpha2 = rough * rough * rough * rough; // GGX α = roughness², squared again in D
  // F0: a dielectric reflects ~4 % at normal incidence at the default
  // Specular Intensity (0.5), scaled by that intensity so the slider keeps its
  // AE meaning — 0 is no highlight, 1 is a lacquer. A metal reflects its own
  // colour; the metal slider blends between the two.
  let F0 = mix(vec3<f32>(0.08 * obj.shadeParams.y), baseRgb, metal);
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
      lambert = mix(max(dot(N, aim), 0.0), abs(dot(N, aim)), twoSided);
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
        lambert = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
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
    if (pbr) {
      // Cook-Torrance: D (GGX) · G (Smith-Schlick) · F (Schlick) / (4 N·L N·V),
      // times the light's radiance N·L; diffuse is what Fresnel leaves and
      // metals have none. Two-sided surfaces use |N·x| like the Phong path.
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      let NdotL = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
      let NdotV = max(mix(max(dot(N, V), 0.0), abs(dot(N, V)), twoSided), 1e-4);
      let NdotH = mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided);
      let VdotH = max(dot(V, H), 0.0);
      let dd = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      let D = alpha2 / (3.14159265 * dd * dd);
      let kG = (rough + 1.0) * (rough + 1.0) / 8.0;
      let G = (NdotL / (NdotL * (1.0 - kG) + kG)) * (NdotV / (NdotV * (1.0 - kG) + kG));
      let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      let specular = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);
      let kd = (vec3<f32>(1.0) - F) * (1.0 - metal);
      diff = diff + colGain.rgb * gain * atten * NdotL * kd;
      spec = spec + colGain.rgb * gain * atten * NdotL * specular;
      continue;
    }
    diff = diff + colGain.rgb * k;
    if (specI > 0.0) {
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      spec = spec + colGain.rgb * (gain * atten * pow(mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided), shin));
    }
  }
  diff = clamp(diff, vec3<f32>(0.0), vec3<f32>(4.0));
  if (pbr) {
    // Diffuse is already Fresnel-weighted; the specular lobe is radiance, not
    // an intensity-scaled highlight, so specI does not apply.
    return baseRgb * diff + clamp(spec, vec3<f32>(0.0), vec3<f32>(8.0));
  }
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
  // eyeLit.w: 0 unlit, 1 lit two-sided, 2 lit one-sided. See the WGSL twin.
  float twoSided = eyeLit.w > 1.5 ? 0.0 : 1.0;
  vec3 N = normalize(model[2].xyz);
  int count = int(shadeParams.x + 0.5);
  float specI = shadeParams.y;
  float metal = shadeParams.w;
  // shadeParams.z is Blinn-Phong shininess when positive, and −roughness when
  // the PBR model is selected (see packShade3D). Same slot, same layout.
  bool pbr = shadeParams.z < 0.0;
  float rough = clamp(-shadeParams.z, 0.02, 1.0);
  float alpha2 = rough * rough * rough * rough;
  // F0: 8 % × Specular Intensity for dielectrics (0.5 → the canonical 4 %),
  // the surface colour for metals.
  vec3 F0 = mix(vec3(0.08 * shadeParams.y), baseRgb, metal);
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
      lambert = mix(max(dot(N, aim), 0.0), abs(dot(N, aim)), twoSided);
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
        lambert = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
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
    if (pbr) {
      // Cook-Torrance: D (GGX) · G (Smith-Schlick) · F (Schlick) / (4 N·L N·V).
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      float NdotL = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
      float NdotV = max(mix(max(dot(N, V), 0.0), abs(dot(N, V)), twoSided), 1e-4);
      float NdotH = mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided);
      float VdotH = max(dot(V, H), 0.0);
      float dd = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      float D = alpha2 / (3.14159265 * dd * dd);
      float kG = (rough + 1.0) * (rough + 1.0) / 8.0;
      float G = (NdotL / (NdotL * (1.0 - kG) + kG)) * (NdotV / (NdotV * (1.0 - kG) + kG));
      vec3 F = F0 + (vec3(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      vec3 specular = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);
      vec3 kd = (vec3(1.0) - F) * (1.0 - metal);
      diff += colGain.rgb * gain * atten * NdotL * kd;
      spec += colGain.rgb * gain * atten * NdotL * specular;
      continue;
    }
    diff += colGain.rgb * k;
    if (specI > 0.0) {
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      spec += colGain.rgb * (gain * atten * pow(mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided), shin));
    }
  }
  diff = clamp(diff, vec3(0.0), vec3(4.0));
  if (pbr) {
    return baseRgb * diff + clamp(spec, vec3(0.0), vec3(8.0));
  }
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
  srcSpace : vec4<f32>,
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
  /*
    Two-sided or one-sided, from the lit flag.

    eyeLit.w: 0 = unlit, 1 = lit TWO-SIDED, 2 = lit ONE-SIDED. Encoded in the
    existing flag rather than a new uniform slot, so the shade tail's std140
    layout is untouched.

    Two-sided (abs) is right for the app's primitive — a 2D layer in space has
    no inside, and a layer seen from behind should still light. It is wrong for
    a face that BOUNDS A VOLUME: with abs(), a box lit hard from one side comes
    out lit identically on both, which is what "it doesn't read as a solid"
    actually was. Only an extrusion's walls and back cap set 2.
  */
  let twoSided = select(1.0, 0.0, obj.eyeLit.w > 1.5);
  let N = normalize(obj.model[2].xyz);
  let count = i32(obj.shadeParams.x + 0.5);
  let specI = obj.shadeParams.y;
  let metal = obj.shadeParams.w;
  // shadeParams.z is Blinn-Phong shininess when positive, and −roughness when
  // the PBR model is selected (see packShade3D). Same slot, same layout.
  let pbr = obj.shadeParams.z < 0.0;
  let rough = clamp(-obj.shadeParams.z, 0.02, 1.0);
  let alpha2 = rough * rough * rough * rough; // GGX α = roughness², squared again in D
  // F0: a dielectric reflects ~4 % at normal incidence at the default
  // Specular Intensity (0.5), scaled by that intensity so the slider keeps its
  // AE meaning — 0 is no highlight, 1 is a lacquer. A metal reflects its own
  // colour; the metal slider blends between the two.
  let F0 = mix(vec3<f32>(0.08 * obj.shadeParams.y), baseRgb, metal);
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
      lambert = mix(max(dot(N, aim), 0.0), abs(dot(N, aim)), twoSided);
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
        lambert = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
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
    if (pbr) {
      // Cook-Torrance: D (GGX) · G (Smith-Schlick) · F (Schlick) / (4 N·L N·V),
      // times the light's radiance N·L; diffuse is what Fresnel leaves and
      // metals have none. Two-sided surfaces use |N·x| like the Phong path.
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      let NdotL = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
      let NdotV = max(mix(max(dot(N, V), 0.0), abs(dot(N, V)), twoSided), 1e-4);
      let NdotH = mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided);
      let VdotH = max(dot(V, H), 0.0);
      let dd = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      let D = alpha2 / (3.14159265 * dd * dd);
      let kG = (rough + 1.0) * (rough + 1.0) / 8.0;
      let G = (NdotL / (NdotL * (1.0 - kG) + kG)) * (NdotV / (NdotV * (1.0 - kG) + kG));
      let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      let specular = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);
      let kd = (vec3<f32>(1.0) - F) * (1.0 - metal);
      diff = diff + colGain.rgb * gain * atten * NdotL * kd;
      spec = spec + colGain.rgb * gain * atten * NdotL * specular;
      continue;
    }
    diff = diff + colGain.rgb * k;
    if (specI > 0.0) {
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      spec = spec + colGain.rgb * (gain * atten * pow(mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided), shin));
    }
  }
  diff = clamp(diff, vec3<f32>(0.0), vec3<f32>(4.0));
  if (pbr) {
    // Diffuse is already Fresnel-weighted; the specular lobe is radiance, not
    // an intensity-scaled highlight, so specI does not apply.
    return baseRgb * diff + clamp(spec, vec3<f32>(0.0), vec3<f32>(8.0));
  }
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return baseRgb * diff + spec * specI * mix(vec3<f32>(1.0), baseRgb, metal);
}
`;

// GLSL twins of the above (UBO tail + light model), same layout contract.
const GLSL_TEX3D_UBO = `layout(std140) uniform Object { mat4 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; mat4 model; vec4 eyeLit; vec4 shadeParams; vec4 lights[32]; };`;

const GLSL_SHADE3D_FN = /* glsl */ `
vec3 shade3d(vec3 world, vec3 baseRgb) {
  if (eyeLit.w < 0.5) return baseRgb;
  // eyeLit.w: 0 unlit, 1 lit two-sided, 2 lit one-sided. See the WGSL twin.
  float twoSided = eyeLit.w > 1.5 ? 0.0 : 1.0;
  vec3 N = normalize(model[2].xyz);
  int count = int(shadeParams.x + 0.5);
  float specI = shadeParams.y;
  float metal = shadeParams.w;
  // shadeParams.z is Blinn-Phong shininess when positive, and −roughness when
  // the PBR model is selected (see packShade3D). Same slot, same layout.
  bool pbr = shadeParams.z < 0.0;
  float rough = clamp(-shadeParams.z, 0.02, 1.0);
  float alpha2 = rough * rough * rough * rough;
  // F0: 8 % × Specular Intensity for dielectrics (0.5 → the canonical 4 %),
  // the surface colour for metals.
  vec3 F0 = mix(vec3(0.08 * shadeParams.y), baseRgb, metal);
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
      lambert = mix(max(dot(N, aim), 0.0), abs(dot(N, aim)), twoSided);
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
        lambert = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
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
    if (pbr) {
      // Cook-Torrance: D (GGX) · G (Smith-Schlick) · F (Schlick) / (4 N·L N·V).
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      float NdotL = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
      float NdotV = max(mix(max(dot(N, V), 0.0), abs(dot(N, V)), twoSided), 1e-4);
      float NdotH = mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided);
      float VdotH = max(dot(V, H), 0.0);
      float dd = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      float D = alpha2 / (3.14159265 * dd * dd);
      float kG = (rough + 1.0) * (rough + 1.0) / 8.0;
      float G = (NdotL / (NdotL * (1.0 - kG) + kG)) * (NdotV / (NdotV * (1.0 - kG) + kG));
      vec3 F = F0 + (vec3(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      vec3 specular = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);
      vec3 kd = (vec3(1.0) - F) * (1.0 - metal);
      diff += colGain.rgb * gain * atten * NdotL * kd;
      spec += colGain.rgb * gain * atten * NdotL * specular;
      continue;
    }
    diff += colGain.rgb * k;
    if (specI > 0.0) {
      vec3 V = normalize(eyeLit.xyz - world);
      vec3 H = normalize(toLight + V);
      spec += colGain.rgb * (gain * atten * pow(mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided), shin));
    }
  }
  diff = clamp(diff, vec3(0.0), vec3(4.0));
  if (pbr) {
    return baseRgb * diff + clamp(spec, vec3(0.0), vec3(8.0));
  }
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


// ── Extruded-mesh 3D shaders ────────────────────────────────────────────────
// The mesh path for extruded objects (core/geometry/extrudeMesh.ts): real
// side walls, bevel rings and caps as ONE indexed mesh with PER-VERTEX
// normals, instead of the flat-strip quads the quad path synthesises. The
// light model is the shared `shade3d` text above, re-derived here so its
// normal comes from the interpolated vertex normal (transformed by the
// model's inverse-transpose) rather than from the quad's +Z column — a
// cylinder therefore lights as a smooth surface, and a box keeps its crisp
// edges because its corner vertices are split. Both variants use the
// textured3d Object block, so `packTextured3D` packs them.
function withVertexNormal(fn: string, lang: 'wgsl' | 'glsl'): string {
  const sig = lang === 'wgsl'
    ? ['fn shade3d(world : vec3<f32>, baseRgb : vec3<f32>) -> vec3<f32> {', 'fn shade3dN(world : vec3<f32>, nrmIn : vec3<f32>, baseRgb : vec3<f32>) -> vec3<f32> {']
    : ['vec3 shade3d(vec3 world, vec3 baseRgb) {', 'vec3 shade3dN(vec3 world, vec3 nrmIn, vec3 baseRgb) {'];
  const nrm = lang === 'wgsl'
    ? ['let N = normalize(obj.model[2].xyz);', 'let N = normalize(nrmIn);']
    : ['vec3 N = normalize(model[2].xyz);', 'vec3 N = normalize(nrmIn);'];
  for (const [from] of [sig, nrm]) {
    if (!fn.includes(from!)) throw new Error(`withVertexNormal(${lang}): no site matching ${JSON.stringify(from)}`);
  }
  return fn.split(sig[0]!).join(sig[1]!).split(nrm[0]!).join(nrm[1]!);
}
const WGSL_SHADE3D_N_FN = withVertexNormal(WGSL_SHADE3D_FN, 'wgsl');
const GLSL_SHADE3D_N_FN = withVertexNormal(GLSL_SHADE3D_FN, 'glsl');

const WGSL_MESH3D_VS = /* wgsl */ `
struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) world : vec3<f32>,
  @location(2) nrm : vec3<f32>,
};

// Inverse-transpose of the model's 3×3, so a non-uniformly scaled layer still
// lights with correct normals (and a mirrored one keeps them outward).
fn normalMatrix(m : mat3x3<f32>) -> mat3x3<f32> {
  let c0 = cross(m[1], m[2]);
  let c1 = cross(m[2], m[0]);
  let c2 = cross(m[0], m[1]);
  let det = dot(m[0], c0);
  let inv = select(1.0 / det, 1.0, abs(det) < 1e-12);
  return mat3x3<f32>(c0 * inv, c1 * inv, c2 * inv);
}

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) nrm : vec3<f32>, @location(2) uv : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 1.0);
  o.uv = obj.uvRect.xy + uv * obj.uvRect.zw;
  o.world = (obj.model * vec4<f32>(pos, 1.0)).xyz;
  let m = mat3x3<f32>(obj.model[0].xyz, obj.model[1].xyz, obj.model[2].xyz);
  o.nrm = normalMatrix(m) * nrm;
  return o;
}
`;

const GLSL_MESH3D_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 nrm;
layout(location = 2) in vec2 uv;
${GLSL_TEX3D_UBO}
out vec2 vUv;
out vec3 vWorld;
out vec3 vNrm;
mat3 normalMatrix(mat3 m) {
  vec3 c0 = cross(m[1], m[2]);
  vec3 c1 = cross(m[2], m[0]);
  vec3 c2 = cross(m[0], m[1]);
  float det = dot(m[0], c0);
  float inv = abs(det) < 1e-12 ? 1.0 : 1.0 / det;
  return mat3(c0 * inv, c1 * inv, c2 * inv);
}
void main() {
  gl_Position = mvp * vec4(pos, 1.0);
  vUv = uvRect.xy + uv * uvRect.zw;
  vWorld = (model * vec4(pos, 1.0)).xyz;
  vNrm = normalMatrix(mat3(model)) * nrm;
}
`;

/** Solid-colour extruded mesh (walls, bevels, back cap): tint is the colour. */
const MESH3D_SOLID: ShaderSource = {
  name: 'mesh3d-solid',
  wgsl: /* wgsl */ `
${WGSL_TEX3D_OBJECT}
${WGSL_MESH3D_VS}
${WGSL_SHADE3D_N_FN}
@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) world : vec3<f32>, @location(2) nrm : vec3<f32>) -> @location(0) vec4<f32> {
  let a = obj.tint.a;
  let rgb = shade3dN(world, nrm, obj.tint.rgb);
  return vec4<f32>(rgb * a, a);
}
`,
  glsl: {
    vertex: GLSL_MESH3D_VS,
    fragment: /* glsl */ `#version 300 es
precision highp float;
${GLSL_TEX3D_UBO}
in vec2 vUv;
in vec3 vWorld;
in vec3 vNrm;
out vec4 frag;
${GLSL_SHADE3D_N_FN}
void main() {
  float a = tint.a;
  vec3 rgb = shade3dN(vWorld, vNrm, tint.rgb);
  frag = vec4(rgb * a, a);
}
`,
  },
};

/** Textured extruded mesh (a cap carrying the layer's own content). Fragment
 *  stage is textured3d's, so the unpremultiply/linearize rewrites apply. */
const MESH3D_TEXTURED: ShaderSource = {
  name: 'mesh3d-textured',
  wgsl: /* wgsl */ `
${WGSL_TEX3D_OBJECT}
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
${WGSL_MESH3D_VS}
${WGSL_SHADE3D_N_FN}
@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) world : vec3<f32>, @location(2) nrm : vec3<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv) * obj.tint;
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  let lit = shade3dN(world, nrm, graded);
  return vec4<f32>(lit * c.a, c.a);
}
`,
  glsl: {
    vertex: GLSL_MESH3D_VS,
    fragment: /* glsl */ `#version 300 es
precision highp float;
${GLSL_TEX3D_UBO}
uniform sampler2D uTex;
in vec2 vUv;
in vec3 vWorld;
in vec3 vNrm;
out vec4 frag;
${GLSL_SHADE3D_N_FN}
void main() {
  vec4 c = texture(uTex, vUv) * tint;
  vec4 v = vec4(c.rgb, 1.0);
  vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);
  vec3 lit = shade3dN(vWorld, vNrm, graded);
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
  srcSpace : vec4<f32>,
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
layout(std140) uniform Object { mat3 mvp; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uv;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
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
 * Rewrite a textured shader to un-premultiply at the sample, grade in linear
 * light (when LINEAR_WORKING_SPACE is on), and write working-space premul.
 *
 * With LINEAR_INTERMEDIATE_STORAGE the encode-before-write is skipped so RTs
 * stay linear. Uploads still linearize at the sample (`src === 'srgb'`). RT
 * copies use the compile-time `'linear'` variant so they cannot be decoded
 * twice — a uniform tag at the tail of this block was not a reliable enough
 * switch (plugin-identity extra-decoded an already-linear ping-pong). LUT
 * tables stay display-referred: encode into the table, then decode the lookup
 * back to working space when storage is linear.
 *
 * Keeps the base NAME for the upload variant. The RT variant is `${name}-linear`.
 *
 * Throws at module load if a substitution site is missing. A silent no-op would
 * leave a shader that double-multiplies every premultiplied texture, which is
 * plausible-looking wrong output that no type or test signature would catch.
 * Failing at import turns it into a boot failure, which `editorBoot.smoke.test`
 * already guards.
 */
function unpremultiplyingSample(base: ShaderSource, src: 'srgb' | 'linear' = 'srgb'): ShaderSource {
  const sub = (code: string, from: string, to: string, where: string): string => {
    if (!code.includes(from)) {
      throw new Error(`unpremultiplyingSample(${base.name}): no ${where} site matching ${JSON.stringify(from)}`);
    }
    return code.split(from).join(to);
  };
  let wgsl = sub(
    sub(base.wgsl, '@fragment', `${UNPREMUL_WGSL}${SRGB_TRANSFER_WGSL}@fragment`, 'wgsl fragment entry'),
    'textureSample(tex, smp, uv) * obj.tint',
    'unpremul(textureSample(tex, smp, uv)) * obj.tint',
    'wgsl sample',
  );
  if (src !== 'linear') {
    wgsl = sub(
      wgsl,
      'let v = vec4<f32>(c.rgb, 1.0);',
      `let lin = workingFromSample(c.rgb, 0.0);
  let ws = select(lin, linearSrgbToAcesCg(lin), obj.srcSpace.y > 0.5);
  let v = vec4<f32>(ws, 1.0);`,
      'wgsl linearize',
    );
  }

  let fragment = sub(
    sub(base.glsl.fragment, 'void main()', `${UNPREMUL_GLSL}${SRGB_TRANSFER_GLSL}void main()`, 'glsl main'),
    'texture(uTex, vUv) * tint',
    'unpremul(texture(uTex, vUv)) * tint',
    'glsl sample',
  );
  if (src !== 'linear') {
    fragment = sub(
      fragment,
      'vec4 v = vec4(c.rgb, 1.0);',
      `vec3 lin = workingFromSample(c.rgb, 0.0);
  vec3 ws = srcSpace.y > 0.5 ? linearSrgbToAcesCg(lin) : lin;
  vec4 v = vec4(ws, 1.0);`,
      'glsl linearize',
    );
  }

  // LUT tables are authored in display-referred sRGB — encode after the matrix
  // and before the table. With linear storage, decode the table output back.
  if (base.name === 'lut-textured') {
    wgsl = sub(
      wgsl,
      'var graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));',
      'var graded = linearToSrgbRgb(clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0)));',
      'wgsl lut encode',
    );
    fragment = sub(
      fragment,
      'vec3 graded = clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0);',
      'vec3 graded = linearToSrgbRgb(clamp(vec3(dot(cr0, v), dot(cr1, v), dot(cr2, v)), 0.0, 1.0));',
      'glsl lut encode',
    );
    if (LINEAR_INTERMEDIATE_STORAGE) {
      wgsl = sub(wgsl, 'graded = vec3<f32>(lr, lg, lb);', 'graded = srgbToLinearRgb(vec3<f32>(lr, lg, lb));', 'wgsl lut decode');
      fragment = sub(fragment, 'graded = vec3(lr, lg, lb);', 'graded = srgbToLinearRgb(vec3(lr, lg, lb));', 'glsl lut decode');
    }
  } else if (!LINEAR_INTERMEDIATE_STORAGE) {
    if (base.name === 'textured3d' || base.name === 'mesh3d-textured') {
      wgsl = sub(wgsl, 'lit * c.a', 'linearToSrgbRgb(lit) * c.a', 'wgsl encode lit');
      fragment = sub(fragment, 'lit * c.a', 'linearToSrgbRgb(lit) * c.a', 'glsl encode lit');
    } else if (base.name === 'masked-textured3d') {
      wgsl = sub(wgsl, 'lit * a', 'linearToSrgbRgb(lit) * a', 'wgsl encode lit');
      fragment = sub(fragment, 'lit * a', 'linearToSrgbRgb(lit) * a', 'glsl encode lit');
    } else if (base.name === 'masked-textured') {
      wgsl = sub(wgsl, 'graded * a', 'linearToSrgbRgb(graded) * a', 'wgsl encode');
      fragment = sub(fragment, 'graded * a', 'linearToSrgbRgb(graded) * a', 'glsl encode');
    } else {
      // textured, deformed-mesh
      wgsl = sub(wgsl, 'graded * c.a', 'linearToSrgbRgb(graded) * c.a', 'wgsl encode');
      fragment = sub(fragment, 'graded * c.a', 'linearToSrgbRgb(graded) * c.a', 'glsl encode');
    }
  }

  return {
    name: src === 'linear' ? `${base.name}-linear` : base.name,
    wgsl,
    glsl: { ...base.glsl, fragment },
  };
}

// The silhouette fill is derived from the STRAIGHT-sampling source on purpose:
// it discards the texture's RGB and reads only alpha, which is the same value in
// either alpha space, so an un-premultiply in front of it would be dead code
// operating on a channel it never uses.
const TEXTURED_SILHOUETTE = silhouetteOf(TEXTURED);

/**
 * Final scene-color → SURFACE blit. When LINEAR_INTERMEDIATE_STORAGE is on,
 * scene-color holds linear premul and this encodes to sRGB for the canvas.
 */
const SCENE_BLIT: ShaderSource = {
  name: 'scene-blit',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
  srcSpace : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
${UNPREMUL_WGSL}${SRGB_TRANSFER_WGSL}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = unpremul(textureSample(tex, smp, uv)) * obj.tint;
  ${LINEAR_INTERMEDIATE_STORAGE
    ? 'let rgb = workingToDisplay(c.rgb, obj.srcSpace);'
    : 'let rgb = c.rgb;'}
  return vec4<f32>(rgb * c.a, c.a);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 tint; vec4 cr0; vec4 cr1; vec4 cr2; vec4 srcSpace; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
${UNPREMUL_GLSL}${SRGB_TRANSFER_GLSL}
void main() {
  vec4 c = unpremul(texture(uTex, vUv)) * tint;
  ${LINEAR_INTERMEDIATE_STORAGE
    ? 'vec3 rgb = workingToDisplay(c.rgb, srcSpace);'
    : 'vec3 rgb = c.rgb;'}
  frag = vec4(rgb * c.a, c.a);
}
`,
  },
};

export const BUILTIN_SHADERS: readonly ShaderSource[] = [
  SOLID, MATTE_COMBINE, BLEND_COMBINE, BLUR, GRADIENT_RAMP, FRACTAL_NOISE, DISPLACEMENT_MAP, COMPOUND_BLUR, APPLY_COLOR_LUT, MOTION_TILE,
  FILL, STROKE, SHARPEN, NOISE, SET_MATTE, BEAM, LIGHT_SWEEP, LENS_FLARE, LIGHT_RAYS, BEND,
  BEVEL_ALPHA, BEVEL_EDGES, SPOTLIGHT, SPHERE, CYLINDER, ARITHMETIC,
  // Round-six per-pixel colour ports.
  VIGNETTE_FX, BLACK_AND_WHITE_FX, TRITONE_FX, PHOTO_FILTER_FX, THRESHOLD_FX, VIBRANCE_FX,
  // Round-six waves 2–3: warps + neighbourhood passes (fxRoundSix.ts).
  ...FX_ROUND_SIX_SHADERS,
  SOLID3D,
  // The six families that sample a layer texture. Every one un-premultiplies.
  // Upload (`srgb`) and RT (`linear`) variants: linear storage keeps graph RTs
  // in working space, so a copy must not run the upload decode.
  unpremultiplyingSample(TEXTURED),
  unpremultiplyingSample(TEXTURED, 'linear'),
  unpremultiplyingSample(MASKED_TEXTURED),
  unpremultiplyingSample(MASKED_TEXTURED, 'linear'),
  unpremultiplyingSample(LUT_TEXTURED),
  unpremultiplyingSample(LUT_TEXTURED, 'linear'),
  unpremultiplyingSample(DEFORMED_MESH),
  unpremultiplyingSample(DEFORMED_MESH, 'linear'),
  unpremultiplyingSample(TEXTURED3D),
  unpremultiplyingSample(TEXTURED3D, 'linear'),
  unpremultiplyingSample(MASKED_TEXTURED3D),
  unpremultiplyingSample(MASKED_TEXTURED3D, 'linear'),
  MESH3D_SOLID,
  unpremultiplyingSample(MESH3D_TEXTURED),
  unpremultiplyingSample(MESH3D_TEXTURED, 'linear'),
  TEXTURED_SILHOUETTE,
  SCENE_BLIT,
  GLASS_COMPOSITE,
];
