
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var lutTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn sliceSample(rg : vec2<f32>, slice : f32, n : f32) -> vec3<f32> {
  // Half a texel in from each end of THIS slice, so the linear filter cannot
  // reach the neighbouring slice's very different blue.
  let xIn = clamp(rg.x * (n - 1.0) + 0.5, 0.5, n - 0.5);
  let u = (slice * n + xIn) / (n * n);
  let v = clamp(rg.y * (n - 1.0) + 0.5, 0.5, n - 0.5) / n;
  return textureSampleLevel(lutTex, smp, vec2<f32>(u, v), 0.0).rgb;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, smp, uv);
  if (src.a <= 0.0001) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  // Straight colour for the lookup; premultiplied again at the end.
  let straight = clamp(src.rgb / src.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let lo = obj.params.z;
  let hi = obj.params.w;
  let span = max(hi - lo, 0.0001);
  let c = clamp((straight - vec3<f32>(lo)) / span, vec3<f32>(0.0), vec3<f32>(1.0));
  let n = obj.params.x;
  var graded : vec3<f32>;
  if (obj.params.y > 0.5) {
    // 1D: one texel row, each channel looked up independently.
    let w = n;
    let rr = textureSampleLevel(lutTex, smp, vec2<f32>((c.r * (w - 1.0) + 0.5) / w, 0.5), 0.0).r;
    let gg = textureSampleLevel(lutTex, smp, vec2<f32>((c.g * (w - 1.0) + 0.5) / w, 0.5), 0.0).g;
    let bb = textureSampleLevel(lutTex, smp, vec2<f32>((c.b * (w - 1.0) + 0.5) / w, 0.5), 0.0).b;
    graded = vec3<f32>(rr, gg, bb);
  } else {
    let bz = c.b * (n - 1.0);
    let z0 = floor(bz);
    let z1 = min(z0 + 1.0, n - 1.0);
    let f = bz - z0;
    graded = mix(sliceSample(c.rg, z0, n), sliceSample(c.rg, z1, n), f);
  }
  return vec4<f32>(graded * src.a, src.a);
}
