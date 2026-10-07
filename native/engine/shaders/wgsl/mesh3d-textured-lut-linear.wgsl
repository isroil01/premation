

struct Object {
  mvp : mat4x4<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
  srcSpace : vec4<f32>,
  model : mat4x4<f32>,
  eyeLit : vec4<f32>,
  shadeParams : vec4<f32>,
  lights : array<vec4<f32>, 32>,
  envParams : vec4<f32>,
  reflParams : vec4<f32>,
  alphaParams : vec4<f32>,
  aoMatrix : mat4x4<f32>,
  aoParams : vec4<f32>,
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
  envSh : array<vec4<f32>, 9>,
  envShParams : vec4<f32>,
  fogParams : vec4<f32>,
  fogColor : vec4<f32>,
  fogEye : vec4<f32>,
  layerReflParams : vec4<f32>,
  layerReflMatrix : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

// Specular environment map: the roughness bands, stacked. Bindings 7/8 —
// clear of the mask (3), a plugin origin (4) and the mesh PBR set (3-6).
@group(0) @binding(7) var envTex : texture_2d<f32>;
@group(0) @binding(8) var envSmp : sampler;

// The shadow map, 9/10. Its own sampler because it is the one texture in a lit
// draw that must be NEAREST: its texels are a 24-bit depth packed across rgb,
// and a bilinear blend of two packed depths is not a depth.
@group(0) @binding(9) var shadowTex : texture_2d<f32>;
@group(0) @binding(10) var shadowSmp : sampler;
// The run's SECOND shadow map, 13/14 (plan B2) — same contract as 9/10.
@group(0) @binding(13) var shadow2Tex : texture_2d<f32>;
@group(0) @binding(14) var shadow2Smp : sampler;
// AE parity 4.3: the run's third and fourth shadow-mapped lights, 16/17 — the
// same contract as 9/10, sampled with the first map's nearest sampler.
@group(0) @binding(16) var shadow3Tex : texture_2d<f32>;
@group(0) @binding(17) var shadow4Tex : texture_2d<f32>;
// AE parity 4.8: this surface's planar reflection of the run's other layers, 18.
@group(0) @binding(18) var layerReflTex : texture_2d<f32>;

// The run's ambient-occlusion buffer, 11/12. Its own sampler for the opposite
// reason the shadow map has one: this one must be LINEAR (it is a half-res
// image being magnified), and solid3d carries no layer sampler at all for the
// backend to broadcast, so an AO unit without its own would be incomplete.
@group(0) @binding(11) var ssaoMap : texture_2d<f32>;
@group(0) @binding(12) var ssaoMapSmp : sampler;

@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(15) var lutTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) world : vec3<f32>,
  @location(2) nrm : vec3<f32>,
  // AE parity 4.7: the vertex colour (glTF COLOR_0, linear rgba; white when the mesh has none).
  @location(3) col : vec4<f32>,
};

// Inverse-transpose of the model's 3×3, so a non-uniformly scaled layer still
// lights with correct normals (and a mirrored one keeps them outward).
fn normalMatrix(m : mat3x3<f32>) -> mat3x3<f32> {
  let c0 = cross(m[1], m[2]);
  let c1 = cross(m[2], m[0]);
  let c2 = cross(m[0], m[1]);
  let det = dot(m[0], c0);
  let inv = select(1.0 / det, 1.0, abs(det) < 1e-12);
  return mat3x3<f32>(c0 * inv, c1 * inv, c2 * inv);
}

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) nrm : vec3<f32>, @location(2) uv : vec2<f32>, @location(3) col : vec4<f32>) -> VOut {
  var o : VOut;
  o.pos = obj.mvp * vec4<f32>(pos, 1.0);
  o.uv = obj.uvRect.xy + uv * obj.uvRect.zw;
  o.world = (obj.model * vec4<f32>(pos, 1.0)).xyz;
  let m = mat3x3<f32>(obj.model[0].xyz, obj.model[1].xyz, obj.model[2].xyz);
  o.nrm = normalMatrix(m) * nrm;
  o.col = col;
  return o;
}



