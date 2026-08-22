/**
 * Round-six waves 2–3: warps + neighbourhood passes, ported off the CPU bake.
 *
 * One shared uniform shape: mvp + uvRect + N param vec4s + fxBox
 * (`packFxBlock`). All geometry is in LAYER PIXELS (lw/lh ride in the params)
 * so each fragment mirrors its CPU kernel's px-space maths exactly, and fxBox
 * maps layer px ↔ chain-buffer uv — the same contract Bend/Beam use.
 *
 * Every sample is textureSampleLevel/textureLod: the warps sample inside
 * NON-UNIFORM control flow, where implicit-derivative sampling is illegal in
 * WGSL and undefined in GLSL.
 *
 * Warps are pure RESAMPLES — moving a pixel is colour-space-agnostic, so they
 * skip the sRGB decode. The neighbourhood passes (find-edges, emboss,
 * colour-emboss, halftone) do byte maths, so each tap decodes to display sRGB
 * exactly as the wave-1 ports do, and outputs re-encode. Rec.601 luma
 * throughout — the CPU kernels' own weights (see the wave-1 gotcha).
 *
 * Known, deliberate approximations (the kernels stay the reference):
 *   • offset: the CPU seam blends with WRAPPING bilinear neighbours; the GPU
 *     samples the wrapped point with a clamping sampler, so the 1-px seam can
 *     differ by a blend footprint.
 *   • mosaic (mean mode) and halftone average a stratified tap grid instead of
 *     every pixel of the cell — identical on flat cells, indistinguishable on
 *     real footage at the block/dot sizes the effects exist for.
 */

import type { ShaderSource } from './builtin';
import { SRGB_TRANSFER_GLSL, SRGB_TRANSFER_WGSL } from './linearWorkingSpace';

const fxWgslProlog = (vec4s: number): string => `
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, ${Array.from({ length: vec4s }, (_, i) => `p${i}: vec4<f32>`).join(', ')}, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn layerUv(px : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> {
  return obj.fxBox.xy + (px / lwh) * obj.fxBox.zw;
}
fn samplePx(px : vec2<f32>, lwh : vec2<f32>) -> vec4<f32> {
  if (px.x < 0.0 || px.y < 0.0 || px.x > lwh.x || px.y > lwh.y) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return textureSampleLevel(tex, smp, layerUv(px, lwh), 0.0);
}
${SRGB_TRANSFER_WGSL}
fn straightSrgbPx(px : vec2<f32>, lwh : vec2<f32>) -> vec4<f32> {
  let s = samplePx(px, lwh);
  let a = max(s.a, 0.00001);
  let c = select(s.rgb / a, vec3<f32>(0.0, 0.0, 0.0), s.a <= 0.0);
  return vec4<f32>(linearToSrgbRgb(c), s.a);
}
fn lum601(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }
fn encodeOut(c : vec3<f32>, a : f32) -> vec4<f32> {
  return vec4<f32>(srgbToLinearRgb(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a);
}
`;

const fxGlslVert = (vec4s: number): string => `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; ${Array.from({ length: vec4s }, (_, i) => `vec4 p${i};`).join(' ')} vec4 fxBox; };
out vec2 vUv;
void main() { vec3 p = mvp * vec3(pos, 1.0); gl_Position = vec4(p.xy, 0.0, p.z); vUv = uvRect.xy + pos * uvRect.zw; }
`;

const fxGlslProlog = (vec4s: number): string => `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; ${Array.from({ length: vec4s }, (_, i) => `vec4 p${i};`).join(' ')} vec4 fxBox; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
vec2 layerUv(vec2 px, vec2 lwh) { return fxBox.xy + (px / lwh) * fxBox.zw; }
vec4 samplePx(vec2 px, vec2 lwh) {
  if (px.x < 0.0 || px.y < 0.0 || px.x > lwh.x || px.y > lwh.y) return vec4(0.0);
  return textureLod(uTex, layerUv(px, lwh), 0.0);
}
${SRGB_TRANSFER_GLSL}
vec4 straightSrgbPx(vec2 px, vec2 lwh) {
  vec4 s = samplePx(px, lwh);
  float a = max(s.a, 0.00001);
  vec3 c = (s.a <= 0.0) ? vec3(0.0) : s.rgb / a;
  return vec4(linearToSrgbRgb(c), s.a);
}
float lum601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 encodeOut(vec3 c, float a) { return vec4(srgbToLinearRgb(clamp(c, vec3(0.0), vec3(1.0))) * a, a); }
`;

