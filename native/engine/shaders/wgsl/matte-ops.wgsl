
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var texB : texture_2d<f32>;
@group(0) @binding(4) var texC : texture_2d<f32>;
@group(0) @binding(5) var texD : texture_2d<f32>;
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
// AE parity 5.3 — the keying / matte family's GPU passes (effect_chain.cpp
// runs them in sequence over scratch targets in the chain buffer's space).
// Every distance is in layer px (fxBox spans lw × lh, p1.xy), as the CPU bake
// that works on the layer raster. Rows: p0 = (mode, dirX, dirY, radius /
// sigma), p1 = (lw, lh, edge rule, channel index), p2 = channel mask or the
// mode's params, p3 = more params. Textures: tex (binding 1) = A, texB / texC /
// texD = the mode's other inputs, all sampled at the fragment's own uv.
const M_BOX : i32 = 1;
const M_GAUSS : i32 = 2;
const M_MAX : i32 = 3;
const M_MEDIAN : i32 = 4;
const M_KL_MATTE : i32 = 10;
const M_KL_FINAL : i32 = 11;
const M_KC_EDGE : i32 = 20;
const M_KC_FINAL : i32 = 21;
const M_RG_YCC : i32 = 30;
const M_RG_BILATERAL : i32 = 31;
const M_RG_FINAL : i32 = 32;
const M_RM_PREP : i32 = 40;
const M_RM_AB : i32 = 41;
const M_RM_APPLY : i32 = 42;
const M_RM_CONTRAST : i32 = 43;
const M_RM_BG : i32 = 44;
const M_RM_FINAL : i32 = 45;
const M_SPILL_VOTE : i32 = 50;

