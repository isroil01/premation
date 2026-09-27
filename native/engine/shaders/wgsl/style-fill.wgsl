// E4 (effect_chain.cpp): the interior styles, Satin and Bevel over a FADED
// layer — Fill Opacity < 100 % (effectBake.ts applyEffectChain: the silhouette
// is snapshotted, the contents faded, every style shaped by the snapshot at
// full strength over the faded contents).
//
//   binding 1  the faded contents          binding 3  the blurred silhouette
//   binding 4  the silhouette
//   p0..p3     the style's own rows (INTERIOR_STYLE / SATIN rows with their
//              lw/lh row moved to p3; BEVEL rows as they are)
//   p4.x       0 Inner Shadow, 1 Inner Glow, 2 Satin, 3 Bevel
//
// The band is the reference shaders' (interior-style / satin / bevel), and it
// lands with the Canvas2D operator the CPU pass draws it with — source-over
// (shadow, satin), lighter (glow, bevel highlight), multiply (bevel shadow) —
// in display sRGB, as those passes composite.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, p4: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var tex2 : texture_2d<f32>;
@group(0) @binding(4) var silTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn fieldQ(uv : vec2<f32>) -> vec2<f32> {
  return (uv - obj.uvRect.xy) / obj.uvRect.zw;
}
fn layerUv(px : vec2<f32>, lwh : vec2<f32>) -> vec2<f32> {
  let q = obj.fxBox.xy + (px / lwh) * obj.fxBox.zw;
  return obj.uvRect.xy + q * obj.uvRect.zw;
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
fn decodeS(s : vec4<f32>) -> vec4<f32> {
  let a = max(s.a, 0.00001);
  let c = select(s.rgb / a, vec3<f32>(0.0), s.a <= 0.0);
  return vec4<f32>(linearToSrgbRgb(c), s.a);
}
fn encodeOut(c : vec3<f32>, a : f32) -> vec4<f32> {
  return vec4<f32>(srgbToLinearRgb(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a);
}
fn blurA(px : vec2<f32>, lwh : vec2<f32>) -> f32 {
  return textureSampleLevel(tex2, smp, layerUv(px, lwh), 0.0).a;
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let lwh = obj.p3.xy;
  let pp = (fieldQ(uv) - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001)) * lwh;
  let s0 = textureSampleLevel(tex, smp, uv, 0.0);
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x > lwh.x || pp.y > lwh.y) { return s0; }
  let sil = textureSampleLevel(silTex, smp, uv, 0.0).a;
  if (sil <= 0.0) { return s0; }
  let mode = obj.p4.x;
  var k = obj.p1.xyz;
  var beta = 0.0;
  var op = 0;  // 0 source-over, 1 lighter, 2 multiply
  if (mode < 1.5) {
    beta = (1.0 - blurA(pp - obj.p0.xy, lwh)) * sil * obj.p0.z;
    if (obj.p0.w > 0.5) { op = 1; }
  } else if (mode < 2.5) {
    let A = blurA(pp - obj.p0.xy, lwh);
    let B = blurA(pp + obj.p0.xy, lwh);
    var band = 0.0;
    if (obj.p0.w > 0.5) { band = A * B; }
    else { let a2 = A * (1.0 - B); let b2 = B * (1.0 - A); band = a2 + b2 * (1.0 - a2); }
    beta = band * sil * obj.p0.z;
  } else {
    let xy = floor(pp) + 0.5;
    let hx1 = blurA(xy + vec2<f32>(1.0, 0.0), lwh);
    let hx0 = blurA(xy - vec2<f32>(1.0, 0.0), lwh);
    let hy1 = blurA(xy + vec2<f32>(0.0, 1.0), lwh);
    let hy0 = blurA(xy - vec2<f32>(0.0, 1.0), lwh);
    let nx = -(hx1 - hx0) * 0.5 * obj.p0.w; let ny = -(hy1 - hy0) * 0.5 * obj.p0.w;
    let len = sqrt(nx * nx + ny * ny + 1.0);
    let shade = (nx * obj.p0.x + ny * obj.p0.y + obj.p0.z) / len - obj.p0.z;
    if (shade == 0.0) { return s0; }
    if (shade > 0.0) {
      beta = min(shade, 1.0) * obj.p1.w * sil;
      op = 1;
    } else {
      beta = min(-shade, 1.0) * obj.p2.w * sil;
      k = obj.p2.xyz;
      op = 2;
    }
  }
  if (beta <= 0.0) { return s0; }
  let c = decodeS(s0);
  let da = s0.a;
  var outP = vec3<f32>(0.0);
  var outA = 0.0;
  if (op == 1) {
    outP = min(c.rgb * da + k * beta, vec3<f32>(1.0));
    outA = min(da + beta, 1.0);
  } else if (op == 2) {
    outP = k * beta * (1.0 - da) + c.rgb * da * (1.0 - beta) + k * beta * c.rgb * da;
    outA = beta + da * (1.0 - beta);
  } else {
    outP = k * beta + c.rgb * da * (1.0 - beta);
    outA = beta + da * (1.0 - beta);
  }
  if (outA <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return encodeOut(outP / outA, outA);
}
