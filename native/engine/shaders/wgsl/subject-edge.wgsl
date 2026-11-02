// Stream B3: a subject matte's live edge on the GPU (scene_textures.cpp
// subject_ref; effect_chain.cpp's Set Matte softness / choke). One material,
// several passes, each one quad over the whole target, taps at whole texels
// through a nearest clamp-to-edge sampler (a subject touching the frame's
// edge keeps it — the CPU path, subject_matte.cpp, extends lines by their own
// ends the same way). Each pass is one of:
//   mode 0  MIX     r = tex·(1 − a − b) + texB·a + texC·b      Temporal Smooth: the frame with its neighbours
//   mode 1  GAUSS   a Gaussian of sigma p0.w along dir (p0.yz), weights exp(−k²/2σ²) over ±ceil(3σ)
//   mode 2  ERODE   a running min over ±p0.w along dir      (choke +)
//   mode 3  DILATE  a running max over ±p0.w along dir      (choke −)
//   mode 4  FINISH  the contrast curve (p1.z), the invert (p1.w), united with the
//                   subjects so far (texB, when p0.y > 0.5) by the larger alpha;
//                   written to every channel: (a, a, a, a), premultiplied white.
// Every pass reads coverage from .r (an R8 frame or an R8 scratch target) and
// writes it to .r; FINISH's output is RGBA8. p1.xy = one texel in uv.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var texB : texture_2d<f32>;
@group(0) @binding(4) var texC : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn tap(uv : vec2<f32>) -> f32 { return textureSampleLevel(tex, smp, uv, 0.0).r; }

@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mode = i32(obj.p0.x + 0.5);
  let step = obj.p0.yz * obj.p1.xy;
  if (mode == 0) {
    let a = obj.p1.z;
    let b = obj.p1.w;
    let v = tap(uv) * (1.0 - a - b) + textureSampleLevel(texB, smp, uv, 0.0).r * a + textureSampleLevel(texC, smp, uv, 0.0).r * b;
    return vec4<f32>(v, 0.0, 0.0, 1.0);
  }
  if (mode == 1) {
    let sigma = obj.p0.w;
    if (sigma < 0.1) { return vec4<f32>(tap(uv), 0.0, 0.0, 1.0); }
    let r = min(i32(ceil(3.0 * sigma)), 96);
    var acc = tap(uv);
    var wsum = 1.0;
    for (var k = 1; k <= r; k = k + 1) {
      let w = exp(-f32(k * k) / (2.0 * sigma * sigma));
      acc = acc + w * (tap(uv - step * f32(k)) + tap(uv + step * f32(k)));
      wsum = wsum + 2.0 * w;
    }
    return vec4<f32>(acc / wsum, 0.0, 0.0, 1.0);
  }
  if (mode == 2 || mode == 3) {
    let r = min(i32(obj.p0.w + 0.5), 64);
    var v = tap(uv);
    for (var k = 1; k <= r; k = k + 1) {
      let s = step * f32(k);
      if (mode == 2) { v = min(v, min(tap(uv - s), tap(uv + s))); }
      else { v = max(v, max(tap(uv - s), tap(uv + s))); }
    }
    return vec4<f32>(v, 0.0, 0.0, 1.0);
  }
  // FINISH (subject_matte.cpp finish_alpha): the curve about the 1/2-contour, the invert, the
  // union with texB (p0.y); p0.z clears instead (every subject hidden: a transparent matte).
  if (obj.p0.z > 0.5) { return vec4<f32>(0.0); }
  let contrast = clamp(obj.p1.z, 0.0, 1.0);
  let k = 1.0 / max(0.05, 1.0 - contrast);
  var m = clamp((tap(uv) - 0.5) * k + 0.5, 0.0, 1.0);
  if (obj.p1.w > 0.5) { m = 1.0 - m; }
  if (obj.p0.y > 0.5) { m = max(m, textureSampleLevel(texB, smp, uv, 0.0).a); }
  return vec4<f32>(m, m, m, m);
}
