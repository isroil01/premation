
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, fxBox: vec4<f32> };
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

fn hash2u(a : i32, b : i32) -> f32 {
  var n = u32(a) * 374761393u + u32(b) * 668265263u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  n = n ^ (n >> 16u);
  return f32(n) / 4294967296.0;
}
fn lum709(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn decodeS(s : vec4<f32>) -> vec4<f32> {
  let a = max(s.a, 0.00001);
  let c = select(s.rgb / a, vec3<f32>(0.0), s.a <= 0.0);
  return vec4<f32>(linearToSrgbRgb(c), s.a);
}
fn tapStraight(px : vec2<f32>, lwh : vec2<f32>, clampBorder : bool) -> vec4<f32> {
  var p = px;
  if (clampBorder) { p = clamp(p, vec2<f32>(0.5, 0.5), lwh - vec2<f32>(0.5, 0.5)); }
  let s = samplePx(p, lwh);
  if (s.a <= 0.00001) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(s.rgb / s.a, s.a);
}
fn premul(c : vec4<f32>) -> vec4<f32> { return vec4<f32>(c.rgb * c.a, c.a); }
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

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = obj.p0.xy;
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return s0; }
  let c = lwh * 0.5; let n = i32(obj.p0.z + 0.5); let sd = i32(obj.p1.z);
  var acc = vec3<f32>(0.0); var aMax = 0.0;
  for (var i = 0; i < 400; i = i + 1) {
    if (i >= n) { break; }
    let ang = hash2u(i, sd) * 6.28318530718;
    let speed = 0.25 + 0.75 * hash2u(i, sd + 101);
    let t = fract(obj.p0.w / 1000.0 * speed + hash2u(i, sd + 202));
    let dirv = vec2<f32>(cos(ang), sin(ang));
    let p = c + dirv * (t * t * obj.p1.w);
    if (p.x < -4.0 || p.x > lwh.x + 4.0 || p.y < -4.0 || p.y > lwh.y + 4.0) { continue; }
    let sz = max(0.5, obj.p1.x) * (0.4 + 0.6 * t);
    let spikeLen = sz * 4.0;
    let d = pp - p;
    if (abs(d.x) > spikeLen || abs(d.y) > spikeLen) { continue; }
    let core = max(0.5, sz * 0.5); let spikeW = max(0.4, sz * 0.22);
    var inten = exp(-dot(d, d) / (core * core));
    let ax = abs(d.x); let ay = abs(d.y);
    inten = inten + 0.85 * exp(-(ay * ay) / (spikeW * spikeW)) * pow(max(0.0, 1.0 - ax / spikeLen), 2.0);
    inten = inten + 0.85 * exp(-(ax * ax) / (spikeW * spikeW)) * pow(max(0.0, 1.0 - ay / spikeLen), 2.0);
    let du = abs(d.x * 0.70710678 + d.y * 0.70710678); let dv = abs(-d.x * 0.70710678 + d.y * 0.70710678);
    inten = inten + 0.35 * exp(-(dv * dv) / (spikeW * spikeW)) * pow(max(0.0, 1.0 - du / (spikeLen * 0.5)), 2.0);
    inten = inten + 0.35 * exp(-(du * du) / (spikeW * spikeW)) * pow(max(0.0, 1.0 - dv / (spikeLen * 0.5)), 2.0);
    let sInt = clamp(inten * (0.25 + 0.75 * t), 0.0, 1.0);
    if (sInt <= 0.003) { continue; }
    let hp = clamp(round(c + dirv * obj.p1.w * 0.5), vec2<f32>(0.0), lwh - 1.0) + 0.5;
    let hs = decodeS(samplePx(hp, lwh));
    let mixT = select(1.0, 0.5, hs.a > 8.0 / 255.0);
    let col = mix(hs.rgb, obj.p2.xyz, mixT);
    acc = min(acc + col * sInt, vec3<f32>(1.0));
    aMax = max(aMax, sInt);
  }
  let k = obj.p1.y;
  if (k <= 0.0) { return encodeOut(acc, aMax); }
  let c0 = decodeS(s0);
  let a = c0.a * k + aMax * (1.0 - k);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  return encodeOut((c0.rgb * c0.a * k + acc * aMax * (1.0 - k)) / a, a);
}
