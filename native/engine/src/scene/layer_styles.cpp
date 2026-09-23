// Port of `layerStylesToEffects` (src/core/effects/layerStyles.ts).
//
// The styles are the document's own loosely typed JSON, so every read goes
// through JavaScript semantics: a gate like `ds.blur > 0` is a relational
// comparison on ToNumber(ds.blur) (undefined → NaN → false), `Math.max(0, x)`
// propagates NaN, and pass-through fields (`angle`, `color`, `direction` …) are
// copied verbatim, `undefined` included, exactly as the TS object literal does.
#include "layer_styles.hpp"

#include <array>
#include <charconv>
#include <cmath>
#include <memory>
#include <string>
#include <utility>

#include "jsmath.hpp"

namespace premation::scene {
namespace {

namespace jm = motion::js;

/// ECMAScript ToNumber for the value kinds a style field can hold.
double to_number(const Json& v) {
  switch (v.kind()) {
    case Json::Kind::undefined: return jm::kNaN;
    case Json::Kind::null: return 0.0;
    case Json::Kind::boolean: return v.b() ? 1.0 : 0.0;
    case Json::Kind::number: return v.num();
    case Json::Kind::string: {
      std::string_view s = v.str();
      constexpr std::string_view kWs = " \t\n\r\f\v";
      const std::size_t b = s.find_first_not_of(kWs);
      if (b == std::string_view::npos) return 0.0;
      s = s.substr(b, s.find_last_not_of(kWs) - b + 1);
      if (s == "Infinity" || s == "+Infinity") return jm::kInf;
      if (s == "-Infinity") return -jm::kInf;
      if (s.starts_with('+')) s.remove_prefix(1);
      double d = 0;
      const char* const first = std::to_address(s.begin());
      const char* const last = std::to_address(s.end());
      const auto [end, ec] = std::from_chars(first, last, d);
      if (ec != std::errc{} || end != last) return jm::kNaN;
      return d;
    }
    case Json::Kind::array:
    case Json::Kind::object: return jm::kNaN;
  }
  return jm::kNaN;
}

/// JavaScript truthiness.
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

double num(const Json& style, std::string_view key) { return to_number(style.at(key)); }

double max2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return jm::max_of(v);
}
double min2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return jm::min_of(v);
}

/// `clamp01` (src/utils/lang.ts): `v > 0 ? (v > 1 ? 1 : v) : 0` — NaN → 0.
double clamp01(double v) {
  if (v > 0) return v > 1 ? 1.0 : v;
  return 0.0;
}

/// `x ?? d` for a number-typed field (only null/undefined fall back).
double num_or(const Json& style, std::string_view key, double d) {
  const Json& v = style.at(key);
  return v.is_undefined() || v.is_null() ? d : to_number(v);
}

/// `s?.enabled`: the style when it is an object whose `enabled` is truthy.
const Json* enabled_style(const Json& styles, std::string_view key) {
  const Json& s = styles.at(key);
  if (!s.is_object() || !truthy(s.at("enabled"))) return nullptr;
  return &s;
}

Json make_effect(std::string_view key, std::string_view type, Json params) {
  Json e = Json::object();
  e.set("id", Json::string("layerstyle:" + std::string(key)));
  e.set("type", Json::string(std::string(type)));
  e.set("params", std::move(params));
  return e;
}

Json n(double d) { return Json::number(d); }

}  // namespace

