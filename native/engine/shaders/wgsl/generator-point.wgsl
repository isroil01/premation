
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
  @location(3) iColor : vec4<f32>
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
  o.uv = corner;
  o.color = iColor;
  return o;
}

@fragment
fn fs(@location(0) quad : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  var a = color.a;
  if (obj.params.x < 0.5) {
    // The parameter is the INSTANCE's own quad corner in 0..1, not a target
    // coordinate, so centring on 0.5 finds the centre of this particle rather
    // than the centre of the frame. That is why the raw-centre rule in
    // shaderBackendParity.test.ts does not apply here, and why the name says so.
    let d = length(quad - vec2<f32>(0.5, 0.5)) * 2.0;
    let f = clamp(1.0 - d * d, 0.0, 1.0);
    a = a * f;
  }
  return vec4<f32>(color.rgb * a, a);
}
