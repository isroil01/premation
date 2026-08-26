/**
 * Glass composite — one pass that turns a blurred backdrop plus a layer
 * silhouette into convincing glass.
 *
 * WHY THIS IS A SHADER RATHER THAN A STACK OF EFFECTS
 *
 * After Effects has no real glass feature. `CC Glass` is a weak bump-mapped
 * refraction, and what people actually do is hand-stack a dozen effects: Fast
 * Box Blur on an adjustment layer, a Transform scaled up, a Displacement Map
 * pointed at a hand-built displacement source, CC Light Sweep duplicated and
 * rotated for the opposite edge, Bevel Alpha for the rim. That workflow is not
 * a stylistic choice — it is a workaround. An AE layer cannot cheaply sample
 * what is composited beneath it, so refraction has to be faked with a
 * displacement map and the backdrop blur smuggled in via an adjustment layer.
 *
 * We do not have that constraint. The compositor already renders everything
 * below the layer into a target and blurs it (see CompositionPass's backdrop
 * branch). Given that texture and the layer's own alpha, real refraction is a
 * UV offset and chromatic aberration is three samples instead of one. So glass
 * ships as ONE layer style with a proper parameter set, not as a pile the user
 * assembles — this is an area to beat AE rather than chase it.
 *
 * THE TWO DETAILS THAT SEPARATE GLASS FROM A BLURRED RECTANGLE
 *
 *  • Chromatic aberration at the edges. Real glass splits light; a one-or-two
 *    pixel per-channel offset in the refraction band is the whole difference.
 *  • Grain. A blurred gradient bands on any real display. A few percent of
 *    noise removes it and reads as material rather than as a filter.
 *
 * The refraction direction comes from the GRADIENT of the layer's alpha, a
 * cheap stand-in for a signed-distance field's gradient: it points out of the
 * silhouette, peaks at the border, and falls to zero in the interior. That
 * falloff is why the effect concentrates at the rim with no explicit edge mask
 * — the same place it concentrates in real glass.
 */

import type { ShaderSource } from './builtin';

