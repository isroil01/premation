
struct Object {
  mvp: mat3x3<f32>,
  uvRect: vec4<f32>,
  ends: vec4<f32>,
  params: vec4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let a = obj.ends.xy;
  let b = obj.ends.zw;
  let core = obj.params.x;
  let soft = obj.params.y;
  let aa = obj.params.z;
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-12);
  // Field coordinate: endpoints are authored top-down (fxBox space); uv's V
  // is backend-dependent on FBO round-trips (targetSampleUv).
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let t = clamp(dot(q - a, ab) / len2, 0.0, 1.0);
  let d = length(q - (a + ab * t));
  let cov = 1.0 - smoothstep(core - aa, core + aa, d);
  let covSoft = 1.0 - smoothstep(soft - aa, soft + aa, d);
  let add = obj.color.rgb * t * (0.35 * covSoft + cov);
  return vec4<f32>(src.rgb + add, min(1.0, src.a + t * (0.35 * covSoft + cov)));
}