fn tapA(px : vec2<f32>, lwh : vec2<f32>) -> vec4<f32> { return textureSampleLevel(tex, smp, layerUv(px, lwh), 0.0); }
fn insideBox(pp : vec2<f32>, lwh : vec2<f32>) -> bool { return pp.x >= 0.0 && pp.y >= 0.0 && pp.x <= lwh.x && pp.y <= lwh.y; }
/// The CPU's clamped-edge tap: the nearest pixel centre inside the layer.
fn clampPx(px : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> { return clamp(px, vec2<f32>(0.5), max(lwh - vec2<f32>(0.5), vec2<f32>(0.5))); }
fn chanOf(c : vec3<f32>, i : f32) -> f32 { return select(select(c.b, c.g, i < 1.5), c.r, i < 0.5); }
fn otherA(p : f32) -> f32 { return select(0.0, 1.0, p < 0.5); }
fn otherB(p : f32) -> f32 { return select(2.0, 1.0, p > 1.5); }
fn withChan(c : vec3<f32>, i : f32, v : f32) -> vec3<f32> {
  var o = c;
  if (i < 0.5) { o.r = v; } else if (i < 1.5) { o.g = v; } else { o.b = v; }
  return o;
}
fn isZero(a : f32) -> bool { return a <= 0.5 / 255.0; }
fn ycc(c : vec3<f32>) -> vec3<f32> {
  let y = lum709(c);
  return vec3<f32>(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
fn median9(v : array<f32, 9>) -> f32 {
  var a = v;
  // Partial selection sort: the 5th smallest.
  for (var i = 0; i < 5; i = i + 1) {
    var m = i;
    for (var j = i + 1; j < 9; j = j + 1) { if (a[j] < a[m]) { m = j; } }
    let t = a[i];
    a[i] = a[m];
    a[m] = t;
  }
  return a[4];
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = max(obj.p1.xy, vec2<f32>(1.0, 1.0));
  let pp = layerPx(uv, lwh);
  let mode = i32(obj.p0.x + 0.5);
  let inside = insideBox(pp, lwh);
  let a0 = textureSampleLevel(tex, smp, uv, 0.0);
  let dir = obj.p0.yz;

  if (mode == M_BOX || mode == M_GAUSS || mode == M_MAX) {
    if (!inside) { return a0; }
    let mask = obj.p2;
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    if (mode == M_BOX) {
      // p1.z: 0 = clamped edges (box_blur_plane), 1 = the window shrinks at the edge (window_mean).
      let r = min(i32(obj.p0.w + 0.5), 300);
      let shrink = obj.p1.z > 0.5;
      for (var k = -r; k <= r; k = k + 1) {
        var q = pp + dir * f32(k);
        if (shrink) {
          if (!insideBox(q, lwh)) { continue; }
        } else {
          q = clampPx(q, lwh);
        }
        acc = acc + tapA(q, lwh);
        wsum = wsum + 1.0;
      }
      return mix(a0, acc / max(wsum, 1.0), mask);
    }
    if (mode == M_GAUSS) {
      let sigma = obj.p0.w;
      if (!(sigma > 0.3)) { return a0; }
      let r = min(i32(ceil(3.0 * sigma)), 300);
      for (var k = -r; k <= r; k = k + 1) {
        let w = exp(-f32(k * k) / (2.0 * sigma * sigma));
        acc = acc + w * tapA(clampPx(pp + dir * f32(k), lwh), lwh);
        wsum = wsum + w;
      }
      return mix(a0, acc / max(wsum, 1e-9), mask);
    }
    // M_MAX: a square dilation's line (dilate), taps past the layer ignored.
    let r = min(i32(obj.p0.w + 0.5), 300);
    var v = a0;
    for (var k = -r; k <= r; k = k + 1) {
      let q = pp + dir * f32(k);
      if (!insideBox(q, lwh)) { continue; }
      v = max(v, tapA(q, lwh));
    }
    return mix(a0, v, mask);
  }

  if (mode == M_MEDIAN) {
    // Key Cleaner's Reduce Chatter: 3×3 median of x inside the zone (z); x and y both take it.
    if (!inside || a0.z < 0.5) { return a0; }
    var v : array<f32, 9>;
    var n = 0;
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        v[n] = tapA(clampPx(pp + vec2<f32>(f32(dx), f32(dy)), lwh), lwh).x;
        n = n + 1;
      }
    }
    let m = median9(v);
    return vec4<f32>(m, m, a0.z, a0.w);
  }

  if (mode == M_KL_MATTE) {
    // Keylight's matte from the (pre-blurred) source: (raw, clipped, opaque, not opaque).
    if (!inside) { return vec4<f32>(0.0); }
    let c = straightOf(a0).rgb;
    let p = obj.p1.w;
    let s1 = chanOf(c, otherA(p));
    let s2 = chanOf(c, otherB(p));
    let bal = obj.p2.x;
    let sec = bal * max(s1, s2) + (1.0 - bal) * min(s1, s2);
    let v = 1.0 - ((chanOf(c, p) - sec) / obj.p3.x) * obj.p2.y;
    let raw = clamp(v, 0.0, 1.0);
    let cb = obj.p2.z;
    let cw = obj.p2.w;
    var clipped = 0.0;
    if (cw <= cb) { clipped = select(1.0, 0.0, v <= cb); }
    else { clipped = clamp((v - cb) / (cw - cb), 0.0, 1.0); }
    let opaque = select(0.0, 1.0, clipped >= 0.999);
    return vec4<f32>(raw, clipped, opaque, 1.0 - opaque);
  }

  if (mode == M_KL_FINAL) {
    // A = colour, B = the matte (raw, clipped, near opaque, near clear), C / D = inside / outside masks.
    // p2 = (despill, rollback, inside, outside), p3 = (intermediate, 0, 0, 0), p1.w = screen channel.
    if (a0.a <= 0.0 || !inside) { return a0; }
    let m = textureSampleLevel(texB, smp, uv, 0.0);
    var matte = m.y;
    if (obj.p2.y > 0.5 && m.z > 0.5 && m.w > 0.5) { matte = max(matte, m.x); }
    if (obj.p2.z > 0.5) { matte = max(matte, clamp(textureSampleLevel(texC, smp, uv, 0.0).a, 0.0, 1.0)); }
    if (obj.p2.w > 0.5) { matte = matte * clamp(textureSampleLevel(texD, smp, uv, 0.0).a, 0.0, 1.0); }
    let intermediate = obj.p3.x > 0.5;
    let alpha = select(matte, m.x, intermediate);
    var c = straightOf(a0).rgb;
    let p = obj.p1.w;
    if (!intermediate && obj.p2.x > 0.0 && alpha > 0.0) {
      let cap = max(chanOf(c, otherA(p)), chanOf(c, otherB(p)));
      let cp = chanOf(c, p);
      if (cp > cap) { c = withChan(c, p, cp + (cap - cp) * obj.p2.x); }
    }
    return encodeOut(c, a0.a * alpha);
  }

  if (mode == M_KC_EDGE) {
    // Key Cleaner's edge zone seed: (alpha, alpha, edge, 0); soft alpha, or where opaque meets clear.
    if (!inside) { return vec4<f32>(0.0); }
    let a = a0.a;
    var edge = a > 0.5 / 255.0 && a < 254.5 / 255.0;
    if (pp.x + 1.0 <= lwh.x && isZero(a) != isZero(tapA(pp + vec2<f32>(1.0, 0.0), lwh).a)) { edge = true; }
    if (pp.x - 1.0 >= 0.0 && isZero(a) != isZero(tapA(pp - vec2<f32>(1.0, 0.0), lwh).a)) { edge = true; }
    return vec4<f32>(a, a, select(0.0, 1.0, edge), 0.0);
  }

  if (mode == M_KC_FINAL) {
    // A = colour, B = (alpha, smoothed, zone, 0); p2 = (contrast, strength).
    if (!inside) { return a0; }
    let m = textureSampleLevel(texB, smp, uv, 0.0);
    if (m.z < 0.5 || (isZero(a0.a) && m.y < 0.002)) { return a0; }
    let a = clamp((m.y - 0.5) * obj.p2.x + 0.5, 0.0, 1.0);
    let outA = clamp(m.x + (a - m.x) * obj.p2.y, 0.0, 1.0);
    // A clear pixel the clean-up makes visible has no colour of its own (black, as the bake's).
    if (a0.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, outA); }
    return vec4<f32>(a0.rgb / a0.a * outA, outA);
  }

  if (mode == M_RG_YCC) {
    if (!inside) { return vec4<f32>(0.0); }
    let c = straightOf(a0);
    return vec4<f32>(ycc(c.rgb), c.a);
  }

  if (mode == M_RG_BILATERAL) {
    // Remove Grain: one bilateral pass in YCbCr (p0.w radius; p2 = luma / chroma range sigma, spatial sigma).
    if (!inside) { return a0; }
    let r = min(i32(obj.p0.w + 0.5), 8);
    let sy = obj.p2.x;
    let sc = obj.p2.y;
    let ss = obj.p2.z;
    var sum = vec3<f32>(0.0);
    var wy = 0.0;
    var wc = 0.0;
    for (var dy = -r; dy <= r; dy = dy + 1) {
      for (var dx = -r; dx <= r; dx = dx + 1) {
        let t = tapA(clampPx(pp + vec2<f32>(f32(dx), f32(dy)), lwh), lwh);
        let sp = exp(-f32(dx * dx + dy * dy) / (2.0 * ss * ss));
        let dl = t.x - a0.x;
        let w1 = sp * exp(-(dl * dl) / (2.0 * sy * sy));
        let w2 = sp * exp(-(dl * dl) / (2.0 * sc * sc));
        sum = sum + vec3<f32>(w1 * t.x, w2 * t.y, w2 * t.z);
        wy = wy + w1;
        wc = wc + w2;
      }
    }
    return vec4<f32>(sum.x / max(1e-9, wy), sum.y / max(1e-9, wc), sum.z / max(1e-9, wc), a0.w);
  }

  if (mode == M_RG_FINAL) {
    // A = colour, B = filtered YCbCr; p2.x = View Noise Samples.
    if (a0.a <= 0.0 || !inside) { return a0; }
    let f = textureSampleLevel(texB, smp, uv, 0.0).xyz;
    var Y = f.x;
    var Cb = f.y;
    var Cr = f.z;
    if (obj.p2.x > 0.5) {
      let o = ycc(straightOf(a0).rgb);
      Y = 128.0 / 255.0 + (o.x - Y) * 4.0;
      Cb = (o.y - Cb) * 4.0;
      Cr = (o.z - Cr) * 4.0;
    }
    let R = Y + 1.5748 * Cr;
    let B = Y + 1.8556 * Cb;
    let G = (Y - 0.2126 * R - 0.0722 * B) / 0.7152;
    return encodeOut(vec3<f32>(R, G, B), a0.a);
  }

  if (mode == M_RM_PREP) {
    // Refine Matte's guide: (I, α, I², I·α), I = Rec.601 luma of the straight colour.
    if (!inside) { return vec4<f32>(0.0); }
    let c = straightOf(a0);
    let I = lum601(c.rgb);
    return vec4<f32>(I, c.a, I * I, I * c.a);
  }
  if (mode == M_RM_AB) {
    // The guided filter's local linear model from the window means (p2.x = ε).
    let A = (a0.w - a0.x * a0.y) / (a0.z - a0.x * a0.x + obj.p2.x);
    return vec4<f32>(A, a0.y - A * a0.x, 0.0, 0.0);
  }
  if (mode == M_RM_APPLY) {
    // A = (mean A, mean B) or nothing (p2.y = 0: no guided filter), B = colour → α in x.
    let c = straightOf(textureSampleLevel(texB, smp, uv, 0.0));
    if (obj.p2.y < 0.5) { return vec4<f32>(c.a, 0.0, 0.0, 0.0); }
    return vec4<f32>(clamp(a0.x * lum601(c.rgb) + a0.y, 0.0, 1.0), 0.0, 0.0, 0.0);
  }
  if (mode == M_RM_CONTRAST) {
    // p2 = (contrast k, edge shift).
    return vec4<f32>(clamp((a0.x - 0.5 + obj.p2.y) * obj.p2.x + 0.5, 0.0, 1.0), a0.yzw);
  }
  if (mode == M_RM_BG) {
    // A = α, B = colour: the clear pixels' colour, weighted (w·R, w·G, w·B, w).
    if (!inside) { return vec4<f32>(0.0); }
    let w = select(0.0, 1.0, a0.x < 0.1);
    let c = straightOf(textureSampleLevel(texB, smp, uv, 0.0)).rgb;
    return vec4<f32>(c * w, w);
  }
  if (mode == M_RM_FINAL) {
    // A = colour, B = refined α, C = the blurred background (p2 = (decontaminate amount, on)).
    if (!inside) { return a0; }
    let a = clamp(textureSampleLevel(texB, smp, uv, 0.0).x, 0.0, 1.0);
    var c = straightOf(a0).rgb;
    if (obj.p2.y > 0.5) {
      let bg = textureSampleLevel(texC, smp, uv, 0.0);
      if (a > 0.02 && a < 0.98 && bg.w >= 1e-4) {
        let B = bg.rgb / bg.w;
        let F = clamp((c - (1.0 - a) * B) / a, vec3<f32>(0.0), vec3<f32>(1.0));
        c = c + obj.p2.x * (F - c);
      }
    }
    return encodeOut(c, a);
  }

  if (mode == M_SPILL_VOTE) {
    // Advanced Spill Suppressor ▸ Standard: which of green / blue dominates the
    // layer, from a 64 × 64 sample grid (drawn into one texel).
    var g = 0.0;
    var b = 0.0;
    for (var j = 0; j < 64; j = j + 1) {
      for (var i = 0; i < 64; i = i + 1) {
        let q = obj.fxBox.xy + (vec2<f32>(f32(i), f32(j)) + vec2<f32>(0.5)) / 64.0 * obj.fxBox.zw;
        let s = textureSampleLevel(tex, smp, obj.uvRect.xy + q * obj.uvRect.zw, 0.0);
        if (s.a <= 0.0) { continue; }
        let c = straightOf(s).rgb;
        g = g + max(0.0, c.g - max(c.r, c.b));
        b = b + max(0.0, c.b - max(c.r, c.g));
      }
    }
    return vec4<f32>(g / 4096.0, b / 4096.0, 0.0, 1.0);
  }
  return a0;
}
