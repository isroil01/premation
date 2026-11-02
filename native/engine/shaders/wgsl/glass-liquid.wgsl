// Liquid glass (stream D L4, 2026-11-02): glass-composite.wgsl with a SURFACE.
// The original glass refracts the backdrop along the alpha-edge gradient only;
// this one also carries a normal from a bump source (binding 4):
//   1 dome   the alpha's distance field (fx_distance.hpp: r = signed distance
//            in texels, + outside) — a dome `thickness` texels wide, sideways
//            at the contour and flat inside, the way a drop of liquid sits;
//   2 luma   the layer's own luminance as height, `thickness` tall;
//   3 layer  another layer's luminance as height (drawn where it sits).
// The view ray is refracted through that normal at `ior` (per channel ±
// dispersion), an inner caustic highlight where the surface faces the light,
// and a Fresnel rim where it faces away from the viewer. Every term of the
// original (tint, saturation, edge refraction, aberration, rim, specular,
// grain) is kept verbatim; bump source 0 never reaches this shader.
// p0..p4 as glass-composite.wgsl; p5 = (bump source, thickness texels, ior,
// dispersion); p6 = (caustic, fresnel, bump texel w, bump texel h).
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  p0 : vec4<f32>,
  p1 : vec4<f32>,
  p2 : vec4<f32>,
  p3 : vec4<f32>,
  p4 : vec4<f32>,
  p5 : vec4<f32>,
  p6 : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var backdropTex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var layerTex : texture_2d<f32>;
@group(0) @binding(4) var bumpTex : texture_2d<f32>;

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

