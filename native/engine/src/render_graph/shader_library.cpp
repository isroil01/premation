// The builtin WGSL table (extracted verbatim from packages/renderer).
#include <cstdint>
#include <iterator>
#include <span>
#include <string>
#include <string_view>

#include "materials.hpp"

namespace premation::rg {
namespace {
#include "builtin_shaders.inc"  // NOLINT(bugprone-suspicious-include) — generated data table
}  // namespace

std::string builtin_wgsl(std::string_view name) {
  for (const BuiltinShader& s : kBuiltinShaders) {
    if (s.name != name) continue;
    std::string out;
    for (const char* piece : std::span(s.pieces, s.count)) out += piece;
    return out;
  }
  return {};
}

std::size_t builtin_shader_count() noexcept { return std::size(kBuiltinShaders); }

}  // namespace premation::rg
