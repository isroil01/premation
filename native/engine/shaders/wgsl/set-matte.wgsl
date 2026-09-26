
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = textureSample(matteTex, smp, uv);
  // Luminance is read from the PREMULTIPLIED sample deliberately: a transparent
  // region of the matte layer must read as zero coverage, not as whatever colour
  // happens to sit in its unused channels.
  var k = select(m.a, dot(m.rgb, vec3<f32>(0.299, 0.587, 0.114)), obj.params.x > 0.5);
  k = select(k, 1.0 - k, obj.params.y > 0.5);
  return textureSample(tex, smp, uv) * clamp(k, 0.0, 1.0);
}
