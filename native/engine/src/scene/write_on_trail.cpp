#include "write_on_trail.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "handlers_items.hpp"
#include "jsmath.hpp"

namespace premation::scene {

namespace {

namespace mjs = motion::js;

double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

int hexv(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/// writeOnBrush.ts hexRgb: /^#?([0-9a-f]{6})/i on the trimmed string, else white.
std::array<double, 3> hex_rgb(const Json& hex) {
  if (!hex.is_string()) return {255, 255, 255};
  const std::string s = doc::js_trim(hex.str());
  const std::size_t o = !s.empty() && s[0] == '#' ? 1 : 0;
  if (s.size() < o + 6) return {255, 255, 255};
  int n = 0;
  for (std::size_t i = o; i < o + 6; ++i) {
    const int d = hexv(s[i]);
    if (d < 0) return {255, 255, 255};
    n = n * 16 + d;
  }
  const auto u = static_cast<unsigned>(n);  // six hex digits: 0 … 0xFFFFFF
  return {static_cast<double>((u >> 16U) & 255U), static_cast<double>((u >> 8U) & 255U), static_cast<double>(u & 255U)};
}

}  // namespace

bool write_on_uses_brush(const Json& params) {
  const Json& m = params.at("writeOnMode");
  return m.is_number() && mjs::round(m.num()) == 0;
}

WriteOnTrail resolve_write_on_trail(const std::string& effectId, const Json& params, double layerTimeSec, const TrailSample& sample,
                                    const TrailIsAnimated& isAnimated, std::optional<double> earliestSec) {
  const auto num = [&params](std::string_view k, double fb) {
    const Json& v = params.at(k);
    return v.is_number() && std::isfinite(v.num()) ? v.num() : fb;
  };
  const std::array<double, 3> staticRgb = hex_rgb(params.at("brushColor"));
  // effectPropPath(effectId, k), kept only when that track is animated.
  const auto track = [&](std::string_view k) -> std::optional<std::string> {
    std::string prop = "effect." + effectId + "." + std::string(k);
    if (isAnimated(prop)) return prop;
    return std::nullopt;
  };
  const std::optional<std::string> px = track("brushPositionX");
  const std::optional<std::string> py = track("brushPositionY");
  const std::optional<std::string> ps = track("brushSize");
  const std::optional<std::string> ph = track("brushHardness");
  const std::optional<std::string> po = track("brushOpacity");
  const std::array<std::optional<std::string>, 3> pc = {track("brushColor_r"), track("brushColor_g"), track("brushColor_b")};

  const double fbX = num("brushPositionX", 0);
  const double fbY = num("brushPositionY", 0);
  const double fbSize = num("brushSize", 8);
  const double fbHard = num("brushHardness", 75);
  const double fbOpacity = num("brushOpacity", 100);

  WriteOnTrail out;
  const auto at = [&](double t) {
    const auto read = [&](const std::optional<std::string>& prop, double fb) {
      if (!prop) return fb;
      return sample(*prop, t).value_or(fb);
    };
    out.xy.push_back(read(px, fbX));
    out.xy.push_back(read(py, fbY));
    out.size.push_back(read(ps, fbSize));
    out.attr.push_back(read(ph, fbHard));
    out.attr.push_back(read(po, fbOpacity));
    for (std::size_t c = 0; c < 3; ++c) {
      out.attr.push_back(pc[c] ? clamp01(sample(*pc[c], t).value_or(staticRgb[c] / 255)) * 255 : staticRgb[c]);
    }
  };

  if (!px && !py) {
    at(layerTimeSec);
    return out;
  }
  const double spacing = std::max(0.001, num("brushSpacing", 0.001));
  const double length = std::max(0.0, num("strokeLength", 0));
  const double tEnd = layerTimeSec;
  double tStart = earliestSec && std::isfinite(*earliestSec) ? *earliestSec : tEnd;
  if (length > 0) tStart = std::max(tStart, tEnd - length);
  tStart = std::min(tStart, tEnd);

  const double k0 = std::ceil(tStart / spacing - 1e-9);
  const double k1 = std::floor(tEnd / spacing + 1e-9);
  const double onGrid = std::max(0.0, k1 - k0 + 1);
  if (onGrid + 1 > kWriteOnMaxTrail) {
    out.filled = true;
    constexpr int n = kWriteOnMaxTrail;
    for (int i = 0; i < n; ++i) at(tStart + ((tEnd - tStart) * i) / (n - 1));
    return out;
  }
  for (double k = k0; k <= k1; ++k) at(k * spacing);
  // The playhead's own dab, so the brush is drawn exactly where it is now.
  if (onGrid == 0 || tEnd - k1 * spacing > 1e-6) at(tEnd);
  return out;
}

}  // namespace premation::scene
