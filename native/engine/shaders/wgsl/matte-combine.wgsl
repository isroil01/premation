
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, tint : vec4<f32>, cr0 : vec4<f32>, cr1 : vec4<f32>, cr2 : vec4<f32>, srcSpace : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var matteTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let m = textureSample(tex, smp, uv);
  let s = textureSample(matteTex, smp, uv);
  let isLuma = obj.cr0.x > 0.5;
  let isInverted = obj.cr0.y > 0.5;
  var val : f32;
  if (isLuma) {
    let lumaVal = dot(s.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (isInverted) {
      val = (1.0 - lumaVal) * s.a;
    } else {
      val = lumaVal * s.a;
    }
  } else {
    if (isInverted) {
      val = 1.0 - s.a;
    } else {
      val = s.a;
    }
  }
  return vec4<f32>(m.rgb * val, m.a * val);
}
