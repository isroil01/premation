
struct Object {
  mvp : mat3x3<f32>,
  params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn vs(
  @location(0) corner : vec2<f32>,
  @location(1) iPos : vec3<f32>,
  @location(2) iSizeRot : vec2<f32>,
  @location(3) iColor : vec4<f32>,
  @location(4) iUv : vec2<f32>
) -> VOut {
  var o : VOut;
  let focal = obj.params.y;
  // The perspective divide, guarded: an instance AT or BEHIND the focal plane
  // would scale to infinity or turn inside out, so the denominator floors at
  // one pixel. A particle that flew past the camera simply stops growing.
  var k = 1.0;
  if (focal > 0.0) { k = focal / max(focal - iPos.z, 1.0); }
  let c = corner - vec2<f32>(0.5, 0.5);
  let s = sin(iSizeRot.y);
  let cs = cos(iSizeRot.y);
  let size = iSizeRot.x * k;
  let r = vec2<f32>(c.x * cs - c.y * s, c.x * s + c.y * cs) * size;
  let p = obj.mvp * vec3<f32>(iPos.xy * k + r, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = iUv + corner * obj.params.zw;
  o.color = iColor;
  return o;
}

@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  let t = textureSample(tex, smp, uv);
  return vec4<f32>(t.rgb * color.rgb * color.a, t.a * color.a);
}
