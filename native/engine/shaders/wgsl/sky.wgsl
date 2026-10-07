// AE parity 4.4: the environment drawn behind the comp — a visible sky.
// Full-screen, behind every layer (drawn first, no depth): each pixel looks up
// the environment along its own view ray through the 3D camera (and the
// viewport's 2D lift), with the lit shaders' equirect convention.
struct Object {
  invViewProj : mat4x4<f32>,
  // x = intensity, y = rotation (radians), z = roughness band 0..4 (blur),
  // w = the atlas decode scale (negative: a linear float atlas, scale -w).
  envParams : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var envTex : texture_2d<f32>;
@group(0) @binding(2) var envSmp : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) ndc : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let ndc = vec2<f32>(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0);
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.ndc = ndc;
  return o;
}

fn envUv(dir : vec3<f32>, level : f32) -> vec2<f32> {
  let phi = atan2(dir.x, dir.z) - obj.envParams.y;
  let u = phi * 0.15915494309189535;
  let v = acos(clamp(-dir.y, -1.0, 1.0)) * 0.31830988618379069;
  let vy = clamp(v, 0.00390625, 1.0 - 0.00390625);
  return vec2<f32>(u, (level + vy) / 5.0);
}

fn envFetch(dir : vec3<f32>, level : f32) -> vec3<f32> {
  let c = textureSampleLevel(envTex, envSmp, envUv(dir, level), 0.0).rgb;
  let w = obj.envParams.w;
  return select(c * c * w, c * -w, w < 0.0);
}

@fragment
fn fs(@location(0) ndc : vec2<f32>) -> @location(0) vec4<f32> {
  // Two points on this pixel's ray (any two depths: works for either clip-z convention).
  let a = obj.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let b = obj.invViewProj * vec4<f32>(ndc, 0.5, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  let lod = clamp(obj.envParams.z, 0.0, 4.0);
  let l0 = floor(lod);
  let rgb = mix(envFetch(dir, l0), envFetch(dir, min(l0 + 1.0, 4.0)), lod - l0);
  return vec4<f32>(rgb * obj.envParams.x, 1.0);
}
