// Frosted Glass (frosted-glass) -- Frosted glass: the picture seen through a rough pane, each pixel scattered within the frost radius.
// Generated from the fx60 spec (docs/PROGRAM_PERFORMANCE.md E). Layer px through fxBox.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
// Stream D (2026-11-02): p1.y = 1 scatters the scene under the layer (`tex` is then the
// backdrop) and cuts the result by the layer's own alpha (binding 3).
@group(0) @binding(3) var alphaTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
struct Prm { amt: f32, sm: f32, seed: f32, lw: f32, lh: f32, source: f32 };
fn prm() -> Prm { return Prm(obj.p0.x, obj.p0.y, obj.p0.z, obj.p0.w, obj.p1.x, obj.p1.y); }
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
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let P = prm();
  gLwh = max(vec2<f32>(P.lw, P.lh), vec2<f32>(1.0, 1.0));
  let lwh = gLwh;
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let src = textureSampleLevel(tex, smp, uv, 0.0);
  let cut = select(1.0, textureSampleLevel(alphaTex, smp, uv, 0.0).a, P.source > 0.5);
  if (P.amt <= 0.0) { return src * cut; }
  let cell = floor(pp);
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < 6; i++) {
    let hx = hcell(cell + vec2<f32>(f32(i) * 17.0, 0.0), P.seed);
    let hy = hcell(cell + vec2<f32>(0.0, f32(i) * 31.0), P.seed + 3.0);
    let th = hy * TAU;
    acc += samplePx(pp + vec2<f32>(cos(th), sin(th)) * sqrt(hx) * P.amt);
  }
  let one = samplePx(pp + (vec2<f32>(hcell(cell, P.seed + 9.0), hcell(cell, P.seed + 11.0)) - 0.5) * 2.0 * P.amt);
  return mix(one, acc / 6.0, P.sm) * cut;
}
