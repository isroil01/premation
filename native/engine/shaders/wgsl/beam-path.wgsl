
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, p4: vec4<f32>, p5: vec4<f32>, p6: vec4<f32>, p7: vec4<f32>, p8: vec4<f32>, p9: vec4<f32>, p10: vec4<f32>, p11: vec4<f32>, p12: vec4<f32>, p13: vec4<f32>, p14: vec4<f32>, p15: vec4<f32>, p16: vec4<f32>, p17: vec4<f32>, p18: vec4<f32>, p19: vec4<f32>, p20: vec4<f32>, p21: vec4<f32>, p22: vec4<f32>, p23: vec4<f32>, p24: vec4<f32>, p25: vec4<f32>, p26: vec4<f32>, p27: vec4<f32>, p28: vec4<f32>, p29: vec4<f32>, p30: vec4<f32>, p31: vec4<f32>, p32: vec4<f32>, p33: vec4<f32>, p34: vec4<f32>, p35: vec4<f32>, p36: vec4<f32>, p37: vec4<f32>, p38: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
// FIELD coordinate: fxBox (and every centre/offset packed in it) is authored
// in TOP-DOWN buffer fractions, but uv's V runs the opposite way per backend
// on FBO round-trips (targetSampleUv). All layer-pixel maths runs in field
// space; layerUv folds the field->sample conversion back in when sampling.
fn fieldQ(uv : vec2<f32>) -> vec2<f32> {
  return (uv - obj.uvRect.xy) / obj.uvRect.zw;
}
fn layerUv(px : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> {
  let q = obj.fxBox.xy + (px / lwh) * obj.fxBox.zw;
  return obj.uvRect.xy + q * obj.uvRect.zw;
}
fn samplePx(px : vec2<f32>, lwh : vec2<f32>) -> vec4<f32> {
  if (px.x < 0.0 || px.y < 0.0 || px.x > lwh.x || px.y > lwh.y) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return textureSampleLevel(tex, smp, layerUv(px, lwh), 0.0);
}

fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}

fn linearSrgbToAcesCg(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(c, vec3<f32>(0.613097396, 0.339523469, 0.047379562)),
    dot(c, vec3<f32>(0.070194066, 0.916353879, 0.013452032)),
    dot(c, vec3<f32>(0.020615588, 0.109569769, 0.869814633)),
  );
}

