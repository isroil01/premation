// Engine-owned WGSL for D3 (colour management) and D2's texture preparation.
// Not extracted from packages/renderer: the TS renderer has no counterpart
// (it has no OCIO and never fills a mip chain). Everything that must match the
// TS pixels stays in builtin_shaders.inc.
//
//   kColorDisplayWgsl   scene-color (working linear, premultiplied) → display /
//                       output encoding through an OCIO op program, then the
//                       optional viewer LUT (the scene-blit-lut maths, verbatim),
//                       premultiplied out. Replaces scene-blit when a frame is
//                       colour-managed.
//   kColorInputWgsl     one footage texel (textureLoad, no filtering) → working
//                       linear through the footage's input program. Runs once
//                       per (content, interpretation), into a float texture.
//   kMipWgsl            one mip level from the level above: the exact 2×2 box
//                       average of premultiplied texels (textureLoad, edge-clamped).
//
// The op interpreter `applyOps` is the WGSL twin of color_program.cpp
// `evaluate`; the two are compared on every op type by test_render_graph_color.
#pragma once

#include <string>

namespace premation::shaders {

inline constexpr const char* kColorOpsWgsl = R"WGSL(
fn exponentOp(x : f32, g : f32, neg : u32) -> f32 {
  if (neg == 1u) { return sign(x) * pow(abs(x), g); }
  if (neg == 2u) { if (x > 0.0) { return pow(x, g); } return x; }
  return pow(max(x, 0.0), g);
}
fn moncurveFwd(x : f32, scale : f32, offset : f32, g : f32, brk : f32, slope : f32, neg : u32) -> f32 {
  var a = x;
  if (neg == 1u) { a = abs(x); }
  var v : f32;
  if (a <= brk) { v = a * slope; } else { v = pow(a * scale + offset, g); }
  if (neg == 1u) { return sign(x) * v; }
  return v;
}
fn moncurveRev(x : f32, g : f32, scale : f32, offset : f32, brk : f32, slope : f32, neg : u32) -> f32 {
  var a = x;
  if (neg == 1u) { a = abs(x); }
  var v : f32;
  if (a > brk) { v = pow(a, g) * scale - offset; } else { v = a * slope; }
  if (neg == 1u) { return sign(x) * v; }
  return v;
}
fn shapeOp(x : f32, kind : f32, lo : f32, hi : f32) -> f32 {
  if (kind > 0.5) { return (log2(max(x, exp2(lo))) - lo) / (hi - lo); }
  return (x - lo) / (hi - lo);
}
fn lutTap(r : i32, g : i32, b : i32, n : i32) -> vec3<f32> {
  return textureLoad(lutTex, vec2<i32>(r + b * n, g), 0).rgb;
}
fn lutOp(c : vec3<f32>, s : vec4<f32>, n : i32) -> vec3<f32> {
  let nm1 = f32(n - 1);
  let t = clamp(vec3<f32>(shapeOp(c.r, s.x, s.y, s.z), shapeOp(c.g, s.x, s.y, s.z), shapeOp(c.b, s.x, s.y, s.z)),
                vec3<f32>(0.0), vec3<f32>(1.0)) * nm1;
  let fl = floor(t);
  let fr = t - fl;
  let i0 = vec3<i32>(fl);
  let i1 = min(i0 + vec3<i32>(1), vec3<i32>(n - 1));
  let c00 = mix(lutTap(i0.x, i0.y, i0.z, n), lutTap(i1.x, i0.y, i0.z, n), fr.x);
  let c10 = mix(lutTap(i0.x, i1.y, i0.z, n), lutTap(i1.x, i1.y, i0.z, n), fr.x);
  let c01 = mix(lutTap(i0.x, i0.y, i1.z, n), lutTap(i1.x, i0.y, i1.z, n), fr.x);
  let c11 = mix(lutTap(i0.x, i1.y, i1.z, n), lutTap(i1.x, i1.y, i1.z, n), fr.x);
  return mix(mix(c00, c10, fr.y), mix(c01, c11, fr.y), fr.z);
}
// ── D3: OCIO's ACES kernels (render_graph/color/aces_ops.cpp, op for op) ─────
fn satWeight(c : vec3<f32>) -> f32 {
  let mn = min(c.r, min(c.g, c.b));
  let mx = max(c.r, max(c.g, c.b));
  return (max(1e-10, mx) - max(1e-10, mn)) / max(0.01, mx);
}
fn hueWeight(c : vec3<f32>, invWidth : f32) -> f32 {
  let a = 2.0 * c.r - (c.g + c.b);
  let b = 1.7320508075688772 * (c.g - c.b);
  let knot = atan2(b, a) * invWidth + 2.0;
  let j = i32(knot);  // truncation toward zero, as OCIO's (int) cast
  if (j < 0 || j >= 4) { return 0.0; }
  let t = knot - f32(j);
  var m = vec4<f32>(0.25, 0.0, 0.0, 0.0);
  if (j == 1) { m = vec4<f32>(-0.75, 0.75, 0.75, 0.25); }
  if (j == 2) { m = vec4<f32>(0.75, -1.5, 0.0, 1.0); }
  if (j == 3) { m = vec4<f32>(-0.25, 0.75, -0.75, 0.25); }
  return m.w + t * (m.z + t * (m.y + t * m.x));
}
fn redMod(cIn : vec3<f32>, oneMinusScale : f32, invWidth : f32, restoreHue : bool) -> vec3<f32> {
  var c = cIn;
  let fH = hueWeight(c, invWidth);
  if (fH > 0.0) {
    let fS = satWeight(c);
    let newRed = c.r + fH * fS * (0.03 - c.r) * oneMinusScale;
    if (restoreHue) {
      if (c.g >= c.b) {
        c.g = (c.g - c.b) / max(1e-10, c.r - c.b) * (newRed - c.b) + c.b;
      } else {
        c.b = (c.b - c.g) / max(1e-10, c.r - c.g) * (newRed - c.g) + c.g;
      }
    }
    c.r = newRed;
  }
  return c;
}
fn glowOp(c : vec3<f32>, gain : f32, mid : f32) -> vec3<f32> {
  let chroma = sqrt(c.b * (c.b - c.g) + c.g * (c.g - c.r) + c.r * (c.r - c.b));
  let yc = (c.b + c.g + c.r + 1.75 * chroma) / 3.0;
  let x = (satWeight(c) - 0.4) * 5.0;
  let sg = select(1.0, -1.0, x < 0.0);
  let t = max(0.0, 1.0 - 0.5 * sg * x);
  let s = (1.0 + sg * (1.0 - t * t)) * 0.5;
  let g = gain * s;
  var out = 0.0;
  if (yc >= mid * 2.0) { out = 0.0; } else if (yc <= mid * 2.0 / 3.0) { out = g; } else { out = g * (mid / yc - 0.5); }
  return c * (1.0 + out);
}
fn darkToDim(c : vec3<f32>, gm1 : f32) -> vec3<f32> {
  let y = max(1e-10, 0.27222871678091454 * c.r + 0.67408176581114831 * c.g + 0.053689517407937051 * c.b);
  return c * pow(y, gm1);
}
fn curveF(i : u32) -> f32 {
  let t = textureLoad(lutTex, vec2<i32>(i32(i / 4u), 0), 0);
  let k = i % 4u;
  if (k == 0u) { return t.x; }
  if (k == 1u) { return t.y; }
  if (k == 2u) { return t.z; }
  return t.w;
}
fn evalCurve(offset : f32, x : f32) -> f32 {
  if (offset < 0.0) { return x; }
  let o = u32(offset);
  let knots = u32(curveF(o));
  let sets = u32(curveF(o + 1u));
  if (sets == 0u || knots < 2u) { return x; }
  let kn = o + 2u;
  let ca = kn + knots;
  let cb = ca + sets;
  let cc = cb + sets;
  let knStart = curveF(kn);
  let knEnd = curveF(kn + knots - 1u);
  if (x <= knStart) { return (x - knStart) * curveF(cb) + curveF(cc); }
  if (x >= knEnd) {
    let a = curveF(ca + sets - 1u);
    let b = curveF(cb + sets - 1u);
    let c = curveF(cc + sets - 1u);
    let t = knEnd - curveF(kn + knots - 2u);
    return (x - knEnd) * (2.0 * a * t + b) + ((a * t + b) * t + c);
  }
  var i = 0u;
  loop {
    if (i >= knots - 2u) { break; }
    if (x < curveF(kn + i + 1u)) { break; }
    i = i + 1u;
  }
  let t = x - curveF(kn + i);
  return (curveF(ca + i) * t + curveF(cb + i)) * t + curveF(cc + i);
}
fn applyOps(rgbIn : vec3<f32>) -> vec3<f32> {
  var c = rgbIn;
  let count = u32(obj.info.x);
  for (var i = 0u; i < count; i = i + 1u) {
    let h = obj.ops[i * 6u];
    let p0 = obj.ops[i * 6u + 1u];
    let p1 = obj.ops[i * 6u + 2u];
    let p2 = obj.ops[i * 6u + 3u];
    let p3 = obj.ops[i * 6u + 4u];
    let p4 = obj.ops[i * 6u + 5u];
    let kind = u32(h.x);
    let neg = u32(h.y);
    if (kind == 1u) {
      c = vec3<f32>(p0.x * c.r + p0.y * c.g + p0.z * c.b + p0.w,
                    p1.x * c.r + p1.y * c.g + p1.z * c.b + p1.w,
                    p2.x * c.r + p2.y * c.g + p2.z * c.b + p2.w);
    } else if (kind == 2u) {
      c = vec3<f32>(exponentOp(c.r, p0.x, neg), exponentOp(c.g, p0.y, neg), exponentOp(c.b, p0.z, neg));
    } else if (kind == 3u) {
      c = vec3<f32>(moncurveFwd(c.r, p0.x, p1.x, p2.x, p3.x, p4.x, neg),
                    moncurveFwd(c.g, p0.y, p1.y, p2.y, p3.y, p4.y, neg),
                    moncurveFwd(c.b, p0.z, p1.z, p2.z, p3.z, p4.z, neg));
    } else if (kind == 4u) {
      c = vec3<f32>(moncurveRev(c.r, p0.x, p1.x, p2.x, p3.x, p4.x, neg),
                    moncurveRev(c.g, p0.y, p1.y, p2.y, p3.y, p4.y, neg),
                    moncurveRev(c.b, p0.z, p1.z, p2.z, p3.z, p4.z, neg));
    } else if (kind == 5u) {
      c = clamp(c * p0.xyz + p1.xyz, p2.xyz, p3.xyz);
    } else if (kind == 6u) {
      c = lutOp(c, p0, i32(h.z));
    } else if (kind == 7u) {
      let fn_ = u32(p0.x);
      if (fn_ == 1u) { c = redMod(c, 1.0 - 0.85, 1.9098593171027443, true); }
      else if (fn_ == 2u) { c = redMod(c, 1.0 - 0.82, 1.6976527263135504, false); }
      else if (fn_ == 3u) { c = glowOp(c, p0.y, p0.z); }
      else if (fn_ == 4u) { c = darkToDim(c, p0.y); }
    } else if (kind == 8u) {
      c = log2(max(c, vec3<f32>(1.17549435e-38))) * p0.x;
    } else if (kind == 9u) {
      c = exp2(c * p0.x);
    } else if (kind == 10u) {
      let t = vec3<f32>(evalCurve(p0.x, c.r), evalCurve(p0.y, c.g), evalCurve(p0.z, c.b));
      c = vec3<f32>(evalCurve(p0.w, t.r), evalCurve(p0.w, t.g), evalCurve(p0.w, t.b));
    }
  }
  return c;
}
fn unpremul(t : vec4<f32>) -> vec4<f32> {
  if (t.a < 0.00392156862745098) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(t.rgb / t.a, t.a);
}
)WGSL";

