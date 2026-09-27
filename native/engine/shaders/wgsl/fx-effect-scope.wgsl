// E4 (effect_chain.cpp): an effect scoped to one mask path — effectBake.ts
// compositeBlend: out = before * (1 - cov) + after * cov, cov = the path's
// coverage (binding 4, drawn into the chain buffer's space) x the effect
// opacity (p0.x), in display-premultiplied values as the Canvas2D ops blend.
//   binding 1  after the effect        binding 3  before it
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var tex2 : texture_2d<f32>;
@group(0) @binding(4) var scopeTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
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
fn encodeOut(c : vec3<f32>, a : f32) -> vec4<f32> {
  return vec4<f32>(srgbToLinearRgb(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a);
}
fn displayPremul(s : vec4<f32>) -> vec4<f32> {
  if (s.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(linearToSrgbRgb(clamp(s.rgb / s.a, vec3<f32>(0.0), vec3<f32>(1.0))) * s.a, s.a);
}

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let cov = clamp(obj.p0.x, 0.0, 1.0) * textureSampleLevel(scopeTex, smp, uv, 0.0).a;
  let outP = displayPremul(textureSampleLevel(tex, smp, uv, 0.0));
  let inP = displayPremul(textureSampleLevel(tex2, smp, uv, 0.0));
  let m = inP * (1.0 - cov) + outP * cov;
  if (m.a <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return encodeOut(m.rgb / m.a, m.a);
}
