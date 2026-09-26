
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let radius = max(obj.p0.x, 0.0001);
  let rot = obj.p0.y;
  let shading = obj.p0.z;

  // Field coordinate: fxBox is authored top-down; uv's V is backend-
  // dependent on FBO round-trips (targetSampleUv).
  let fq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let l = (fq - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let px = (l.x - 0.5) * 2.0 / radius;
  if (abs(px) > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let z = sqrt(1.0 - px * px);
  // Angle across the visible front half maps to the FULL texture width, so
  // rotating spins the whole image past the viewer.
  let su = fract(0.5 + asin(px) * 0.31830989 + rot * 0.15915494);
  // textureSampleLEVEL — non-uniform control flow after the silhouette test.
  let c = textureSampleLevel(tex, smp, obj.uvRect.xy + vec2<f32>(su, l.y) * obj.uvRect.zw, 0.0);
  let lam = mix(1.0, z, shading);
  return vec4<f32>(c.rgb * obj.lightColor.rgb * lam, c.a);
}
