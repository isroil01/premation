// E4 (fx_distance.cpp): jump-flood seeds. rg = offset to the nearest INSIDE
// texel (alpha >= 1/2), ba = offset to the nearest OUTSIDE texel, in texels;
// FAR = none yet.
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, p0 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
const FAR : f32 = 16384.0;
@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let a = textureLoad(tex, vec2<i32>(v.pos.xy), 0).a;
  if (a >= 0.5) { return vec4<f32>(0.0, 0.0, FAR, FAR); }
  return vec4<f32>(FAR, FAR, 0.0, 0.0);
}
