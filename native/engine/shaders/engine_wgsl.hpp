// Engine-owned WGSL for the C1 prototype: the display pass (scene-linear
// premultiplied RT → 8-bit sRGB target, letterboxed, opaque over black) and
// the frame-counter strip. Everything that makes the picture itself is
// renderer_wgsl.hpp — the shaders the TypeScript engine runs, verbatim.
#pragma once

namespace premation::shaders {

inline constexpr const char* kPresentWgsl = R"WGSL(
struct Present {
  dst : vec4<f32>,    // clip-space rect: x0, y0 (top-left), x1, y1 (bottom-right)
  color : vec4<f32>,  // lit counter cell colour
  info : vec4<u32>,   // x = frame index, y = counter bit count
};
@group(0) @binding(0) var<uniform> p : Present;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) lit : f32,
};

fn corner(i : u32) -> vec2<f32> {
  var c = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                              vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  return c[i];
}

@vertex fn vs_blit(@builtin(vertex_index) vi : u32) -> VOut {
  let c = corner(vi);
  var o : VOut;
  o.pos = vec4<f32>(mix(p.dst.xy, p.dst.zw, c), 0.0, 1.0);
  o.uv = c;
  o.lit = 1.0;
  return o;
}

@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

fn encode(c : f32) -> f32 {
  let x = clamp(c, 0.0, 1.0);
  if (x <= 0.0031308) { return x * 12.92; }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

@fragment fn fs_blit(i : VOut) -> @location(0) vec4<f32> {
  let c = textureSample(src, smp, i.uv);
  // Premultiplied over black == the premultiplied colour itself.
  return vec4<f32>(encode(c.r), encode(c.g), encode(c.b), 1.0);
}

@vertex fn vs_bits(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let c = corner(vi);
  let bits = p.info.y;
  let cell = (p.dst.zw - p.dst.xy) / vec2<f32>(f32(bits), 1.0);
  let inset = cell * 0.12;
  let origin = p.dst.xy + vec2<f32>(cell.x * f32(ii), 0.0);
  var o : VOut;
  o.pos = vec4<f32>(origin + inset + c * (cell - 2.0 * inset), 0.0, 1.0);
  o.uv = c;
  o.lit = f32((p.info.x >> (bits - 1u - ii)) & 1u);
  return o;
}

@fragment fn fs_bits(i : VOut) -> @location(0) vec4<f32> {
  return mix(vec4<f32>(0.10, 0.10, 0.10, 1.0), p.color, i.lit);
}
)WGSL";

}  // namespace premation::shaders
