
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32>, srcSpace : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
fn linearToSrgbChan(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
// AE's luma matte reads the matte layer as it looks over black, in the
// display-encoded values a non-linear working space blends in: sRGB mid-grey
// (linear 0.214) passes 50 %, not 21 %. `s` is premultiplied, so the luma of
// its straight colour times its alpha already carries the coverage once —
// multiplying by alpha again would pass 25 % through a 50 % white matte.
fn matteLuma(s : vec4<f32>) -> f32 {
  if (s.a <= 0.0) { return 0.0; }
  let c = clamp(s.rgb / s.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let e = vec3<f32>(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
  return dot(e, vec3<f32>(0.2126, 0.7152, 0.0722)) * min(s.a, 1.0);
}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = textureSample(tex, smp, uv);
  let s = textureSample(matteTex, smp, uv);
  let isLuma = obj.cr0.x > 0.5;
  let isInverted = obj.cr0.y > 0.5;
  // An empty matte region is black to a luma matte, so an inverted luma matte
  // passes it fully (AE), like an inverted alpha matte does.
  var val = select(s.a, matteLuma(s), isLuma);
  if (isInverted) { val = 1.0 - val; }
  // tint.a: the matted layer's opacity, applied here after its effects ran
  // at full opacity (the main path does the same at composite).
  val = clamp(val, 0.0, 1.0) * obj.tint.a;
  return vec4<f32>(m.rgb * val, m.a * val);
}
