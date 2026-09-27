// E4 (fx_distance.cpp): the flooded offsets (binding 1) and the source alpha
// (binding 3) as r = signed distance to the 1/2-contour in texels (+ outside),
// g = the source alpha. A texel next to the contour places the edge by its own
// alpha (0.5 - a), so dilating the field by 0 gives the alpha back.
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, p0 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var tex2 : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let p = vec2<i32>(v.pos.xy);
  let n = textureLoad(tex, p, 0);
  let a = textureLoad(tex2, p, 0).a;
  let dIn = length(n.xy);
  let dOut = length(n.zw);
  var sd = 0.0;
  if (a >= 0.5) {
    sd = select(0.5 - dOut, 0.5 - a, dOut <= 1.0);
  } else {
    sd = select(dIn - 0.5, 0.5 - a, dIn <= 1.0);
  }
  return vec4<f32>(sd, a, 0.0, 1.0);
}