/*
  Image-based reflections — the split-sum approximation.

  envParams: x = enabled (0 for every scene without an environment light,
  which is what makes this whole block a no-op there), y = intensity, z = the
  environment rotation in RADIANS, w = the atlas HDR decode scale.

  envSpecular is textureLod written out by hand: the map is ONE 2D texture
  holding the roughness levels as equirect bands stacked vertically, so a
  fractional level is two taps and a mix. A real mip chain would be tidier and
  is not available - neither backend's writeTexture uploads past level 0.
*/
fn envUv(dir : vec3<f32>, level : f32) -> vec2<f32> {
  // Inverse of the projector's equirectDir (core/scene/environmentLight.ts):
  // phi sweeps about the compositor's vertical axis with phi = 0 facing +z,
  // theta measures from "up" (-y). Rotating the environment by +a is sampling
  // it at -a - the same convention environmentRig counter-rotates its axes
  // with, so the reflection and the SH light rig turn together.
  let phi = atan2(dir.x, dir.z) - obj.envParams.z;
  // No wrap here: the env sampler REPEATS in u, so a rotation may push this
  // outside [0,1] and the hardware brings it back — including across the seam,
  // which a fract() would break by clamping the bilinear tap at the edge.
  let u = phi * 0.15915494309189535;
  let v = acos(clamp(-dir.y, -1.0, 1.0)) * 0.31830988618379069;
  // Half-texel inset, or a direction at a pole bilinearly taps the NEXT
  // roughness band stacked below this one.
  let vy = clamp(v, 0.00390625, 1.0 - 0.00390625);
  return vec2<f32>(u, (level + vy) / 5.0);
}

fn envFetch(dir : vec3<f32>, level : f32) -> vec3<f32> {
  // Explicit LOD (not textureSample) so this stays legal inside the gate's
  // conditional: WGSL's uniformity analysis rejects implicit derivatives
  // there, and there is nothing to derive from anyway.
  let c = textureSampleLevel(envTex, envSmp, envUv(dir, level), 0.0).rgb;
  // sqrt transfer + one scale - see EnvSpecularMap's encoding note. A
  // NEGATIVE scale marks a linear float atlas (AE parity 4.4: an HDRI's
  // rgba16float atlas, or a live comp / video environment prefiltered on the
  // GPU): no transfer, scale -w.
  let w = obj.envParams.w;
  return select(c * c * w, c * -w, w < 0.0);
}

fn envSpecular(dir : vec3<f32>, roughness : f32) -> vec3<f32> {
  let lod = clamp(roughness, 0.0, 1.0) * (5.0 - 1.0);
  let l0 = floor(lod);
  return mix(envFetch(dir, l0), envFetch(dir, min(l0 + 1.0, 5.0 - 1.0)), lod - l0);
}

// Karis' analytic environment BRDF (the mobile fit): the split sum's second
// factor without a BRDF lookup TEXTURE, which would have cost another binding
// and another upload to describe a surface this smooth.
fn envBRDF(NdotV : f32, roughness : f32) -> vec2<f32> {
  let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

/*
  Geometry-aware shadows — one light's casters, rasterised from the light.

  shadowParams: x = DARKNESS, how much of the light a caster blocks (AE's
  Shadow Darkness). Zero for every comp that has not turned a light's Shadow Map
  on, which is the whole gate: the block below never runs there and those frames
  render the arithmetic they rendered before shadow maps existed. One number
  rather than a flag plus a strength, because a shadow that blocks nothing IS
  no shadow. y = depth bias, z = PCF tap spacing in UV, w = 1 when the lookup
  must flip v (WebGPU, which writes render targets top-down; WebGL2 needs none).

  The map stores a LINEAR distance measured along the light's own axis
  (shadowAxis.xyz, from shadowOrigin.xyz, scaled by shadowAxis.w = 1/far),
  packed 24-bit across rgb — NOT a clip-space z. Two reasons, both decisive:
  (No backticks in here: this shader source is itself a JS template literal.)

    · clip z means [-1,1] on WebGL2 and [0,1] on WebGPU, so one bias would be
      half the other and a scene tuned on one backend would acne on the other;
    · an rgba8 colour target is renderable and sampleable on BOTH backends
      without asking whether a depth TEXTURE can be sampled, which is the trap
      the DOF gather work already paid for once.

  Outside the map, in front of the light, or past the far plane the answer is
  LIT. Guessing "shadowed" outside the frustum would black out everything the
  caster bounds could not cover, which is most of a comp.
*/
fn unpackShadowDepth(c : vec4<f32>) -> f32 {
  // AE parity 4.3: float depth — the maps are rgba16float, r the distance
  // rounded to half precision and g the remainder × 4096 (about 24 bits in
  // all). A cleared map (1, 1) reads past the far plane: lit.
  return c.r + c.g * (1.0 / 4096.0);
}

// One body for both maps: the block's four uniforms and the map's handles are
// parameters, so the second light's shadow (plan B2) is the same arithmetic
// against its own map rather than a copy that could drift.
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
  let world = worldIn + n * (params.y / max(axis.w, 1e-9));
  let clip = mtx * vec4<f32>(world, 1.0);
  if (clip.w <= 1e-6) { return 1.0; }
  var uv = (clip.xy / clip.w) * 0.5 + vec2<f32>(0.5);
  if (params.w > 0.5) { uv.y = 1.0 - uv.y; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let d = dot(world - origin.xyz, axis.xyz) * axis.w - bias;
  if (d <= 0.0 || d >= 1.0) { return 1.0; }
  let s = params.z;
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      // Explicit LOD, like envFetch: the map has no mip chain, and an implicit
      // derivative inside this nest is both meaningless and illegal in WGSL.
      let occ = unpackShadowDepth(textureSampleLevel(tex, smp, uv + vec2<f32>(f32(x), f32(y)) * s, 0.0));
      lit = lit + select(0.0, 1.0, d <= occ);
    }
  }
  // Darkness lerps the term back toward fully lit, so 100 % is a black shadow
  // and 60 % leaves 40 % of the light through — the same meaning the slider has
  // on the projected path.
  return 1.0 - (1.0 - lit / 9.0) * params.x;
}
fn shadowFactor(world : vec3<f32>, n : vec3<f32>) -> f32 {
  if (obj.shadowParams.x < 0.0005) { return 1.0; }
  return shadowTerm(world, n, obj.shadowMatrix, obj.shadowAxis, obj.shadowOrigin, obj.shadowParams, shadowTex, shadowSmp);
}
fn shadowFactor2(world : vec3<f32>, n : vec3<f32>) -> f32 {
  if (obj.shadow2Params.x < 0.0005) { return 1.0; }
  return shadowTerm(world, n, obj.shadow2Matrix, obj.shadow2Axis, obj.shadow2Origin, obj.shadow2Params, shadow2Tex, shadow2Smp);
}

