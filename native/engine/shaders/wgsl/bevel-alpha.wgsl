
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let thick = max(obj.p0.x, 0.0001);
  let lightDir = vec2<f32>(obj.p0.y, obj.p0.z);
  let intensity = obj.p0.w;
  let texel = obj.p1.xy * thick;

  let c = textureSample(tex, smp, uv);
  // Central differences on ALPHA: the gradient points into the shape, so it is
  // the 2D part of the surface normal of a chamfer around the silhouette.
  let ax = textureSample(tex, smp, uv + vec2<f32>(texel.x, 0.0)).a
         - textureSample(tex, smp, uv - vec2<f32>(texel.x, 0.0)).a;
  let ay = textureSample(tex, smp, uv + vec2<f32>(0.0, texel.y)).a
         - textureSample(tex, smp, uv - vec2<f32>(0.0, texel.y)).a;
  let g = vec2<f32>(ax, ay);
  let mag = length(g);
  // Flat interior has no gradient and must stay untouched, or the whole layer
  // tints instead of just its rim.
  if (mag < 0.0001 || c.a <= 0.0) { return c; }
  let lambert = dot(g / mag, lightDir);
  // Rim strength rides the gradient magnitude, so a soft edge bevels softly.
  let shade = lambert * clamp(mag, 0.0, 1.0) * intensity;
  // Premultiplied in, premultiplied out: scale by the pixel's own alpha so the
  // highlight cannot exceed coverage (see project-motion-alpha-invariant).
  let lit = obj.lightColor.rgb * max(shade, 0.0) * c.a;
  let dark = 1.0 - clamp(-shade, 0.0, 1.0);
  return vec4<f32>(c.rgb * dark + lit, c.a);
}
