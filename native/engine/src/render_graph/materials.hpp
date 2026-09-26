// Materials — packages/renderer/src/shaders/Material.ts as data.
//
// A material is a shader + fixed pipeline state (bind-group layout, vertex
// buffers, depth). The table below is shaders/materials.json and the WGSL is
// shaders/wgsl/*.wgsl, both embedded by shaders/embed_wgsl.cmake at configure
// time (→ materials.inc, builtin_shaders.inc). They were frozen from
// packages/renderer's Material.ts / BUILTIN_SHADERS, verbatim.
#pragma once

#include <cstdint>
#include <iterator>
#include <span>
#include <string>
#include <string_view>

namespace premation::rg {

/// `unfilterable`: a float texture read with textureLoad only (engine-owned
/// shaders: rgba32float LUT lattices, exact mip taps) — needs no float32-filterable.
enum class BindingType : std::uint8_t { uniform, storage, texture, sampler, depth, unfilterable };
inline constexpr std::uint8_t kStageVertex = 1;
inline constexpr std::uint8_t kStageFragment = 2;
inline constexpr std::uint8_t kStageCompute = 4;

struct LayoutEntry {
  std::uint32_t binding;
  BindingType type;
  std::uint8_t stages;
};

enum class VertexFormat : std::uint8_t { Float32, Float32x2, Float32x3, Float32x4 };

struct VertexAttr {
  std::uint32_t location;
  std::uint32_t offset;
  VertexFormat format;
};

struct VertexLayout {
  std::uint32_t stride = 0;
  bool instance = false;
  std::span<const VertexAttr> attributes;
};

struct MaterialDesc {
  std::string_view name;
  std::string_view shader;
  std::span<const LayoutEntry> layout;
  /// Empty = the shared unit quad (QUAD_LAYOUT).
  std::span<const VertexLayout> buffers;
  bool hasDepth = false;
  bool depthTest = false;
  bool depthWrite = false;
};

#include "materials.inc"  // NOLINT(bugprone-suspicious-include) — generated data table

/// The builtin material m (m < Mat::Count_; dynamic materials resolve through Device::material_of).
[[nodiscard]] inline const MaterialDesc& material(Mat m) noexcept { return std::span(kMaterials)[static_cast<std::size_t>(m)]; }

/// One BUILTIN_SHADERS entry: WGSL split into raw-string pieces (see shaders/embed_wgsl.cmake).
struct BuiltinShader {
  std::string_view name;
  const char* const* pieces;
  std::size_t count;
};

/// The WGSL of a builtin shader, joined; empty when no such name.
[[nodiscard]] std::string builtin_wgsl(std::string_view name);
[[nodiscard]] std::size_t builtin_shader_count() noexcept;

}  // namespace premation::rg