// AE parity 4.3: the third and fourth mapped lights — the same arithmetic.
fn shadowFactor3(world : vec3<f32>, n : vec3<f32>) -> f32 {
  if (obj.shadow3Params.x < 0.0005) { return 1.0; }
  return shadowTerm(world, n, obj.shadow3Matrix, obj.shadow3Axis, obj.shadow3Origin, obj.shadow3Params, shadow3Tex, shadowSmp);
}
fn shadowFactor4(world : vec3<f32>, n : vec3<f32>) -> f32 {
  if (obj.shadow4Params.x < 0.0005) { return 1.0; }
  return shadowTerm(world, n, obj.shadow4Matrix, obj.shadow4Axis, obj.shadow4Origin, obj.shadow4Params, shadow4Tex, shadowSmp);
}

/*
  AE parity 4.4: image-based DIFFUSE from the environment's band-2 SH probe —
  irradiance (already × the band weights, the light's intensity and 1/π, see
  threed.cpp) evaluated at the normal, so an environment light no longer
  spends light slots on a derived rig. envShParams: x = on, y = the shadow
  slot casting the environment's key shadow (−1 none), z = how much of the
  irradiance that shadow can take, w = the environment rotation (radians).
  Same basis and axes as env_light.cpp (−y is up).
*/
fn envIrradiance(nIn : vec3<f32>) -> vec3<f32> {
  let a = -obj.envShParams.w;
  let c = cos(a);
  let s = sin(a);
  let n = vec3<f32>(nIn.x * c + nIn.z * s, nIn.y, -nIn.x * s + nIn.z * c);
  var r = obj.envSh[0].rgb * 0.282095;
  r = r + obj.envSh[1].rgb * (0.488603 * n.y);
  r = r + obj.envSh[2].rgb * (0.488603 * n.z);
  r = r + obj.envSh[3].rgb * (0.488603 * n.x);
  r = r + obj.envSh[4].rgb * (1.092548 * n.x * n.y);
  r = r + obj.envSh[5].rgb * (1.092548 * n.y * n.z);
  r = r + obj.envSh[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0));
  r = r + obj.envSh[7].rgb * (1.092548 * n.x * n.z);
  r = r + obj.envSh[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
  return max(r, vec3<f32>(0.0));
}

/*
  AE parity 4.8: distance fog. fogParams: x = mode (0 off, 1 linear, 2
  exponential, 3 exponential²), y = start, z = end (linear), w = density per
  1000 px; fogColor: working-space rgb + the most fog can hide; fogEye: the
  camera. Packed for unlit draws too — fog is not lighting.
*/
fn applyFog(world : vec3<f32>, rgb : vec3<f32>) -> vec3<f32> {
  let mode = i32(obj.fogParams.x + 0.5);
  if (mode == 0) { return rgb; }
  let d = distance(world, obj.fogEye.xyz);
  var f = 0.0;
  if (mode == 1) {
    f = clamp((d - obj.fogParams.y) / max(obj.fogParams.z - obj.fogParams.y, 1e-3), 0.0, 1.0);
  } else {
    let k = max(d - obj.fogParams.y, 0.0) * obj.fogParams.w * 0.001;
    f = select(1.0 - exp(-k * k), 1.0 - exp(-k), mode == 2);
  }
  return mix(rgb, obj.fogColor.rgb, f * obj.fogColor.a);
}

