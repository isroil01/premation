// Texels of the render graph's intermediates ⇄ SDK pixel worlds (G1).
//
// The graph's float targets hold the project's precision (bit_depth.hpp):
// rgba8unorm (8), rgba16float (16), rgba32float (32) — premultiplied, linear
// working space. A plugin gets a world of the depth it can process
// (PluginHost::world_format): 8-bit 0..255, 16-bit 0..65535, 32-bit float
// (over-range kept only there). Rounding is round-half-away for the integer
// depths and IEEE round-to-nearest-even for half floats; every conversion is a
// pure function, so a frame converts identically every time (determinism).
#pragma once

#include <premation_sdk/pr_world.h>

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace premation::plugins {

enum class TexelFormat : std::uint8_t { rgba8, rgba16f, rgba32f };

[[nodiscard]] std::uint32_t texel_bytes(TexelFormat f) noexcept;
[[nodiscard]] float half_to_float(std::uint16_t h) noexcept;
[[nodiscard]] std::uint16_t float_to_half(float f) noexcept;

/// `h` rows of `w` texels, `rowPitch` bytes apart → a tightly packed world of `wf` in `out`.
void texels_to_world(std::span<const std::uint8_t> texels, TexelFormat tf, std::uint32_t w, std::uint32_t h,
                     std::size_t rowPitch, PrPixelFormat wf, std::vector<std::uint8_t>& out);
/// A world → tightly packed texels of `tf` in `out`.
void world_to_texels(const PrWorld& world, TexelFormat tf, std::vector<std::uint8_t>& out);

}  // namespace premation::plugins
