// AE parity 4.3: an invisible floor at the comp's ground level that only
// catches shadows — black, with the coverage of the shadow the run's mapped
// lights throw onto it. Tested against the run's depth, never written.
struct Object {
  mvp : mat4x4<f32>,
  model : mat4x4<f32>,
  // x = opacity
  params : vec4<f32>,
  shadowMatrix : mat4x4<f32>,
  shadowAxis : vec4<f32>,
  shadowOrigin : vec4<f32>,
  shadowParams : vec4<f32>,
  shadow2Matrix : mat4x4<f32>,
  shadow2Axis : vec4<f32>,
  shadow2Origin : vec4<f32>,
  shadow2Params : vec4<f32>,
  shadow3Matrix : mat4x4<f32>,
  shadow3Axis : vec4<f32>,
  shadow3Origin : vec4<f32>,
  shadow3Params : vec4<f32>,
  shadow4Matrix : mat4x4<f32>,
  shadow4Axis : vec4<f32>,
  shadow4Origin : vec4<f32>,
  shadow4Params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(9) var shadowTex : texture_2d<f32>;
@group(0) @binding(10) var shadowSmp : sampler;
@group(0) @binding(13) var shadow2Tex : texture_2d<f32>;
@group(0) @binding(16) var shadow3Tex : texture_2d<f32>;
@group(0) @binding(17) var shadow4Tex : texture_2d<f32>;

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

fn unpackShadowDepth(c : vec4<f32>) -> f32 {
  return c.r + c.g * (1.0 / 4096.0);
}

fn shadowTerm(worldIn : vec3<f32>, n : vec3<f32>, mtx : mat4x4<f32>, axis : vec4<f32>, origin : vec4<f32>, params : vec4<f32>, tex : texture_2d<f32>, smp : sampler) -> f32 {
  if (params.x < 0.0005) { return 1.0; }
  // Acne control, two halves. A constant bias is tuned for a surface FACING
  // the light; one turned away from it crosses a whole map texel of depth
  // per texel of map, so the same bias reads its own back as an occluder and
  // the face hatches with stripes (every lit wall of an extrusion did). The
  // bias grows with the surface's slope against the light axis (slope-scaled
  // bias, clamped so a grazing wall does not float its shadow away), and the
  // lookup point steps off the surface along its normal by the bias distance
  // (normal-offset shadows), which is what actually clears the stripes on the
  // walls the slope term alone still catches. params.y is bias / far, so
  // bias in px is params.y / axis.w.
  let cosN = abs(dot(n, axis.xyz));
  let slope = sqrt(max(0.0, 1.0 - cosN * cosN)) / max(cosN, 0.05);
  let bias = params.y * (1.0 + min(slope, 4.0) * 1.5);
  // The offset steps TOWARD the light. A layer is two-sided and its normal
  // (the quad's +z) faces away from a light on the camera's side: stepped
  // along it, the lookup sat behind its own surface and the layer shadowed
  // itself (black lit head-on, a striped band at a grazing angle). A
  // parallel light arrives back along the axis (an orthographic map: its w
  // row is 0, 0, 0, 1); a point / spot light from origin, its position (a
  // perspective map: its w row is the axis).
  let persp = abs(mtx[0][3]) + abs(mtx[1][3]) + abs(mtx[2][3]) > 0.5;
  let toLight = select(-axis.xyz, origin.xyz - worldIn, persp);
  let nl = select(n, -n, dot(n, toLight) < 0.0);
  let world = worldIn + nl * (params.y / max(axis.w, 1e-9));
  let clip = mtx * vec4<f32>(world, 1.0);
  if (clip.w <= 1e-6) { return 1.0; }
  var uv = (clip.xy / clip.w) * 0.5 + vec2<f32>(0.5);
  if (params.w > 0.5) { uv.y = 1.0 - uv.y; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let d = dot(world - origin.xyz, axis.xyz) * axis.w - bias;
  if (d <= 0.0 || d >= 1.0) { return 1.0; }
  let s = params.z;
  // Twelve Poisson taps over 1.5 steps, each a bilinear 2×2 comparison — two
  // gathers, as the depth is packed in r + g / 4096 (unpackShadowDepth). The
  // nine nearest taps it replaces gave the penumbra ten hard steps.
  var taps = array<vec2<f32>, 12>(
    vec2<f32>(-0.326, -0.406), vec2<f32>(-0.840, -0.074), vec2<f32>(-0.696, 0.457), vec2<f32>(-0.203, 0.621),
    vec2<f32>(0.962, -0.195), vec2<f32>(0.473, -0.480), vec2<f32>(0.519, 0.767), vec2<f32>(0.185, -0.893),
    vec2<f32>(0.507, 0.064), vec2<f32>(0.896, 0.412), vec2<f32>(-0.322, -0.933), vec2<f32>(-0.792, -0.598));
  let dim = vec2<f32>(textureDimensions(tex, 0));
  var lit = 0.0;
  for (var i = 0; i < 12; i = i + 1) {
    let tuv = uv + taps[i] * s * 1.5;
    let w = fract(tuv * dim - vec2<f32>(0.5));
    let occ = textureGather(0, tex, smp, tuv) + textureGather(1, tex, smp, tuv) * (1.0 / 4096.0);
    // Gather order: x (u0, v1), y (u1, v1), z (u1, v0), w (u0, v0).
    let t = select(vec4<f32>(0.0), vec4<f32>(1.0), vec4<f32>(d) <= occ);
    lit = lit + mix(mix(t.w, t.z, w.x), mix(t.x, t.y, w.x), w.y);
  }
  // Darkness lerps the term back toward fully lit, so 100 % is a black shadow
  // and 60 % leaves 40 % of the light through — the same meaning the slider has
  // on the projected path.
  return 1.0 - (1.0 - lit / 12.0) * params.x;
}

@fragment
fn fs(@location(0) world : vec3<f32>) -> @location(0) vec4<f32> {
  // The floor's normal points up (−y in comp space).
  let n = vec3<f32>(0.0, -1.0, 0.0);
  let lit = shadowTerm(world, n, obj.shadowMatrix, obj.shadowAxis, obj.shadowOrigin, obj.shadowParams, shadowTex, shadowSmp) *
            shadowTerm(world, n, obj.shadow2Matrix, obj.shadow2Axis, obj.shadow2Origin, obj.shadow2Params, shadow2Tex, shadowSmp) *
            shadowTerm(world, n, obj.shadow3Matrix, obj.shadow3Axis, obj.shadow3Origin, obj.shadow3Params, shadow3Tex, shadowSmp) *
            shadowTerm(world, n, obj.shadow4Matrix, obj.shadow4Axis, obj.shadow4Origin, obj.shadow4Params, shadow4Tex, shadowSmp);
  let a = clamp((1.0 - lit) * obj.params.x, 0.0, 1.0);
  if (a < 0.002) { discard; }
  return vec4<f32>(0.0, 0.0, 0.0, a);
}
