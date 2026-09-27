// E4 (effect_chain.cpp, layer-style Spread): the alpha dilated by p0.x texels
// from the distance field (binding 1), times p0.y (the fill opacity when the
// field is the silhouette's), as premultiplied white — the reference
// STROKE_MATERIAL mode 3 feeds only silhouette draws, which read alpha alone.
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, p0 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let f = textureLoad(tex, vec2<i32>(v.pos.xy), 0);
  let dil = clamp(obj.p0.x + 0.5 - f.x, 0.0, 1.0) * obj.p0.y;
  return vec4<f32>(dil, dil, dil, dil);
}
