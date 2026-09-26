
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, color: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv);
  let width = obj.params.x;
  let texelSize = obj.params.yz;
  // params.w: 0 Outside, 1 Inside, 2 Center, 3 Alpha-dilate (Spread pre-pass).
  let mode = obj.params.w;
  // Center straddles the edge — half the stroke outside, half inside.
  var strokeWidth = width;
  if (mode > 1.5 && mode < 2.5) {
    strokeWidth = width * 0.5;
  }
  var maxAlpha = c.a;
  var minAlpha = c.a;
  // Cap matches layer-style Stroke Size (UI ≤100). Was 16 — thick strokes
  // silently plateaued while the inspector kept climbing.
  let w = i32(clamp(strokeWidth, 1.0, 64.0));
  for (var dy = -w; dy <= w; dy = dy + 1) {
    for (var dx = -w; dx <= w; dx = dx + 1) {
      if (f32(dx*dx + dy*dy) <= strokeWidth*strokeWidth) {
        let offsetUv = uv + vec2<f32>(f32(dx), f32(dy)) * texelSize;
        let a = textureSample(tex, smp, clamp(offsetUv, vec2<f32>(0.0), vec2<f32>(1.0))).a;
        maxAlpha = max(maxAlpha, a);
        minAlpha = min(minAlpha, a);
      }
    }
  }
  if (mode > 2.5) {
    // Dilate: expand alpha footprint for layer-style Spread before blur.
    let scale = select(1.0, maxAlpha / max(c.a, 1e-5), c.a > 1e-5);
    return vec4<f32>(c.rgb * scale, maxAlpha);
  }
  var edge = 0.0;
  if (mode < 0.5) {
    edge = maxAlpha - c.a;
  } else if (mode < 1.5) {
    edge = c.a - minAlpha;
  } else {
    edge = max(maxAlpha - c.a, c.a - minAlpha);
  }
  let strokeCol = vec4<f32>(obj.color.rgb * obj.color.a, obj.color.a);
  return mix(c, strokeCol, edge * strokeCol.a);
}
