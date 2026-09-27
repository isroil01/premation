
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn hash22(p: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(.1031, .1030, .0973));
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
fn perlin(p: vec2<f32>) -> f32 {
  let pi = floor(p); let pf = fract(p);
  let w = pf * pf * (3.0 - 2.0 * pf);
  return mix(
    mix(dot(hash22(pi + vec2<f32>(0.0, 0.0)), pf - vec2<f32>(0.0, 0.0)),
        dot(hash22(pi + vec2<f32>(1.0, 0.0)), pf - vec2<f32>(1.0, 0.0)), w.x),
    mix(dot(hash22(pi + vec2<f32>(0.0, 1.0)), pf - vec2<f32>(0.0, 1.0)),
        dot(hash22(pi + vec2<f32>(1.0, 1.0)), pf - vec2<f32>(1.0, 1.0)), w.x), w.y);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let scale = obj.params.x; let offset = obj.params.yz; let octaves = i32(obj.params.w);
  // Field coordinate: the noise field is anchored top-down like its params;
  // uv's V is backend-dependent on FBO round-trips (targetSampleUv).
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  var n = 0.0; var amp = 0.5; var p = q * scale + offset;
  for (var i = 0; i < 4; i = i + 1) {
    if (i >= octaves) { break; }
    n = n + perlin(p) * amp;
    p = p * 2.0; amp = amp * 0.5;
  }
  let c = textureSample(tex, smp, uv);
  n = n * 0.5 + 0.5;
  return vec4<f32>(vec3<f32>(n), 1.0) * c.a;
}