const fxShader = (name: string, vec4s: number, wgslFs: string, glslFs: string): ShaderSource => ({
  name,
  wgsl: `${fxWgslProlog(vec4s)}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${wgslFs}
}
`,
  glsl: {
    vertex: fxGlslVert(vec4s),
    fragment: `${fxGlslProlog(vec4s)}
void main() {
${glslFs}
}
`,
  },
});

export const MIRROR_FX = fxShader('mirror', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let d = (pp.x - obj.p0.x) * obj.p0.z + (pp.y - obj.p0.y) * obj.p0.w;
  var sp = pp;
  if (d > 0.0) { sp = pp - 2.0 * d * obj.p0.zw; }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  float d = (pp.x - p0.x) * p0.z + (pp.y - p0.y) * p0.w;
  vec2 sp = (d > 0.0) ? pp - 2.0 * d * p0.zw : pp;
  frag = samplePx(sp, lwh);`);

export const OFFSET_FX = fxShader('offset', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  // Positive modulo, like the kernel — plain % keeps the dividend's sign.
  let sp = vec2<f32>(
    ((pp.x - obj.p0.x) % lwh.x + lwh.x) % lwh.x,
    ((pp.y - obj.p0.y) % lwh.y + lwh.y) % lwh.y,
  );
  if (obj.p0.z <= 0.0) { return textureSampleLevel(tex, smp, layerUv(sp, lwh), 0.0); }
  // The kernel blends BYTES — decode to display sRGB, mix there, re-encode.
  let moved = straightSrgbPx(sp, lwh);
  let orig = straightSrgbPx(pp, lwh);
  let mixed = mix(moved, orig, obj.p0.z);
  return encodeOut(mixed.rgb, mixed.a);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 sp = mod(mod(pp - p0.xy, lwh) + lwh, lwh);
  if (p0.z <= 0.0) { frag = textureLod(uTex, layerUv(sp, lwh), 0.0); return; }
  vec4 moved = straightSrgbPx(sp, lwh);
  vec4 orig = straightSrgbPx(pp, lwh);
  vec4 mixed = mix(moved, orig, p0.z);
  frag = encodeOut(mixed.rgb, mixed.a);`);

export const BULGE_FX = fxShader('bulge', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let v = pp - obj.p0.xy;
  let dist = length(v);
  let radius = obj.p0.z;
  var sp = pp;
  if (dist < radius && radius > 0.0) {
    let t = 1.0 - dist / radius;
    let f = t * t * (3.0 - 2.0 * t);
    sp = obj.p0.xy + v * (1.0 - obj.p0.w * f);
  }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 v = pp - p0.xy;
  float dist = length(v);
  float radius = p0.z;
  vec2 sp = pp;
  if (dist < radius && radius > 0.0) {
    float t = 1.0 - dist / radius;
    float f = t * t * (3.0 - 2.0 * t);
    sp = p0.xy + v * (1.0 - p0.w * f);
  }
  frag = samplePx(sp, lwh);`);

export const TWIRL_FX = fxShader('twirl', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let v = pp - obj.p0.xy;
  let dist = length(v);
  var sp = pp;
  if (dist < obj.p0.z) {
    let ang = obj.p0.w * (1.0 - dist / obj.p0.z);
    let cA = cos(ang); let sA = sin(ang);
    sp = obj.p0.xy + vec2<f32>(v.x * cA - v.y * sA, v.x * sA + v.y * cA);
  }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 v = pp - p0.xy;
  float dist = length(v);
  vec2 sp = pp;
  if (dist < p0.z) {
    float ang = p0.w * (1.0 - dist / p0.z);
    float cA = cos(ang); float sA = sin(ang);
    sp = p0.xy + vec2(v.x * cA - v.y * sA, v.x * sA + v.y * cA);
  }
  frag = samplePx(sp, lwh);`);