fn hash21(p : vec2<f32>) -> f32 {
  let px = u32(clamp(floor(p.x), 0.0, 16777215.0));
  let py = u32(clamp(floor(p.y), 0.0, 16777215.0));
  var h : u32 = (px + 1u) * 374761393u + (py + 1u) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
fn l2s(c : f32) -> f32 { if (c <= 0.0031308) { return c * 12.92; } return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
// A bump texel's height 0..1: the luminance of its straight display colour, weighted by coverage.
fn heightAt(uv : vec2<f32>) -> f32 {
  let s = textureSampleLevel(bumpTex, smp, uv, 0.0);
  let c = select(vec3<f32>(0.0), s.rgb / s.a, s.a > 0.00001);
  return dot(vec3<f32>(l2s(c.r), l2s(c.g), l2s(c.b)), vec3<f32>(0.2126, 0.7152, 0.0722)) * s.a;
}

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let texel = obj.p4.zw;
  let alpha = textureSample(layerTex, smp, uv).a;
  // Every sample in uniform control flow (glass-composite.wgsl has the story).
  let e = vec2<f32>(max(1.0, obj.p0.y)) * texel;
  let gx = textureSample(layerTex, smp, uv + vec2<f32>(e.x, 0.0)).a
         - textureSample(layerTex, smp, uv - vec2<f32>(e.x, 0.0)).a;
  let gy = textureSample(layerTex, smp, uv + vec2<f32>(0.0, e.y)).a
         - textureSample(layerTex, smp, uv - vec2<f32>(0.0, e.y)).a;
  let grad = vec2<f32>(gx, gy);
  let gmag = length(grad);
  var gdir = vec2<f32>(0.0, 0.0);
  if (gmag > 1e-5) { gdir = grad / gmag; }

  // ── The surface normal (sample space; its field-space twin for the lights) ──
  let bumpSource = i32(obj.p5.x);
  let thick = max(obj.p5.y, 0.5);
  let bt = obj.p6.zw;
  let f0 = textureSampleLevel(bumpTex, smp, uv, 0.0);
  let fxp = textureSampleLevel(bumpTex, smp, uv + vec2<f32>(bt.x, 0.0), 0.0).r;
  let fxm = textureSampleLevel(bumpTex, smp, uv - vec2<f32>(bt.x, 0.0), 0.0).r;
  let fyp = textureSampleLevel(bumpTex, smp, uv + vec2<f32>(0.0, bt.y), 0.0).r;
  let fym = textureSampleLevel(bumpTex, smp, uv - vec2<f32>(0.0, bt.y), 0.0).r;
  let hxp = heightAt(uv + vec2<f32>(bt.x, 0.0));
  let hxm = heightAt(uv - vec2<f32>(bt.x, 0.0));
  let hyp = heightAt(uv + vec2<f32>(0.0, bt.y));
  let hym = heightAt(uv - vec2<f32>(0.0, bt.y));
  var n = vec3<f32>(0.0, 0.0, 1.0);
  if (bumpSource == 1) {
    // The dome: the distance inside the contour over the thickness.
    let inside = clamp(-f0.r / thick, 0.0, 1.0);
    let tilt = 1.0 - inside;
    let dg = vec2<f32>(fxp - fxm, fyp - fym);
    let dmag = length(dg);
    var ddir = vec2<f32>(0.0);
    if (dmag > 1e-5) { ddir = dg / dmag; }
    n = normalize(vec3<f32>(ddir * tilt, sqrt(max(1.0 - tilt * tilt, 0.0)) + 0.001));
  } else {
    // A height field: the luminance, `thickness` texels tall.
    let dh = vec2<f32>(hxp - hxm, hyp - hym) * 0.5 * thick;
    n = normalize(vec3<f32>(-dh, 1.0));
  }
  let nfield = vec3<f32>(n.xy * sign(obj.uvRect.zw), n.z);

  // ── Refraction through the surface, per channel (dispersion) ──
  let iv = vec3<f32>(0.0, 0.0, -1.0);
  let ior = max(obj.p5.z, 1.0);
  let spread = obj.p5.w * 0.1;
  let base = -gdir * obj.p0.x * gmag * texel;
  let ab = gdir * obj.p0.z * gmag * texel;
  var offs = array<vec2<f32>, 3>(vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0));
  for (var k = 0; k < 3; k++) {
    let eta = 1.0 / max(ior + spread * (f32(k) - 1.0), 1.0);
    let tr = refract(iv, n, eta);
    offs[k] = tr.xy / max(-tr.z, 0.2) * thick * texel;
  }
  var col = vec3<f32>(
    textureSample(backdropTex, smp, uv + base + ab + offs[0]).r,
    textureSample(backdropTex, smp, uv + base + offs[1]).g,
    textureSample(backdropTex, smp, uv + base - ab + offs[2]).b,
  );

  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3<f32>(lum, lum, lum), col, obj.p0.w), vec3<f32>(0.0), vec3<f32>(1.0));
  col = mix(col, obj.p1.rgb, obj.p1.w);

  let rimBand = smoothstep(0.0, 1.0, gmag * max(0.01, obj.p3.x));
  let gfield = gdir * sign(obj.uvRect.zw);
  let rimDir = vec2<f32>(cos(obj.p3.y), sin(obj.p3.y));
  let rimFace = 0.5 + 0.5 * dot(gfield, rimDir);
  col = col + obj.p2.rgb * (rimBand * rimFace * obj.p2.w);

  let specDir = vec2<f32>(cos(obj.p4.x), sin(obj.p4.x));
  let facing = max(0.0, dot(gfield, specDir));
  let spec = pow(facing, max(0.1, obj.p3.w)) * rimBand * obj.p3.z;
  col = col + vec3<f32>(spec, spec, spec);

  // ── The surface's own light: an inner caustic where it faces the light, a Fresnel rim ──
  let l = normalize(vec3<f32>(specDir * 0.7, 0.72));
  let hv = normalize(l + vec3<f32>(0.0, 0.0, 1.0));
  let tilt2 = 1.0 - clamp(nfield.z, 0.0, 1.0);
  let caustic = obj.p6.x * (pow(max(dot(nfield, hv), 0.0), 24.0) + 0.35 * max(dot(-nfield.xy, specDir), 0.0) * tilt2);
  col = col + vec3<f32>(caustic);
  let fres = obj.p6.y * pow(tilt2, 4.0);
  col = col + obj.p2.rgb * fres;

  let gq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let nz = hash21(gq / obj.p4.zw) - 0.5;
  col = clamp(col + vec3<f32>(nz * obj.p4.y), vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(col * alpha, alpha);
}
