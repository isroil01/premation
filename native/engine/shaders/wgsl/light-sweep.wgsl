
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
  let soft = obj.params.x;
  let inten = obj.params.y;
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-12);
  // Field coordinate: the endpoints are authored top-down (fxBox space); uv's
  // V is backend-dependent on FBO round-trips (targetSampleUv).
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let t = clamp(dot(q - a, ab) / len2, 0.0, 1.0);
  // Approximate the soft-shouldered band with a smoothstep falloff from the
  // centre. Matches drawLightSweep visually; avoids a piecewise profile that
  // has disagreed across backends.
  let u = abs(t - 0.5) * 2.0;
  let p = inten * (1.0 - smoothstep(max(0.001, 1.0 - soft), 1.0, u));
  let add = obj.color.rgb * p;
  return vec4<f32>(src.rgb + add * src.a, src.a);
}
