

struct Object {
  mvp : mat4x4<f32>,
  model : mat4x4<f32>,
  axis : vec4<f32>,
  origin : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  return o;
}

fn packShadowDepth(d : f32) -> vec4<f32> {
  // Clamped just SHORT of 1: fract(1.0) is 0, so an exact 1 would pack as
  // (0,0,0) and decode as the NEAREST possible caster — the far plane reading
  // as "everything is occluded", which is the whole frame going black.
  let c = clamp(d, 0.0, 0.9999847);
  var e = fract(c * vec3<f32>(1.0, 255.0, 65025.0));
  e = e - vec3<f32>(e.y, e.z, 0.0) * (1.0 / 255.0);
  return vec4<f32>(e, 1.0);
}

@fragment
fn fs(@location(0) world : vec3<f32>) -> @location(0) vec4<f32> {
  return packShadowDepth(dot(world - obj.origin.xyz, obj.axis.xyz) * obj.axis.w);
}
