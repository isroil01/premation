#include "light_wash.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "jsmath.hpp"

namespace premation::scene {

namespace {

constexpr std::uint32_t kLightTexSize = 512;  // AppTextureProvider LIGHT_TEX_SIZE

/// `Uint8ClampedArray` store: clamp, round half to even.
std::uint8_t clamped_u8(double v) {
  if (!(v > 0)) return 0;
  if (v >= 255) return 255;
  const double f = std::floor(v);
  const double d = v - f;
  double r = f;
  if (d > 0.5 || (d == 0.5 && std::fmod(f, 2.0) != 0)) r = f + 1;
  return static_cast<std::uint8_t>(r);
}

/// AppTextureProvider `poolProfile(t, featherFrac)`.
double pool_profile(double t, double featherFrac) {
  if (t >= 1) return 0;
  const double f = std::min(1.0, std::max(1e-3, featherFrac));
  if (t <= 1 - f) return 1;
  const double u = (1 - t) / f;
  return u * u * (3 - 2 * u);
}

/// AppTextureProvider `spotConeFactor(dx, dy, aimRad, halfConeRad, featherRad)`.
double spot_cone_factor(double dx, double dy, double aimRad, double halfConeRad, double featherRad) {
  if (dx == 0 && dy == 0) return 1;
  double delta = std::abs(motion::js::atan2(dy, dx) - aimRad);
  if (delta > std::numbers::pi) delta = 2 * std::numbers::pi - delta;
  if (delta > halfConeRad) return 0;
  if (featherRad > 1e-6 && delta > halfConeRad - featherRad) {
    const double u = (halfConeRad - delta) / featherRad;
    return u * u * (3 - 2 * u);
  }
  return 1;
}

/// AppTextureProvider `washRgb(color)`: `#rgb` / `#rrggbb`, anything else white.
std::array<std::uint8_t, 3> wash_rgb(std::string color) {
  const auto b = color.find_first_not_of(" \t\r\n");
  const auto e = color.find_last_not_of(" \t\r\n");
  color = b == std::string::npos ? std::string() : color.substr(b, e - b + 1);
  if (!color.empty() && color.front() == '#') color.erase(0, 1);
  std::string full = color;
  if (color.size() == 3) {
    full.clear();
    for (const char c : color) full.append(2, c);
  }
  if (full.size() != 6 || !std::ranges::all_of(full, [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; })) {
    return {255, 255, 255};
  }
  const auto n = static_cast<std::uint32_t>(std::stoul(full, nullptr, 16));
  return {static_cast<std::uint8_t>((n >> 16U) & 0xFFU), static_cast<std::uint8_t>((n >> 8U) & 0xFFU), static_cast<std::uint8_t>(n & 0xFFU)};
}

}  // namespace

raster::RasterOutput draw_light_wash(const LightWash& light, const raster::CanvasOptions& opts) {
  raster::RasterOutput out;
  const std::uint32_t s = kLightTexSize;
  out.width = s;
  out.height = s;
  const auto ctx = raster::Canvas2D::make(s, s, opts);
  if (!ctx) {
    out.error = "no canvas";
    return out;
  }
  const double c = static_cast<double>(s) / 2;
  const double featherFrac = std::max(0.0, light.coneFeather) / 100;
  const auto parse = [](const std::string& v) { return raster::css::parse_color(v); };
  if (light.pool) {
    const auto rgb = wash_rgb(light.color);
    std::vector<std::uint8_t> img(static_cast<std::size_t>(s) * s * 4, 0);
    for (std::uint32_t y = 0; y < s; ++y) {
      const double dy = y + 0.5 - c;
      for (std::uint32_t x = 0; x < s; ++x) {
        const double dx = x + 0.5 - c;
        const double a = pool_profile(std::sqrt(dx * dx + dy * dy) / c, featherFrac);
        if (a <= 0) continue;
        const std::size_t o = (static_cast<std::size_t>(y) * s + x) * 4;
        img[o] = rgb[0];
        img[o + 1] = rgb[1];
        img[o + 2] = rgb[2];
        img[o + 3] = static_cast<std::uint8_t>(motion::js::round(a * 255));
      }
    }
    ctx->putImageData(img, s, s, 0, 0);
  } else if (light.type == "ambient") {
    raster::Style st;
    if (const auto col = parse(light.color)) st.color = *col;
    ctx->setFillStyle(st);
    ctx->fillRect(0, 0, s, s);
  } else {
    auto g = std::make_shared<raster::Gradient>();
    g->kind = raster::Gradient::Kind::radial;
    g->p = {c, c, 0, c, c, c};
    if (const auto col = parse(light.color)) g->add_stop(0, *col);
    if (const auto clear = parse("rgba(0,0,0,0)")) g->add_stop(1, *clear);
    raster::Style st;
    st.kind = raster::Style::Kind::gradient;
    st.gradient = g;
    ctx->setFillStyle(st);
    ctx->fillRect(0, 0, s, s);
    if (light.type == "spot") {
      const double half = std::max(1e-3, ((light.cone / 2) * std::numbers::pi) / 180);
      const double feather = half * featherFrac;
      std::vector<std::uint8_t> d = ctx->getImageData(0, 0, s, s);
      for (std::uint32_t y = 0; y < s; ++y) {
        for (std::uint32_t x = 0; x < s; ++x) {
          const std::size_t a = (static_cast<std::size_t>(y) * s + x) * 4 + 3;
          d[a] = clamped_u8(d[a] * spot_cone_factor(x + 0.5 - c, y + 0.5 - c, 0, half, feather));
        }
      }
      ctx->putImageData(d, s, s, 0, 0);
    }
  }
  out.rgba = ctx->pixels();
  out.ok = true;
  return out;
}

js::Json light_wash_spec(const LightWash& l) {
  js::Json o = js::Json::object();
  o.set("color", js::Json::string(l.color));
  o.set("type", js::Json::string(l.type));
  o.set("cone", js::Json::number(l.cone));
  o.set("coneFeather", js::Json::number(l.coneFeather));
  o.set("pool", js::Json::boolean(l.pool));
  return o;
}

LightWash light_wash_of_spec(const js::Json& spec) {
  LightWash l;
  l.color = spec.at("color").is_string() ? spec.at("color").str() : "#ffffff";
  l.type = spec.at("type").is_string() ? spec.at("type").str() : "point";
  l.cone = spec.at("cone").num();
  l.coneFeather = spec.at("coneFeather").num();
  l.pool = spec.at("pool").b();
  return l;
}

}  // namespace premation::scene
