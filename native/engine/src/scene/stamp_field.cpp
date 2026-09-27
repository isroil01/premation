#include "stamp_field.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <string>
#include <vector>

#include "fxstate.hpp"
#include "jsmath.hpp"
#include "noise_hash.hpp"
#include "pixel_ops.hpp"
#include "rg_math.hpp"

namespace premation::scene {
namespace {

namespace fx = premation::effects;

std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }

double num_of(const Json& params, std::string_view key) {
  const Json* v = params.find(key);
  return v != nullptr && v->is_number() ? v->num() : 0;
}

std::string str_of(const Json& params, std::string_view key) {
  const Json* v = params.find(key);
  return v != nullptr && v->is_string() ? v->str() : std::string();
}

std::array<double, 3> linear_hex(const std::string& hex) {
  std::string s = hex;
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.erase(s.begin());
  if (!s.empty() && s[0] == '#') s.erase(s.begin());
  if (s.size() == 3) s = std::string(2, s[0]) + std::string(2, s[1]) + std::string(2, s[2]);
  auto channel = [&](std::size_t i) {
    if (s.size() < i + 2) return 1.0;
    auto nib = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    const int hi = nib(s[i]);
    const int lo = nib(s[i + 1]);
    if (hi < 0 || lo < 0) return 1.0;
    return rg::srgb_to_linear((hi * 16 + lo) / 255.0);
  };
  return {channel(0), channel(2), channel(4)};
}

constexpr std::uint32_t kRow = 1024;
constexpr double kMaxPoints = 700;

struct Rgba {
  double r, g, b, a;
};
struct Line {
  double x0, y0, x1, y1;
  Rgba c;
};
struct Disc {
  double x, y, radius, hardness;
  Rgba c;
};
struct Tri {
  double x0, y0, x1, y1, x2, y2;
  Rgba c;
};

void push4(std::vector<float>& f, double a, double b, double c, double d) {
  f.push_back(static_cast<float>(a));
  f.push_back(static_cast<float>(b));
  f.push_back(static_cast<float>(c));
  f.push_back(static_cast<float>(d));
}

StampTexture pack_field(std::string key, double width, double height, double lineWidth, const std::vector<Tri>& tris,
                        const std::vector<Line>& lines, const std::vector<Disc>& discs, double over) {
  std::vector<float> f(8, 0);
  f[0] = static_cast<float>(tris.size());
  f[1] = static_cast<float>(lines.size());
  f[2] = static_cast<float>(discs.size());
  f[3] = static_cast<float>(width);
  f[4] = static_cast<float>(height);
  f[5] = static_cast<float>(lineWidth);
  for (const Tri& t : tris) {
    push4(f, t.x0, t.y0, t.x1, t.y1);
    push4(f, t.x2, t.y2, t.c.r, t.c.g);
    push4(f, t.c.b, t.c.a, 0, 0);
  }
  for (const Line& l : lines) push4(f, l.x0, l.y0, l.x1, l.y1), push4(f, l.c.r, l.c.g, l.c.b, l.c.a);
  for (const Disc& d : discs) push4(f, d.x, d.y, d.radius, d.hardness), push4(f, d.c.r, d.c.g, d.c.b, d.c.a);
  StampTexture out;
  out.key = std::move(key);
  out.over = over;
  out.instances = static_cast<std::uint32_t>(tris.size() + lines.size() + discs.size());
  out.width = kRow;
  out.height = static_cast<std::uint32_t>((f.size() + kRow - 1) / kRow);
  out.rgba.assign(static_cast<std::size_t>(out.width) * out.height * 4, 0);
  for (std::size_t i = 0; i < f.size(); ++i) {
    const auto bits = std::bit_cast<std::uint32_t>(f[i]);
    out.rgba[i * 4] = static_cast<std::uint8_t>(bits & 0xFFU);
    out.rgba[i * 4 + 1] = static_cast<std::uint8_t>((bits >> 8U) & 0xFFU);
    out.rgba[i * 4 + 2] = static_cast<std::uint8_t>((bits >> 16U) & 0xFFU);
    out.rgba[i * 4 + 3] = static_cast<std::uint8_t>(bits >> 24U);
  }
  return out;
}

std::string effect_key(const RLayer& layer, const Json& e) {
  std::string k = "stamp:";
  k += layer.id;
  k += ':';
  k += e.at("id").is_string() ? e.at("id").str() : type_of(e);
  return k;
}

/// drawPlexusInto's point cloud, links and dots. Composite 0..4 maps onto the
/// chain's `over` (0 source-over, 3 lighten, 4 screen, 5 multiply, 6 atop).
std::optional<StampTexture> plexus_field(const RLayer& layer, const Json& e) {
  const Json p = doc::params_of(e);
  const double opacity = std::max(0.0, std::min(1.0, num_of(p, "opacity") / 100));
  if (opacity <= 0) return std::nullopt;
  const double w = layer.width;
  const double h = layer.height;
  struct P {
    double x, y;
  };
  std::vector<P> pts;
  const Json* flat = p.find("pathPoints");
  if (flat != nullptr && flat->is_array() && flat->arr().size() >= 4) {
    const double step = std::max(1.0, fx::js::round(num_of(p, "pathStep")));
    double k = 0;
    const Json::Array& arr = flat->arr();
    for (std::size_t i = 0; i + 1 < arr.size(); i += 2, ++k) {
      if (!arr[i].is_number() || !arr[i + 1].is_number() || arr[i].num() >= 1e9) continue;
      if (std::fmod(k, step) == 0) pts.push_back({w / 2 + arr[i].num(), h / 2 + arr[i + 1].num()});
    }
  } else {
    const double cnt = std::max(0.0, std::min(kMaxPoints, std::floor(num_of(p, "pointCount"))));
    const double spread = std::max(0.0, std::min(1.0, num_of(p, "spread") / 100));
    const double drift = std::max(0.0, num_of(p, "drift"));
    const double evolution = num_of(p, "evolution");
    const double seed = fx::js::round(num_of(p, "seed"));
    const double sw = w * spread;
    const double sh = h * spread;
    const double bx0 = (w - sw) / 2;
    const double by0 = (h - sh) / 2;
    const double ev = evolution * 0.05;
    for (double i = 0; i < cnt; ++i) {
      const double bx = bx0 + fx::hash01u(fx::ju32(i), 1, fx::ju32(seed)) * sw;
      const double by = by0 + fx::hash01u(fx::ju32(i), 2, fx::ju32(seed)) * sh;
      const double dx = (fx::vnoise_u(ev + i * 7.13, 0.5, seed + 11) * 2 - 1) * drift;
      const double dy = (fx::vnoise_u(ev + i * 7.13, 9.5, seed + 23) * 2 - 1) * drift;
      pts.push_back({bx + dx, by + dy});
    }
  }
  const std::size_t n = std::min(pts.size(), static_cast<std::size_t>(kMaxPoints));
  const double maxDistance = std::max(0.0, num_of(p, "maxDistance"));
  const double lineWidth = std::max(0.0, num_of(p, "lineWidth"));
  const double lineOpacity = std::max(0.0, std::min(1.0, num_of(p, "lineOpacity") / 100)) * opacity;
  const bool triangles = p.at("triangles").is_bool() && p.at("triangles").b();
  const double triOpacity = std::max(0.0, std::min(1.0, num_of(p, "triangleOpacity") / 100)) * opacity;
  const auto lineRgb = linear_hex(str_of(p, "lineColor"));
  const auto pointRgb = linear_hex(str_of(p, "pointColor"));
  std::vector<Tri> tris;
  std::vector<Line> lines;
  if (maxDistance > 0 && n > 1) {
    const double d2max = maxDistance * maxDistance;
    std::vector<std::vector<std::size_t>> near(triangles ? n : 0);
    for (std::size_t i = 0; i < n; ++i) {
      for (std::size_t j = i + 1; j < n; ++j) {
        const double dx = pts[j].x - pts[i].x;
        const double dy = pts[j].y - pts[i].y;
        const double d2 = dx * dx + dy * dy;
        if (d2 >= d2max) continue;
        const double wt = 1 - std::sqrt(d2) / maxDistance;
        if (lineOpacity > 0 && lineWidth > 0) {
          lines.push_back({pts[i].x, pts[i].y, pts[j].x, pts[j].y, {lineRgb[0], lineRgb[1], lineRgb[2], wt * lineOpacity}});
        }
        if (triangles) near[i].push_back(j);
      }
    }
    if (triangles && triOpacity > 0) {
      for (std::size_t i = 0; i < n; ++i) {
        const auto& ni = near[i];
        for (std::size_t q = 0; q < ni.size(); ++q) {
          const std::size_t j = ni[q];
          const auto& nj = near[j];
          for (std::size_t r = q + 1; r < ni.size(); ++r) {
            if (std::ranges::find(nj, ni[r]) == nj.end()) continue;
            const std::size_t k = ni[r];
            const auto edge = [&](const P& a, const P& b) { return 1 - std::hypot(b.x - a.x, b.y - a.y) / maxDistance; };
            const double wt = std::min({edge(pts[i], pts[j]), edge(pts[i], pts[k]), edge(pts[j], pts[k])});
            tris.push_back({pts[i].x, pts[i].y, pts[j].x, pts[j].y, pts[k].x, pts[k].y,
                            {lineRgb[0], lineRgb[1], lineRgb[2], std::max(0.0, wt) * triOpacity}});
          }
        }
      }
    }
  }
  std::vector<Disc> discs;
  const double ps = std::max(0.0, num_of(p, "pointSize"));
  if (ps > 0 && opacity > 0) {
    for (std::size_t i = 0; i < n; ++i) {
      discs.push_back({pts[i].x, pts[i].y, ps / 2, 1, {pointRgb[0], pointRgb[1], pointRgb[2], opacity}});
    }
  }
  if (tris.empty() && lines.empty() && discs.empty()) return std::nullopt;
  const double comp = fx::js::round(num_of(p, "composite"));
  const double over = comp == 1 ? 3 : comp == 2 ? 4 : comp == 3 ? 5 : comp == 4 ? 6 : 0;
  return pack_field(effect_key(layer, e), w, h, lineWidth, tris, lines, discs, over);
}

double trail_at(const Json& params, std::string_view key, std::size_t i, double fb) {
  const Json* v = params.find(key);
  if (v == nullptr || !v->is_array() || i >= v->arr().size() || !v->arr()[i].is_number()) return fb;
  return v->arr()[i].num();
}

/// writeOnBrush: one dab at the brush, or the resolved trail (effect_handoff).
std::optional<StampTexture> write_on_brush_field(const RLayer& layer, const Json& e) {
  const Json p = doc::params_of(e);
  const Json* mode = p.find("writeOnMode");
  if (mode == nullptr || !mode->is_number() || fx::js::round(mode->num()) != 0) return std::nullopt;
  const double w = layer.width;
  const double h = layer.height;
  const auto rgb = linear_hex(str_of(p, "brushColor"));
  const double size = num_of(p, "brushSize");
  const double hard = std::max(0.0, std::min(1.0, num_of(p, "brushHardness") / 100));
  const double opacity = std::max(0.0, std::min(1.0, num_of(p, "brushOpacity") / 100));
  const double ptp = fx::js::round(num_of(p, "paintTimeProps"));
  const bool perOp = ptp == 1;
  const bool perColor = ptp == 2;
  const double bt = fx::js::round(num_of(p, "brushTimeProps"));
  const bool perSize = bt == 1 || bt == 3;
  const bool perHard = bt == 2 || bt == 3;
  const Json* xy = p.find("brushTrailXY");
  const std::size_t count = xy != nullptr && xy->is_array() ? xy->arr().size() / 2 : 0;
  struct Dab {
    double x, y, size, hard, op, r, g, b;
  };
  std::vector<Dab> dabs;
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t a = i * 5;
    dabs.push_back({w / 2 + trail_at(p, "brushTrailXY", i * 2, 0), h / 2 + trail_at(p, "brushTrailXY", i * 2 + 1, 0),
                    perSize ? trail_at(p, "brushTrailSize", i, size) : size,
                    perHard ? std::max(0.0, std::min(1.0, trail_at(p, "brushTrailAttr", a, hard * 100) / 100)) : hard,
                    perOp ? std::max(0.0, std::min(1.0, trail_at(p, "brushTrailAttr", a + 1, 100) / 100)) : 1,
                    perColor ? rg::srgb_to_linear(std::max(0.0, std::min(1.0, trail_at(p, "brushTrailAttr", a + 2, 255) / 255))) : rgb[0],
                    perColor ? rg::srgb_to_linear(std::max(0.0, std::min(1.0, trail_at(p, "brushTrailAttr", a + 3, 255) / 255))) : rgb[1],
                    perColor ? rg::srgb_to_linear(std::max(0.0, std::min(1.0, trail_at(p, "brushTrailAttr", a + 4, 255) / 255))) : rgb[2]});
  }
  if (dabs.empty()) dabs.push_back({w / 2 + num_of(p, "brushPositionX"), h / 2 + num_of(p, "brushPositionY"), size, hard, 1, rgb[0], rgb[1], rgb[2]});
  const bool filled = num_of(p, "brushTrailFilled") == 1;
  std::vector<Disc> discs;
  const auto stamp = [&](const Dab& d) {
    if (d.size <= 0 || d.op <= 0) return;
    discs.push_back({d.x, d.y, std::max(0.25, d.size / 2), d.hard, {d.r, d.g, d.b, d.op}});
  };
  for (std::size_t i = 0; i < dabs.size(); ++i) {
    stamp(dabs[i]);
    if (!filled || i + 1 >= dabs.size()) continue;
    const Dab& nx = dabs[i + 1];
    const double gap = std::hypot(nx.x - dabs[i].x, nx.y - dabs[i].y);
    const double step = std::max(0.5, std::min(dabs[i].size, nx.size) * 0.25);
    const double n = std::min(4096.0, std::floor(gap / step));
    for (int k = 1; k < static_cast<int>(n); ++k) {
      const double f = k / n;
      const auto lerp = [f](double a, double b) { return a + (b - a) * f; };
      stamp(Dab{lerp(dabs[i].x, nx.x), lerp(dabs[i].y, nx.y), lerp(dabs[i].size, nx.size), lerp(dabs[i].hard, nx.hard),
                lerp(dabs[i].op, nx.op), lerp(dabs[i].r, nx.r), lerp(dabs[i].g, nx.g), lerp(dabs[i].b, nx.b)});
    }
  }
  if (discs.empty()) return std::nullopt;
  const double style = fx::js::round(num_of(p, "paintStyle"));
  const double over = style == 1 ? 1 : style == 2 ? 2 : 0;
  // Per-dab opacity already sits on each disc; a single brush opacity scales them
  // except when paint-time opacity replaced it (write_on_brush's composite).
  if (!perOp && opacity < 1) {
    for (Disc& d : discs) d.c.a *= opacity;
  }
  return pack_field(effect_key(layer, e), w, h, 0, {}, {}, discs, over);
}

}  // namespace

std::optional<StampTexture> stamp_for_effect(const RLayer& layer, const Json& effect) {
  if (effect.at("enabled").is_bool() && !effect.at("enabled").b()) return std::nullopt;
  const std::string t = type_of(effect);
  if (t == "plexus") return plexus_field(layer, effect);
  if (t == "write-on") return write_on_brush_field(layer, effect);
  return std::nullopt;
}

std::vector<StampTexture> stamp_textures(const RLayer& layer) {
  std::vector<StampTexture> out;
  for (const Json& e : layer.effects) {
    if (auto s = stamp_for_effect(layer, e)) out.push_back(std::move(*s));
  }
  return out;
}

}  // namespace premation::scene
