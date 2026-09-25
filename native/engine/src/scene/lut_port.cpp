#include "lut_port.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <string>
#include <utility>

#include "effects/effect_chain.hpp"
#include "effects_port.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "raster/json.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;
namespace rj = raster::json;
using Table = std::array<float, 256>;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }

/// colorLut.ts `clamp255` (NaN passes through).
double clamp255(double v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
float f32(double v) { return static_cast<float>(v); }

/// `table[clamp255(Math.round(v))]` — undefined (→ NaN) for a NaN index.
double at_rounded(const Table& t, double v) {
  const double i = clamp255(mjs::round(v));
  if (std::isnan(i)) return kNaN;
  return static_cast<double>(t[static_cast<std::size_t>(i)]);
}

Table identity_table() {
  Table t{};
  for (std::size_t i = 0; i < 256; ++i) t[i] = static_cast<float>(i);
  return t;
}

/// buildChannelLut's per-effect table — the E4 chain's builders (effect_color.cpp,
/// byte-exact against colorLut.ts in effect_chain_parity.json) over paramsOf(e).
std::optional<ChannelLut> tables_for(const Json& e) {
  const std::string t = type_of(e);
  if (!effects::is_lut_effect(t)) return std::nullopt;
  rj::Value params;
  std::string err;
  if (!rj::parse(js::stringify(doc::params_of(e)), params, err)) return std::nullopt;
  const effects::ChannelLut c = effects::build_channel_lut(t, params);
  ChannelLut out;
  for (std::size_t i = 0; i < 256; ++i) {
    out.r[i] = c.r[i];
    out.g[i] = c.g[i];
    out.b[i] = c.b[i];
  }
  return out;
}

/// `lutStripByte(v)`.
std::uint8_t strip_byte(double v) {
  const double b = std::max(0.0, std::min(255.0, mjs::round(v)));
  return std::isnan(b) || std::isnan(v) ? 0 : static_cast<std::uint8_t>(b);
}

double sample_strip(const Table& t, double v) {
  const double u = v > 0 ? (v < 1 ? v : 1) : 0;
  const double x = std::max(0.0, std::min(255.0, u * 256 - 0.5));
  const double i0 = std::floor(x);
  const double i1 = std::min(255.0, i0 + 1);
  const double f = x - i0;
  return (strip_byte(t[static_cast<std::size_t>(i0)]) * (1 - f) + strip_byte(t[static_cast<std::size_t>(i1)]) * f) / 255;
}

bool first_enabled_cube(const RLayer& l, const Json*& out) {
  for (const Json& e : l.effects) {
    if (effect_enabled(e) && type_of(e) == "apply-color-lut") {
      out = &e;
      return true;
    }
  }
  return false;
}

}  // namespace

bool is_lut_effect_type(std::string_view t) { return effects::is_lut_effect(t); }

std::optional<ChannelLut> build_channel_lut(const std::vector<Json>& effects) {
  std::vector<ChannelLut> active;
  for (const Json& e : effects) {
    if (!effect_enabled(e)) continue;
    if (auto t = tables_for(e)) active.push_back(std::move(*t));
  }
  if (active.empty()) return std::nullopt;
  ChannelLut lut{identity_table(), identity_table(), identity_table()};
  for (const ChannelLut& tables : active) {
    for (std::size_t i = 0; i < 256; ++i) {
      lut.r[i] = f32(at_rounded(tables.r, static_cast<double>(lut.r[i])));
      lut.g[i] = f32(at_rounded(tables.g, static_cast<double>(lut.g[i])));
      lut.b[i] = f32(at_rounded(tables.b, static_cast<double>(lut.b[i])));
    }
  }
  return lut;
}

std::array<double, 3> sample_channel_lut_as_uploaded(const ChannelLut& lut, const std::array<double, 3>& rgb) {
  return {sample_strip(lut.r, rgb[0]), sample_strip(lut.g, rgb[1]), sample_strip(lut.b, rgb[2])};
}

