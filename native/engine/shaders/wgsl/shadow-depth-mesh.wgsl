

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
fn vs(@location(0) pos : vec3<f32>, @location(1) nrm : vec3<f32>, @location(2) uv : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 1.0);
  o.world = (obj.model * vec4<f32>(pos, 1.0)).xyz;
  return o;
}

fn packShadowDepth(d : f32) -> vec4<f32> {
  // AE parity 4.3: float depth into an rgba16float target — r the distance at
  // half precision, g the remainder × 4096, about 24 bits in all (the
  // receivers' unpackShadowDepth). Clamped just short of 1 so the far plane
  // never reads as an occluder.
  let c = clamp(d, 0.0, 0.9999847);
  let hi = unpack2x16float(pack2x16float(vec2<f32>(c, 0.0))).x;
  return vec4<f32>(hi, (c - hi) * 4096.0, 0.0, 1.0);
}

@fragment
fn fs(@location(0) world : vec3<f32>) -> @location(0) vec4<f32> {
  return packShadowDepth(dot(world - obj.origin.xyz, obj.axis.xyz) * obj.axis.w);
}
