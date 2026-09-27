
struct Object {
  mvp: mat3x3<f32>,
  uvRect: vec4<f32>,
  ends: vec4<f32>,
  params: vec4<f32>,
  seedComp: vec4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn nextRand(state: ptr<function, u32>) -> f32 {
  *state = (*state) * 22695477u + 1u;
  return f32(*state) * (1.0 / 4294967296.0);
}
fn angDiff(a: f32, b: f32) -> f32 {
  var d = a - b;
  d = d - 6.28318530718 * floor((d + 3.14159265359) / 6.28318530718);
  return d;
}
fn radialFalloff(t: f32, falloff: f32, a: f32) -> f32 {
  let mid = max(0.001, 1.0 - falloff);
  let r0 = mix(a, a * 0.35, t / mid);
  let r1 = mix(a * 0.35, 0.0, (t - mid) / max(1.0 - mid, 1e-5));
  return select(r1, r0, t <= mid);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  let c = obj.ends.xy;
  let maxLen = max(obj.ends.z, 1e-6);
  let n = i32(clamp(obj.ends.w, 1.0, 128.0));
  let opac = obj.params.x;
  let falloff = obj.params.y;
  let rot = obj.params.z;
  var arc = obj.params.w;
  if (arc <= 1e-5) { arc = 6.28318530718; }
  let hue = obj.color.rgb;
  var state: u32 = u32(obj.seedComp.x) * 22695477u + 1u;
  // FIELD coordinate: uv's V runs the opposite way per backend on FBO
  // round-trips (targetSampleUv), which mirrored the whole ray fan on WebGL2
  // — the centre (ends.xy) is authored in top-down box fractions.
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let delta = q - c;
  let dist = length(delta);
  let pang = atan2(delta.y, delta.x);
  var add = 0.0;
  let nf = f32(n);
  for (var i = 0; i < 128; i++) {
    if (i >= n) { break; }
    let fi = f32(i);
    let jitter = (nextRand(&state) - 0.5) * (arc / nf) * 0.6;
    let ang = rot + (fi / nf) * arc - arc * 0.5 + jitter;
    let len = maxLen * (0.55 + nextRand(&state) * 0.45);
    let halfW = (arc / nf) * 0.35;
    let da = abs(angDiff(pang, ang));
    if (da < halfW && dist < len) {
      let lat = 1.0 - da / max(halfW, 1e-5);
      let t = clamp(dist / len, 0.0, 1.0);
      add += lat * radialFalloff(t, falloff, opac);
    }
  }
  let rgb = hue * add;
  let mode = obj.seedComp.y;
  if (mode < 0.5) {
    let outA = add + src.a * (1.0 - add);
    return vec4<f32>(rgb * add + src.rgb * src.a * (1.0 - add), outA);
  }
  // Default lighter (1) and other modes — additive shine.
  return vec4<f32>(src.rgb + rgb, min(1.0, src.a + add));
}
