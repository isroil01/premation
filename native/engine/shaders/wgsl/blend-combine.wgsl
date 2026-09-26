
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

fn matteFactor(mode : i32, s : vec4<f32>) -> f32 {
  if (mode == 31) { return clamp(s.a, 0.0, 1.0); }
  if (mode == 32) { return clamp(bLum(s.rgb), 0.0, 1.0); }
  if (mode == 33) { return clamp(1.0 - s.a, 0.0, 1.0); }
  return clamp(1.0 - bLum(s.rgb), 0.0, 1.0);
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