std::optional<CubeLut> read_cube_lut_param(const Json& e) {
  const Json& o = e.at("params").at("lut");
  if (!o.is_object()) return std::nullopt;
  const double size = o.at("size").is_number() ? o.at("size").num() : 0;
  const double size1d = o.at("size1d").is_number() ? o.at("size1d").num() : 0;
  if (!o.at("data").is_array()) return std::nullopt;
  if (size == 0 && size1d == 0) return std::nullopt;
  if (size > 0 && size1d > 0) return std::nullopt;
  const double expected = size > 0 ? size * size * size * 3 : size1d * 3;
  const Json::Array& data = o.at("data").arr();
  if (static_cast<double>(data.size()) != expected) return std::nullopt;
  CubeLut lut;
  lut.data.reserve(data.size());
  for (const Json& v : data) {
    if (!v.is_number() || !std::isfinite(v.num())) return std::nullopt;
    lut.data.push_back(f32(v.num()));
  }
  const auto triple = [](const Json& a, std::array<double, 3> fb) -> std::optional<std::array<double, 3>> {
    if (a.is_undefined() || a.is_null()) return fb;
    if (!a.is_array() || a.arr().size() < 3) return std::nullopt;
    std::array<double, 3> t{};
    for (std::size_t i = 0; i < 3; ++i) {
      if (!a.arr()[i].is_number()) return std::nullopt;
      t[i] = a.arr()[i].num();
    }
    return t;
  };
  const auto mn = triple(o.at("domainMin"), {0, 0, 0});
  const auto mx = triple(o.at("domainMax"), {1, 1, 1});
  if (!mn || !mx) return std::nullopt;
  for (std::size_t i = 0; i < 3; ++i) {
    if (!((*mx)[i] > (*mn)[i])) return std::nullopt;
  }
  lut.size = static_cast<int>(size);
  lut.size1d = static_cast<int>(size1d);
  lut.domainMin = *mn;
  lut.domainMax = *mx;
  return lut;
}

void append_lut_textures(const RLayer& l, std::vector<TextureRequest>& out) {
  // MotionRendererBackend: only the enabled LUT effects are composed.
  std::vector<Json> lutEffects;
  for (const Json& e : l.effects) {
    if (effect_enabled(e) && is_lut_effect_type(type_of(e))) lutEffects.push_back(e);
  }
  if (!lutEffects.empty()) {
    if (const auto lut = build_channel_lut(lutEffects)) {
      TextureRequest r;
      r.key = "lut:" + l.id;
      r.kind = TexKind::pixels;
      r.pxWidth = 256;
      r.pxHeight = 1;
      r.pixels.resize(256 * 4);
      for (std::size_t i = 0; i < 256; ++i) {
        r.pixels[i * 4] = strip_byte(lut->r[i]);
        r.pixels[i * 4 + 1] = strip_byte(lut->g[i]);
        r.pixels[i * 4 + 2] = strip_byte(lut->b[i]);
        r.pixels[i * 4 + 3] = 255;
      }
      r.layerId = l.id;
      out.push_back(std::move(r));
    }
  }
  const Json* cubeFx = nullptr;
  if (!first_enabled_cube(l, cubeFx)) return;
  const auto cube = read_cube_lut_param(*cubeFx);
  if (!cube) return;
  const bool is1d = cube->size1d > 0;
  const auto n = static_cast<std::uint32_t>(is1d ? cube->size1d : cube->size);
  if (n == 0) return;
  TextureRequest r;
  r.key = "cubelut:" + l.id;
  r.kind = TexKind::pixels;
  r.pxWidth = is1d ? n : n * n;
  r.pxHeight = is1d ? 1 : n;
  r.pixels.assign(static_cast<std::size_t>(r.pxWidth) * r.pxHeight * 4, 0);
  const auto b8 = [](float v) {
    const double x = mjs::round((std::isfinite(v) ? static_cast<double>(v) : 0) * 255);
    return static_cast<std::uint8_t>(x < 0 ? 0 : x > 255 ? 255 : x);
  };
  const auto put = [&](std::size_t x, std::size_t y, std::size_t s) {
    const std::size_t o = (y * r.pxWidth + x) * 4;
    r.pixels[o] = b8(cube->data[s]);
    r.pixels[o + 1] = b8(cube->data[s + 1]);
    r.pixels[o + 2] = b8(cube->data[s + 2]);
    r.pixels[o + 3] = 255;
  };
  if (is1d) {
    for (std::size_t i = 0; i < n; ++i) put(i, 0, i * 3);
  } else {
    for (std::size_t z = 0; z < n; ++z) {
      for (std::size_t g = 0; g < n; ++g) {
        for (std::size_t rr = 0; rr < n; ++rr) put(z * n + rr, g, (rr + g * n + z * n * n) * 3);
      }
    }
  }
  r.layerId = l.id;
  out.push_back(std::move(r));
}

std::optional<api::RenderEffect> apply_color_lut_entry(const Json& e, const Json& params, const RLayer& l) {
  const auto cube = read_cube_lut_param(e);
  if (!cube) return std::nullopt;
  const Json& inten = params.at("intensity");
  FxWriter w("apply-color-lut");
  w.text("lutTextureKey", "cubelut:" + l.id);
  w.num("size", cube->size1d > 0 ? cube->size1d : cube->size);
  w.flag("is1d", cube->size1d > 0);
  w.num("intensity", (inten.is_number() ? inten.num() : 0) / 100);
  w.num("domainMin", cube->domainMin[0]);
  w.num("domainMax", cube->domainMax[0]);
  return w.done();
}

std::array<double, 3> grade_uniform_lut(const RLayer& l, const std::array<double, 3>& rgb) {
  if (l.effects.empty()) return rgb;
  const auto lut = build_channel_lut(l.effects);
  return lut ? sample_channel_lut_as_uploaded(*lut, rgb) : rgb;
}

}  // namespace premation::scene
