// Text features of the D2w SVG / text / misc family — see text_port.hpp.

#include "text_port.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <map>
#include <memory>
#include <mutex>
#include <numbers>
#include <optional>
#include <string>
#include <unordered_map>

#include "eval.hpp"
#include "expr.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "line_break.hpp"
#include "strutil.hpp"
#include "text_measure.hpp"
#include "text_unicode.hpp"

namespace premation::scene {
namespace {

struct MPt {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};

double js_hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

double num_or(const Json& v, double fb) { return v.is_number() ? v.num() : fb; }

/// mask.ts expandMaskPoints.
std::vector<MPt> expand_mask_points(const std::vector<MPt>& points, double expansion) {
  if (expansion == 0 || std::isnan(expansion) || std::fabs(expansion) < 1e-4 || points.size() < 2) return points;
  const std::size_t n = points.size();
  std::vector<MPt> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const MPt& curr = points[i];
    const MPt& prev = points[(i + n - 1) % n];
    const MPt& next = points[(i + 1) % n];
    double vx1 = curr.x - curr.inX;
    double vy1 = curr.y - curr.inY;
    if (js_hypot2(vx1, vy1) < 1e-4) {
      vx1 = curr.x - prev.x;
      vy1 = curr.y - prev.y;
    }
    double l1 = js_hypot2(vx1, vy1);
    if (l1 == 0 || std::isnan(l1)) l1 = 1;
    const double nx1 = vy1 / l1;
    const double ny1 = -vx1 / l1;
    double vx2 = curr.outX - curr.x;
    double vy2 = curr.outY - curr.y;
    if (js_hypot2(vx2, vy2) < 1e-4) {
      vx2 = next.x - curr.x;
      vy2 = next.y - curr.y;
    }
    double l2 = js_hypot2(vx2, vy2);
    if (l2 == 0 || std::isnan(l2)) l2 = 1;
    const double nx2 = vy2 / l2;
    const double ny2 = -vx2 / l2;
    const double nx = (nx1 + nx2) / 2;
    const double ny = (ny1 + ny2) / 2;
    double nLen = js_hypot2(nx, ny);
    if (nLen == 0 || std::isnan(nLen)) nLen = 1;
    const double factor = expansion / std::max(0.2, nLen);
    const double dx = nx * factor;
    const double dy = ny * factor;
    out.push_back({curr.x + dx, curr.y + dy, curr.inX + dx, curr.inY + dy, curr.outX + dx, curr.outY + dy});
  }
  return out;
}

Json pt(double x, double y) {
  Json o = Json::object();
  o.set("x", Json::number(x));
  o.set("y", Json::number(y));
  return o;
}

/// textAnimators.ts identityGlyphTransform(ch), in its key order.
Json identity_glyph(const std::string& ch) {
  Json g = Json::object();
  g.set("char", Json::string(ch));
  g.set("displayChar", Json::string(ch));
  g.set("dx", Json::number(0));
  g.set("dy", Json::number(0));
  g.set("scale", Json::number(1));
  g.set("scaleY", Json::number(1));
  g.set("rotation", Json::number(0));
  g.set("opacity", Json::number(1));
  g.set("fillOpacity", Json::number(1));
  for (const char* k : {"tracking", "lineSpacing", "blur", "skew", "strokeWidth"}) g.set(k, Json::number(0));
  return g;
}

// ── Character Value / Range (textAnimators.ts) ──────────────────────────────

/// `[...ch].length === 1 ? ch.codePointAt(0) : undefined`.
std::optional<char32_t> single_code_point(const std::string& ch) {
  const auto cps = raster::code_points(ch);
  if (cps.size() != 1) return std::nullopt;
  return static_cast<char32_t>(cps[0]);
}

std::string from_code_point(char32_t c) {
  std::string out;
  raster::append_utf8(out, c);
  return out;
}

/// offsetCharacter: Character Range "Preserve Case & Digits" walks 0-9 / A-Z / a-z, wrapping.
std::string offset_character(const std::string& ch, long long shift) {
  if (shift == 0) return ch;
  const auto cp = single_code_point(ch);
  if (!cp) return ch;
  const auto code = static_cast<long long>(*cp);
  constexpr std::array<std::pair<long long, long long>, 3> kAlphabets{{{0x30, 0x39}, {0x41, 0x5a}, {0x61, 0x7a}}};
  for (const auto& [lo, hi] : kAlphabets) {
    if (code < lo || code > hi) continue;
    const long long span = hi - lo + 1;
    const long long shifted = (((code - lo + shift) % span) + span) % span;
    return from_code_point(static_cast<char32_t>(lo + shifted));
  }
  return ch;
}

/// offsetCharacterFull: Character Range "Full Unicode" shifts the code point
/// itself, stepping over the surrogate block, within U+0020..U+10FFFF.
std::string offset_character_full(const std::string& ch, long long shift) {
  if (shift == 0) return ch;
  const auto cp = single_code_point(ch);
  if (!cp) return ch;
  long long c = static_cast<long long>(*cp) + shift;
  if (c >= 0xd800 && c <= 0xdfff) c += shift > 0 ? 0x800 : -0x800;
  c = std::max<long long>(0x20, std::min<long long>(0x10ffff, c));
  return from_code_point(static_cast<char32_t>(c));
}

/// characterFromValue: the Character Value as a drawable character (clamped, surrogates refused).
std::optional<std::string> character_from_value(double value) {
  if (!std::isfinite(value)) return std::nullopt;
  const double c = std::floor(value + 0.5);  // Math.round
  if (c < 0x20 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return std::nullopt;
  return from_code_point(static_cast<char32_t>(c));
}

// ── Expression selector (textSelectors.ts expressionSelectorAt) ─────────────

/// The selector's source runs in the engine's expression language with AE's
/// per-character names bound by a `var` prologue (the TypeScript evaluated the
/// same AST with a scope of textIndex / textTotal / selectorValue / time).
/// Compiled sources are kept by their full text: a stack over a short text
/// compiles a handful per frame and finds them again on the next.
class SelectorExpressions {
 public:
  double run(const std::string& src, int unit, int count, double incoming, double time) {
    namespace ex = motion::expr;
    std::string full = "var textIndex = " + js::number_to_string(unit) + "; var textTotal = " +
                       js::number_to_string(count) + "; var selectorValue = " + js::number_to_string(incoming * 100) +
                       ";\n" + src;
    const ex::Expression* compiled = nullptr;
    {
      const std::scoped_lock lock(m_);
      auto it = cache_.find(full);
      if (it == cache_.end()) {
        if (cache_.size() >= kMax) cache_.clear();
        it = cache_.emplace(full, std::make_unique<ex::Expression>(ex::Expression::compile(ex::utf8_to_utf16(full)))).first;
      }
      compiled = it->second.get();
    }
    ex::Context ctx;
    ctx.time = time;
    ctx.value = incoming * 100;
    const ex::Result r = compiled->run(ctx);
    if (r.error || r.kind != ex::Result::Kind::kNumber || !std::isfinite(r.number)) return 0;
    return r.number;
  }

 private:
  static constexpr std::size_t kMax = 512;
  std::mutex m_;
  std::unordered_map<std::string, std::unique_ptr<motion::expr::Expression>> cache_;
};

SelectorExpressions& selector_expressions() {
  static SelectorExpressions s;
  return s;
}

/// expressionSelectorAt: 0 for a unit outside the text or a source that does
/// not evaluate; else the percentage it returns, scaled by Amount.
double expression_selector_at(const Json& sel, int unit, int count, double time, double incoming) {
  if (unit < 0) return 0;
  const std::string src = sel.at("expression").is_string() ? sel.at("expression").str() : std::string("selectorValue");
  const double amount = sel.at("amount").is_number() ? sel.at("amount").num() : 100;
  const double v = selector_expressions().run(src, unit, count, incoming, time);
  return (v / 100) * (amount / 100);
}

}  // namespace

Json flatten_mask_path(const Json& path, int perSegment) {
  // maskSegments(path): the (expanded) points joined by cubics, closing back when closed.
  std::vector<MPt> raw;
  if (path.at("points").is_array()) {
    for (const Json& p : path.at("points").arr()) {
      const double x = num_or(p.at("x"), 0);
      const double y = num_or(p.at("y"), 0);
      raw.push_back({x, y, num_or(p.at("inX"), x), num_or(p.at("inY"), y), num_or(p.at("outX"), x), num_or(p.at("outY"), y)});
    }
  }
  const std::vector<MPt> pts = expand_mask_points(raw, num_or(path.at("expansion"), 0));
  const bool closed = path.at("closed").is_bool() && path.at("closed").b();
  Json out = Json::object();
  Json list = Json::array();
  const std::size_t n = pts.size();
  if (n >= 2) {
    const std::size_t last = closed ? n : n - 1;
    list.arr_mut().push_back(pt(pts[0].x, pts[0].y));
    for (std::size_t i = 0; i < last; ++i) {
      const MPt& a = pts[i];
      const MPt& b = pts[(i + 1) % n];
      const bool straight = a.outX == a.x && a.outY == a.y && b.inX == b.x && b.inY == b.y;
      if (straight) {
        list.arr_mut().push_back(pt(b.x, b.y));
        continue;
      }
      for (int k = 1; k <= perSegment; ++k) {
        // textPath.ts cubicAt.
        const double t = static_cast<double>(k) / perSegment;
        const double u = 1 - t;
        const double ca = u * u * u;
        const double cb = 3 * u * u * t;
        const double cc = 3 * u * t * t;
        const double cd = t * t * t;
        list.arr_mut().push_back(pt(ca * a.x + cb * a.outX + cc * b.inX + cd * b.x, ca * a.y + cb * a.outY + cc * b.inY + cd * b.y));
      }
    }
    if (closed && list.arr().size() > 1) list.arr_mut().pop_back();
  }
  out.set("pts", std::move(list));
  out.set("closed", Json::boolean(closed));
  return out;
}

Json resolve_layer_text_path(const doc::Node& n, const Values& a) {
  // resolveTextPath(node, a).
  const auto base = doc::read_text_path_config(n);
  if (!base) return {};
  const auto flag = [&a](const char* param, bool fb) {
    const auto v = a.get(std::string("textPath.") + param);
    return v ? *v >= 0.5 : fb;
  };
  const double firstMargin = a.get("textPath.firstMargin").value_or(base->at("firstMargin").num());
  const bool reversed = flag("reversed", base->at("reversed").b());
  const bool perpendicular = flag("perpendicular", base->at("perpendicular").b());
  const bool forceAlignment = flag("forceAlignment", base->at("forceAlignment").is_bool() && base->at("forceAlignment").b());
  const std::optional<double> lm = a.get("textPath.lastMargin");
  const double lastMargin = lm ? *lm : num_or(base->at("lastMargin"), 0);
  // resolveTextPathMask: the node's stored masks (fx.mask.paths), by id or the first.
  const Json* fx = nullptr;
  for (const auto& c : n.components) {
    if (c.type == "fx") {
      fx = &c.props;
      break;
    }
  }
  if (fx == nullptr) return {};
  const Json& paths = fx->at("mask").at("paths");
  if (!paths.is_array() || paths.arr().empty()) return {};
  const std::string& pid = base->at("pathId").str();
  const Json* mask = nullptr;
  if (pid.empty()) {
    mask = &paths.arr()[0];
  } else {
    for (const Json& p : paths.arr()) {
      if (p.at("id").is_string() && p.at("id").str() == pid) {
        mask = &p;
        break;
      }
    }
  }
  if (mask == nullptr) return {};
  Json flat = flatten_mask_path(*mask);
  if (flat.at("pts").arr().size() < 2) return {};
  Json tp = Json::object();
  tp.set("points", flat.at("pts"));
  tp.set("closed", flat.at("closed"));
  tp.set("firstMargin", Json::number(firstMargin));
  tp.set("reversed", Json::boolean(reversed));
  tp.set("perpendicular", Json::boolean(perpendicular));
  if (forceAlignment) tp.set("forceAlignment", Json::boolean(true));
  if (lastMargin != 0 && !std::isnan(lastMargin)) tp.set("lastMargin", Json::number(lastMargin));
  return tp;
}

Json point_text_extras(const doc::Node& n) {
  // readTextExtrasProps.
  Json x = Json::object();
  for (const auto& c : n.components) {
    const Json& p = c.props;
    for (const char* k : {"leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter"}) {
      if (p.at(k).is_number() && std::isfinite(p.at(k).num())) x.set(k, p.at(k));
    }
    if (p.at("strokeLineJoin").is_string()) {
      const std::string& j = p.at("strokeLineJoin").str();
      if (j == "miter" || j == "round" || j == "bevel") x.set("strokeLineJoin", p.at("strokeLineJoin"));
    }
    if (p.at("strokeOrder").is_string()) x.set("strokeOrder", p.at("strokeOrder"));
    for (const char* k : {"fauxBold", "fauxItalic", "noFill", "noStroke"}) {
      if (p.at(k).is_bool()) x.set(k, p.at(k));
    }
    if (p.at("kerningMode").is_string() && (p.at("kerningMode").str() == "metrics" || p.at("kerningMode").str() == "optical")) {
      x.set("kerningMode", p.at("kerningMode"));
    }
    if (p.at("direction").is_string()) {
      const std::string& dir = p.at("direction").str();
      if (dir == "rtl" || dir == "auto") x.set("direction", p.at("direction"));
      else if (dir == "ltr") x.erase("direction");
    }
    // T3: the text's language ('auto' / absent = from its script).
    if (p.at("language").is_string()) {
      if (!p.at("language").str().empty() && p.at("language").str() != "auto") x.set("language", p.at("language"));
      else x.erase("language");
    }
    if (p.at("orientation").is_string() && p.at("orientation").str() == "vertical") x.set("orientation", Json::string("vertical"));
    else if (p.at("orientation").is_string() && p.at("orientation").str() == "horizontal") x.erase("orientation");
    // Standard Vertical Roman Alignment, auto tate-chu-yoko.
    if (p.at("verticalRomanAlignment").is_bool()) {
      if (p.at("verticalRomanAlignment").b()) x.set("verticalRomanAlignment", Json::boolean(true));
      else x.erase("verticalRomanAlignment");
    }
    if (p.at("tateChuYokoAuto").is_bool()) {
      if (p.at("tateChuYokoAuto").b()) {
        if (!x.at("tateChuYokoDigits").is_number()) x.set("tateChuYokoDigits", Json::number(2));  // TATE_CHU_YOKO_DEFAULT_DIGITS
      } else {
        x.erase("tateChuYokoDigits");
      }
    }
    if (x.at("tateChuYokoDigits").is_number() && p.at("tateChuYokoDigits").is_finite_number()) {
      x.set("tateChuYokoDigits", Json::number(std::max(1.0, std::min(4.0, std::floor(p.at("tateChuYokoDigits").num() + 0.5)))));
    }
  }
  // compactTextExtras.
  Json out = Json::object();
  for (const char* k : {"leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter"}) {
    if (x.at(k).is_number() && x.at(k).num() != 0) out.set(k, x.at(k));
  }
  if (x.at("strokeLineJoin").is_string() && x.at("strokeLineJoin").str() != "round") out.set("strokeLineJoin", x.at("strokeLineJoin"));
  if (x.at("strokeOrder").is_string() && !x.at("strokeOrder").str().empty()) out.set("strokeOrder", x.at("strokeOrder"));
  for (const char* k : {"fauxBold", "fauxItalic", "noFill", "noStroke"}) {
    if (x.at(k).is_bool() && x.at(k).b()) out.set(k, Json::boolean(true));
  }
  if (x.at("kerningMode").is_string() && x.at("kerningMode").str() == "optical") out.set("kerningMode", x.at("kerningMode"));
  if (x.at("direction").is_string()) out.set("direction", x.at("direction"));
  if (x.at("language").is_string()) out.set("language", x.at("language"));
  if (x.at("orientation").is_string()) {
    out.set("orientation", Json::string("vertical"));
    if (x.at("verticalRomanAlignment").b()) out.set("verticalRomanAlignment", Json::boolean(true));
    if (x.at("tateChuYokoDigits").is_number() && x.at("tateChuYokoDigits").num() >= 1) out.set("tateChuYokoDigits", x.at("tateChuYokoDigits"));
  }
  return out;
}

void with_text_more_options(Json& extras, const doc::Node& n, const Values& a) {
  // readTextMoreOptions.
  std::string grouping = "character";
  double alignX = 0;
  double alignY = 0;
  bool allAsOne = false;
  std::string blending = "normal";
  static constexpr std::array<std::string_view, 17> kBlends{
      "normal", "darken", "multiply", "color-burn", "add", "lighten", "screen", "color-dodge", "overlay",
      "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"};
  for (const auto& c : n.components) {
    if (c.type != "Text") continue;
    const Json& p = c.props;
    if (p.at("anchorGrouping").is_string()) {
      const std::string& g = p.at("anchorGrouping").str();
      if (g == "character" || g == "word" || g == "line" || g == "all") grouping = g;
    }
    if (p.at("groupingAlignX").is_finite_number()) alignX = p.at("groupingAlignX").num();
    if (p.at("groupingAlignY").is_finite_number()) alignY = p.at("groupingAlignY").num();
    if (p.at("fillStrokeMode").is_string() && p.at("fillStrokeMode").str() == "allAsOne") allAsOne = true;
    if (p.at("interCharacterBlending").is_string()) {
      const std::string& b = p.at("interCharacterBlending").str();
      if (b != "normal" && std::ranges::find(kBlends, b) != kBlends.end()) blending = b;
    }
  }
  const double ax = a.get("groupingAlignX").value_or(alignX);
  const double ay = a.get("groupingAlignY").value_or(alignY);
  if (grouping != "character") extras.set("anchorGrouping", Json::string(grouping));
  if (ax != 0 || ay != 0) {
    Json g = Json::array();
    g.arr_mut().push_back(Json::number(ax));
    g.arr_mut().push_back(Json::number(ay));
    extras.set("groupingAlign", std::move(g));
  }
  if (allAsOne) extras.set("fillStrokeMode", Json::string("allAsOne"));
  if (blending != "normal") extras.set("interCharacterBlending", Json::string(blending));
  for (const auto& c : n.components) {
    if (c.type != "Text") continue;
    const Json& p = c.props;
    // Background: a box behind the glyphs (whole block, or one per line).
    // Color, Opacity, Padding and Roundness are keyframeable: the track's value first.
    if (p.at("background").is_bool() && p.at("background").b()) {
      const auto num = [&p, &a](const char* k, double def, double lo, double hi) {
        const double v = a.get(k).value_or(p.at(k).is_finite_number() ? p.at(k).num() : def);
        return std::isfinite(v) ? std::clamp(v, lo, hi) : def;
      };
      Json bg = Json::object();
      if (a.has("backgroundColor_r")) {
        bg.set("color", Json::string(color_to_hex({a.get("backgroundColor_r").value_or(0), a.get("backgroundColor_g").value_or(0),
                                                   a.get("backgroundColor_b").value_or(0), a.get("backgroundColor_a").value_or(1)})));
      } else {
        bg.set("color", p.at("backgroundColor").is_string() ? p.at("backgroundColor") : Json::string("#000000"));
      }
      bg.set("opacity", Json::number(num("backgroundOpacity", 100, 0, 100) / 100));
      bg.set("padding", Json::number(num("backgroundPadding", 12, 0, 500)));
      bg.set("radius", Json::number(num("backgroundRadius", 0, 0, 1000)));
      if (p.at("backgroundMode").is_string() && p.at("backgroundMode").str() == "line") bg.set("mode", Json::string("line"));
      if (bg.at("opacity").num() > 0) extras.set("background", std::move(bg));
    }
    if (p.at("ligatures").is_bool() && !p.at("ligatures").b()) extras.set("ligatures", Json::boolean(false));
    if (p.at("discretionaryLigatures").is_bool() && p.at("discretionaryLigatures").b()) {
      extras.set("discretionaryLigatures", Json::boolean(true));
    }
    if (p.at("contextualAlternates").is_bool() && !p.at("contextualAlternates").b()) {
      extras.set("contextualAlternates", Json::boolean(false));
    }
    if (p.at("stylisticSets").is_array()) {
      std::vector<double> sets;
      for (const Json& v : p.at("stylisticSets").arr()) {
        const double x = v.is_number() ? v.num() : -1;
        if (x >= 1 && x <= 20 && std::floor(x) == x && std::ranges::find(sets, x) == sets.end()) sets.push_back(x);
      }
      std::ranges::sort(sets);
      if (!sets.empty()) {
        Json s = Json::array();
        for (const double x : sets) s.arr_mut().push_back(Json::number(x));
        extras.set("stylisticSets", std::move(s));
      }
    }
  }
}

Json text_stroke_paint(const doc::Node& n, const Values& a) {
  for (const auto& c : n.components) {
    if (c.type != "Text") continue;
    const Json& p = c.props.at("strokePaint");
    const std::string type = p.at("type").is_string() ? p.at("type").str() : "";
    if (!p.is_object() || (type != "linear" && type != "radial") || !p.at("stops").is_array() || p.at("stops").arr().empty()) {
      return {};
    }
    Json out = p;
    if (type == "linear") {
      if (const auto angle = a.get("strokeAngle")) out.set("angle", Json::number(*angle));
      return out;
    }
    const auto cx = a.get("strokeCenterX");
    const auto cy = a.get("strokeCenterY");
    const auto r = a.get("strokeRadius");
    if (cx) out.set("cx", Json::number(*cx));
    if (cy) out.set("cy", Json::number(*cy));
    if (r) out.set("radius", Json::number(*r));
    return out;
  }
  return {};
}

namespace {

/// lineBreak.ts alignIndicesToWrap: a CJK wrap INSERTS its soft breaks, so the
/// runs and the animator glyphs — indexed on the raw text — move onto the
/// wrapped text: runs shift past every inserted break, the glyphs gain an
/// identity '\n' at each. A wrap that only replaced spaces changes nothing.
void align_to_wrap(RLayer& l, const std::string& raw, const std::string& wrapped) {
  const bool runs = l.runs.is_array();
  const bool glyphs = l.glyphs.is_array();
  if (!(runs || glyphs) || wrapped.size() <= raw.size()) return;
  const std::vector<std::size_t> inserted =
      raster::inserted_break_indices(raster::split_graphemes(raw), raster::split_graphemes(wrapped));
  if (inserted.empty()) return;
  if (glyphs) {
    std::vector<Json> out = l.glyphs.arr();
    for (const std::size_t j : inserted) {
      const auto at = static_cast<std::ptrdiff_t>(std::min(j, out.size()));
      out.insert(out.begin() + at, identity_glyph("\n"));
    }
    Json a = Json::array();
    for (Json& g : out) a.arr_mut().push_back(std::move(g));
    l.glyphs = std::move(a);
  }
  if (runs) {
    Json a = Json::array();
    for (const Json& r : l.runs.arr()) {
      Json shifted = r;
      if (r.at("start").is_number() && r.at("end").is_number()) {
        const auto [start, end] = raster::shift_span_for_inserted_breaks(r.at("start").num(), r.at("end").num(), inserted);
        shifted.set("start", Json::number(start));
        shifted.set("end", Json::number(end));
      }
      a.arr_mut().push_back(std::move(shifted));
    }
    l.runs = std::move(a);
  }
}

}  // namespace

std::string paragraph_layer(RLayer& l, const doc::Node& n, TextMeasurer* measurer, const std::string& raw) {
  // wrappedLayerText: hasTextPath ? 0 : readNumProp(node, 'boxWidth').
  if (doc::read_text_path_config(n)) return {};
  std::optional<double> bw;
  for (const auto& c : n.components) {
    if (c.props.at("boxWidth").is_number()) {
      bw = c.props.at("boxWidth").num();
      break;
    }
  }
  if (!bw || !(*bw > 0)) return {};
  if (measurer == nullptr) return "paragraph text (no fonts)";
  auto style = read_measured_text_style(n, {{"boxWidth", *bw}});
  if (!style) return {};
  style->content = raw;
  std::string why;
  const auto wrapped = measurer->wrapped_style(*style, &why);
  if (!wrapped) return why.empty() ? "paragraph text (box wrapping)" : why;
  // Runs that change a line's size or leading: the painter stacks them itself
  // (stackLines); the box placement / fit / anchor read the same stack
  // (paragraph_line_stack).
  l.text = wrapped->content;
  align_to_wrap(l, raw, wrapped->content);
  // textExtrasForNode(node, style.softBreakLines, …).
  Json x = l.textExtras.is_object() ? l.textExtras : Json::object();
  std::string align;
  for (const auto& c : n.components) {
    if (c.props.at("align").is_string()) align = c.props.at("align").str();
  }
  const auto nz = [&x](const char* k) { return x.at(k).is_number() && x.at(k).num() != 0; };
  const bool needsLines = align.starts_with("justify") || nz("leftIndent") || nz("rightIndent") || nz("firstLineIndent") ||
                          nz("spaceBefore") || nz("spaceAfter") ||
                          (x.at("direction").is_string() && (x.at("direction").str() == "rtl" || x.at("direction").str() == "auto"));
  if (needsLines && wrapped->softBreakLines) {
    Json lines = Json::array();
    for (const int ln : *wrapped->softBreakLines) lines.arr_mut().push_back(Json::number(ln));
    x.set("softBreakLines", std::move(lines));
  }
  // readParagraphBox(node) — no overrides here, as textExtrasForNode reads it.
  const auto box = read_measured_text_style(n, {});
  if (box && box->boxHeight) {
    x.set("boxHeight", Json::number(*box->boxHeight));
    if (!box->boxVerticalAlign.empty()) x.set("boxVerticalAlign", Json::string(box->boxVerticalAlign));
    // Fit Text to Box: the painter draws the wrap scaled by the fit (compactTextExtras: 0 < k < 1).
    if (box->boxFit && wrapped->fitScale && *wrapped->fitScale > 0 && *wrapped->fitScale < 1) {
      x.set("fitScale", Json::number(*wrapped->fitScale));
    }
  } else if (box && box->boxAnchorHeight) {
    // An auto-height box with an authored height keeps its TOP edge: the centred
    // line block moves down by half of what it grew (measureParagraphBox
    // lineOffsetY → textExtras.boxOffsetY; compactTextExtras drops ~0).
    const double contentHeight = paragraph_line_stack(*wrapped).blockHeight;
    const double off = (contentHeight - *box->boxAnchorHeight) / 2;
    if (std::isfinite(off) && std::abs(off) > 1e-6) x.set("boxOffsetY", Json::number(off));
  }
  if (!x.obj().empty()) l.textExtras = std::move(x);
  return {};
}

double text_raster_padding(const RLayer& l, double bakedSpread) {
  constexpr double kMaxGlyphPad = 512;
  const double em = l.fontSize;
  // glyphSpread.
  double glyph = 0;
  if (l.glyphs.is_array()) {
    const bool grouped = l.textExtras.is_object() && ((l.textExtras.at("anchorGrouping").is_string() &&
                                                       !l.textExtras.at("anchorGrouping").str().empty()) ||
                                                      l.textExtras.at("groupingAlign").b());
    const double groupReach = std::max(l.width, l.height) / 2;
    constexpr double kDeg = std::numbers::pi / 180;
    for (const Json& g : l.glyphs.arr()) {
      const auto n = [&g](const char* k) { return g.at(k).is_number() ? g.at(k).num() : 0.0; };
      double d = std::max(std::fabs(n("dx")), std::fabs(n("dy")) + std::fabs(n("lineSpacing")));
      const double grow = std::max(n("scale"), n("scaleY")) - 1;
      if (grow > 0) d += (grow * em) / 2;
      d += std::max(n("blur"), n("blurY")) * 2 + n("strokeWidth") / 2;
      if (n("skew") != 0) d += std::fabs(std::tan((n("skew") * std::numbers::pi) / 180)) * em * 0.5;
      if (n("anchorX") != 0 || n("anchorY") != 0) d += std::max(std::fabs(n("anchorX")), std::fabs(n("anchorY")));
      if (grouped && n("rotation") != 0) d += std::fabs(std::sin(n("rotation") * kDeg)) * groupReach;
      glyph = std::max(glyph, d);
    }
  }
  // textPathSpread.
  double path = 0;
  if (l.textPath.is_object() && l.textPath.at("points").is_array() && !l.textPath.at("points").arr().empty()) {
    const double halfW = l.width / 2;
    const double halfH = l.height / 2;
    double spread = 0;
    for (const Json& p : l.textPath.at("points").arr()) {
      spread = std::max({spread, std::fabs(p.at("x").num()) - halfW, std::fabs(p.at("y").num()) - halfH});
    }
    path = spread > 0 ? spread + em : 0;
  }
  // The background box reaches its padding past the text box.
  const double background = l.textExtras.is_object() && l.textExtras.at("background").is_object()
                                ? l.textExtras.at("background").at("padding").num()
                                : 0;
  // rasterPadding: the baked-effect bleed, widened by the text's own escape.
  double pad = bakedSpread;
  const double escape = std::min(kMaxGlyphPad, std::max({glyph, path, background}));
  if (escape > pad) pad = escape;
  return pad > 0 ? std::min(kMaxGlyphPad, std::ceil(pad + 1)) : 0;
}

// ── text animators (textAnimators.ts + textSelectors.ts) ─────────────────────

namespace {

constexpr std::array<const char*, 13> kSelectorParams{"start", "end", "offset", "amount", "smoothness", "easeHigh", "easeLow",
                                                      "maxAmount", "minAmount", "wigglesPerSecond", "correlation",
                                                      "temporalPhase", "spatialPhase"};

/// textSelectors.ts defaultSelector(kind) (ids omitted: nothing reads them).
Json default_selector(std::string_view kind) {
  Json s = Json::object();
  if (kind == "wiggly") {
    s.set("kind", Json::string("wiggly"));
    s.set("basedOn", Json::string("characters"));
    s.set("mode", Json::string("intersect"));
    s.set("maxAmount", Json::number(100));
    s.set("minAmount", Json::number(-100));
    s.set("wigglesPerSecond", Json::number(2));
    s.set("correlation", Json::number(50));
    s.set("temporalPhase", Json::number(0));
    s.set("spatialPhase", Json::number(0));
    s.set("lockDimensions", Json::boolean(false));
    s.set("randomSeed", Json::number(0));
  } else if (kind == "expression") {
    s.set("kind", Json::string("expression"));
    s.set("basedOn", Json::string("characters"));
    s.set("mode", Json::string("intersect"));
    s.set("amount", Json::number(100));
    s.set("expression", Json::string("selectorValue"));
  } else {
    s.set("kind", Json::string("range"));
    s.set("basedOn", Json::string("characters"));
    s.set("units", Json::string("percentage"));
    s.set("mode", Json::string("add"));
    s.set("start", Json::number(0));
    s.set("end", Json::number(100));
    s.set("offset", Json::number(0));
    s.set("amount", Json::number(100));
    s.set("shape", Json::string("square"));
    s.set("smoothness", Json::number(100));
    s.set("easeHigh", Json::number(0));
    s.set("easeLow", Json::number(0));
    s.set("randomizeOrder", Json::boolean(false));
    s.set("randomSeed", Json::number(0));
  }
  return s;
}

/// `{ ...base, ...patch }`.
Json spread(Json base, const Json& patch) {
  if (patch.is_object()) {
    for (const auto& m : patch.obj()) base.set(m.key, m.value);
  }
  return base;
}

/// `x ?? fb` for a stored member.
Json or_num(const Json& v, double fb) { return v.is_undefined() || v.is_null() ? Json::number(fb) : v; }

/// normalizeSelector.
Json normalize_selector(const Json& s) {
  const std::string kind = s.at("kind").is_string() ? s.at("kind").str() : "range";
  Json out = spread(default_selector(kind), s);
  out.set("kind", Json::string(kind));
  return out;
}

/// legacySelector: the single inline selector an old animator carried.
Json legacy_selector(const Json& d) {
  const auto str_or = [&d](const char* k, const char* fb) {
    return d.at(k).is_undefined() || d.at(k).is_null() ? Json::string(fb) : d.at(k);
  };
  if (d.at("mode").is_string() && d.at("mode").str() == "wiggly") {
    Json s = default_selector("wiggly");
    s.set("basedOn", str_or("basedOn", "characters"));
    s.set("wigglesPerSecond", or_num(d.at("wiggleFreq"), 2));
    s.set("mode", Json::string("intersect"));
    return s;
  }
  Json s = default_selector("range");
  s.set("basedOn", str_or("basedOn", "characters"));
  s.set("shape", str_or("shape", "square"));
  s.set("start", or_num(d.at("start"), 0));
  s.set("end", or_num(d.at("end"), 100));
  s.set("offset", or_num(d.at("offset"), 0));
  s.set("smoothness", Json::number(0));
  return s;
}

double jnum(const Json& v, double fb) { return v.is_number() ? v.num() : fb; }
double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/// `/\s/.test(cluster)`.
bool is_ws_cluster(std::string_view c) { return !c.empty() && raster::is_js_blank(c); }

struct UnitMap {
  int count = 0;
  std::vector<int> unitOfChar;
};

/// unitPositions(text, basedOn) over the grapheme clusters.
UnitMap unit_positions(const std::vector<std::string>& chars, std::string_view basedOn) {
  UnitMap m;
  if (basedOn == "characters") {
    m.count = static_cast<int>(chars.size());
    for (std::size_t i = 0; i < chars.size(); ++i) m.unitOfChar.push_back(static_cast<int>(i));
    return m;
  }
  if (basedOn == "charactersExcludingSpaces") {
    int unit = 0;
    for (const auto& c : chars) m.unitOfChar.push_back(is_ws_cluster(c) ? -1 : unit++);
    m.count = unit;
    return m;
  }
  if (basedOn == "lines") {
    int unit = 0;
    for (const auto& c : chars) {
      m.unitOfChar.push_back(unit);
      if (c == "\n") ++unit;
    }
    m.count = unit + 1;
    return m;
  }
  int wordIdx = -1;
  bool prevSpace = true;
  for (const auto& c : chars) {
    const bool space = is_ws_cluster(c);
    if (!space && prevSpace) ++wordIdx;
    m.unitOfChar.push_back(wordIdx < 0 ? 0 : wordIdx);
    prevSpace = space;
  }
  m.count = wordIdx < 0 ? std::max(1, static_cast<int>(chars.size())) : wordIdx + 1;
  return m;
}

/// textSelectors.ts hash01, in JavaScript number semantics (double products,
/// ToInt32 / ToUint32 at the bit operators).
double hash01(double a, double b) {
  double n = (static_cast<double>(motion::js::to_int32(a)) + 1) * 374761393.0 +
             (static_cast<double>(motion::js::to_int32(b)) + 1) * 668265263.0;
  // `^` works on the 32-bit patterns, where ToInt32 and ToUint32 agree: XOR the
  // unsigned patterns and reinterpret (modular since C++20) where the JS reads a signed result.
  std::uint32_t u = motion::js::to_uint32(n);
  n = static_cast<double>(static_cast<std::int32_t>(u ^ (u >> 13U))) * 1274126177.0;
  u = motion::js::to_uint32(n);
  return static_cast<double>(u ^ (u >> 16U)) / 4294967296.0;
}

/// orderPermutation(count, seed): Fisher-Yates on hash01.
std::vector<int> order_permutation(int count, double seed) {
  std::vector<int> perm(static_cast<std::size_t>(std::max(0, count)));
  for (std::size_t i = 0; i < perm.size(); ++i) perm[i] = static_cast<int>(i);
  for (int i = static_cast<int>(perm.size()) - 1; i > 0; --i) {
    const auto j = static_cast<std::size_t>(std::floor(hash01(i, seed) * (i + 1)));
    std::swap(perm[static_cast<std::size_t>(i)], perm[j]);
  }
  return perm;
}

double shape_falloff(double t, std::string_view shape) {
  const double u = clamp01(t);
  if (shape == "rampUp") return u;
  if (shape == "rampDown") return 1 - u;
  if (shape == "triangle") return 1 - std::fabs(2 * u - 1);
  if (shape == "round") return std::sqrt(std::max(0.0, 1 - std::pow(2 * u - 1, 2)));
  if (shape == "smooth") {
    const double tri = 1 - std::fabs(2 * u - 1);
    return tri * tri * (3 - 2 * tri);
  }
  return 1;
}

double apply_ease(double v, double easeHigh, double easeLow) {
  const double el = std::clamp(easeLow / 100, -1.0, 1.0);
  const double eh = std::clamp(easeHigh / 100, -1.0, 1.0);
  if (el == 0 && eh == 0) return clamp01(v);
  const double x1 = 1.0 / 3 + el / 3;
  const double y1 = 1.0 / 3 - el / 3;
  const double x2 = 2.0 / 3 - eh / 3;
  const double y2 = 2.0 / 3 + eh / 3;
  return clamp01(motion::eval::cubic_bezier_ease(x1, y1, x2, y2, clamp01(v)));
}

double soft_window(double centre, double lo, double hi, double edge) {
  if (hi <= lo) return 0;
  if (edge <= 0) return centre >= lo && centre <= hi ? 1 : 0;
  const double rise = clamp01((centre - lo) / edge + 0.5);
  const double fall = clamp01((hi - centre) / edge + 0.5);
  return std::min(rise, fall);
}

double range_selector_at(const Json& sel, int unit, int count) {
  if (count <= 0 || unit < 0) return 0;
  int effUnit = unit;
  if (sel.at("randomizeOrder").b()) {
    const auto perm = order_permutation(count, jnum(sel.at("randomSeed"), 0));
    if (static_cast<std::size_t>(unit) < perm.size()) effUnit = perm[static_cast<std::size_t>(unit)];
  }
  const double centre = effUnit + 0.5;
  const bool index = sel.at("units").is_string() && sel.at("units").str() == "index";
  const auto to_units = [&](double v) { return index ? v : (v / 100) * count; };
  const double off = to_units(jnum(sel.at("offset"), 0));
  const double a = to_units(jnum(sel.at("start"), 0)) + off;
  const double b = to_units(jnum(sel.at("end"), 100)) + off;
  const double lo = std::min(a, b);
  const double hi = std::max(a, b);
  const std::string shape = sel.at("shape").is_string() ? sel.at("shape").str() : "square";
  const bool rampUp = shape == "rampUp";
  // AE: Ramp Up holds full strength past the window's end (Ramp Down before
  // its start), so offset −100 → 100 on a Ramp Up sweeps the whole text.
  const bool ramp = rampUp || shape == "rampDown";
  if (hi <= lo && !ramp) return 0;
  double w = 0;
  if (ramp && (hi <= lo || centre < lo || centre > hi)) {
    w = (centre > hi || (hi <= lo && centre >= hi)) == rampUp ? 1 : 0;
  } else if (shape == "square") {
    w = soft_window(centre, lo, hi, std::max(0.0, jnum(sel.at("smoothness"), 100)) / 100);
  } else {
    if (centre < lo || centre > hi) return 0;
    w = shape_falloff((centre - lo) / (hi - lo), shape);
  }
  w = apply_ease(w, jnum(sel.at("easeHigh"), 0), jnum(sel.at("easeLow"), 0));
  return w * (jnum(sel.at("amount"), 100) / 100);
}

double smooth_noise(double unit, double ts, double channel) {
  const double i = std::floor(ts);
  const double f = ts - i;
  const double s = f * f * (3 - 2 * f);
  const double a = hash01(unit * 2654435761.0 + channel * 40503, i);
  const double b = hash01(unit * 2654435761.0 + channel * 40503, i + 1);
  return a + (b - a) * s;
}

double wiggly_selector_at(const Json& sel, int unit, double time, int channel) {
  if (unit < 0) return 0;
  const double freq = std::max(0.001, jnum(sel.at("wigglesPerSecond"), 2));
  const double ts = time * freq + jnum(sel.at("temporalPhase"), 0) / 360;
  const double spatial = unit + jnum(sel.at("spatialPhase"), 0) / 360;
  const double seed = jnum(sel.at("randomSeed"), 0);
  const double own = smooth_noise(spatial + seed * 977, ts, channel);
  const double shared = smooth_noise(seed * 977, ts, channel);
  const double corr = clamp01(jnum(sel.at("correlation"), 50) / 100);
  const double n = own + (shared - own) * corr;
  const double lo = jnum(sel.at("minAmount"), -100) / 100;
  const double hi = jnum(sel.at("maxAmount"), 100) / 100;
  return lo + (hi - lo) * n;
}

double combine(double acc, double v, std::string_view mode) {
  if (mode == "subtract") return acc - v;
  if (mode == "intersect") return acc * v;
  if (mode == "min") return std::min(acc, v);
  if (mode == "max") return std::max(acc, v);
  if (mode == "difference") return std::fabs(acc - v);
  return acc + v;
}

/// selectorPropPath (selector 0 keeps the legacy flat paths).
std::string selector_prop_path(std::size_t index, std::size_t sel, std::string_view param) {
  const std::string i = std::to_string(index);
  if (sel == 0) {
    if (param == "start" || param == "end" || param == "offset") return "ta." + i + "." + std::string(param);
    if (param == "wigglesPerSecond") return "ta." + i + ".wiggleFreq";
  }
  return "ta." + i + ".s" + std::to_string(sel) + "." + std::string(param);
}

/// applyOptionalProperties' `add`: only when the animator carries a non-zero value.
void set_opt_sum(Json& g, const char* key, const Json& v, double w) {
  if (!v.is_number() || v.num() == 0) return;
  g.set(key, Json::number(jnum(g.at(key), 0) + v.num() * w));
}

}  // namespace

std::vector<Json> resolve_text_animators(const doc::Node& n, const Values& a) {
  const doc::Component* t = n.comp("Text");
  if (t == nullptr) return {};
  return resolve_text_animators_json(t->props.at("__animators"), a);
}

std::vector<Json> resolve_text_animators_json(const Json& stored, const Values& a) {
  std::vector<Json> out;
  if (!stored.is_array()) return out;
  std::size_t i = 0;
  for (const Json& raw : stored.arr()) {
    const Json d = raw.is_object() ? raw : Json::object();
    const std::string pre = "ta." + std::to_string(i) + ".";
    const auto val = [&](const char* param, double fb) { return a.get(pre + param).value_or(fb); };
    Json r = Json::object();
    // Optional properties: resolved only when the animator carries them.
    for (const char* p : {"anchorX", "anchorY", "anchorZ", "skewAxis", "lineAnchor", "characterValue", "fillHue",
                          "fillSaturation", "fillBrightness", "strokeOpacity", "strokeHue", "strokeSaturation",
                          "strokeBrightness"}) {
      if (!d.at(p).is_undefined() && !d.at(p).is_null()) r.set(p, Json::number(val(p, jnum(d.at(p), 0))));
    }
    if (d.at("characterRange").is_string() && !d.at("characterRange").str().empty()) r.set("characterRange", d.at("characterRange"));
    if (d.at("trackingType").is_string() && !d.at("trackingType").str().empty()) r.set("trackingType", d.at("trackingType"));
    // Font Axis properties: the stored offsets, a keyed `ta.<i>.axis<TAG>` value winning.
    if (d.at("axes").is_object()) {
      Json axes = Json::object();
      for (const auto& m : d.at("axes").obj()) {
        if (!doc::is_axis_tag(m.key) || !m.value.is_number()) continue;
        axes.set(m.key, Json::number(val((std::string("axis") + m.key).c_str(), m.value.num())));
      }
      if (!axes.obj().empty()) r.set("axes", std::move(axes));
    }
    r.set("enabled", Json::boolean(!(d.at("enabled").is_bool() && !d.at("enabled").b())));
    // normalizeAnimator's selector stack, then resolveSelector.
    std::vector<Json> sels;
    if (d.at("selectors").is_array() && !d.at("selectors").arr().empty()) {
      for (const Json& s : d.at("selectors").arr()) sels.push_back(normalize_selector(s));
    } else {
      sels.push_back(legacy_selector(d));
    }
    Json selArr = Json::array();
    for (std::size_t j = 0; j < sels.size(); ++j) {
      Json s = sels[j];
      for (const char* p : kSelectorParams) {
        if (!s.has(p)) continue;
        if (const auto v = a.get(selector_prop_path(i, j, p))) s.set(p, Json::number(*v));
      }
      selArr.arr_mut().push_back(std::move(s));
    }
    r.set("selectors", std::move(selArr));
    const double scale = jnum(d.at("scale"), 100);
    r.set("x", Json::number(val("x", jnum(d.at("x"), 0))));
    r.set("y", Json::number(val("y", jnum(d.at("y"), 0))));
    r.set("z", Json::number(val("z", jnum(d.at("z"), 0))));
    r.set("scale", Json::number(val("scale", scale)));
    r.set("scaleY", Json::number(val("scaleY", jnum(d.at("scaleY"), scale))));
    r.set("rotation", Json::number(val("rotation", jnum(d.at("rotation"), 0))));
    r.set("rotationX", Json::number(val("rotationX", jnum(d.at("rotationX"), 0))));
    r.set("rotationY", Json::number(val("rotationY", jnum(d.at("rotationY"), 0))));
    r.set("opacity", Json::number(val("opacity", jnum(d.at("opacity"), 100))));
    r.set("fillOpacity", Json::number(val("fillOpacity", jnum(d.at("fillOpacity"), 100))));
    r.set("tracking", Json::number(val("tracking", jnum(d.at("tracking"), 0))));
    r.set("lineSpacing", Json::number(val("lineSpacing", jnum(d.at("lineSpacing"), 0))));
    r.set("characterOffset", Json::number(val("characterOffset", jnum(d.at("characterOffset"), 0))));
    const double blur = jnum(d.at("blur"), 0);
    r.set("blur", Json::number(val("blur", blur)));
    if (!d.at("blurY").is_undefined() || a.get(pre + "blurY")) r.set("blurY", Json::number(val("blurY", jnum(d.at("blurY"), blur))));
    r.set("skew", Json::number(val("skew", jnum(d.at("skew"), 0))));
    r.set("strokeWidth", Json::number(val("strokeWidth", jnum(d.at("strokeWidth"), 0))));
    if (d.at("color").is_string()) r.set("color", d.at("color"));
    if (d.at("strokeColor").is_string()) r.set("strokeColor", d.at("strokeColor"));
    out.push_back(std::move(r));
    ++i;
  }
  return out;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity) — evaluateTextAnimators, statement for statement
Json evaluate_text_animators(std::string_view text, const std::vector<Json>& animators, double time, std::string* why) {
  const std::vector<std::string> chars = raster::split_graphemes(text);
  std::vector<Json> glyphs;
  glyphs.reserve(chars.size());
  for (const auto& ch : chars) glyphs.push_back(identity_glyph(ch));
  std::map<std::string, UnitMap, std::less<>> units;
  const auto units_for = [&](const std::string& basedOn) -> const UnitMap& {
    auto it = units.find(basedOn);
    if (it == units.end()) it = units.emplace(basedOn, unit_positions(chars, basedOn)).first;
    return it->second;
  };
  if (why != nullptr) why->clear();  // every animator feature evaluates here
  std::vector<double> charShift(chars.size(), 0);
  // Character Value replaces (last affecting animator wins); Character Range
  // decides how the accumulated offset then walks.
  std::vector<std::optional<double>> charValue(chars.size());
  std::vector<std::string> charRange(chars.size());
  for (const Json& a : animators) {
    if (!a.at("enabled").b()) continue;
    std::vector<const Json*> active;
    for (const Json& s : a.at("selectors").arr()) {
      if (!(s.at("enabled").is_bool() && !s.at("enabled").b())) active.push_back(&s);
    }
    for (std::size_t i = 0; i < chars.size(); ++i) {
      Json& g = glyphs[i];
      if (a.has("lineAnchor")) g.set("lineAnchor", Json::number(clamp01(a.at("lineAnchor").num() / 100)));
      // evaluateSelectors.
      double wx = 1;
      double wy = 1;
      if (!active.empty()) {
        double accX = 0;
        double accY = 0;
        bool started = false;
        for (const Json* sp : active) {
          const Json& sel = *sp;
          const std::string basedOn = sel.at("basedOn").is_string() ? sel.at("basedOn").str() : "characters";
          const UnitMap& map = units_for(basedOn);
          const int unit = i < map.unitOfChar.size() ? map.unitOfChar[i] : -1;
          const std::string& kind = sel.at("kind").str();
          double vx = 0;
          double vy = 0;
          if (kind == "range") {
            vx = vy = range_selector_at(sel, unit, map.count);
          } else if (kind == "wiggly") {
            vx = wiggly_selector_at(sel, unit, time, 0);
            vy = sel.at("lockDimensions").b() ? vx : wiggly_selector_at(sel, unit, time, 1);
          } else {
            // The expression sees the stack so far as `selectorValue`, which is how
            // AE's Text Bounce and Inch Worm presets shape an incoming range.
            vx = vy = expression_selector_at(sel, unit, map.count, time, started ? accX : 1);
          }
          const std::string mode = sel.at("mode").is_string() ? sel.at("mode").str() : "add";
          if (!started) {
            accX = vx;
            accY = vy;
            started = true;
          } else {
            accX = combine(accX, vx, mode);
            accY = combine(accY, vy, mode);
          }
        }
        wx = clamp01(accX);
        wy = clamp01(accY);
      }
      if (wx <= 0 && wy <= 0) continue;
      if (a.at("characterValue").is_number() && wx >= 0.5) charValue[i] = a.at("characterValue").num();
      if (a.at("characterRange").is_string() && a.at("characterOffset").num() != 0) charRange[i] = a.at("characterRange").str();
      // applyOptionalProperties.
      set_opt_sum(g, "anchorX", a.at("anchorX"), wx);
      set_opt_sum(g, "anchorY", a.at("anchorY"), wy);
      set_opt_sum(g, "anchorZ", a.at("anchorZ"), wx);
      set_opt_sum(g, "skewAxis", a.at("skewAxis"), wx);
      for (const char* k : {"fillHue", "fillSaturation", "fillBrightness", "strokeHue", "strokeSaturation", "strokeBrightness"}) {
        set_opt_sum(g, k, a.at(k), wx);
      }
      if (a.at("strokeOpacity").is_number() && a.at("strokeOpacity").num() != 100) {
        g.set("strokeOpacity", Json::number(jnum(g.at("strokeOpacity"), 1) * (1 + (a.at("strokeOpacity").num() / 100 - 1) * wx)));
      }
      const double tracking = a.at("tracking").num();
      if (tracking != 0 && a.at("trackingType").is_string() &&
          (a.at("trackingType").str() == "before" || a.at("trackingType").str() == "beforeAfter")) {
        const double tt = tracking * wx;
        g.set("trackingBefore",
              Json::number(jnum(g.at("trackingBefore"), 0) + (a.at("trackingType").str() == "before" ? tt : tt / 2)));
      }
      // Font Axis properties: per-glyph variation offsets, summed under the selector.
      if (a.at("axes").is_object()) {
        for (const auto& m : a.at("axes").obj()) {
          if (!doc::is_axis_tag(m.key) || !m.value.is_finite_number() || m.value.num() == 0) continue;
          Json ax = g.at("axes").is_object() ? g.at("axes") : Json::object();
          ax.set(m.key, Json::number(jnum(ax.at(m.key), 0) + m.value.num() * wx));
          g.set("axes", std::move(ax));
        }
      }
      const auto add = [&g](const char* k, double v) { g.set(k, Json::number(g.at(k).num() + v)); };
      add("dx", a.at("x").num() * wx);
      add("dy", a.at("y").num() * wy);
      if (a.at("z").num() != 0) g.set("dz", Json::number(jnum(g.at("dz"), 0) + a.at("z").num() * wx));
      if (a.at("rotationX").num() != 0) g.set("rotationX", Json::number(jnum(g.at("rotationX"), 0) + a.at("rotationX").num() * wx));
      if (a.at("rotationY").num() != 0) g.set("rotationY", Json::number(jnum(g.at("rotationY"), 0) + a.at("rotationY").num() * wy));
      add("rotation", a.at("rotation").num() * wx);
      add("tracking", tracking * wx);
      add("lineSpacing", a.at("lineSpacing").num() * wy);
      add("skew", a.at("skew").num() * wx);
      {
        const double aBlurY = a.has("blurY") ? a.at("blurY").num() : a.at("blur").num();
        if (aBlurY != a.at("blur").num() || g.has("blurY")) {
          g.set("blurY", Json::number((g.has("blurY") ? g.at("blurY").num() : g.at("blur").num()) + aBlurY * wy));
        }
      }
      add("blur", a.at("blur").num() * wx);
      add("strokeWidth", a.at("strokeWidth").num() * wx);
      charShift[i] += a.at("characterOffset").num() * wx;
      g.set("scale", Json::number(g.at("scale").num() * (1 + (a.at("scale").num() / 100 - 1) * wx)));
      g.set("scaleY", Json::number(g.at("scaleY").num() * (1 + (a.at("scaleY").num() / 100 - 1) * wy)));
      g.set("opacity", Json::number(g.at("opacity").num() * (1 + (a.at("opacity").num() / 100 - 1) * wx)));
      g.set("fillOpacity", Json::number(g.at("fillOpacity").num() * (1 + (a.at("fillOpacity").num() / 100 - 1) * wx)));
      if (a.at("color").is_string() && !a.at("color").str().empty()) {
        g.set("color", a.at("color"));
        g.set("colorMix", Json::number(std::max(jnum(g.at("colorMix"), 0), clamp01(wx))));
      }
      if (a.at("strokeColor").is_string() && !a.at("strokeColor").str().empty()) {
        g.set("strokeColor", a.at("strokeColor"));
        g.set("strokeColorMix", Json::number(std::max(jnum(g.at("strokeColorMix"), 0), clamp01(wx))));
      }
    }
  }
  // Value first, then the offset walks from the replaced character — AE's
  // order, so a Character Value + Character Offset pair counts up from it.
  for (std::size_t i = 0; i < glyphs.size(); ++i) {
    const std::string& ch = chars[i];
    std::string from = ch;
    if (charValue[i]) {
      if (const auto replaced = character_from_value(*charValue[i])) from = *replaced;
    }
    const auto shift = static_cast<long long>(std::floor(charShift[i] + 0.5));  // Math.round
    const std::string walked = shift == 0 ? from : charRange[i] == "full" ? offset_character_full(from, shift) : offset_character(from, shift);
    if (walked != ch) glyphs[i].set("displayChar", Json::string(walked));
  }
  Json out = Json::array();
  for (Json& g : glyphs) out.arr_mut().push_back(std::move(g));
  return out;
}

}  // namespace premation::scene
