// Glass layer style: resolveGlass (src/core/effects/glassResolve.ts) and
// toRenderableGlass (src/core/rendering/snapshotToFrameScene.ts), call for call.
//
// Glass does not compile to an effect: it resolves straight onto the layer
// (and its backdrop blur) and the render graph composites it in its backdrop
// branch.
#include <cmath>
#include <numbers>
#include <string>
#include <string_view>

#include "fxstate.hpp"
#include "misc_port.hpp"

namespace premation::scene {
namespace {

/// defaultGlassStyle() (effects/layerStyles.ts).
struct GlassDefaults {
  static constexpr double blur = 28, saturation = 1.9, tintOpacity = 0.1, refraction = 34, edgeWidth = 3.5,
                          chromaticAberration = 10, rimOpacity = 0.42, rimWidth = 7, rimAngle = 315, specularAngle = 315,
                          specularIntensity = 0.38, specularFalloff = 10, grain = 0.04;
};
constexpr std::string_view kDefaultTint = "#ffffff";
constexpr std::string_view kDefaultRim = "#ffffff";

/// `clamp01` (src/utils/lang.ts): NaN → 0.
double clamp01(double v) {
  if (v > 0) return v > 1 ? 1.0 : v;
  return 0.0;
}

/// `Math.max(0, v)` (NaN propagates).
double max0(double v) { return std::isnan(v) ? v : (v > 0 ? v : 0.0); }

/// JavaScript truthiness of a style field.
bool truthy(const Json& v) {
  switch (v.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: return false;
    case Json::Kind::boolean: return v.b();
    case Json::Kind::number: return v.num() != 0 && !std::isnan(v.num());
    case Json::Kind::string: return !v.str().empty();
    case Json::Kind::array:
    case Json::Kind::object: return true;
  }
  return false;
}

/// A GlassStyle numeric field: the stored number (`fallback`), `undefined`
/// when absent. A non-number stored value reads as NaN (it is typed number).
std::optional<double> stored_num(const Json& style, std::string_view key) {
  const Json& v = style.at(key);
  if (v.is_undefined() || v.is_null()) return std::nullopt;
  if (v.is_number()) return v.num();
  if (v.is_bool()) return v.b() ? 1.0 : 0.0;
  return std::nan("");
}

/// `resolveGlassColor(param, stored, av, fallback)`.
std::string resolve_color(std::string_view param, const Json& stored, const Values& av, std::string_view fallback) {
  const std::string base = stored.is_string() ? stored.str() : std::string(fallback);
  const std::string path = "glass." + std::string(param);
  const auto r = av.get(path + "_r");
  const auto g = av.get(path + "_g");
  const auto b = av.get(path + "_b");
  const auto a = av.get(path + "_a");
  if (!r && !g && !b && !a) return base;
  const auto ch = doc::parse_color_channels(base);
  return doc::channels_to_color(r.value_or(ch[0]), g.value_or(ch[1]), b.value_or(ch[2]), a.value_or(ch[3]));
}

api::Color to_color(const Rgba& c) {
  api::Color o;
  o.r = c.r;
  o.g = c.g;
  o.b = c.b;
  o.a = c.a;
  return o;
}

}  // namespace

std::optional<ResolvedGlass> resolve_glass(const Json& style, const Values& av, double globalLightAngle) {
  if (!style.is_object() || !truthy(style.at("enabled"))) return std::nullopt;
  // `av?.get(glassPropPath(param)) ?? fallback ?? d[param]`.
  const auto val = [&](std::string_view param, double d) {
    if (const auto live = av.get("glass." + std::string(param))) return *live;
    return stored_num(style, param).value_or(d);
  };
  using D = GlassDefaults;
  const bool bound = truthy(style.at("useGlobalLight")) && std::isfinite(globalLightAngle);
  const double rimAngle = bound ? globalLightAngle : val("rimAngle", D::rimAngle);

  ResolvedGlass g;
  g.blur = max0(val("blur", D::blur));
  g.saturation = max0(val("saturation", D::saturation));
  g.tintColor = resolve_color("tintColor", style.at("tintColor"), av, kDefaultTint);
  g.tintOpacity = clamp01(val("tintOpacity", D::tintOpacity));
  g.refraction = val("refraction", D::refraction);
  g.edgeWidth = max0(val("edgeWidth", D::edgeWidth));
  g.chromaticAberration = val("chromaticAberration", D::chromaticAberration);
  g.rimColor = resolve_color("rimColor", style.at("rimColor"), av, kDefaultRim);
  g.rimOpacity = clamp01(val("rimOpacity", D::rimOpacity));
  g.rimWidth = max0(val("rimWidth", D::rimWidth));
  g.rimAngle = rimAngle;
  g.specularAngle = bound ? rimAngle : val("specularAngle", D::specularAngle);
  g.specularIntensity = max0(val("specularIntensity", D::specularIntensity));
  {
    // Math.max(0.1, v).
    const double f = val("specularFalloff", D::specularFalloff);
    g.specularFalloff = std::isnan(f) ? f : (f > 0.1 ? f : 0.1);
  }
  g.grain = clamp01(val("grain", D::grain));
  return g;
}

api::RenderGlass to_renderable_glass(const ResolvedGlass& g) {
  const auto rad = [](double deg) { return (deg * std::numbers::pi) / 180; };
  api::RenderGlass r;
  r.refraction = g.refraction;
  r.edge_width = g.edgeWidth;
  r.aberration = g.chromaticAberration;
  r.saturation = g.saturation;
  r.tint = to_color(color_from_hex(g.tintColor));
  r.tint_opacity = g.tintOpacity;
  r.rim = to_color(color_from_hex(g.rimColor));
  r.rim_opacity = g.rimOpacity;
  r.rim_width = g.rimWidth;
  r.rim_angle = rad(g.rimAngle);
  r.specular_angle = rad(g.specularAngle);
  r.specular_intensity = g.specularIntensity;
  r.specular_falloff = g.specularFalloff;
  r.grain = g.grain;
  return r;
}

}  // namespace premation::scene