fn acesOdtSrgb(c : vec3<f32>) -> vec3<f32> {
  var v = max(c, vec3<f32>(0.0));
  let a = v * (v + vec3<f32>(0.0245786)) - vec3<f32>(0.0000905377);
  let b = v * (0.983729 * v + vec3<f32>(0.4329510)) + vec3<f32>(0.238081);
  return clamp(a / b, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hlgOetfChannel(E : f32) -> f32 {
  // ARIB STD-B67 — same curve as hdrTransfer.ts (HDR export). Preview ODT
  // must match delivery or Comp Settings “HLG” and Export ▸ HLG diverge.
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  let e = max(E, 0.0);
  if (e <= 1.0 / 12.0) { return sqrt(3.0 * e); }
  return a * log(12.0 * e - b) + c;
}

fn workingToDisplay(rgb : vec3<f32>, srcSpace : vec4<f32>) -> vec3<f32> {
  // z≈3 → HLG (ARIB STD-B67) preview ODT on SDR canvas.
  if (srcSpace.z > 2.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    return clamp(vec3<f32>(hlgOetfChannel(v.x), hlgOetfChannel(v.y), hlgOetfChannel(v.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // z≈2 → PQ (ST.2084) foothold: map linear scene → PQ then re-expand for
  // SDR canvas preview. Not a real HDR10 encode — just a selectable ODT.
  if (srcSpace.z > 1.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      // ACEScg → approx linear Rec.709 for the PQ curve.
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    let Y = max(v, vec3<f32>(0.0)) / 100.0; // assume ~100 nit scene white
    let Ym = pow(Y, vec3<f32>(m1));
    let pq = pow((c1 + c2 * Ym) / (1.0 + c3 * Ym), vec3<f32>(m2));
    return clamp(pq, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (srcSpace.z > 0.5) {
    var v = rgb;
    if (srcSpace.y < 0.5) { v = linearSrgbToAcesCg(v); }
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}


fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> {
  return select(srgbToLinearRgb(rgb), rgb, srcLinear > 0.5);
}
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return rgb; }


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

fn hash01(x : i32, y : i32, seed : i32) -> f32 {
  var n = u32(x) * 374761393u + u32(y) * 668265263u + u32(seed) * 2147483647u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  n = n ^ (n >> 16u);
  return f32(n) / 4294967296.0;
}
fn vnoise(p : vec2<f32>, seed : i32) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f);
  let xi = i32(i.x); let yi = i32(i.y);
  let a = hash01(xi, yi, seed); let b = hash01(xi + 1, yi, seed);
  let c = hash01(xi, yi + 1, seed); let d = hash01(xi + 1, yi + 1, seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn vnoiseF(p : vec2<f32>, seed : f32) -> f32 {
  let s0 = floor(seed);
  return mix(vnoise(p, i32(s0)), vnoise(p, i32(s0) + 1), seed - s0);
}
fn fbm(p : vec2<f32>, seed : i32, octaves : i32) -> f32 {
  var total = 0.0; var amp = 1.0; var freq = 1.0; var maxA = 0.0;
  for (var i = 0; i < 6; i = i + 1) {
    if (i >= octaves) { break; }
    total = total + (vnoise(p * freq, seed + i * 101) * 2.0 - 1.0) * amp;
    maxA = maxA + amp; amp = amp * 0.5; freq = freq * 2.0;
  }
  return total / maxA;
}
fn sampleClamped(px : vec2<f32>, lwh : vec2<f32>) -> vec4<f32> {
  return samplePx(clamp(px, vec2<f32>(0.5, 0.5), lwh - vec2<f32>(0.5, 0.5)), lwh);
}
fn sstep(e0 : f32, e1 : f32, x : f32) -> f32 {
  if (e1 <= e0) { return select(1.0, 0.0, x < e0); }
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn beamPt(i : i32) -> vec2<f32> {
  let r = i / 2;
  var row : vec4<f32>;
  switch (r) {
    case 0: { row = obj.p7; }
    case 1: { row = obj.p8; }
    case 2: { row = obj.p9; }
    case 3: { row = obj.p10; }
    case 4: { row = obj.p11; }
    case 5: { row = obj.p12; }
    case 6: { row = obj.p13; }
    case 7: { row = obj.p14; }
    case 8: { row = obj.p15; }
    case 9: { row = obj.p16; }
    case 10: { row = obj.p17; }
    case 11: { row = obj.p18; }
    case 12: { row = obj.p19; }
    case 13: { row = obj.p20; }
    case 14: { row = obj.p21; }
    case 15: { row = obj.p22; }
    case 16: { row = obj.p23; }
    case 17: { row = obj.p24; }
    case 18: { row = obj.p25; }
    case 19: { row = obj.p26; }
    case 20: { row = obj.p27; }
    case 21: { row = obj.p28; }
    case 22: { row = obj.p29; }
    case 23: { row = obj.p30; }
    case 24: { row = obj.p31; }
    case 25: { row = obj.p32; }
    case 26: { row = obj.p33; }
    case 27: { row = obj.p34; }
    case 28: { row = obj.p35; }
    case 29: { row = obj.p36; }
    case 30: { row = obj.p37; }
    case 31: { row = obj.p38; }
    default: { row = vec4<f32>(1e9, 0.0, 1e9, 0.0); }
  }
  if ((i & 1) == 0) { return row.xy; }
  return row.zw;
}
fn sstep2(e0 : f32, e1 : f32, x : f32) -> f32 {
  if (e1 <= e0) { return select(1.0, 0.0, x < e0); }
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = obj.p0.xy;
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  let count = i32(obj.p0.z + 0.5); let totalLen = obj.p0.w;
  let beamOnly = obj.p4.x > 0.5;
  let base = select(s0, vec4<f32>(0.0), beamOnly);
  if (count < 2 || totalLen <= 0.0) { return base; }
  var q = pp;
  let dist = obj.p3.y;
  if (dist > 0.0) {
    let inv = obj.p3.z; let ev = obj.p3.w;
    let f = floor(pp);
    let dpdx = fbm(vec2<f32>((f.x + 1.0) * inv + ev, f.y * inv - ev), 53, 3) - fbm(vec2<f32>((f.x - 1.0) * inv + ev, f.y * inv - ev), 53, 3);
    let dpdy = fbm(vec2<f32>(f.x * inv + ev, (f.y + 1.0) * inv - ev), 53, 3) - fbm(vec2<f32>(f.x * inv + ev, (f.y - 1.0) * inv - ev), 53, 3);
    q = q + vec2<f32>(dpdy, -dpdx) * dist;
  }
  let halfW = obj.p1.x; let softF = obj.p1.y; let spread = obj.p1.z; let inten = obj.p1.w;
  let expo = obj.p2.x; let start = obj.p2.y; let end = obj.p2.z; let sz0 = obj.p2.w; let sz1 = obj.p3.x;
  let win = max(end - start, 0.000001);
  var core = 0.0; var dmin = 1e9; var acc = 0.0;
  for (var i = 0; i + 1 < count; i = i + 1) {
    let a = beamPt(i); let b = beamPt(i + 1);
    if (a.x >= 1e9 || b.x >= 1e9) { continue; }
    let ab = b - a; let len = length(ab);
    let sa = acc / totalLen; let sb = (acc + len) / totalLen;
    acc = acc + len;
    if (len <= 0.000001) { continue; }
    let va = max(sa, start); let vb = min(sb, end);
    if (vb <= va) { continue; }
    let ta = (va - sa) / (sb - sa); let tb = (vb - sa) / (sb - sa);
    let t = clamp(dot(q - a, ab) / (len * len), ta, tb);
    let d = length(q - (a + ab * t));
    let sAt = sa + t * (sb - sa);
    let u = clamp((sAt - start) / win, 0.0, 1.0);
    let wh = halfW * mix(sz0, sz1, u);
    let soft = wh * softF;
    let cov = 1.0 - sstep2(wh - soft, wh + soft + 0.75, d);
    core = max(core, cov);
    dmin = min(dmin, d - wh);
  }
  if (dmin >= 1e9) { return base; }
  let dd = max(0.0, dmin);
  var glow = inten * pow(1.0 + dd / spread, -expo);
  glow = glow * (1.0 - sstep2(6.0 * spread, 10.0 * spread, dd));
  let coreF = core * obj.p4.z;
  let addA = min(1.0, coreF + min(1.0, glow));
  let a = min(1.0, base.a + addA);
  let rgb = min(base.rgb + obj.p5.xyz * coreF + obj.p6.xyz * glow, vec3<f32>(a));
  return vec4<f32>(rgb, a);
}
