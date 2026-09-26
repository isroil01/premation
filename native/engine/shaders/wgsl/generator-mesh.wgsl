
struct Object {
  mvp : mat3x3<f32>,
  params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn vs(
  @location(0) mPos : vec3<f32>,
  @location(5) mUv : vec2<f32>,
  @location(1) iPos : vec3<f32>,
  @location(2) iSizeRot : vec2<f32>,
  @location(3) iColor : vec4<f32>
) -> VOut {
  var o : VOut;
  let scaled = mPos * iSizeRot.x;
  let s = sin(iSizeRot.y);
  let cs = cos(iSizeRot.y);
  let rotated = vec3<f32>(scaled.x * cs - scaled.y * s, scaled.x * s + scaled.y * cs, scaled.z);
  let world = iPos + rotated;
  let focal = obj.params.y;
  var k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - world.z, 1.0); }
  let p = obj.mvp * vec3<f32>(world.xy * k, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = mUv;
  o.color = iColor;
  return o;
}

@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  let t = textureSample(tex, smp, uv);
  return vec4<f32>(t.rgb * color.rgb * color.a, t.a * color.a);
}