export const SPHERIZE_FX = fxShader('spherize', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let v = pp - obj.p0.xy;
  let dist = length(v);
  var sp = pp;
  if (dist > 0.0 && dist < obj.p0.z) {
    let nr = dist / obj.p0.z;
    // asin — the INVERSE optics; see spherizeData for why the forward form
    // warps in the wrong direction.
    let bent = (2.0 / 3.14159265) * asin(min(nr, 1.0));
    sp = obj.p0.xy + v * (1.0 + obj.p0.w * (bent / nr - 1.0));
  }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 v = pp - p0.xy;
  float dist = length(v);
  vec2 sp = pp;
  if (dist > 0.0 && dist < p0.z) {
    float nr = dist / p0.z;
    float bent = (2.0 / 3.14159265) * asin(min(nr, 1.0));
    sp = p0.xy + v * (1.0 + p0.w * (bent / nr - 1.0));
  }
  frag = samplePx(sp, lwh);`);

export const KALEIDOSCOPE_FX = fxShader('kaleidoscope', 2,
  `  let lwh = obj.p1.zw;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let seg = obj.p1.x;
  if (seg <= 0.0) { return samplePx(pp, lwh); }
  let v = pp - obj.p0.xy;
  let r = length(v) / obj.p1.y;
  var ang = atan2(v.y, v.x) - obj.p0.z;
  let seg2 = seg * 2.0;
  var a = ang - floor(ang / seg) * seg;
  let fold = ang - floor(ang / seg2) * seg2;
  if (fold >= seg) { a = seg - a; }
  ang = a + obj.p0.w;
  let sp = obj.p0.xy + vec2<f32>(cos(ang), sin(ang)) * r;
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.zw;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  float seg = p1.x;
  if (seg <= 0.0) { frag = samplePx(pp, lwh); return; }
  vec2 v = pp - p0.xy;
  float r = length(v) / p1.y;
  float ang = atan(v.y, v.x) - p0.z;
  float seg2 = seg * 2.0;
  float a = ang - floor(ang / seg) * seg;
  float fold = ang - floor(ang / seg2) * seg2;
  if (fold >= seg) a = seg - a;
  ang = a + p0.w;
  vec2 sp = p0.xy + vec2(cos(ang), sin(ang)) * r;
  frag = samplePx(sp, lwh);`);

export const RIPPLE_FX = fxShader('ripple', 3,
  `  let lwh = vec2<f32>(obj.p1.w, obj.p2.x);
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let v = pp - obj.p0.xy;
  let d = length(v);
  let rad = obj.p0.z;
  var sp = pp;
  if (d > 0.000001 && d <= rad) {
    let t = 1.0 - d / rad;
    let falloff = t * t * (3.0 - 2.0 * t) * exp(-obj.p1.z * (d / rad));
    let push = sin((d / max(0.000001, rad)) * obj.p1.x * 6.2831853 - obj.p1.y) * obj.p0.w * falloff;
    sp = obj.p0.xy + v * ((d - push) / d);
  }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = vec2(p1.w, p2.x);
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 v = pp - p0.xy;
  float d = length(v);
  float rad = p0.z;
  vec2 sp = pp;
  if (d > 0.000001 && d <= rad) {
    float t = 1.0 - d / rad;
    float falloff = t * t * (3.0 - 2.0 * t) * exp(-p1.z * (d / rad));
    float push = sin((d / max(0.000001, rad)) * p1.x * 6.2831853 - p1.y) * p0.w * falloff;
    sp = p0.xy + v * ((d - push) / d);
  }
  frag = samplePx(sp, lwh);`);

export const CHROMATIC_ABERRATION_FX = fxShader('chromatic-aberration', 3,
  `  let lwh = obj.p2.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  var vx = obj.p0.z; var vy = obj.p0.w;
  if (obj.p0.y < 0.5) {
    let dx = pp.x - obj.p1.y; let dy = pp.y - obj.p1.z;
    let r = length(vec2<f32>(dx, dy));
    if (r < 0.001) { return samplePx(pp, lwh); }
    let scale = (obj.p0.x * pow(r / obj.p1.w, obj.p1.x)) / r;
    vx = dx * scale; vy = dy * scale;
  }
  let sR = straightSrgbPx(pp - vec2<f32>(vx, vy), lwh);
  let sG = straightSrgbPx(pp, lwh);
  let sB = straightSrgbPx(pp + vec2<f32>(vx, vy), lwh);
  let a = max(sG.a, max(sR.a, sB.a));
  return encodeOut(vec3<f32>(sR.r, sG.g, sB.b), a);`,
  `  vec2 lwh = p2.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  float vx = p0.z; float vy = p0.w;
  if (p0.y < 0.5) {
    float dx = pp.x - p1.y; float dy = pp.y - p1.z;
    float r = length(vec2(dx, dy));
    if (r < 0.001) { frag = samplePx(pp, lwh); return; }
    float scale = (p0.x * pow(r / p1.w, p1.x)) / r;
    vx = dx * scale; vy = dy * scale;
  }
  vec4 sR = straightSrgbPx(pp - vec2(vx, vy), lwh);
  vec4 sG = straightSrgbPx(pp, lwh);
  vec4 sB = straightSrgbPx(pp + vec2(vx, vy), lwh);
  float a = max(sG.a, max(sR.a, sB.a));
  frag = encodeOut(vec3(sR.r, sG.g, sB.b), a);`);

export const MAGNIFY_FX = fxShader('magnify', 2,
  `  let lwh = obj.p1.zw;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return textureSampleLevel(tex, smp, uv, 0.0); }
  let v = pp - obj.p0.xy;
  let d = select(length(v), max(abs(v.x), abs(v.y)), obj.p1.x > 0.5);
  var sp = pp;
  if (d <= obj.p0.z) {
    let feath = obj.p1.y;
    let edge = obj.p0.z - feath;
    var t = 1.0;
    if (feath > 0.0) { t = 1.0 - clamp((d - edge) / feath, 0.0, 1.0); }
    let sm = t * t * (3.0 - 2.0 * t);
    sp = obj.p0.xy + v * (1.0 + (1.0 / obj.p0.w - 1.0) * sm);
  }
  return samplePx(sp, lwh);`,
  `  vec2 lwh = p1.zw;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { frag = textureLod(uTex, vUv, 0.0); return; }
  vec2 v = pp - p0.xy;
  float d = (p1.x > 0.5) ? max(abs(v.x), abs(v.y)) : length(v);
  vec2 sp = pp;
  if (d <= p0.z) {
    float feath = p1.y;
    float edge = p0.z - feath;
    float t = (feath > 0.0) ? 1.0 - clamp((d - edge) / feath, 0.0, 1.0) : 1.0;
    float sm = t * t * (3.0 - 2.0 * t);
    sp = p0.xy + v * (1.0 + (1.0 / p0.w - 1.0) * sm);
  }
  frag = samplePx(sp, lwh);`);

export const MOSAIC_FX = fxShader('mosaic', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let cols = obj.p0.x; let rows = obj.p0.y;
  let bx = floor(pp.x * cols / lwh.x);
  let by = floor(pp.y * rows / lwh.y);
  let x0 = floor(bx * lwh.x / cols); let x1 = floor((bx + 1.0) * lwh.x / cols);
  let y0 = floor(by * lwh.y / rows); let y1 = floor((by + 1.0) * lwh.y / rows);
  if (obj.p0.z > 0.5) {
    // Sharp Colors: the cell's centre pixel, exactly as the kernel takes it.
    let cxp = min(lwh.x - 1.0, floor((x0 + x1) / 2.0)) + 0.5;
    let cyp = min(lwh.y - 1.0, floor((y0 + y1) / 2.0)) + 0.5;
    return samplePx(vec2<f32>(cxp, cyp), lwh);
  }
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) {
      let sx = x0 + (x1 - x0) * (f32(i) + 0.5) / 4.0;
      let sy = y0 + (y1 - y0) * (f32(j) + 0.5) / 4.0;
      acc = acc + samplePx(vec2<f32>(sx, sy), lwh);
    }
  }
  return acc / 16.0;`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  float cols = p0.x; float rows = p0.y;
  float bx = floor(pp.x * cols / lwh.x);
  float by = floor(pp.y * rows / lwh.y);
  float x0 = floor(bx * lwh.x / cols); float x1 = floor((bx + 1.0) * lwh.x / cols);
  float y0 = floor(by * lwh.y / rows); float y1 = floor((by + 1.0) * lwh.y / rows);
  if (p0.z > 0.5) {
    float cxp = min(lwh.x - 1.0, floor((x0 + x1) / 2.0)) + 0.5;
    float cyp = min(lwh.y - 1.0, floor((y0 + y1) / 2.0)) + 0.5;
    frag = samplePx(vec2(cxp, cyp), lwh);
    return;
  }
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      float sx = x0 + (x1 - x0) * (float(i) + 0.5) / 4.0;
      float sy = y0 + (y1 - y0) * (float(j) + 0.5) / 4.0;
      acc += samplePx(vec2(sx, sy), lwh);
    }
  }
  frag = acc / 16.0;`);

export const FIND_EDGES_FX = fxShader('find-edges', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  // Clamped taps, like the kernel — skipping leaves a hairline frame.
  let cl = vec2<f32>(0.5, 0.5);
  let ch = lwh - vec2<f32>(0.5, 0.5);
  var l : array<f32, 9>;
  var idx = 0;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let tp = clamp(pp + vec2<f32>(f32(i), f32(j)), cl, ch);
      l[idx] = lum601(straightSrgbPx(tp, lwh).rgb);
      idx = idx + 1;
    }
  }
  let gx = -l[0] + l[2] - 2.0 * l[3] + 2.0 * l[5] - l[6] + l[8];
  let gy = -l[0] - 2.0 * l[1] - l[2] + l[6] + 2.0 * l[7] + l[8];
  let mag = min(1.0, length(vec2<f32>(gx, gy)));
  var v = mag;
  if (obj.p0.x > 0.5) { v = 1.0 - mag; }
  let src = straightSrgbPx(pp, lwh);
  let outC = mix(vec3<f32>(v, v, v), src.rgb, obj.p0.y);
  return encodeOut(outC, src.a);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  vec2 cl = vec2(0.5);
  vec2 ch = lwh - vec2(0.5);
  float l[9];
  int idx = 0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 tp = clamp(pp + vec2(float(i), float(j)), cl, ch);
      l[idx] = lum601(straightSrgbPx(tp, lwh).rgb);
      idx++;
    }
  }
  float gx = -l[0] + l[2] - 2.0 * l[3] + 2.0 * l[5] - l[6] + l[8];
  float gy = -l[0] - 2.0 * l[1] - l[2] + l[6] + 2.0 * l[7] + l[8];
  float mag = min(1.0, length(vec2(gx, gy)));
  float v = (p0.x > 0.5) ? 1.0 - mag : mag;
  vec4 src = straightSrgbPx(pp, lwh);
  vec3 outC = mix(vec3(v), src.rgb, p0.y);
  frag = encodeOut(outC, src.a);`);

