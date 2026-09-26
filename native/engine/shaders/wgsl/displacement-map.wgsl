
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
  let d = (mapC.rg - 0.5) * 2.0 * obj.params.xy;
  // Displace in FIELD space: d.y is authored down-positive (top-down), but
  // uv's V runs the opposite way per backend on FBO round-trips
  // (targetSampleUv) — adding d to uv flipped vertical displacement on WebGL2.
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let nq = clamp(q + d, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSample(tex, smp, obj.uvRect.xy + nq * obj.uvRect.zw);
}
