#include "styled_surface.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <vector>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace premation::scene {
namespace {

struct Rgba {
  double r = 0, g = 0, b = 0, a = 255;
};

std::string trim(std::string_view s) {
  const auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  while (!s.empty() && ws(s.front())) s.remove_prefix(1);
  while (!s.empty() && ws(s.back())) s.remove_suffix(1);
  return std::string(s);
}

/// fill.ts `parseHex`: rgb()/rgba(), #rgb / #rrggbb / #rrggbbaa, else opaque black.
Rgba parse_hex(std::string_view in) {
  const std::string raw = trim(in);
  std::string low = raw;
  for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if ((low.starts_with("rgb(") || low.starts_with("rgba(")) && low.size() > 5 && low.back() == ')') {
    const auto open = low.find('(');
    const std::string body = low.substr(open + 1, low.size() - open - 2);
    std::vector<double> parts;
    std::string cur;
    const auto flush = [&] {
      if (!cur.empty()) parts.push_back(motion::js::string_to_number(std::string_view(cur)));
      cur.clear();
    };
    for (const char c : body) {
      if (c == ',' || c == ' ' || c == '/' || c == '\t' || c == '\n' || c == '\r') flush();
      else cur.push_back(c);
    }
    flush();
    const auto clamp255 = [](double n) { return std::max(0.0, std::min(255.0, motion::js::round(n))); };
    if (parts.size() >= 3 && std::isfinite(parts[0]) && std::isfinite(parts[1]) && std::isfinite(parts[2])) {
      const double alpha = parts.size() > 3 && std::isfinite(parts[3]) ? parts[3] : 1.0;
      return {clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), clamp255(std::max(0.0, std::min(1.0, alpha)) * 255)};
    }
    return {};
  }
  std::string h = raw;
  if (!h.empty() && h.front() == '#') h.erase(h.begin());
  if (h.size() == 3) h = std::string{h[0], h[0], h[1], h[1], h[2], h[2]};
  if (h.size() == 6) h += "ff";
  if (h.size() != 8) return {};
  std::array<unsigned, 4> v{};
  for (std::size_t i = 0; i < 8; ++i) {
    const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(h[i])));
    int d = -1;
    if (c >= '0' && c <= '9') d = c - '0';
    else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
    if (d < 0) return {};
    v.at(i / 2) = v.at(i / 2) * 16 + static_cast<unsigned>(d);
  }
  return {static_cast<double>(v[0]), static_cast<double>(v[1]), static_cast<double>(v[2]), static_cast<double>(v[3])};
}

/// layerStyles.ts `mixHex(a, b, t)`.
std::string mix_hex(std::string_view a, std::string_view b, double t) {
  const Rgba ca = parse_hex(a);
  const Rgba cb = parse_hex(b);
  const double k = std::max(0.0, std::min(1.0, t));
  constexpr std::string_view kHex = "0123456789abcdef";
  const auto h = [&](double v) {
    const auto n = static_cast<unsigned>(std::max(0.0, std::min(255.0, motion::js::round(v))));
    return std::string{kHex[(n >> 4U) & 0xFU], kHex[n & 0xFU]};
  };
  return "#" + h(ca.r + (cb.r - ca.r) * k) + h(ca.g + (cb.g - ca.g) * k) + h(ca.b + (cb.b - ca.b) * k);
}

/// `x?.enabled && x.opacity > 0`.
bool on(const js::Json& s) {
  if (!s.is_object()) return false;
  const js::Json& e = s.at("enabled");
  const bool enabled = e.is_bool() ? e.b() : (e.is_number() ? e.num() != 0 && !std::isnan(e.num()) : e.is_string() && !e.str().empty());
  return enabled && s.at("opacity").is_number() && s.at("opacity").num() > 0;
}

std::string str_of(const js::Json& v) { return v.is_string() ? v.str() : std::string(); }

}  // namespace

std::string styled_surface_fill(const js::Json& styles, std::string_view baseFill) {
  std::string out(baseFill);
  if (!styles.is_object()) return out;
  const js::Json& co = styles.at("colorOverlay");
  if (on(co)) out = mix_hex(out, str_of(co.at("color")), co.at("opacity").num());
  const js::Json& go = styles.at("gradientOverlay");
  if (on(go)) out = mix_hex(out, mix_hex(str_of(go.at("from")), str_of(go.at("to")), 0.5), go.at("opacity").num());
  return out;
}

}  // namespace premation::scene
