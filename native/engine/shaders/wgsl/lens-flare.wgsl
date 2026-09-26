
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
fn ghostAlpha(d: f32, gr: f32, alpha: f32) -> f32 {
  return (1.0 - smoothstep(0.0, gr * 0.7, d)) * alpha
    + (1.0 - smoothstep(gr * 0.7, gr, d)) * alpha * 0.5;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let c = obj.ends.xy;
  let mid = obj.ends.zw;
  let b = obj.params.x;
  let coreR = obj.params.y;
  let haloR = obj.params.z;
  let streakH = obj.params.w;
  let hue = obj.color.rgb;
  var add = vec3<f32>(0.0);

  // Field coordinate: centre/ghost positions are authored top-down (fxBox
  // space); uv's V is backend-dependent on FBO round-trips (targetSampleUv).
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let d = length(q - c);
  let haloT = clamp(d / max(haloR, 1e-6), 0.0, 1.0);
  let halo = select(
    mix(0.18 * b, 0.0, (haloT - 0.25) / 0.75),
    mix(0.55 * b, 0.18 * b, haloT / 0.25),
    haloT <= 0.25,
  );
  add += hue * halo;

  let coreW = (1.0 - smoothstep(0.0, coreR * 0.5, d)) * 0.95 * b;
  let coreH = (1.0 - smoothstep(coreR * 0.5, coreR, d)) * 0.5 * b;
  add += vec3<f32>(1.0) * coreW + hue * coreH;

  let sx = abs(q.x - c.x) / max(haloR, 1e-6);
  let sy = abs(q.y - c.y) / max(streakH, 1e-6);
  let streak = (1.0 - smoothstep(0.0, 1.0, sx)) * (1.0 - smoothstep(0.0, 1.0, sy)) * 0.35 * b;
  add += hue * streak;

  let axis = mid - c;
  let gp = array<f32, 7>(-0.35, 0.25, 0.55, 0.8, 1.15, 1.45, 1.9);
  let gs = array<f32, 7>(0.09, 0.05, 0.13, 0.07, 0.045, 0.1, 0.06);
  let span = max(haloR / 0.35, 1e-6);
  for (var i = 0; i < 7; i++) {
    let t = gp[i];
    let gxy = c + axis * (2.0 * t);
    let gr = max(span * gs[i], 1e-6);
    let alpha = 0.14 * b * (1.0 - min(1.0, abs(t) / 2.2));
    add += hue * ghostAlpha(length(q - gxy), gr, alpha);
  }

  return vec4<f32>(src.rgb + add, min(1.0, src.a + max(add.r, max(add.g, add.b))));
}