export const GLASS_COMPOSITE: ShaderSource = {
  name: 'glass-composite',
  wgsl: /* wgsl */ `
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  p0 : vec4<f32>,
  p1 : vec4<f32>,
  p2 : vec4<f32>,
  p3 : vec4<f32>,
  p4 : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var backdropTex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var layerTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}

// Per-PIXEL integer hash (the Dissolve construction). The float form —
// fract(q.x·q.y) at ~4e6 magnitude — kept almost no fractional bits and
// amplified varying-interpolation ULPs into a different grain per backend
// (the webgl2-vs-webgpu glass-grain divergence). The input is the BUFFER
// pixel index (field uv ÷ texel size): pixel centres sit half a texel from
// any cell boundary, so interpolation jitter can never flip a cell, and u32
// maths is bit-exact on every driver.
fn hash21(p : vec2<f32>) -> f32 {
  let px = u32(clamp(floor(p.x), 0.0, 16777215.0));
  let py = u32(clamp(floor(p.y), 0.0, 16777215.0));
  var h : u32 = (px + 1u) * 374761393u + (py + 1u) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let texel = obj.p4.zw;
  let alpha = textureSample(layerTex, smp, uv).a;

  // NO early-out on alpha here, deliberately. WGSL requires textureSample to
  // be reached from UNIFORM control flow, and branching on a sampled value
  // makes everything after it non-uniform — the module then fails to compile
  // outright ("'textureSample' must only be called from uniform control flow"),
  // which is a black viewport rather than a slow one. Outside the silhouette
  // alpha is 0 and the final multiply zeroes the result anyway; the saved
  // samples were never worth a shader that does not build.
  let e = vec2<f32>(max(1.0, obj.p0.y)) * texel;
  let gx = textureSample(layerTex, smp, uv + vec2<f32>(e.x, 0.0)).a
         - textureSample(layerTex, smp, uv - vec2<f32>(e.x, 0.0)).a;
  let gy = textureSample(layerTex, smp, uv + vec2<f32>(0.0, e.y)).a
         - textureSample(layerTex, smp, uv - vec2<f32>(0.0, e.y)).a;
  let grad = vec2<f32>(gx, gy);
  let gmag = length(grad);
  var gdir = vec2<f32>(0.0, 0.0);
  if (gmag > 1e-5) { gdir = grad / gmag; }

  let base = -gdir * obj.p0.x * gmag * texel;
  let ab = gdir * obj.p0.z * gmag * texel;
  var col = vec3<f32>(
    textureSample(backdropTex, smp, uv + base + ab).r,
    textureSample(backdropTex, smp, uv + base).g,
    textureSample(backdropTex, smp, uv + base - ab).b,
  );

  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3<f32>(lum, lum, lum), col, obj.p0.w), vec3<f32>(0.0), vec3<f32>(1.0));
  col = mix(col, obj.p1.rgb, obj.p1.w);

  let rimBand = smoothstep(0.0, 1.0, gmag * max(0.01, obj.p3.x));
  // The rim and specular ANGLES are authored top-down (comp space), but gdir
  // was measured in SAMPLE space — whose V flips per backend on FBO
  // round-trips (targetSampleUv). Convert the gradient to field space for the
  // angle comparisons or the highlight sits on the wrong vertical side on
  // WebGL2. The refraction offsets above stay in sample space on purpose:
  // gradient and sampling agree there by construction.
  let gfield = gdir * sign(obj.uvRect.zw);
  let rimDir = vec2<f32>(cos(obj.p3.y), sin(obj.p3.y));
  let rimFace = 0.5 + 0.5 * dot(gfield, rimDir);
  col = col + obj.p2.rgb * (rimBand * rimFace * obj.p2.w);

  let specDir = vec2<f32>(cos(obj.p4.x), sin(obj.p4.x));
  let facing = max(0.0, dot(gfield, specDir));
  let spec = pow(facing, max(0.1, obj.p3.w)) * rimBand * obj.p3.z;
  col = col + vec3<f32>(spec, spec, spec);

  // Field coordinate: uv's V runs opposite per backend on FBO round-trips
  // (targetSampleUv) — normalize by uvRect so the grain field is identical on
  // both engines. See the hash21 note above.
  let gq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let n = hash21(gq / obj.p4.zw) - 0.5;
  col = clamp(col + vec3<f32>(n * obj.p4.y), vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(col * alpha, alpha);
}
`,
  glsl: {
    vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; vec4 p3; vec4 p4; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
    fragment: /* glsl */ `#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 p0; vec4 p1; vec4 p2; vec4 p3; vec4 p4; };
uniform sampler2D uTex;
uniform sampler2D uMaskTex;
in vec2 vUv;
out vec4 frag;

// Per-pixel integer hash — must match the WGSL branch above exactly.
float hash21(vec2 p) {
  uint px = uint(clamp(floor(p.x), 0.0, 16777215.0));
  uint py = uint(clamp(floor(p.y), 0.0, 16777215.0));
  uint h = (px + 1u) * 374761393u + (py + 1u) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}

void main() {
  vec2 texel = p4.zw;
  float alpha = texture(uMaskTex, vUv).a;

  // Kept branchless to match the WGSL exactly — see the note there. Two
  // backends that disagree about when they sample is how a look drifts between
  // WebGPU and WebGL2 without anyone noticing which one is right.
  vec2 e = vec2(max(1.0, p0.y)) * texel;
  float gx = texture(uMaskTex, vUv + vec2(e.x, 0.0)).a - texture(uMaskTex, vUv - vec2(e.x, 0.0)).a;
  float gy = texture(uMaskTex, vUv + vec2(0.0, e.y)).a - texture(uMaskTex, vUv - vec2(0.0, e.y)).a;
  vec2 grad = vec2(gx, gy);
  float gmag = length(grad);
  vec2 gdir = gmag > 1e-5 ? grad / gmag : vec2(0.0);

  vec2 base = -gdir * p0.x * gmag * texel;
  vec2 ab = gdir * p0.z * gmag * texel;
  vec3 col = vec3(
    texture(uTex, vUv + base + ab).r,
    texture(uTex, vUv + base).g,
    texture(uTex, vUv + base - ab).b
  );

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(lum), col, p0.w), 0.0, 1.0);
  col = mix(col, p1.rgb, p1.w);

  float rimBand = smoothstep(0.0, 1.0, gmag * max(0.01, p3.x));
  // Field-space gradient for the angle comparisons - matches the WGSL above.
  vec2 gfield = gdir * sign(uvRect.zw);
  vec2 rimDir = vec2(cos(p3.y), sin(p3.y));
  float rimFace = 0.5 + 0.5 * dot(gfield, rimDir);
  col += p2.rgb * (rimBand * rimFace * p2.w);

  vec2 specDir = vec2(cos(p4.x), sin(p4.x));
  float facing = max(0.0, dot(gfield, specDir));
  float spec = pow(facing, max(0.1, p3.w)) * rimBand * p3.z;
  col += vec3(spec);

  // Field coordinate — must match the WGSL branch above.
  vec2 gq = (vUv - uvRect.xy) / uvRect.zw;
  float n = hash21(gq / p4.zw) - 0.5;
  col = clamp(col + vec3(n * p4.y), 0.0, 1.0);

  frag = vec4(col * alpha, alpha);
}
`,
  },
};