export const EMBOSS_FX = fxShader('emboss', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let cl = vec2<f32>(0.5, 0.5);
  let ch = lwh - vec2<f32>(0.5, 0.5);
  // Whole-pixel taps, like the kernel's at() — it rounds before clamping.
  let fwd = clamp(floor(pp + obj.p0.xy) + vec2<f32>(0.5, 0.5), cl, ch);
  let bwd = clamp(floor(pp - obj.p0.xy) + vec2<f32>(0.5, 0.5), cl, ch);
  let d = lum601(straightSrgbPx(fwd, lwh).rgb) - lum601(straightSrgbPx(bwd, lwh).rgb);
  let v = clamp((128.0 + d * 255.0 * obj.p0.z) / 255.0, 0.0, 1.0);
  let src = straightSrgbPx(pp, lwh);
  let outC = mix(vec3<f32>(v, v, v), src.rgb, obj.p0.w);
  return encodeOut(outC, src.a);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  vec2 cl = vec2(0.5);
  vec2 ch = lwh - vec2(0.5);
  vec2 fwd = clamp(floor(pp + p0.xy) + vec2(0.5), cl, ch);
  vec2 bwd = clamp(floor(pp - p0.xy) + vec2(0.5), cl, ch);
  float d = lum601(straightSrgbPx(fwd, lwh).rgb) - lum601(straightSrgbPx(bwd, lwh).rgb);
  float v = clamp((128.0 + d * 255.0 * p0.z) / 255.0, 0.0, 1.0);
  vec4 src = straightSrgbPx(pp, lwh);
  vec3 outC = mix(vec3(v), src.rgb, p0.w);
  frag = encodeOut(outC, src.a);`);

export const COLOR_EMBOSS_FX = fxShader('color-emboss', 2,
  `  let lwh = obj.p1.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let cl = vec2<f32>(0.5, 0.5);
  let ch = lwh - vec2<f32>(0.5, 0.5);
  let neg = clamp(pp - obj.p0.xy, cl, ch);
  let pos = clamp(pp + obj.p0.xy, cl, ch);
  let src = straightSrgbPx(pp, lwh);
  let d = (straightSrgbPx(pos, lwh).rgb - straightSrgbPx(neg, lwh).rgb) * obj.p0.z;
  let v = clamp(src.rgb + d, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
  let outC = mix(src.rgb, v, obj.p0.w);
  return encodeOut(outC, src.a);`,
  `  vec2 lwh = p1.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  vec2 cl = vec2(0.5);
  vec2 ch = lwh - vec2(0.5);
  vec2 neg = clamp(pp - p0.xy, cl, ch);
  vec2 pos = clamp(pp + p0.xy, cl, ch);
  vec4 src = straightSrgbPx(pp, lwh);
  vec3 d = (straightSrgbPx(pos, lwh).rgb - straightSrgbPx(neg, lwh).rgb) * p0.z;
  vec3 v = clamp(src.rgb + d, vec3(0.0), vec3(1.0));
  vec3 outC = mix(src.rgb, v, p0.w);
  frag = encodeOut(outC, src.a);`);

export const HALFTONE_FX = fxShader('halftone', 4,
  `  let lwh = obj.p3.xy;
  let pp = (uv - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let cell = obj.p0.x;
  let ca = obj.p0.y; let sa = obj.p0.z;
  // The CPU kernel addresses pixels by INTEGER index; pp is centre-space, so
  // shift back half a pixel or every dot boundary lands ~0.7px off.
  let pi = pp - vec2<f32>(0.5, 0.5);
  let rx = pi.x * ca + pi.y * sa;
  let ry = -pi.x * sa + pi.y * ca;
  let cxr = floor(rx / cell); let cyr = floor(ry / cell);
  var accC = vec3<f32>(0.0, 0.0, 0.0);
  var accL = 0.0;
  var cnt = 0.0;
  for (var j = 0; j < 5; j = j + 1) {
    for (var i = 0; i < 5; i = i + 1) {
      let srx = (cxr + (f32(i) + 0.5) / 5.0) * cell;
      let sry = (cyr + (f32(j) + 0.5) / 5.0) * cell;
      let sx = srx * ca - sry * sa;
      let sy = srx * sa + sry * ca;
      if (sx >= 0.0 && sy >= 0.0 && sx <= lwh.x - 1.0 && sy <= lwh.y - 1.0) {
        let s = straightSrgbPx(vec2<f32>(sx + 0.5, sy + 0.5), lwh);
        accC = accC + s.rgb;
        accL = accL + lum601(s.rgb);
        cnt = cnt + 1.0;
      }
    }
  }
  let src = straightSrgbPx(pp, lwh);
  if (cnt <= 0.0) { return encodeOut(src.rgb, src.a); }
  let mean = accL / cnt;
  let radius = sqrt(clamp((1.0 - mean) * obj.p0.w, 0.0, 1.0)) * (cell * 0.72);
  let dxr = rx - (cxr * cell + cell / 2.0);
  let dyr = ry - (cyr * cell + cell / 2.0);
  let inside = length(vec2<f32>(dxr, dyr)) <= radius;
  var inkC = obj.p1.xyz;
  if (obj.p1.w > 0.5) { inkC = accC / cnt; }
  let tgt = select(obj.p2.xyz, inkC, inside);
  let outC = mix(src.rgb, tgt, obj.p2.w);
  return encodeOut(outC, src.a);`,
  `  vec2 lwh = p3.xy;
  vec2 pp = (vUv - fxBox.xy) / max(fxBox.zw, vec2(0.000001)) * lwh;
  float cell = p0.x;
  float ca = p0.y; float sa = p0.z;
  // The CPU kernel addresses pixels by INTEGER index; pp is centre-space, so
  // shift back half a pixel or every dot boundary lands ~0.7px off.
  vec2 pi2 = pp - vec2(0.5);
  float rx = pi2.x * ca + pi2.y * sa;
  float ry = -pi2.x * sa + pi2.y * ca;
  float cxr = floor(rx / cell); float cyr = floor(ry / cell);
  vec3 accC = vec3(0.0);
  float accL = 0.0;
  float cnt = 0.0;
  for (int j = 0; j < 5; j++) {
    for (int i = 0; i < 5; i++) {
      float srx = (cxr + (float(i) + 0.5) / 5.0) * cell;
      float sry = (cyr + (float(j) + 0.5) / 5.0) * cell;
      float sx = srx * ca - sry * sa;
      float sy = srx * sa + sry * ca;
      if (sx >= 0.0 && sy >= 0.0 && sx <= lwh.x - 1.0 && sy <= lwh.y - 1.0) {
        vec4 s = straightSrgbPx(vec2(sx + 0.5, sy + 0.5), lwh);
        accC += s.rgb;
        accL += lum601(s.rgb);
        cnt += 1.0;
      }
    }
  }
  vec4 src = straightSrgbPx(pp, lwh);
  if (cnt <= 0.0) { frag = encodeOut(src.rgb, src.a); return; }
  float mean = accL / cnt;
  float radius = sqrt(clamp((1.0 - mean) * p0.w, 0.0, 1.0)) * (cell * 0.72);
  float dxr = rx - (cxr * cell + cell / 2.0);
  float dyr = ry - (cyr * cell + cell / 2.0);
  bool inside = length(vec2(dxr, dyr)) <= radius;
  vec3 inkC = (p1.w > 0.5) ? accC / cnt : p1.xyz;
  vec3 tgt = inside ? inkC : p2.xyz;
  vec3 outC = mix(src.rgb, tgt, p2.w);
  frag = encodeOut(outC, src.a);`);

export const FX_ROUND_SIX_SHADERS: readonly ShaderSource[] = [
  MIRROR_FX, OFFSET_FX, BULGE_FX, TWIRL_FX, SPHERIZE_FX, KALEIDOSCOPE_FX,
  RIPPLE_FX, CHROMATIC_ABERRATION_FX, MAGNIFY_FX,
  MOSAIC_FX, FIND_EDGES_FX, EMBOSS_FX, COLOR_EMBOSS_FX, HALFTONE_FX,
];
