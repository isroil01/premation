// The builtin WGSL table (shaders/wgsl, embedded by shaders/embed_wgsl.cmake).
#include <algorithm>
#include <cstdint>
#include <iterator>
#include <optional>
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

namespace {

bool ident_char(char c) noexcept {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

std::string_view trim(std::string_view s) noexcept {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\r' || s.front() == '\n')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n')) s.remove_suffix(1);
  return s;
}

/// `s` past its leading attributes (`@location(0)`, `@builtin(position)`, `@interpolate(flat)`).
std::string_view strip_attributes(std::string_view s) noexcept {
  s = trim(s);
  while (!s.empty() && s.front() == '@') {
    std::size_t i = 1;
    while (i < s.size() && ident_char(s[i])) ++i;
    std::size_t j = i;
    while (j < s.size() && (s[j] == ' ' || s[j] == '\t')) ++j;
    if (j < s.size() && s[j] == '(') {
      int depth = 0;
      for (; j < s.size(); ++j) {
        if (s[j] == '(') ++depth;
        if (s[j] == ')' && --depth == 0) break;
      }
      i = j + 1;
    }
    s = trim(s.substr(std::min(i, s.size())));
  }
  return s;
}

}  // namespace

std::optional<std::string> gamma_out_wgsl(std::string_view wgsl) {
  constexpr std::string_view kEntry = "fn fs(";
  std::size_t at = std::string_view::npos;
  for (std::size_t p = wgsl.find(kEntry); p != std::string_view::npos; p = wgsl.find(kEntry, p + 1)) {
    if (p > 0 && ident_char(wgsl[p - 1])) continue;
    if (at != std::string_view::npos) return std::nullopt;  // two candidates: not ours to guess
    at = p;
  }
  if (at == std::string_view::npos) return std::nullopt;
  // The `@fragment` attribute in front of it (same line or the one before).
  std::string_view before = wgsl.substr(0, at);
  while (!before.empty() && (before.back() == ' ' || before.back() == '\t' || before.back() == '\r' || before.back() == '\n')) {
    before.remove_suffix(1);
  }
  constexpr std::string_view kFragment = "@fragment";
  if (!before.ends_with(kFragment)) return std::nullopt;
  const std::size_t fragmentAt = before.size() - kFragment.size();
  // The parameter list, to its matching parenthesis.
  const std::size_t open = at + kEntry.size() - 1;
  std::size_t close = open;
  for (int depth = 0; close < wgsl.size(); ++close) {
    if (wgsl[close] == '(') ++depth;
    if (wgsl[close] == ')' && --depth == 0) break;
  }
  if (close >= wgsl.size()) return std::nullopt;
  const std::string_view params = wgsl.substr(open + 1, close - open - 1);
  const std::size_t body = wgsl.find('{', close);
  if (body == std::string_view::npos) return std::nullopt;
  std::string_view ret = trim(wgsl.substr(close + 1, body - close - 1));
  if (!ret.starts_with("->")) return std::nullopt;
  ret.remove_prefix(2);
  if (strip_attributes(ret) != "vec4<f32>") return std::nullopt;

  // Each parameter once without its attributes (the inner function) and by name (the call).
  std::string inner;
  std::string names;
  int depth = 0;
  std::size_t from = 0;
  for (std::size_t i = 0; i <= params.size(); ++i) {
    const char c = i < params.size() ? params[i] : ',';
    if (c == '(' || c == '<') ++depth;
    if (c == ')' || c == '>') --depth;
    if (c != ',' || depth != 0) continue;
    const std::string_view one = strip_attributes(params.substr(from, i - from));
    from = i + 1;
    if (one.empty()) continue;  // a trailing comma
    const std::size_t colon = one.find(':');
    if (colon == std::string_view::npos) return std::nullopt;
    if (!inner.empty()) {
      inner += ", ";
      names += ", ";
    }
    inner += one;
    names += trim(one.substr(0, colon));
  }

  std::string out;
  out.reserve(wgsl.size() + 900);
  out += wgsl.substr(0, fragmentAt);
  out += "fn pmLinearOut(";
  out += inner;
  out += ") -> vec4<f32> ";
  out += wgsl.substr(body);
  out += R"WGSL(

// ── Gamma blending (shader_library.cpp gamma_out_wgsl) ──
fn pmGammaEnc(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn pmGammaOut(c : vec4<f32>) -> vec4<f32> {
  if (c.a <= 1e-6) { return vec4<f32>(pmGammaEnc(c.r), pmGammaEnc(c.g), pmGammaEnc(c.b), c.a); }
  let s = c.rgb / c.a;
  return vec4<f32>(vec3<f32>(pmGammaEnc(s.r), pmGammaEnc(s.g), pmGammaEnc(s.b)) * c.a, c.a);
}
@fragment
fn fs()WGSL";
  out += params;
  out += ") -> @location(0) vec4<f32> { return pmGammaOut(pmLinearOut(";
  out += names;
  out += ")); }\n";
  return out;
}

}  // namespace premation::rg
