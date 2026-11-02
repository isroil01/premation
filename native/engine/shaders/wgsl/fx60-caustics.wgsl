// Caustics (caustics) -- AE's Caustics: the layer seen as the bottom of moving water, refracted, under a bright caustic light web.
// Generated from the fx60 spec (docs/PROGRAM_PERFORMANCE.md E). Layer px through fxBox.
// Stream D (2026-11-02): p3 = (bottom layer set, water layer set, water gain, 0) — the
// Bottom layer (binding 3) is what the water refracts instead of the layer itself; the Water
// layer's luminance (binding 4) is a height added to the procedural surface and lights the
// caustic web where it is bright. Unset, both bindings hold the layer: the original picture.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var bottomTex : texture_2d<f32>;
@group(0) @binding(4) var waterTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
struct Prm { scale: f32, dist: f32, inten: f32, light: vec3<f32>, strength: f32, amb: f32, t: f32, seed: f32, lw: f32, lh: f32 };
fn prm() -> Prm { return Prm(obj.p0.x, obj.p0.y, obj.p0.z, vec3<f32>(obj.p0.w, obj.p1.x, obj.p1.y), obj.p1.z, obj.p1.w, obj.p2.x, obj.p2.y, obj.p2.z, obj.p2.w); }
const PI : f32 = 3.14159265358979;
const TAU : f32 = 6.28318530717959;
var<private> gLwh : vec2<f32>;
// FIELD coordinate (top-down buffer fractions); layer px = field -> fxBox -> lwh.
fn fieldQ(uv : vec2<f32>) -> vec2<f32> { return (uv - obj.uvRect.xy) / obj.uvRect.zw; }
fn pxUv(px : vec2<f32>) -> vec2<f32> {
  let q = obj.fxBox.xy + (px / gLwh) * obj.fxBox.zw;
  return obj.uvRect.xy + q * obj.uvRect.zw;
}
fn inBox(px : vec2<f32>) -> bool { return px.x >= 0.0 && px.y >= 0.0 && px.x <= gLwh.x && px.y <= gLwh.y; }
fn samplePx(px : vec2<f32>) -> vec4<f32> {
  if (!inBox(px)) { return vec4<f32>(0.0); }
  return textureSampleLevel(tex, smp, pxUv(px), 0.0);
}
fn sampleClampPx(px : vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(tex, smp, pxUv(clamp(px, vec2<f32>(0.5), gLwh - vec2<f32>(0.5))), 0.0);
}
fn fmod(a : f32, b : f32) -> f32 { return a - b * floor(a / b); }
fn fmod2(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> { return a - b * floor(a / b); }
fn sampleWrapPx(px : vec2<f32>) -> vec4<f32> { return sampleClampPx(fmod2(px, gLwh)); }
fn sampleMirrorPx(px : vec2<f32>) -> vec4<f32> {
  let m = fmod2(px, gLwh * 2.0);
  return sampleClampPx(select(m, gLwh * 2.0 - m, m > gLwh));
}
// One target texel, in layer px.
fn texelPx() -> vec2<f32> { return gLwh / max(obj.fxBox.zw * obj.uvRect.zw * vec2<f32>(textureDimensions(tex)), vec2<f32>(1.0)); }
fn s2l(c : f32) -> f32 { if (c <= 0.04045) { return c / 12.92; } return pow((c + 0.055) / 1.055, 2.4); }
fn l2s(c : f32) -> f32 { if (c <= 0.0031308) { return c * 12.92; } return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
fn s2l3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(s2l(c.r), s2l(c.g), s2l(c.b)); }
fn l2s3(c : vec3<f32>) -> vec3<f32> { return vec3<f32>(l2s(c.r), l2s(c.g), l2s(c.b)); }
// Premultiplied working colour -> straight display (sRGB) colour, and back.
fn toDisp(c : vec4<f32>) -> vec4<f32> {
  if (c.a <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(l2s3(max(c.rgb / c.a, vec3<f32>(0.0))), c.a);
}
fn fromDisp(rgb : vec3<f32>, a : f32) -> vec4<f32> { return vec4<f32>(s2l3(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a); }
fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }
fn lumaLin(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn pcg(v : u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Hash of an integer-valued cell (and a seed) to [0, 1).
fn hcell(c : vec2<f32>, s : f32) -> f32 {
  let i = vec2<i32>(floor(c));
  return f32(pcg((u32(i.x) * 1597334677u) ^ pcg(u32(i.y) ^ (u32(i32(floor(s))) * 3812015801u))) >> 8u) / 16777216.0;
}
fn hcell3(c : vec3<f32>, s : f32) -> f32 { return hcell(c.xy + vec2<f32>(c.z * 7919.0, c.z * 104729.0), s); }
fn h1(x : f32, s : f32) -> f32 { return hcell(vec2<f32>(x, 0.0), s); }
fn vnoise(p : vec2<f32>, s : f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hcell(i, s), hcell(i + vec2<f32>(1.0, 0.0), s), u.x), mix(hcell(i + vec2<f32>(0.0, 1.0), s), hcell(i + vec2<f32>(1.0, 1.0), s), u.x), u.y);
}
// Value noise through time: two slices blended (z is the evolution, any real).
fn vnoiseT(p : vec2<f32>, z : f32, s : f32) -> f32 {
  let k = floor(z); let f = fract(z); let u = f * f * (3.0 - 2.0 * f);
  return mix(vnoise(p, s + k * 131.0), vnoise(p, s + (k + 1.0) * 131.0), u);
}
fn fbm(p : vec2<f32>, s : f32, oct : i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var q = p; var norm = 0.0;
  for (var i = 0; i < oct; i++) {
    sum += amp * vnoise(q, s + f32(i) * 17.0); norm += amp;
    q = q * 2.03 + vec2<f32>(11.7, 5.3); amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}
fn fbmT(p : vec2<f32>, z : f32, s : f32, oct : i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var q = p; var norm = 0.0;
  for (var i = 0; i < oct; i++) {
    sum += amp * vnoiseT(q, z * (1.0 + f32(i) * 0.5), s + f32(i) * 17.0); norm += amp;
    q = q * 2.03 + vec2<f32>(11.7, 5.3); amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}
fn rot2(p : vec2<f32>, a : f32) -> vec2<f32> { let c = cos(a); let s = sin(a); return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y); }
fn rgb2hsl(c : vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  if (mx - mn < 0.00001) { return vec3<f32>(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3<f32>(h / 6.0, s, l);
}
fn hue2rgb(p : f32, q : f32, t0 : f32) -> f32 {
  let t = fract(t0);
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}
fn hsl2rgb(c : vec3<f32>) -> vec3<f32> {
  if (c.y <= 0.0) { return vec3<f32>(c.z); }
  let q = select(c.z + c.y - c.z * c.y, c.z * (1.0 + c.y), c.z < 0.5);
  let p = 2.0 * c.z - q;
  return vec3<f32>(hue2rgb(p, q, c.x + 1.0 / 3.0), hue2rgb(p, q, c.x), hue2rgb(p, q, c.x - 1.0 / 3.0));
}
fn softLight1(a : f32, b : f32) -> f32 {
  if (b <= 0.5) { return a - (1.0 - 2.0 * b) * a * (1.0 - a); }
  let d = select(sqrt(a), ((16.0 * a - 12.0) * a + 4.0) * a, a <= 0.25);
  return a + (2.0 * b - 1.0) * (d - a);
}
fn overlay1(a : f32, b : f32) -> f32 { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < 0.5); }
// Display-space blend of `b` over `a` (After Effects / Photoshop modes).
// 0 normal 1 multiply 2 screen 3 overlay 4 soft light 5 hard light 6 add 7 subtract
// 8 difference 9 darken 10 lighten 11 color dodge 12 color burn 13 exclusion
fn blendMode(a : vec3<f32>, b : vec3<f32>, m : i32) -> vec3<f32> {
  switch (m) {
    case 1: { return a * b; }
    case 2: { return 1.0 - (1.0 - a) * (1.0 - b); }
    case 3: { return vec3<f32>(overlay1(a.r, b.r), overlay1(a.g, b.g), overlay1(a.b, b.b)); }
    case 4: { return vec3<f32>(softLight1(a.r, b.r), softLight1(a.g, b.g), softLight1(a.b, b.b)); }
    case 5: { return vec3<f32>(overlay1(b.r, a.r), overlay1(b.g, a.g), overlay1(b.b, a.b)); }
    case 6: { return min(a + b, vec3<f32>(1.0)); }
    case 7: { return max(a - b, vec3<f32>(0.0)); }
    case 8: { return abs(a - b); }
    case 9: { return min(a, b); }
    case 10: { return max(a, b); }
    case 11: { return min(a / max(1.0 - b, vec3<f32>(0.0001)), vec3<f32>(1.0)); }
    case 12: { return 1.0 - min((1.0 - a) / max(b, vec3<f32>(0.0001)), vec3<f32>(1.0)); }
    case 13: { return a + b - 2.0 * a * b; }
    default: { return b; }
  }
}
fn causticAt(uvq : vec2<f32>, time : f32) -> f32 {
  // The iterated-sine water caustic, tiling once per unit of uvq.
  let p = fmod2(uvq * TAU, vec2<f32>(TAU)) - 250.0;
  var i = p;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < 5; n++) {
    let t = time * (1.0 - (3.5 / f32(n + 1)));
    i = p + vec2<f32>(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2<f32>(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
// The Water layer's luminance (straight display, by coverage) at a layer px.
fn waterLumaPx(px : vec2<f32>) -> f32 {
  let w = textureSampleLevel(waterTex, smp, pxUv(clamp(px, vec2<f32>(0.5), gLwh - vec2<f32>(0.5))), 0.0);
  let d = toDisp(w);
  return luma(d.rgb) * d.a;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let P = prm();
  gLwh = max(vec2<f32>(P.lw, P.lh), vec2<f32>(1.0, 1.0));
  let lwh = gLwh;
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let src = textureSampleLevel(tex, smp, uv, 0.0);
  if (src.a <= 0.0) { return src; }
  let q = pp / P.scale;
  let e = 0.02;
  let hc = fbmT(q * 1.3, P.t * 0.6, P.seed, 3);
  let hx = fbmT(q * 1.3 + vec2<f32>(e, 0.0), P.t * 0.6, P.seed, 3) - hc;
  let hy = fbmT(q * 1.3 + vec2<f32>(0.0, e), P.t * 0.6, P.seed, 3) - hc;
  var off = vec2<f32>(hx, hy) / e * P.dist * P.scale * 0.05;
  // The Water layer's luminance as a height on top of the waves (one px finite differences).
  let useWater = obj.p3.y > 0.5;
  let wgain = obj.p3.z;
  let wc = waterLumaPx(pp);
  let wx = waterLumaPx(pp + vec2<f32>(1.0, 0.0)) - waterLumaPx(pp - vec2<f32>(1.0, 0.0));
  let wy = waterLumaPx(pp + vec2<f32>(0.0, 1.0)) - waterLumaPx(pp - vec2<f32>(0.0, 1.0));
  if (useWater) { off = off + vec2<f32>(wx, wy) * P.dist * P.scale * 0.5 * wgain; }
  let bottomOwn = sampleClampPx(pp + off);
  let bottomMap = textureSampleLevel(bottomTex, smp, pxUv(clamp(pp + off, vec2<f32>(0.5), gLwh - vec2<f32>(0.5))), 0.0);
  let bottom = select(bottomOwn, bottomMap, obj.p3.x > 0.5);
  let base = bottom.rgb / max(bottom.a, 0.00001);
  var c = causticAt(q, P.t * 0.5 + 23.0);
  if (useWater) { c = c + max(wc * 2.0 - 1.0, 0.0) * 1.5 * wgain; }
  let light = P.light * (P.amb + c * P.strength * 2.0) * P.inten;
  return vec4<f32>(base * light * src.a, src.a);
}
