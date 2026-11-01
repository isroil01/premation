
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


@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let r = obj.blurParams.z;
  if (r <= 0.0) {
    return textureSample(tex, smp, uv);
  }
  let dir = obj.blurParams.xy;

  // CSS blur semantics: the radius IS the Gaussian sigma (what Canvas2D's
  // filter uses, so both backends match). Taps span ±3.5σ; when that exceeds
  // the loop cap, taps spread out and linear filtering fills the gaps. The
  // old kernel used σ = r/2 truncated at ±r — visibly tighter than Canvas2D
  // at every radius (profiled: tail died 2–3× sooner).
  //
  // The sum is linear in the texels: premultiplied colour in the storage
  // space, which is the working space here (storageToWorking and
  // workingToStorage are the identity in every shader of the library), so
  // two neighbouring taps can share one bilinear fetch below.
  let sigma = r;
  // ±3.5σ, not 2.5σ: at 2.5σ the Gaussian is still 4% of its peak, and the two
  // separable passes cut a wide glow off at a RECTANGLE — a faint box around
  // every big glow on a dark ground (docs/PROGRAM_PERFORMANCE.md S4). At 3.5σ
  // the tail is 0.2%, below one 8-bit step.
  //
  // The tap SPACING stays what it was at ±2.5σ over 30 taps (max(1, 2.5σ / 30));
  // the reach grows by adding taps (up to 42 a side), not by spreading them. Taps
  // further apart skip texels, and on a hard edge that aliases: a bevel's lighting
  // (the slope of this blur) rippled ±6 levels at σ 30 when the 30 taps were
  // stretched over 3.5σ (bevel-below-cap / -above-cap goldens, 2026-10-13).
  //
  // The taps stop at ±3.5σ. They used to run to at least ±30 whatever σ, so a
  // σ 4 drop shadow paid 61 fetches a pixel a pass for 29 taps of weight
  // under 1e-12 (renderArtifacts / manyEffects benches, 2026-11-01).
  let spacing = max(1.0, (sigma * 2.5) / 30.0);
  let steps = max(1, i32(ceil((sigma * 3.5) / spacing - 0.001)));
  let k = 0.5 / (sigma * sigma);
  var c = textureSample(tex, smp, uv);
  var total = 1.0;
  if (spacing <= 1.0) {
    // One texel apart: taps i and i + 1 are one fetch between them, at the
    // weight-centred offset (the bilinear filter returns exactly
    // (w1·t1 + w2·t2) / (w1 + w2) there) — half the fetches, the same sum.
    for (var i = 1; i <= steps; i = i + 2) {
      let o1 = f32(i);
      let o2 = o1 + 1.0;
      let w1 = exp(-(o1 * o1) * k);
      let w2 = select(0.0, exp(-(o2 * o2) * k), i + 1 <= steps);
      let w = w1 + w2;
      let o = (o1 * w1 + o2 * w2) / w;
      c = c + (textureSample(tex, smp, uv + dir * o) + textureSample(tex, smp, uv - dir * o)) * w;
      total = total + 2.0 * w;
    }
  } else {
    for (var i = 1; i <= steps; i = i + 1) {
      let off = f32(i) * spacing;
      let w = exp(-(off * off) * k);
      c = c + (textureSample(tex, smp, uv + dir * off) + textureSample(tex, smp, uv - dir * off)) * w;
      total = total + 2.0 * w;
    }
  }
  return c / total;
}
