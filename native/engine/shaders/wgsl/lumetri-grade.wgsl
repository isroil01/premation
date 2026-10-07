
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, p4: vec4<f32>, p5: vec4<f32>, p6: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var data : texture_2d<f32>;
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

fn lum709(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn smooth01(a : f32, b : f32, x : f32) -> f32 {
  if (b <= a) { return select(1.0, 0.0, x < a); }
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn rgbToHsl(c : vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  let d = mx - mn;
  if (d < 1e-6) { return vec3<f32>(0.0, 0.0, l); }
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3<f32>(h * 60.0, s, l);
}
fn hueChan(p : f32, q : f32, t0 : f32) -> f32 {
  var t = t0;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}
fn hslToRgb(h0 : f32, s : f32, l : f32) -> vec3<f32> {
  var h = h0 % 360.0;
  if (h < 0.0) { h = h + 360.0; }
  if (s <= 0.0) { return vec3<f32>(l); }
  let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
  let p = 2.0 * l - q;
  let hk = h / 360.0;
  return vec3<f32>(hueChan(p, q, hk + 1.0 / 3.0), hueChan(p, q, hk), hueChan(p, q, hk - 1.0 / 3.0));
}
fn hueDistDeg(a : f32, b : f32) -> f32 {
  let d = abs(a - b) % 360.0;
  return select(d, 360.0 - d, d > 180.0);
}
/// Layer px of a fragment (the box is fxBox in field space).
fn layerPx(uv : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> {
  return (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
}
fn straightOf(s : vec4<f32>) -> vec4<f32> {
  if (s.a <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(linearToSrgbRgb(s.rgb / s.a), s.a);
}
// One float32 per RGBA8 texel, little-endian bytes in r g b a (effects_port.cpp pack_float_texture).
const DATA_ROW : u32 = 1024u;
fn fetch(i : u32) -> f32 {
  let t = textureLoad(data, vec2<i32>(i32(i % DATA_ROW), i32(i / DATA_ROW)), 0);
  let b = vec4<u32>(round(t * 255.0));
  return bitcast<f32>(b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u));
}
/// A Hue / Luma vs curve (256 floats, curve k at k × 256), indexed as the CPU table: round(v · 255).
fn curveAt(k : u32, v01 : f32) -> f32 {
  return fetch(k * 256u + u32(clamp(round(v01 * 255.0), 0.0, 255.0)));
}

// AE parity 5.3: Lumetri's cross-channel stage (effect_color.cpp apply_lumetri_pixels)
// after its LUT, on the GPU route. p6 = which Hue / Luma vs curves the data texture holds.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s = textureSampleLevel(tex, smp, uv, 0.0);
  let a0 = s.a;
  if (a0 <= 0.0) { return s; }
  var c = linearToSrgbRgb(s.rgb / a0);
  // Basic / Creative saturation, then Vibrance (p0.x sat, p0.y vibrance).
  let sat = obj.p0.x;
  let vib = obj.p0.y;
  if (sat != 1.0 || vib != 0.0) {
    let L = lum709(c);
    let chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    let k = sat * (1.0 + vib * (1.0 - chroma));
    c = vec3<f32>(L) + (c - vec3<f32>(L)) * k;
  }
  // Hue vs Saturation / Hue / Luma, Luma vs Saturation (neutral 128): curves 0..3 = hueSat, hueHue, hueLuma, lumaSat.
  let cv = obj.p6;
  if (cv.x > 0.5 || cv.y > 0.5 || cv.z > 0.5 || cv.w > 0.5) {
    let hsl = rgbToHsl(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
    var h = hsl.x;
    var sv = hsl.y;
    var l = hsl.z;
    let hx = h / 360.0;
    if (cv.y > 0.5) { h = h + (curveAt(1u, hx) - 128.0) / 128.0 * 180.0; }
    if (cv.x > 0.5) { sv = sv * max(0.0, curveAt(0u, hx) / 128.0); }
    if (cv.w > 0.5) { sv = sv * max(0.0, curveAt(3u, lum709(c)) / 128.0); }
    if (cv.z > 0.5) { l = l + (curveAt(2u, hx) - 128.0) / 128.0 * 0.5 * sv; }
    c = hslToRgb(h, clamp(sv, 0.0, 1.0), clamp(l, 0.0, 1.0));
  }
  // HSL Secondary (p1.w enable; p2 hue centre / range / softness, range softness; p3 sat / lum ranges; p4 corrections).
  if (obj.p1.w > 0.5) {
    let hsl = rgbToHsl(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
    let dh = hueDistDeg(hsl.x, obj.p2.x);
    var wh = 1.0;
    if (dh > obj.p2.y) { wh = select(0.0, max(0.0, 1.0 - (dh - obj.p2.y) / obj.p2.z), obj.p2.z > 0.0); }
    let soft = obj.p2.w;
    let ws = smooth01(obj.p3.x - soft, obj.p3.x, hsl.y) * (1.0 - smooth01(obj.p3.y, obj.p3.y + soft, hsl.y));
    let wl = smooth01(obj.p3.z - soft, obj.p3.z, hsl.z) * (1.0 - smooth01(obj.p3.w, obj.p3.w + soft, hsl.z));
    let key = wh * ws * wl;
    if (obj.p5.x > 0.5) {
      c = vec3<f32>(key);
    } else if (key > 0.0) {
      var k = vec3<f32>(c.r * (1.0 + 0.3 * obj.p4.x), c.g * (1.0 - 0.3 * obj.p4.y), c.b * (1.0 - 0.3 * obj.p4.x));
      k = (k - vec3<f32>(0.5)) * (1.0 + obj.p4.z) + vec3<f32>(0.5);
      let L = lum709(k);
      k = vec3<f32>(L) + (k - vec3<f32>(L)) * obj.p4.w;
      c = c + (k - c) * key;
    }
  }
  // Vignette over the layer box (p0.z amount, p0.w radius; p1.x exponent, p1.y feather, p1.z aspect-round; p5.yz layer px).
  let amount = obj.p0.z;
  if (amount != 0.0) {
    let lwh = obj.p5.yz;
    let q = layerPx(uv, lwh) / max(lwh, vec2<f32>(1.0, 1.0));
    let u = q.x * 2.0 - 1.0;
    let v = (q.y * 2.0 - 1.0) * obj.p1.z;
    let e = obj.p1.x;
    let dist = pow(pow(abs(u), e) + pow(abs(v), e), 1.0 / e);
    let t = smooth01(obj.p0.w * (1.0 - obj.p1.y * 0.9), obj.p0.w * (1.0 + obj.p1.y * 0.9), dist);
    if (amount < 0.0) { c = c * (1.0 + amount * t); }
    else { c = c + (vec3<f32>(1.0) - c) * amount * t; }
  }
  return encodeOut(c, a0);
}