/*
  AE parity 4.8: layer-to-layer reflections. The run's other layers are drawn
  mirrored about this surface through the same camera (threed.cpp) into 18,
  and sampled here at this fragment's own screen position. layerReflParams:
  x = strength (0 = off), y = blur radius in UV (from Reflection Sharpness),
  z = 1 to flip v (WebGPU), w = Fresnel rolloff.
*/
fn layerReflection(world : vec3<f32>, n : vec3<f32>) -> vec3<f32> {
  if (obj.layerReflParams.x < 0.0005) { return vec3<f32>(0.0); }
  let clip = obj.layerReflMatrix * vec4<f32>(world, 1.0);
  if (clip.w <= 1e-6) { return vec3<f32>(0.0); }
  var uv = (clip.xy / clip.w) * 0.5 + vec2<f32>(0.5);
  if (obj.layerReflParams.z > 0.5) { uv.y = 1.0 - uv.y; }
  let b = obj.layerReflParams.y;
  var acc = vec4<f32>(0.0);
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let q = clamp(uv + vec2<f32>(f32(x), f32(y)) * b, vec2<f32>(0.0005), vec2<f32>(0.9995));
      acc = acc + textureSampleLevel(layerReflTex, envSmp, q, 0.0);
    }
  }
  let v = normalize(obj.eyeLit.xyz - world);
  let ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
  let f0 = obj.reflParams.w;
  let fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
  // Premultiplied: where nothing is reflected the sum adds nothing.
  return (acc.rgb / 9.0) * obj.layerReflParams.x * mix(1.0, fres, obj.layerReflParams.w);
}