// Object: mvp (mat3, 12 floats) · uvRect · info (x = op count) · viewer
// (scene-blit-lut's cr0: ±size, intensity, domainMin, domainMax; size 0 = off)
// · 16 ops × 6 vec4 (color_program.hpp kMaxOps).
inline constexpr const char* kColorObjectWgsl = R"WGSL(
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  info : vec4<f32>,
  viewer : vec4<f32>,
  ops : array<vec4<f32>, 96>,
};
@group(0) @binding(0) var<uniform> obj : Object;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
)WGSL";

inline constexpr const char* kColorDisplayBindingsWgsl = R"WGSL(
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var lutTex : texture_2d<f32>;
@group(0) @binding(4) var viewerTex : texture_2d<f32>;
)WGSL";

inline constexpr const char* kColorDisplayFragmentWgsl = R"WGSL(
fn viewerSlice(rg : vec2<f32>, slice : f32, n : f32) -> vec3<f32> {
  let xIn = clamp(rg.x * (n - 1.0) + 0.5, 0.5, n - 0.5);
  let u = (slice * n + xIn) / (n * n);
  let v = clamp(rg.y * (n - 1.0) + 0.5, 0.5, n - 0.5) / n;
  return textureSampleLevel(viewerTex, smp, vec2<f32>(u, v), 0.0).rgb;
}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = unpremul(textureSample(tex, smp, uv));
  var rgb = applyOps(c.rgb);
  let signedSize = obj.viewer.x;
  let n = abs(signedSize);
  let intensity = clamp(obj.viewer.y, 0.0, 1.0);
  if (n >= 2.0 && intensity > 0.0001) {
    let lo = obj.viewer.z;
    let hi = obj.viewer.w;
    let span = max(hi - lo, 0.0001);
    let d = clamp((rgb - vec3<f32>(lo)) / span, vec3<f32>(0.0), vec3<f32>(1.0));
    var graded : vec3<f32>;
    if (signedSize < 0.0) {
      let w = n;
      let rr = textureSampleLevel(viewerTex, smp, vec2<f32>((d.r * (w - 1.0) + 0.5) / w, 0.5), 0.0).r;
      let gg = textureSampleLevel(viewerTex, smp, vec2<f32>((d.g * (w - 1.0) + 0.5) / w, 0.5), 0.0).g;
      let bb = textureSampleLevel(viewerTex, smp, vec2<f32>((d.b * (w - 1.0) + 0.5) / w, 0.5), 0.0).b;
      graded = vec3<f32>(rr, gg, bb);
    } else {
      let bz = d.b * (n - 1.0);
      let z0 = floor(bz);
      let z1 = min(z0 + 1.0, n - 1.0);
      let f = bz - z0;
      graded = mix(viewerSlice(d.rg, z0, n), viewerSlice(d.rg, z1, n), f);
    }
    rgb = mix(rgb, graded, intensity);
  }
  return vec4<f32>(rgb * c.a, c.a);
}
)WGSL";

