
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
