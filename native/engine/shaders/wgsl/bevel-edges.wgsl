
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
  let c = textureSample(tex, smp, uv);
  // Local coordinates INSIDE the layer box, so the bevel follows the frame
  // rather than the content — that is the whole difference from Bevel Alpha.
  // Field coordinate: fxBox is authored top-down; uv's V is backend-
  // dependent on FBO round-trips (targetSampleUv).
  let fq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let l = (fq - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let dl = l.x; let dr = 1.0 - l.x; let dt = l.y; let db = 1.0 - l.y;
  let d = min(min(dl, dr), min(dt, db));
  if (d > thick) { return c; }
  // The nearest border decides which way the chamfer faces.
  var n = vec2<f32>(0.0, 0.0);
  if (d == dl) { n = vec2<f32>(-1.0, 0.0); }
  else if (d == dr) { n = vec2<f32>(1.0, 0.0); }
  else if (d == dt) { n = vec2<f32>(0.0, -1.0); }
  else { n = vec2<f32>(0.0, 1.0); }
  // Ramp to zero at the inner limit of the bevel so it does not end in a line.
  let ramp = 1.0 - d / thick;
  let shade = dot(n, lightDir) * ramp * intensity;
  let lit = obj.lightColor.rgb * max(shade, 0.0) * c.a;
  let dark = 1.0 - clamp(-shade, 0.0, 1.0);
  return vec4<f32>(c.rgb * dark + lit, c.a);
}