inline constexpr const char* kColorInputBindingsWgsl = R"WGSL(
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(3) var lutTex : texture_2d<f32>;
)WGSL";

inline constexpr const char* kColorInputFragmentWgsl = R"WGSL(
@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let c = unpremul(textureLoad(tex, vec2<i32>(pos.xy), 0));
  let rgb = applyOps(c.rgb);
  return vec4<f32>(rgb * c.a, c.a);
}
)WGSL";

/// The display / input shaders, assembled (object, bindings, ops, fragment).
inline std::string color_display_wgsl() {
  return std::string(kColorObjectWgsl) + kColorDisplayBindingsWgsl + kColorOpsWgsl + kColorDisplayFragmentWgsl;
}
inline std::string color_input_wgsl() {
  return std::string(kColorObjectWgsl) + kColorInputBindingsWgsl + kColorOpsWgsl + kColorInputFragmentWgsl;
}

inline constexpr const char* kMipWgsl = R"WGSL(
struct Object { src : vec4<f32> };  // x, y = the source level's size in texels
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var src : texture_2d<f32>;
@vertex
fn vs(@location(0) pos : vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
  let hi = vec2<i32>(obj.src.xy) - vec2<i32>(1);
  let o = vec2<i32>(p.xy) * 2;
  let a = textureLoad(src, min(o, hi), 0);
  let b = textureLoad(src, min(o + vec2<i32>(1, 0), hi), 0);
  let c = textureLoad(src, min(o + vec2<i32>(0, 1), hi), 0);
  let d = textureLoad(src, min(o + vec2<i32>(1, 1), hi), 0);
  return (a + b + c + d) * 0.25;
}
)WGSL";

}  // namespace premation::shaders
