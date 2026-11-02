
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
  srcSpace : vec4<f32>,
  edge : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var maskTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) local : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let local = mix(-obj.edge.xy, vec2<f32>(1.0) + obj.edge.xy, pos);
  let p = obj.mvp * vec3<f32>(local, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + local * obj.uvRect.zw;
  o.local = local;
  return o;
}

fn unpremul(t : vec4<f32>) -> vec4<f32> {
  // 1e-5, not 1/255: faint light (a glow's tail) is alpha under one 8-bit step (S4).
  if (t.a < 0.00001) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(t.rgb / t.a, t.a);
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


// Layer-edge antialiasing (uniforms.hpp LayerEdge): `local` is the layer's unit
// quad, grown by edge.xy (one device pixel) each side. The coverage is the area
// of a one-pixel box filter inside the quad, per axis in device pixels from the
// local coordinate's screen gradient, so a rotated, scaled or squashed edge
// gets the same one-pixel ramp; a pixel-aligned edge stays fully opaque.
fn edgeCoverage(local : vec2<f32>) -> f32 {
  let gx = max(length(vec2<f32>(dpdx(local.x), dpdy(local.x))), 1e-8);
  let gy = max(length(vec2<f32>(dpdx(local.y), dpdy(local.y))), 1e-8);
  let cx = clamp(local.x / gx + 0.5, 0.0, 1.0) + clamp((1.0 - local.x) / gx + 0.5, 0.0, 1.0) - 1.0;
  let cy = clamp(local.y / gy + 0.5, 0.0, 1.0) + clamp((1.0 - local.y) / gy + 0.5, 0.0, 1.0) - 1.0;
  return max(cx, 0.0) * max(cy, 0.0);
}

@fragment
fn fs(@location(0) uvIn : vec2<f32>, @location(1) local : vec2<f32>) -> @location(0) vec4<f32> {
  // The grown margin samples the edge texel (clamped to the uv rect), with the
  // unclamped gradients so a mipmapped texture keeps its level there. edge.w
  // scales them (0 = 1): a vector raster is supersampled 2×, so its mip level
  // is chosen one finer — the 2× texels are already antialiased, and the
  // coarser level would add a second pixel of blur to every edge.
  let uvLo = min(obj.uvRect.xy, obj.uvRect.xy + obj.uvRect.zw);
  let uvHi = max(obj.uvRect.xy, obj.uvRect.xy + obj.uvRect.zw);
  let uv = clamp(uvIn, uvLo, uvHi);
  let lodScale = select(1.0, obj.edge.w, obj.edge.w > 0.0);
  // lodScale ½ picks one mip level finer for a supersampled raster. Only the
  // shorter gradient (the one the anisotropic LOD follows) is halved; the
  // longer loses the same length, so a squashed layer's filter still spans its
  // whole footprint. Halving both aliased edges along the squashed axis.
  let gdx = dpdx(uvIn);
  let gdy = dpdy(uvIn);
  let lx = max(length(gdx), 1e-12);
  let ly = max(length(gdy), 1e-12);
  let cut = min(lx, ly) * (1.0 - lodScale);
  let ddx = gdx * ((lx - cut) / lx);
  let ddy = gdy * ((ly - cut) / ly);
  let cov = select(1.0, edgeCoverage(local), obj.edge.z > 0.5);
  let c = unpremul(textureSampleGrad(tex, smp, uv, ddx, ddy)) * obj.tint;
  let v = vec4<f32>(c.rgb, 1.0);
  let graded = vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v));
  let maskAlpha = textureSampleGrad(maskTex, smp, uv, ddx, ddy).a;
  let a = c.a * maskAlpha * cov;
  return vec4<f32>(graded * a, a);
}