/*
  Screen-space ambient occlusion — the run's own depth prepass, resolved.

  aoParams: x = STRENGTH, how much of the ambient term full occlusion removes.
  Zero for every comp that has not turned SSAO on, which is the whole gate: the
  block below returns exactly 1.0 there and the ambient accumulation multiplies
  by it, and x * 1.0 is x in IEEE — so those frames render the arithmetic they
  rendered before AO existed, to the byte. y = 1 when the lookup must flip v
  (WebGL2, which writes render targets bottom-up), the OPPOSITE convention to
  targetSampleUv and for the same reason shadowParams.w is: the coordinate
  comes from the camera's own NDC, where +1 is the top of the viewport on both
  backends.

  Outside the buffer the answer is UNOCCLUDED. Guessing "occluded" off-screen
  would darken the border of every comp, which is worse than no AO at all.
*/
fn aoFactor(world : vec3<f32>) -> f32 {
  if (obj.aoParams.x < 0.0005) { return 1.0; }
  let clip = obj.aoMatrix * vec4<f32>(world, 1.0);
  if (clip.w <= 1e-6) { return 1.0; }
  var uv = (clip.xy / clip.w) * 0.5 + vec2<f32>(0.5);
  if (obj.aoParams.y > 0.5) { uv.y = 1.0 - uv.y; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  // Explicit LOD, like envFetch and the shadow tap: the buffer has no mip
  // chain, and an implicit derivative inside this gate is illegal in WGSL.
  let occ = textureSampleLevel(ssaoMap, ssaoMapSmp, uv, 0.0).r;
  return clamp(1.0 - (1.0 - occ) * obj.aoParams.x, 0.0, 1.0);
}

/*
  Advanced-3D Transparency: the view-dependent alpha multiplier every lit-3d
  entry point folds into its output alpha (before premultiplying).

  alphaParams: x = Transparency 0..1 — zero for every scene that has not
  touched the control, which is the whole gate: the early return is a literal
  1.0, each entry point multiplies its alpha by it, and a * 1.0 is a in IEEE,
  so those frames render byte-identically. y = Transparency Rolloff 0..1 —
  Fresnel-weights the transmission (Schlick against reflParams.w, the
  IOR-derived F0 shared with Reflection Rolloff): facing the camera transmits
  most, grazing angles stay opaque, which is how glass reads. Two-sided |N·V|
  on purpose — a layer has no inside. CPU twin: transparencyAlpha in
  core/scene/lightShading.ts; the two must stay identical term for term.
  (No backticks in here: this shader source is itself a JS template literal.)

  The normal is the quad plane's (+Z column of the model matrix), spelled with
  its own variable name so the withVertexNormal substitution leaves it alone —
  only quad materials receive a transparency today, and a quad's plane normal
  IS its per-fragment normal.
*/
fn shadeAlpha3d(world : vec3<f32>) -> f32 {
  let t = obj.alphaParams.x;
  if (t <= 0.0) { return 1.0; }
  let pn = normalize(obj.model[2].xyz);
  let vw = normalize(obj.eyeLit.xyz - world);
  let ndv = clamp(abs(dot(pn, vw)), 0.0, 1.0);
  let f0 = obj.reflParams.w;
  let fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
  return 1.0 - t * mix(1.0, 1.0 - fres, obj.alphaParams.y);
}

// AE parity 4.3: Accepts Shadows does not need Accepts Lights. An unlit
// surface still darkens under every mapped shadow, each sampled facing its
// light (no surface normal to slope the bias by). Unused slots answer 1.
fn unlitShadow(world : vec3<f32>) -> f32 {
  return shadowFactor(world, -obj.shadowAxis.xyz) * shadowFactor2(world, -obj.shadow2Axis.xyz) *
         shadowFactor3(world, -obj.shadow3Axis.xyz) * shadowFactor4(world, -obj.shadow4Axis.xyz);
}
fn shade3dN(world : vec3<f32>, nrmIn : vec3<f32>, baseRgb : vec3<f32>) -> vec3<f32> {
  if (obj.eyeLit.w < 0.5) { return applyFog(world, baseRgb * unlitShadow(world)); }
  /*
    Two-sided or one-sided, from the lit flag.

    eyeLit.w: 0 = unlit, 1 = lit TWO-SIDED, 2 = lit ONE-SIDED. Encoded in the
    existing flag rather than a new uniform slot, so the shade tail's std140
    layout is untouched.

    Two-sided (abs) is right for the app's primitive — a 2D layer in space has
    no inside, and a layer seen from behind should still light. It is wrong for
    a face that BOUNDS A VOLUME: with abs(), a box lit hard from one side comes
    out lit identically on both, which is what "it doesn't read as a solid"
    actually was. Only an extrusion's walls and back cap set 2.
  */
  // 3 and 4 are the TOON twins of 1 and 2 — same lighting math, quantized
  // into hard cel bands at the tail (see packShade3D).
  let toonFlag = obj.eyeLit.w > 2.5;
  let oneS = (obj.eyeLit.w > 1.5 && obj.eyeLit.w < 2.5) || obj.eyeLit.w > 3.5;
  let twoSided = select(1.0, 0.0, oneS);
  let N = normalize(nrmIn);
  let count = i32(obj.shadeParams.x + 0.5);
  let specI = obj.shadeParams.y;
  let metal = obj.shadeParams.w;
  // shadeParams.z is Blinn-Phong shininess when positive, and −roughness when
  // the PBR model is selected (see packShade3D). Same slot, same layout.
  let pbr = obj.shadeParams.z < 0.0;
  let rough = clamp(-obj.shadeParams.z, 0.02, 1.0);
  let alpha2 = rough * rough * rough * rough; // GGX α = roughness², squared again in D
  // F0: a dielectric reflects ~4 % at normal incidence at the default
  // Specular Intensity (0.5), scaled by that intensity so the slider keeps its
  // AE meaning — 0 is no highlight, 1 is a lacquer. A metal reflects its own
  // colour; the metal slider blends between the two.
  let F0 = mix(vec3<f32>(0.08 * obj.shadeParams.y), baseRgb, metal);
  // Toon: shadeParams.z carries the band count, not a shininess — shade with
  // a fixed tight exponent so the stepped highlight stays a crisp blob.
  let shin = select(max(obj.shadeParams.z, 1.0), 32.0, toonFlag);
  // Sampled ONCE, before the loop: the shadow term is a fact about this
  // fragment and this map, not about which light is being accumulated, and
  // nine texture taps per light for one answer would be eight wasted.
  // shadowOrigin.w names WHICH light the map was rendered from — resolved by
  // packShade3D against the same filtered array the loop walks.
  let shTerm = shadowFactor(world, N);
  let shadowIdx = i32(obj.shadowOrigin.w + 0.5);
  let shadowOn = obj.shadowParams.x > 0.0005;
  // The second mapped light's term (plan B2), against its own map and index.
  let shTerm2 = shadowFactor2(world, N);
  let shadow2Idx = i32(obj.shadow2Origin.w + 0.5);
  let shadow2On = obj.shadow2Params.x > 0.0005;
  // The third and fourth mapped lights (AE parity 4.3).
  let shTerm3 = shadowFactor3(world, N);
  let shadow3Idx = i32(floor(obj.shadow3Origin.w + 0.5));
  let shadow3On = obj.shadow3Params.x > 0.0005;
  let shTerm4 = shadowFactor4(world, N);
  let shadow4Idx = i32(floor(obj.shadow4Origin.w + 0.5));
  let shadow4On = obj.shadow4Params.x > 0.0005;
  // Sampled once, beside the shadow term and for the same reasons: it is a fact
  // about this fragment, and a tap per light would be seven wasted.
  let aoTerm = aoFactor(world);
  var diff = vec3<f32>(0.0);
  var spec = vec3<f32>(0.0);
  for (var i = 0; i < 8; i = i + 1) {
    if (i >= count) { break; }
    let posType = obj.lights[i * 4];
    let colGain = obj.lights[i * 4 + 1];
    let misc = obj.lights[i * 4 + 2];
    let misc2 = obj.lights[i * 4 + 3];
    let lType = i32(posType.w + 0.5);
    let gain = colGain.w;
    // AMBIENT — and the one place the AO term is applied. Multiplied AT the
    // accumulation rather than over the sum afterwards, so with AO off (aoTerm
    // exactly 1.0) the additions happen in the same order and the same values
    // as they always did: x * 1.0 == x, and a reordered float sum is not.
    if (lType == 0) { diff = diff + colGain.rgb * gain * aoTerm; continue; }
    var toLight = vec3<f32>(0.0, 0.0, -1.0);
    var atten = 1.0;
    var lambert = 1.0;
    var skip = false;
    // The aim arrives RESOLVED (Point of Interest, or this type's legacy
    // 2D-angle fallback) and unit-length, so there is no per-type fallback to
    // keep in step with the CPU here — see toShaderLights.
    let aim = vec3<f32>(misc.z, misc.w, misc2.x);
    if (lType == 3) {
      lambert = mix(max(dot(N, aim), 0.0), abs(dot(N, aim)), twoSided);
      toLight = -aim;
    } else {
      let Lvec = posType.xyz - world;
      let d = length(Lvec);
      let radius = misc.x;
      let fMode = i32(misc2.z + 0.5);
      if (fMode == 0) {
        // Falloff None: constant intensity at any distance (AE). Mirrors
        // lightFalloffAt — the radius is not a reach until a curve is chosen.
        atten = 1.0;
      } else if (fMode == 3) {
        // Legacy: hard cutoff at the radius, linear ramp inside it — what
        // None meant before 1.8.0, kept for the documents lit under it.
        if (radius > 0.0 && d >= radius) { skip = true; }
        if (!skip) { atten = select(1.0, 1.0 - d / radius, radius > 0.0); }
      } else {
        // AE falloff curves reach PAST the radius, so the cutoff moves out with
        // them — mirrors lightFalloffAt exactly, including its max(1, radius).
        let r = max(1.0, radius);
        var curve = 1.0;
        if (d > r) {
          if (fMode == 1) { curve = max(0.0, 1.0 - (d - r) / max(1.0, misc2.w)); }
          else { curve = (r * r) / (d * d); }
        }
        if (curve <= 0.001) { skip = true; }
        if (!skip) { atten = curve; }
      }
      if (!skip && d > 1e-6) {
        toLight = Lvec / d;
        lambert = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
        if (lType == 2) {
          // Full 3D cone test: with a POI the aim has a z, which the old
          // 2D-only dot product could not express.
          let cosA = dot(aim, -Lvec / d);
          let halfCone = max(misc.y, 1e-3);
          let ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang > halfCone) { skip = true; }
          let feather = misc2.y;
          // Smoothstep across the feather band — see shadeLayer and
          // spotConeFactor; all three must apply the same curve. (No backticks
          // in here: this shader source is itself a JS template literal.)
          if (!skip && feather > 1e-6 && ang > halfCone - feather) { let u = (halfCone - ang) / feather; atten = atten * u * u * (3.0 - 2.0 * u); }
        }
      }
    }
    if (skip) { continue; }
    // The shadow multiplies ATTENUATION — the one factor both branches below
    // carry into diffuse AND specular — so a shadowed fragment loses both from
    // this light and keeps every other light, and keeps ambient (which took
    // the early continue above and never reaches here). That is what shadow
    // means: this lamp cannot see you.
    if (shadowOn && shadowIdx == i) { atten = atten * shTerm; }
    if (shadow2On && shadow2Idx == i) { atten = atten * shTerm2; }
    if (shadow3On && shadow3Idx == i) { atten = atten * shTerm3; }
    if (shadow4On && shadow4Idx == i) { atten = atten * shTerm4; }
    let k = gain * lambert * atten;
    if (pbr) {
      // Cook-Torrance: D (GGX) · G (Smith-Schlick) · F (Schlick) / (4 N·L N·V),
      // times the light's radiance N·L; diffuse is what Fresnel leaves and
      // metals have none. Two-sided surfaces use |N·x| like the Phong path.
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      let NdotL = mix(max(dot(N, toLight), 0.0), abs(dot(N, toLight)), twoSided);
      let NdotV = max(mix(max(dot(N, V), 0.0), abs(dot(N, V)), twoSided), 1e-4);
      let NdotH = mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided);
      let VdotH = max(dot(V, H), 0.0);
      let dd = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      let D = alpha2 / (3.14159265 * dd * dd);
      let kG = (rough + 1.0) * (rough + 1.0) / 8.0;
      let G = (NdotL / (NdotL * (1.0 - kG) + kG)) * (NdotV / (NdotV * (1.0 - kG) + kG));
      let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      let specular = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);
      let kd = (vec3<f32>(1.0) - F) * (1.0 - metal);
      diff = diff + colGain.rgb * gain * atten * NdotL * kd;
      spec = spec + colGain.rgb * gain * atten * NdotL * specular;
      continue;
    }
    diff = diff + colGain.rgb * k;
    if (specI > 0.0) {
      let V = normalize(obj.eyeLit.xyz - world);
      let H = normalize(toLight + V);
      spec = spec + colGain.rgb * (gain * atten * pow(mix(max(dot(N, H), 0.0), abs(dot(N, H)), twoSided), shin));
    }
  }
  // Image-based diffuse (AE parity 4.4), under AO and the environment's own
  // key shadow; a metal has no diffuse to light.
  if (obj.envShParams.x > 0.5) {
    let Vd = normalize(obj.eyeLit.xyz - world);
    let Nd = select(N, -N, twoSided > 0.5 && dot(N, Vd) < 0.0);
    var envShadow = 1.0;
    if (obj.envShParams.y > -0.5) {
      let es = i32(obj.envShParams.y + 0.5);
      var t = shTerm;
      if (es == 1) { t = shTerm2; } else if (es == 2) { t = shTerm3; } else if (es == 3) { t = shTerm4; }
      envShadow = mix(1.0, t, obj.envShParams.z);
    }
    diff = diff + envIrradiance(Nd) * aoTerm * envShadow * select(1.0, 1.0 - metal, pbr);
  }
  diff = clamp(diff, vec3<f32>(0.0), vec3<f32>(4.0));
  if (toonFlag) {
    // Cel quantization: round both responses into hard bands. Rounding (not
    // flooring) keeps full black and full white reachable at the extremes.
    let bands = max(2.0, obj.shadeParams.z);
    diff = floor(diff * bands + vec3<f32>(0.5)) / bands;
    spec = floor(spec * bands + vec3<f32>(0.5)) / bands;
  }
  /*
    Image-based reflections. Gated on envParams.x, which is ZERO for every
    scene that has no environment light — so everything above is untouched and
    those frames render bit-for-bit as they did before reflections existed.

    Placed after the toon quantization and excluded from it on purpose: cel
    shading's whole point is a flat, stepped surface, and a mirrored room in
    the highlight would undo it.
  */
  if (obj.envParams.x > 0.5 && !toonFlag) {
    let Ve = normalize(obj.eyeLit.xyz - world);
    // A two-sided surface has no outside; face the normal at the viewer so the
    // reflection is the one that would actually be seen from here.
    let Ne = select(N, -N, twoSided > 0.5 && dot(N, Ve) < 0.0);
    let R = reflect(-Ve, Ne);
    /*
      The Advanced-3D reflection axes (reflParams), every default an exact
      IEEE identity so pre-axis scenes keep their bytes:
        x  Reflection Intensity 0..1 — scales the term; default 1, and y*1.0
           is y.
        y  Reflection Sharpness 0..1 — the atlas is sampled at
           roughness*(1.0 - y); default 0, and rough*1.0 re-clamps to rough.
        z  Reflection Rolloff 0..1 — mix(1, Schlick F(N·V), z) concentrates
           the term at grazing angles; default 0, and mix(1.0, f, 0.0) is 1.0.
        w  the IOR-derived Schlick F0 both rolloffs share (packed once in
           packShade3D so the dialects cannot disagree).
    */
    let ndve = max(dot(Ne, Ve), 1e-4);
    let fresR = obj.reflParams.w + (1.0 - obj.reflParams.w) * pow(clamp(1.0 - ndve, 0.0, 1.0), 5.0);
    let envK = obj.envParams.y * obj.reflParams.x * mix(1.0, fresR, obj.reflParams.z);
    if (pbr) {
      // Split sum: prefiltered radiance x the analytic env BRDF. A metal takes
      // the scenery through its own F0 — which IS the base colour, so it
      // reflects tinted; a dielectric keeps a Fresnel-weighted sheen over a
      // diffuse that the light loop already computed.
      let ab = envBRDF(ndve, rough);
      spec = spec + envSpecular(R, clamp(rough * (1.0 - obj.reflParams.y), 0.02, 1.0)) * (F0 * ab.x + vec3<f32>(ab.y)) * envK;
    } else {
      // Phong: a plain reflection, which the tail below scales by Specular
      // Intensity and tints by Metal — so the sliders that already exist mean
      // "how mirrored", and nothing new appears in the UI. Shininess becomes a
      // roughness by the usual Phong-to-GGX identity, so a tight highlight
      // reflects a sharp room and a broad one a soft.
      spec = spec + envSpecular(R, clamp(sqrt(2.0 / (max(obj.shadeParams.z, 1.0) + 2.0)) * (1.0 - obj.reflParams.y), 0.02, 1.0)) * envK;
    }
  }
  if (pbr) {
    // Diffuse is already Fresnel-weighted; the specular lobe is radiance, not
    // an intensity-scaled highlight, so specI does not apply.
    return applyFog(world, baseRgb * diff + clamp(spec, vec3<f32>(0.0), vec3<f32>(8.0)) + layerReflection(world, N));
  }
  // Metal tints the highlight by the SURFACE colour rather than the light's:
  // 0 = plastic (highlight keeps the light's colour), 1 = metal (takes the layer's).
  return applyFog(world, baseRgb * diff + spec * specI * mix(vec3<f32>(1.0), baseRgb, metal) + layerReflection(world, N));
}