std::optional<std::vector<Json>> layer_styles_to_effects(const Json& styles, double globalAngle, double globalAltitude,
                                                         const std::function<bool(std::string_view)>& animated) {
  std::vector<Json> out;
  // `if (!styles) return []` — and a non-object has no style members to read.
  if (!styles.is_object()) return out;
  const auto anim = [&animated](std::string_view k) { return animated ? animated(k) : false; };
  const bool angleFinite = std::isfinite(globalAngle);

  if (const Json* ds = enabled_style(styles, "dropShadow");
      ds != nullptr && (num(*ds, "blur") > 0 || num(*ds, "distance") > 0 || anim("dropShadow"))) {
    const Json angle = truthy(ds->at("useGlobalLight")) && angleFinite ? n(globalAngle) : ds->at("angle");
    Json p = Json::object();
    p.set("distance", n(max2(0, num(*ds, "distance"))));
    p.set("angle", angle);
    p.set("softness", n(max2(0, num(*ds, "blur"))));
    p.set("spread", n(max2(0, min2(100, num_or(*ds, "spread", 0)))));
    p.set("color", ds->at("color"));
    p.set("opacity", n(jm::round(clamp01(num(*ds, "opacity")) * 100)));
    out.push_back(make_effect("dropShadow", "drop-shadow", std::move(p)));
  }

  if (const Json* is = enabled_style(styles, "innerShadow");
      is != nullptr && (num(*is, "size") > 0 || num(*is, "distance") > 0 || anim("innerShadow"))) {
    const Json angle = truthy(is->at("useGlobalLight")) && angleFinite ? n(globalAngle) : is->at("angle");
    Json p = Json::object();
    p.set("distance", n(max2(0, num(*is, "distance"))));
    p.set("angle", angle);
    p.set("softness", n(max2(0, num(*is, "size"))));
    p.set("color", is->at("color"));
    p.set("opacity", n(jm::round(num(*is, "opacity") * 100)));
    out.push_back(make_effect("innerShadow", "inner-shadow", std::move(p)));
  }

  if (const Json* og = enabled_style(styles, "outerGlow"); og != nullptr && (num(*og, "size") > 0 || anim("outerGlow"))) {
    Json p = Json::object();
    p.set("radius", n(max2(0, num(*og, "size"))));
    p.set("spread", n(max2(0, min2(100, num_or(*og, "spread", 0)))));
    p.set("color", og->at("color"));
    p.set("intensity", n(jm::round(clamp01(num(*og, "opacity")) * 100)));
    out.push_back(make_effect("outerGlow", "glow", std::move(p)));
  }

  if (const Json* ig = enabled_style(styles, "innerGlow"); ig != nullptr && (num(*ig, "size") > 0 || anim("innerGlow"))) {
    Json p = Json::object();
    p.set("size", n(max2(0, num(*ig, "size"))));
    p.set("color", ig->at("color"));
    p.set("opacity", n(jm::round(num(*ig, "opacity") * 100)));
    out.push_back(make_effect("innerGlow", "inner-glow", std::move(p)));
  }

  if (const Json* sa = enabled_style(styles, "satin");
      sa != nullptr &&
      ((num(*sa, "opacity") > 0 && (num(*sa, "size") > 0 || num(*sa, "distance") > 0)) || anim("satin"))) {
    Json p = Json::object();
    p.set("distance", n(max2(0, num(*sa, "distance"))));
    p.set("angle", sa->at("angle"));
    p.set("size", n(max2(0, num(*sa, "size"))));
    p.set("color", sa->at("color"));
    p.set("opacity", n(jm::round(num(*sa, "opacity") * 100)));
    const Json& inv = sa->at("invert");
    p.set("invert", Json::boolean(inv.is_bool() && inv.b()));
    out.push_back(make_effect("satin", "satin", std::move(p)));
  }

  if (const Json* bv = enabled_style(styles, "bevel");
      bv != nullptr && ((num(*bv, "depth") > 0 && num(*bv, "size") > 0) || anim("bevel"))) {
    const bool bound = truthy(bv->at("useGlobalLight")) && angleFinite;
    Json p = Json::object();
    p.set("size", n(max2(1, num(*bv, "size"))));
    p.set("depth", n(max2(0, num(*bv, "depth"))));
    p.set("direction", bv->at("direction"));
    p.set("angle", bound ? n(globalAngle) : bv->at("angle"));
    p.set("altitude", bound && std::isfinite(globalAltitude) ? n(globalAltitude) : bv->at("altitude"));
    p.set("highlightColor", bv->at("highlightColor"));
    p.set("highlightOpacity", n(jm::round(num(*bv, "highlightOpacity") * 100)));
    p.set("shadowColor", bv->at("shadowColor"));
    p.set("shadowOpacity", n(jm::round(num(*bv, "shadowOpacity") * 100)));
    out.push_back(make_effect("bevel", "bevel", std::move(p)));
  }

  if (const Json* co = enabled_style(styles, "colorOverlay");
      co != nullptr && (num(*co, "opacity") > 0 || anim("colorOverlay"))) {
    Json p = Json::object();
    p.set("color", co->at("color"));
    p.set("opacity", n(jm::round(num(*co, "opacity") * 100)));
    out.push_back(make_effect("colorOverlay", "fill", std::move(p)));
  }

  if (const Json* go = enabled_style(styles, "gradientOverlay");
      go != nullptr && (num(*go, "opacity") > 0 || anim("gradientOverlay"))) {
    const Json angle = truthy(go->at("useGlobalLight")) && angleFinite ? n(globalAngle) : go->at("angle");
    Json p = Json::object();
    p.set("colorA", go->at("from"));
    p.set("colorB", go->at("to"));
    p.set("angle", angle);
    p.set("blend", n(jm::round(num(*go, "opacity") * 100)));
    out.push_back(make_effect("gradientOverlay", "gradient-ramp", std::move(p)));
  }

  if (const Json* st = enabled_style(styles, "stroke");
      st != nullptr && ((num(*st, "size") > 0 && num(*st, "opacity") > 0) || anim("stroke"))) {
    const Json& pos = st->at("position");
    const std::string position =
        pos.is_string() && (pos.str() == "inside" || pos.str() == "center") ? pos.str() : std::string("outside");
    Json p = Json::object();
    p.set("width", n(max2(0, num(*st, "size"))));
    p.set("color", st->at("color"));
    p.set("opacity", n(jm::round(num(*st, "opacity") * 100)));
    p.set("position", Json::string(position));
    out.push_back(make_effect("stroke", "stroke", std::move(p)));
  }

  return out;
}

}  // namespace premation::scene
