// A layer quad as a shadow / SSAO caster, cut out by its own coverage: the
// layer texture's alpha (a PNG with transparency, text, a matte) or a solid's
// SDF shape. Without it a caster was its whole quad, so a cutout cast a
// rectangle (AE parity 1.4). Same depth packing as shadow-depth.wgsl.

struct Object {
  mvp : mat4x4<f32>,
  model : mat4x4<f32>,
  axis : vec4<f32>,
  origin : vec4<f32>,
  uvRect : vec4<f32>,
  // x = kind (0 none, 1 rounded rect, 2 ellipse), y = radius px, zw = size px.
  shape : vec4<f32>,
  // x = layer opacity × tint alpha.
  alpha : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) local : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 0.0, 1.0);
  o.world = (obj.model * vec4<f32>(pos, 0.0, 1.0)).xyz;
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  o.local = pos;
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

fn shapeInside(local : vec2<f32>) -> bool {
  let kind = i32(obj.shape.x + 0.5);
  if (kind == 2) {
    let p = (local - vec2<f32>(0.5)) * 2.0;
    return length(p) <= 1.0;
  }
  if (kind == 1) {
    let r = obj.shape.y;
    let sz = obj.shape.zw;
    let p = (local - vec2<f32>(0.5)) * sz;
    let b = sz * 0.5 - r;
    let q = abs(p) - b;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r <= 0.0;
  }
  return true;
}

@fragment
fn fs(@location(0) world : vec3<f32>, @location(1) uv : vec2<f32>, @location(2) local : vec2<f32>) -> @location(0) vec4<f32> {
  let a = textureSample(tex, smp, uv).a * obj.alpha.x;
  // Half coverage is the cutout edge: a soft edge casts its midline.
  if (a < 0.5 || !shapeInside(local)) { discard; }
  return packShadowDepth(dot(world - obj.origin.xyz, obj.axis.xyz) * obj.axis.w);
}
