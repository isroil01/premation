// E4 (effect_chain.cpp): Stroke from the alpha distance field (binding 3,
// fx_distance.cpp) — the disc dilation / erosion STROKE_MATERIAL takes over up
// to 129 x 129 taps, in one load. params: x = width (texels), y = position
// (0 Outside, 1 Inside, 2 Center), z = 1 when the field is the fill-opacity
// silhouette's: the band lands as applyStroke draws it (outside / centre
// behind the faded contents, inside on them); z = 0: over the contents as
// STROKE_MATERIAL mixes it.
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, color : vec4<f32>, params : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var tex2 : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(tex, smp, v.uv, 0.0);
  let f = textureLoad(tex2, vec2<i32>(v.pos.xy), 0);
  let sd = f.x;
  let a = f.y;
  let mode = obj.params.y;
  var w = obj.params.x;
  if (mode > 1.5 && mode < 2.5) { w = w * 0.5; }
  let dil = clamp(w + 0.5 - sd, 0.0, 1.0);
  let ero = clamp(0.5 - sd - w, 0.0, 1.0);
  var edge = 0.0;
  if (mode < 0.5) {
    edge = max(dil - a, 0.0);
  } else if (mode < 1.5) {
    edge = max(a - ero, 0.0);
  } else {
    edge = max(max(dil - a, 0.0), max(a - ero, 0.0));
  }
  let k = vec4<f32>(obj.color.rgb * obj.color.a, obj.color.a);
  if (obj.params.z < 0.5) { return mix(c, k, edge * k.a); }
  let band = k * edge;
  if (mode > 0.5 && mode < 1.5) { return band * c.a + c * (1.0 - band.a); }
  return c + band * (1.0 - c.a);
}
