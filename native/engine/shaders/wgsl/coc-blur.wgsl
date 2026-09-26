
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  params : vec4<f32>,
  params2 : vec4<f32>,
  corners : vec4<f32>,
  fxBox : vec4<f32>,
  irisP : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
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


fn cocRadius(uv : vec2<f32>) -> f32 {
  let box = obj.fxBox;
  let local = clamp((uv - box.xy) / max(box.zw, vec2<f32>(1e-6)), vec2<f32>(0.0), vec2<f32>(1.0));
  let top = mix(obj.corners.x, obj.corners.y, local.x);
  let bot = mix(obj.corners.w, obj.corners.z, local.x);
  return mix(top, bot, local.y);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSampleLevel(tex, smp, uv, 0.0);
  let radius = cocRadius(uv);
  if (radius < 0.34) { return c0; }
  let blades = obj.params.z;
  let roundness = clamp(obj.params2.x, 0.0, 1.0);
  let gain = max(0.0, obj.params2.y);
  // AE iris extras — neutral values are exact identities (see bokeh's note).
  let rot = obj.params.w;
  let aspect = select(1.0, obj.params2.z, obj.params2.z > 0.0);
  let thr = clamp(obj.params2.w, 0.0, 0.999);
  let sat = max(0.0, obj.irisP.x);
  let fringe = max(0.0, obj.irisP.y);
  let cr = cos(rot);
  let sr = sin(rot);
  let ax = sqrt(aspect);
  let texel = obj.params.xy;
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  if (blades >= 3.0) {
    let n = max(3.0, min(11.0, floor(blades + 0.5)));
    for (var ring = 1; ring <= 5; ring = ring + 1) {
      let fr = f32(ring) / 5.0;
      let r = radius * fr;
      let ringW = 1.0 + fringe * 3.0 * fr * fr * fr * fr;
      for (var b = 0; b < 11; b = b + 1) {
        if (f32(b) >= n) { break; }
        let a0 = 6.2831853 * f32(b) / n;
        let polyR = r / max(0.2, cos(3.14159265 / n));
        let rr = mix(polyR, r, roundness);
        let d0 = vec2<f32>(cos(a0) * ax, sin(a0) / ax);
        let dir = vec2<f32>(d0.x * cr - d0.y * sr, d0.x * sr + d0.y * cr);
        let off = dir * rr * texel;
        let t = textureSampleLevel(tex, smp, uv + off, 0.0);
        var lin = t;
        if (t.a > 0.0001) {
          let straight = t.rgb / t.a;
          lin = vec4<f32>(storageToWorking(straight) * t.a, t.a);
        }
        let lum = dot(lin.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        let lumT = max(0.0, lum - thr) / (1.0 - thr);
        if (sat > 0.0) {
          let grey = vec3<f32>(lum);
          lin = vec4<f32>(grey + (lin.rgb - grey) * (1.0 + sat * lumT), lin.a);
        }
        let w = (1.0 + gain * lumT * lumT) * ringW;
        acc = acc + lin * w;
        wsum = wsum + w;
      }
    }
  } else {
    // Golden-angle rosette (compound-blur style) when iris is off.
    let GOLD = 2.3999632;
    for (var i = 0; i < 24; i = i + 1) {
      let fi = f32(i);
      let a = fi * GOLD;
      let fr = (fi + 0.5) / 24.0;
      let off = vec2<f32>(cos(a), sin(a)) * radius * fr * texel;
      let t = textureSampleLevel(tex, smp, uv + off, 0.0);
      var lin = t;
      if (t.a > 0.0001) {
        let straight = t.rgb / t.a;
        lin = vec4<f32>(storageToWorking(straight) * t.a, t.a);
      }
      acc = acc + lin;
      wsum = wsum + 1.0;
    }
  }
  {
    var lin = c0;
    if (c0.a > 0.0001) {
      let straight = c0.rgb / c0.a;
      lin = vec4<f32>(storageToWorking(straight) * c0.a, c0.a);
    }
    let lum = dot(lin.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let lumT = max(0.0, lum - thr) / (1.0 - thr);
    if (sat > 0.0) {
      let grey = vec3<f32>(lum);
      lin = vec4<f32>(grey + (lin.rgb - grey) * (1.0 + sat * lumT), lin.a);
    }
    let w = 1.0 + gain * lumT * lumT;
    acc = acc + lin * w;
    wsum = wsum + w;
  }
  let avg = acc / max(wsum, 1e-6);
  if (avg.a > 0.0001) {
    let straight = avg.rgb / avg.a;
    return vec4<f32>(workingToStorage(straight) * avg.a, avg.a);
  }
  return avg;
}
