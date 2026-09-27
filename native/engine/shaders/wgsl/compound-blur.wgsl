
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var mapTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mapC = textureSample(mapTex, smp, uv);
  // Rec.709 luma. The map's own ALPHA is ignored on purpose: AE reads a
  // luminance map, and an unpremultiplied read would make a transparent map
  // blur by whatever colour happened to sit behind it.
  var lum = dot(mapC.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (obj.params.y > 0.5) { lum = 1.0 - lum; }
  let radius = obj.params.x * clamp(lum, 0.0, 1.0);
  let c0 = textureSample(tex, smp, uv);
  // Below a third of a texel the rosette collapses onto the centre and the
  // taps are 13 copies of one sample — cheaper and exact to return it.
  if (radius < 0.34) { return c0; }
  var acc = c0;
  var wsum = 1.0;
  for (var i = 0; i < 12; i = i + 1) {
    let fi = f32(i);
    // Golden angle, and sqrt so the samples spread by AREA rather than
    // clustering at the centre.
    let a = fi * 2.39996323;
    let r = radius * sqrt((fi + 0.5) / 12.0);
    // Offsets are FIELD-space directions (golden-angle rosette — asymmetric,
    // so orientation matters); uv's V is backend-dependent on FBO round-trips
    // (targetSampleUv). sign(uvRect.zw) folds the field->sample conversion in.
    let off = vec2<f32>(cos(a), sin(a)) * r * obj.params.zw * sign(obj.uvRect.zw);
    // textureSampleLEVEL, not textureSample. The plain form computes implicit
    // derivatives, which WGSL permits only in uniform control flow — and the
    // radius < 0.34 early return above makes this loop non-uniform. So the
    // shader failed to compile on WebGPU ("must only be called from uniform
    // control flow"), its pipeline was invalid, and Compound Blur drew NOTHING
    // on the primary backend while rendering correctly on WebGL2, whose GLSL
    // twin has no such rule.
    //
    // Explicit LOD 0 is not a compromise: every source here is a non-mipmapped
    // render target, so it is the level implicit sampling would have chosen.
    // The WebGL2 path is untouched.
    acc = acc + textureSampleLevel(tex, smp, uv + off, 0.0);
    wsum = wsum + 1.0;
  }
  return acc / wsum;
}
