// The render graph's input: a RenderFrameFile (engine-api 96_render.eapi — the
// serialized FrameScene + viewport + texels) and the typed accessors the passes
// read it through.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "engine_api.hpp"
#include "resource_pool.hpp"
#include "rg_math.hpp"

namespace premation::rg {

namespace api = premation::api;

/// Decode a RenderFrameFile. False (with `error`) on a malformed file.
bool decode_frame_file(std::span<const std::uint8_t> bytes, api::RenderFrameFile& out, std::string& error);

inline Mat3 mat3_of(const std::vector<double>& v) noexcept {
  Mat3 m;
  for (std::size_t i = 0; i < 9 && i < v.size(); ++i) m.m[i] = f32(v[i]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index): i < 9
  return m;
}

inline Mat4 mat4_of(const std::vector<double>& v) noexcept {
  Mat4 m;
  for (std::size_t i = 0; i < 16; ++i) m.m[i] = i < v.size() ? f32(v[i]) : 0.0F;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index): i < 16
  return m;
}

inline Rect rect_of(const api::Rect& r) noexcept { return {r.x, r.y, r.width, r.height}; }
inline Color color_of(const api::Color& c) noexcept { return {c.r, c.g, c.b, c.a}; }

/// Read-only view of one effect entry's parameter bag, by field name.
class Fx {
 public:
  explicit Fx(const api::RenderEffect& e) noexcept : e_(&e) {}
  [[nodiscard]] std::string_view type() const noexcept { return e_->type; }
  [[nodiscard]] const api::RenderEffectParam* find(std::string_view name) const noexcept {
    for (const auto& p : e_->params) {
      if (p.name == name) return &p;
    }
    return nullptr;
  }
  [[nodiscard]] bool has(std::string_view name) const noexcept { return find(name) != nullptr; }
  /// A number or flag (true = 1); `def` when absent.
  [[nodiscard]] double num(std::string_view name, double def = 0) const noexcept {
    const auto* p = find(name);
    if (p == nullptr) return def;
    if (p->kind == api::RenderParamKind::number || p->kind == api::RenderParamKind::flag) return p->number;
    return def;
  }
  [[nodiscard]] bool flag(std::string_view name, bool def = false) const noexcept { return num(name, def ? 1 : 0) != 0; }
  [[nodiscard]] std::span<const double> nums(std::string_view name) const noexcept {
    const auto* p = find(name);
    return p == nullptr ? std::span<const double>{} : std::span<const double>(p->numbers);
  }
  [[nodiscard]] double at(std::string_view name, std::size_t i, double def = 0) const noexcept {
    const auto v = nums(name);
    return i < v.size() ? v[i] : def;
  }
  [[nodiscard]] bool color(std::string_view name, Color& out) const noexcept {
    const auto v = nums(name);
    if (v.size() < 4) return false;
    out = {v[0], v[1], v[2], v[3]};
    return true;
  }
  [[nodiscard]] std::string_view text(std::string_view name) const noexcept {
    const auto* p = find(name);
    return p == nullptr ? std::string_view{} : std::string_view(p->text);
  }

 private:
  const api::RenderEffect* e_;
};

/// A resolved texture reference: the blob a key points at, or nothing.
struct ResolvedBlob {
  const api::RenderBlob* blob = nullptr;
  bool sampleLinear = false;
  /// The provider's own "these are the real pixels" (a placeholder is not ready).
  bool ready = false;
  /// D3: a colour texture's interpretation (RenderTextureRef.inputSpace); absent = data.
  std::optional<api::RenderColorSpace> inputSpace;
};

/// Key → blob index for one frame file.
class TextureTable {
 public:
  void build(const api::RenderFrameFile& file);
  [[nodiscard]] ResolvedBlob resolve(std::string_view key) const;

 private:
  std::unordered_map<std::string, ResolvedBlob, KeyHash, std::equal_to<>> byKey_;  // heterogeneous: find(string_view) allocates nothing
};

}  // namespace premation::rg