fn unpremul(t : vec4<f32>) -> vec4<f32> {
  if (t.a < 0.00392156862745098) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(t.rgb / t.a, t.a);
}


fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}

fn linearSrgbToAcesCg(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(c, vec3<f32>(0.613097396, 0.339523469, 0.047379562)),
    dot(c, vec3<f32>(0.070194066, 0.916353879, 0.013452032)),
    dot(c, vec3<f32>(0.020615588, 0.109569769, 0.869814633)),
  );
}

fn acesOdtSrgb(c : vec3<f32>) -> vec3<f32> {
  var v = max(c, vec3<f32>(0.0));
  let a = v * (v + vec3<f32>(0.0245786)) - vec3<f32>(0.0000905377);
  let b = v * (0.983729 * v + vec3<f32>(0.4329510)) + vec3<f32>(0.238081);
  return clamp(a / b, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hlgOetfChannel(E : f32) -> f32 {
  // ARIB STD-B67 — same curve as hdrTransfer.ts (HDR export). Preview ODT
  // must match delivery or Comp Settings “HLG” and Export ▸ HLG diverge.
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  let e = max(E, 0.0);
  if (e <= 1.0 / 12.0) { return sqrt(3.0 * e); }
  return a * log(12.0 * e - b) + c;
}

fn workingToDisplay(rgb : vec3<f32>, srcSpace : vec4<f32>) -> vec3<f32> {
  // z≈3 → HLG (ARIB STD-B67) preview ODT on SDR canvas.
  if (srcSpace.z > 2.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    return clamp(vec3<f32>(hlgOetfChannel(v.x), hlgOetfChannel(v.y), hlgOetfChannel(v.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // z≈2 → PQ (ST.2084) foothold: map linear scene → PQ then re-expand for
  // SDR canvas preview. Not a real HDR10 encode — just a selectable ODT.
  if (srcSpace.z > 1.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      // ACEScg → approx linear Rec.709 for the PQ curve.
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    let Y = max(v, vec3<f32>(0.0)) / 100.0; // assume ~100 nit scene white
    let Ym = pow(Y, vec3<f32>(m1));
    let pq = pow((c1 + c2 * Ym) / (1.0 + c3 * Ym), vec3<f32>(m2));
    return clamp(pq, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (srcSpace.z > 0.5) {
    var v = rgb;
    if (srcSpace.y < 0.5) { v = linearSrgbToAcesCg(v); }
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}


fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> {
  return select(srgbToLinearRgb(rgb), rgb, srcLinear > 0.5);
}
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return rgb; }

@fragment
fn fs(@location(0) uv : vec2<f32>, @location(1) world : vec3<f32>, @location(2) nrm : vec3<f32>, @location(3) col : vec4<f32>) -> @location(0) vec4<f32> {
  var c = unpremul(textureSample(tex, smp, uv)) * obj.tint;
  // Advanced-3D Transparency folds into the SOURCE alpha, so every later use
  // (premultiply, matte, the -linear rewrites) sees one consistent coverage.
  c.a = c.a * col.a * shadeAlpha3d(world);
  let v = vec4<f32>(c.rgb, 1.0);
  let affine = vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v));
  let lutIn = linearToSrgbRgb(clamp(affine, vec3<f32>(0.0), vec3<f32>(1.0)));
  let lutR = textureSample(lutTex, smp, vec2<f32>(lutIn.r, 0.5)).r;
  let lutG = textureSample(lutTex, smp, vec2<f32>(lutIn.g, 0.5)).g;
  let lutB = textureSample(lutTex, smp, vec2<f32>(lutIn.b, 0.5)).b;
  let graded = srgbToLinearRgb(vec3<f32>(lutR, lutG, lutB)) * col.rgb;
  let lit = shade3dN(world, nrm, graded);
  return vec4<f32>(lit * c.a, c.a);
}
