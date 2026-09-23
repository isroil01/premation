// textPaint.ts paintTextInBox, ported call for call onto the C++ Canvas2D.
//
// Parity notes (what the TS depends on that is not in the spec):
//   * Alias FontFaces (fontFaceVariants.ts) load asynchronously in the TS; the
//     render-tests harness renders with none loaded (the raster key's `fv0`).
//     This port draws as if no alias exists — font features and variation
//     axes a loaded alias would add are the documented follow-up.
//   * `ctx.fontVariationSettings` is not a Chromium canvas property; the TS
//     assignment is inert, so it is not replayed here either.

#include "text_paint.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <ranges>
#include <utility>

#include "numconv.hpp"
#include "optical_kerning.hpp"
#include "paint_common.hpp"
#include "text_layout.hpp"
#include "text_unicode.hpp"

namespace premation::raster {
namespace {

using json::Value;

std::string num_str(double v) { return motion::js::number_to_string(v); }

// ── cssColor.ts ──────────────────────────────────────────────────────────────

struct Rgba4 {
  double r = 0, g = 0, b = 0, a = 1;
};
double c255(double n) { return std::max(0.0, std::min(255.0, js_round(n))); }

std::optional<Rgba4> parse_css_color(const std::optional<std::string>& in) {
  if (!in) return std::nullopt;
  std::string s = *in;
  while (!s.empty() && s.front() == ' ') s.erase(s.begin());
  while (!s.empty() && s.back() == ' ') s.pop_back();
  if (s.empty()) return std::nullopt;
  const auto hexBody = [](std::string_view body) -> std::optional<Rgba4> {
    for (const char ch : body) {
      if (!std::isxdigit(static_cast<unsigned char>(ch))) return std::nullopt;
    }
    const auto hv = [](char ch) { return std::isdigit(static_cast<unsigned char>(ch)) ? ch - '0' : (std::tolower(static_cast<unsigned char>(ch)) - 'a' + 10); };
    if (body.size() == 3 || body.size() == 4) {
      Rgba4 o{static_cast<double>(hv(body[0]) * 17), static_cast<double>(hv(body[1]) * 17), static_cast<double>(hv(body[2]) * 17), 1};
      if (body.size() == 4) o.a = hv(body[3]) * 17 / 255.0;
      return o;
    }
    if (body.size() == 6 || body.size() == 8) {
      const auto n = [&](std::size_t i) { return static_cast<double>(hv(body[i]) * 16 + hv(body[i + 1])); };
      Rgba4 o{n(0), n(2), n(4), 1};
      if (body.size() == 8) o.a = n(6) / 255.0;
      return o;
    }
    return std::nullopt;
  };
  if (s[0] == '#') return hexBody(std::string_view(s).substr(1));
  if (s.size() == 6 && std::ranges::all_of(s, [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; })) return hexBody(s);
  std::string low = s;
  for (char& ch : low) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (low.starts_with("rgb")) {
    const auto c = css::parse_color(low);
    if (!c) return std::nullopt;
    return Rgba4{c->r, c->g, c->b, c->a};
  }
  if (low == "black") return Rgba4{0, 0, 0, 1};
  if (low == "white") return Rgba4{255, 255, 255, 1};
  if (low == "red") return Rgba4{255, 0, 0, 1};
  if (low == "green") return Rgba4{0, 128, 0, 1};
  if (low == "blue") return Rgba4{0, 0, 255, 1};
  if (low == "yellow") return Rgba4{255, 255, 0, 1};
  if (low == "transparent") return Rgba4{0, 0, 0, 0};
  // normaliseViaCanvas: any other CSS colour the canvas accepts.
  const auto c = css::parse_color(low);
  if (!c) return std::nullopt;
  return Rgba4{c->r, c->g, c->b, c->a};
}

std::string hex2(double n) {
  std::array<char, 4> b{};
  std::snprintf(b.data(), b.size(), "%02x", static_cast<unsigned>(c255(n)));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return {b.data()};
}

std::string format_css_color(const Rgba4& c) {
  if (c.a >= 1) return "#" + hex2(c.r) + hex2(c.g) + hex2(c.b);
  return "rgba(" + num_str(c255(c.r)) + ", " + num_str(c255(c.g)) + ", " + num_str(c255(c.b)) + ", " +
         num_str(js_round(clamp01(c.a) * 1000) / 1000) + ")";
}

std::string to_canvas_color(const std::optional<std::string>& c, const std::string& fallback) {
  const auto p = parse_css_color(c);
  return p ? format_css_color(*p) : fallback;
}

std::string mix_css_colors(const std::optional<std::string>& a, const std::optional<std::string>& b, double mix) {
  const auto pa = parse_css_color(a);
  const auto pb = parse_css_color(b);
  if (!pb) return pa ? format_css_color(*pa) : "#ffffff";
  if (!pa) return format_css_color(*pb);
  const double m = clamp01(std::isfinite(mix) ? mix : 1);
  const auto ch = [m](double x, double y) { return x + (y - x) * m; };
  return format_css_color({js_round(ch(pa->r, pb->r)), js_round(ch(pa->g, pb->g)), js_round(ch(pa->b, pb->b)), ch(pa->a, pb->a)});
}

std::string adjust_hsb(const std::string& color, double hueDeg, double satPct, double brightPct) {
  const auto p = parse_css_color(color);
  if (!p || (hueDeg == 0 && satPct == 0 && brightPct == 0)) return color;
  const double r = p->r / 255;
  const double g = p->g / 255;
  const double b = p->b / 255;
  const double mx = std::max({r, g, b});
  const double mn = std::min({r, g, b});
  const double d = mx - mn;
  double h = 0;
  if (d > 0) {
    if (mx == r) h = std::fmod((g - b) / d, 6);
    else if (mx == g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const double s0 = mx == 0 ? 0 : d / mx;
  h = std::fmod(std::fmod(h + hueDeg, 360) + 360, 360);
  const double s = clamp01(s0 + satPct / 100);
  const double v = clamp01(mx + brightPct / 100);
  const double c = v * s;
  const double x = c * (1 - std::fabs(std::fmod(h / 60, 2) - 1));
  const double m = v - c;
  double r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return format_css_color({js_round((r1 + m) * 255), js_round((g1 + m) * 255), js_round((b1 + m) * 255), p->a});
}

// ── fonts ────────────────────────────────────────────────────────────────────

/// AppTextureProvider textCssFont.
std::string text_css_font(const TextStyle& s) {
  const std::string style = s.fontStyle && *s.fontStyle == "italic" ? "italic " : "";
  return style + s.fontWeight.value_or("600") + " " + num_str(s.fontSize) + "px \"" + s.fontFamily.value_or("Inter") +
         "\", Inter, system-ui, sans-serif";
}

std::string font_for(const TextStyle& s) {
  std::string css = text_css_font(s);
  if (s.smallCaps) css = css.starts_with("italic ") ? "italic small-caps " + css.substr(7) : "small-caps " + css;
  return css;
}

/// Everything about a style that changes the pixels of a same-string draw.
std::string paint_key(const TextStyle& s) {
  std::string ax;
  if (s.axisOffsets) {
    ax = "{";
    bool first = true;
    for (const auto& [k, v] : *s.axisOffsets) {
      ax += (first ? "\"" : ",\"") + k + "\":" + num_str(v);
      first = false;
    }
    ax += '}';
  }
  return text_css_font(s) + "|" + num_str(s.letterSpacing.value_or(0)) + "|" + s.fill.value_or("") + "|" + (s.fauxBold ? "1" : "0") +
         "|" + (s.fauxItalic ? "1" : "0") + "|" + num_str(s.kerning.value_or(0)) + "|" + s.strokeColor.value_or("") + "|" +
         (s.strokeWidth ? num_str(*s.strokeWidth) : "") + "|" + (s.smallCaps ? "1" : "0") + "|" + (s.allCaps ? "1" : "0") + "|" + ax;
}

bool has_glyph_geometry_style(const TextStyle& s) {
  const StyleScale gs = glyph_style_scale(s);
  return gs.sx != 1 || gs.sy != 1 || gs.dy != 0 || (s.tsume && *s.tsume != 0);
}

// ── gradient fill (textGradient.ts) ──────────────────────────────────────────

struct TextGradientFill {
  std::shared_ptr<Pattern> pattern;  // the rendered ramp
  Mat2D toBox;
  [[nodiscard]] Style style_for(const Canvas2D& ctx) const {
    const auto inv = ctx.getTransform().inverse();
    pattern->transform = inv ? *inv * toBox : toBox;
    Style s;
    s.kind = Style::Kind::pattern;
    s.pattern = pattern;
    return s;
  }
};

std::optional<TextGradientFill> create_text_gradient_fill(const Canvas2D& ctx, const Value& paintJson, double w, double h) {
  const auto paint = read_fill_paint(paintJson);
  if (!paint || paint->type == FillPaint::Type::solid || paint->stops.empty() || !(w > 0) || !(h > 0)) return std::nullopt;
  const Mat2D base = ctx.getTransform();
  const double margin = std::max(w, h) / 2;
  const double fullW = w + 2 * margin;
  const double fullH = h + 2 * margin;
  const double density = std::max({1.0, js_hypot(base.a, base.b), js_hypot(base.c, base.d)});
  const double k = std::min({density, 4096 / fullW, 4096 / fullH});
  const auto cw = static_cast<std::uint32_t>(std::max(1.0, js_round(fullW * k)));
  const auto ch = static_cast<std::uint32_t>(std::max(1.0, js_round(fullH * k)));
  const auto g = Canvas2D::make(cw, ch, {});
  g->scale(cw / fullW, ch / fullH);
  g->translate(margin, margin);
  g->setFillStyle(make_canvas_gradient(*paint, w, h, w / 2, h / 2));
  g->fillRect(-margin, -margin, fullW, fullH);
  TextGradientFill f;
  f.pattern = g->createPattern("no-repeat");
  // DOMMatrix: base.translate(-m,-m).scale(fullW/cw, fullH/ch) post-multiplies.
  f.toBox = base * Mat2D{1, 0, 0, 1, -margin, -margin} * Mat2D{fullW / cw, 0, 0, fullH / ch, 0, 0};
  return f;
}

// ── draw items ───────────────────────────────────────────────────────────────

struct DrawItem {  // NOLINT(bugprone-exception-escape): implicit special members only; bad_alloc terminates by design
  std::string text;
  double x = 0, y = 0;
  TextAlign align = TextAlign::center;
  TextStyle style;
  const GlyphTransform* tr = nullptr;
  std::optional<double> angle;
  int line = 0;
  std::optional<std::pair<double, double>> pivot;
  bool run = false;
  std::optional<int> index;
  std::optional<Direction> direction;
  bool vert = false;
};

DrawItem single_item(const PlacedGlyph& g) {
  DrawItem it;
  it.text = g.drawn ? *g.drawn : (g.transform != nullptr ? g.transform->displayChar : g.ch);
  it.x = g.x;
  it.y = g.y;
  it.align = TextAlign::center;
  it.style = g.style;
  it.tr = g.transform;
  it.angle = g.angle;
  it.line = g.line;
  it.index = g.index;
  if (g.level) it.direction = *g.level % 2 == 1 ? Direction::rtl : Direction::ltr;
  return it;
}

DrawItem run_item(const std::vector<const PlacedGlyph*>& span) {
  const PlacedGlyph& first = *span.front();
  const bool odd = first.level && *first.level % 2 == 1;
  DrawItem it;
  if (first.level) it.direction = odd ? Direction::rtl : Direction::ltr;
  if (odd) {
    for (const auto* p : std::views::reverse(span)) it.text += p->drawn.value_or(p->ch);
  } else {
    for (const auto* p : span) it.text += p->drawn.value_or(p->ch);
  }
  it.x = first.x - first.inkWidth / 2;
  it.y = first.y;
  it.align = TextAlign::left;
  it.style = first.style;
  it.line = first.line;
  it.run = true;
  return it;
}

DrawItem rtl_line_item(const std::vector<const PlacedGlyph*>& line) {
  const PlacedGlyph& first = *line.front();
  std::vector<const PlacedGlyph*> logical = line;
  std::ranges::stable_sort(logical, {}, &PlacedGlyph::index);
  DrawItem it;
  for (const auto* g : logical) it.text += g->drawn.value_or(g->ch);
  it.x = first.x - first.inkWidth / 2;
  it.y = first.y;
  it.align = TextAlign::left;
  it.style = first.style;
  it.line = first.line;
  it.run = true;
  it.direction = Direction::rtl;
  return it;
}

TextStyle tcy_squeezed(const TextStyle& s, double scale) {
  TextStyle o = s;
  o.horizontalScale = s.horizontalScale.value_or(100) * scale;
  return o;
}

/// textPaint.ts verticalItem.
DrawItem vertical_item(const PlacedGlyph& g) {
  DrawItem it = single_item(g);
  if (g.vertAlternate) it.vert = true;
  if (g.tcyStart && g.tcyScale < 1) it.style = tcy_squeezed(g.style, g.tcyScale);
  return it;
}

/// textPaint.ts groupVertical.
std::vector<DrawItem> group_vertical(const std::vector<PlacedGlyph>& glyphs, bool never) {
  std::vector<DrawItem> out;
  const auto untouched = [](const PlacedGlyph& g) {
    return !(g.style.kerning && *g.style.kerning != 0) && !has_glyph_geometry_style(g.style) &&
           (g.transform == nullptr || is_identity_transform(*g.transform));
  };
  const auto groupable = [&](const PlacedGlyph& g) { return !never && g.angle.has_value() && untouched(g); };
  std::size_t i = 0;
  while (i < glyphs.size()) {
    const PlacedGlyph& g = glyphs[i];
    if (g.tcyStart) {
      std::size_t k = i + 1;
      while (k < glyphs.size() && glyphs[k].tcyStart == g.tcyStart) ++k;
      const std::string key = paint_key(g.style);
      bool whole = k - i > 1 && !never;
      for (std::size_t s = i; s < k && whole; ++s) whole = untouched(glyphs[s]) && paint_key(glyphs[s].style) == key;
      if (whole) {
        const PlacedGlyph& last = glyphs[k - 1];
        DrawItem it;
        for (std::size_t s = i; s < k; ++s) it.text += glyphs[s].drawn.value_or(glyphs[s].ch);
        it.x = (g.x - g.inkWidth / 2 + last.x + last.inkWidth / 2) / 2;
        it.y = g.y;
        it.align = TextAlign::center;
        it.style = g.tcyScale < 1 ? tcy_squeezed(g.style, g.tcyScale) : g.style;
        it.line = g.line;
        out.push_back(std::move(it));
      } else {
        for (std::size_t s = i; s < k; ++s) out.push_back(vertical_item(glyphs[s]));
      }
      i = k;
      continue;
    }
    if (!groupable(g)) {
      out.push_back(vertical_item(g));
      ++i;
      continue;
    }
    const std::string key = paint_key(g.style);
    std::size_t k = i + 1;
    while (k < glyphs.size() && groupable(glyphs[k]) && glyphs[k].line == g.line && glyphs[k].index == glyphs[k - 1].index + 1 &&
           paint_key(glyphs[k].style) == key) {
      ++k;
    }
    if (k - i > 1) {
      DrawItem it;
      for (std::size_t s = i; s < k; ++s) it.text += glyphs[s].drawn.value_or(glyphs[s].ch);
      it.x = g.x;
      it.y = g.y - g.inkWidth / 2;
      it.align = TextAlign::left;
      it.style = g.style;
      it.angle = g.angle;
      it.line = g.line;
      it.run = true;
      out.push_back(std::move(it));
    } else {
      out.push_back(single_item(g));
    }
    i = k;
  }
  return out;
}

bool canvas_agrees_on_levels(const std::vector<const PlacedGlyph*>& line) {
  std::vector<const PlacedGlyph*> logical = line;
  std::ranges::stable_sort(logical, {}, &PlacedGlyph::index);
  std::vector<std::string> chars;
  chars.reserve(logical.size());
  for (const auto* g : logical) chars.push_back(g->ch);
  const auto own = cluster_bidi(chars, 1).levels;
  for (std::size_t k = 0; k < logical.size(); ++k) {
    if (logical[k]->level != own[k]) return false;  // nullopt never equals a level
  }
  return true;
}

std::vector<DrawItem> group_for_shaping(const std::vector<PlacedGlyph>& glyphs, const std::vector<LineBox>& lines,
                                        bool optical, bool ligatures) {
  std::vector<DrawItem> out;
  const auto groupable = [&](const PlacedGlyph& g) {
    return !optical && !g.angle && !(g.style.kerning && *g.style.kerning != 0) && !has_glyph_geometry_style(g.style) &&
           (g.transform == nullptr || is_identity_transform(*g.transform));
  };
  const auto continues = [](const PlacedGlyph& a, const PlacedGlyph& b) {
    return !a.level || (a.level == b.level && b.index == a.index + (*a.level % 2 == 1 ? -1 : 1));
  };
  std::size_t i = 0;
  while (i < glyphs.size()) {
    const int lineNo = glyphs[i].line;
    std::size_t end = i;
    while (end < glyphs.size() && glyphs[end].line == lineNo) ++end;
    std::vector<const PlacedGlyph*> line;
    for (std::size_t k = i; k < end; ++k) line.push_back(&glyphs[k]);
    const LineBox* lb = static_cast<std::size_t>(lineNo) < lines.size() ? &lines[static_cast<std::size_t>(lineNo)] : nullptr;
    const bool justified = lb != nullptr && lb->spaceExtra > 0;
    const std::string firstKey = paint_key(line[0]->style);
    std::string joined;
    for (const auto* g : line) joined += g->ch;
    const bool uniform = !justified &&
                         std::ranges::all_of(line, [&](const PlacedGlyph* g) { return groupable(*g) && paint_key(g->style) == firstKey; }) &&
                         (ligatures || has_complex_script(joined));
    const bool levelled = line[0]->level.has_value();
    if (uniform && line.size() > 1 && (!levelled || ((lb == nullptr || lb->direction != "ltr") && canvas_agrees_on_levels(line)))) {
      out.push_back(levelled ? rtl_line_item(line) : run_item(line));
    } else {
      std::size_t j = 0;
      while (j < line.size()) {
        const PlacedGlyph& g = *line[j];
        if (justified || !groupable(g)) {
          out.push_back(single_item(g));
          ++j;
          continue;
        }
        const std::string key = paint_key(g.style);
        std::size_t k = j + 1;
        while (k < line.size() && groupable(*line[k]) && paint_key(line[k]->style) == key && continues(*line[k - 1], *line[k])) ++k;
        std::vector<const PlacedGlyph*> span(line.begin() + static_cast<std::ptrdiff_t>(j), line.begin() + static_cast<std::ptrdiff_t>(k));
        std::string sj;
        for (const auto* s : span) sj += s->ch;
        if (span.size() > 1 && (ligatures || has_complex_script(sj))) {
          out.push_back(run_item(span));
        } else {
          for (const auto* s : span) out.push_back(single_item(*s));
        }
        j = k;
      }
    }
    i = end;
  }
  return out;
}

std::vector<DrawItem> fit_items_to_box(std::vector<DrawItem> items, const std::vector<double>& lineYs,
                                       const std::vector<double>& lineHeightPx, const TextExtras& ex, double scale) {
  if (!ex.boxHeight || *ex.boxHeight == 0 || lineYs.empty()) return items;
  const BoxLinePlacement p = place_lines_in_box(lineYs, lineHeightPx, *ex.boxHeight / scale, ex.boxVerticalAlign);
  if (p.dy == 0 && std::cmp_greater_equal(p.visible, lineYs.size())) return items;
  std::vector<DrawItem> out;
  for (auto& it : items) {
    if (it.line < p.visible) {
      it.y += p.dy;
      out.push_back(std::move(it));
    }
  }
  return out;
}

// ── text on a path (textPath.ts, trimPath.ts) ────────────────────────────────

struct ArcTable {
  std::vector<std::pair<double, double>> pts;
  bool closed = false;
  std::vector<double> cum;
  double total = 0;
};

ArcTable arc_table(std::vector<std::pair<double, double>> pts, bool closed) {
  ArcTable t;
  const std::size_t n = pts.size();
  const std::size_t count = closed ? n : (n == 0 ? 0 : n - 1);
  t.cum.push_back(0);
  double total = 0;
  for (std::size_t i = 0; i < count; ++i) {
    const auto& a = pts[i];
    const auto& b = pts[(i + 1) % n];
    const double d = js_hypot(b.first - a.first, b.second - a.second);
    t.cum.push_back(t.cum.back() + d);
    total += d;
  }
  t.pts = std::move(pts);
  t.closed = closed;
  t.total = total;
  return t;
}

struct PointAngle {
  double x = 0, y = 0, angle = 0;
};
PointAngle point_and_tangent(const ArcTable& t, double len) {
  const std::size_t n = t.pts.size();
  if (n == 0) return {};
  if (n == 1 || t.total <= 0) return {t.pts[0].first, t.pts[0].second, 0};
  const std::size_t count = t.closed ? n : n - 1;
  double target = len;
  if (t.closed) target = std::fmod(std::fmod(len, t.total) + t.total, t.total);
  const auto segD = [&](std::size_t i) { return t.cum[i + 1] - t.cum[i]; };
  const auto at = [&](std::size_t i, double u) {
    const auto& a = t.pts[i];
    const auto& b = t.pts[(i + 1) % n];
    return PointAngle{a.first + (b.first - a.first) * u, a.second + (b.second - a.second) * u,
                      js_atan2(b.second - a.second, b.first - a.first)};
  };
  const auto orOne = [](double d) { return d == 0 || std::isnan(d) ? 1.0 : d; };
  if (!t.closed && target < 0) return at(0, target / orOne(segD(0)));
  if (!t.closed && target > t.total) {
    const std::size_t i = count - 1;
    return at(i, 1 + (target - t.total) / orOne(segD(i)));
  }
  std::size_t lo = 0;
  std::size_t hi = count - 1;
  while (lo < hi) {
    const std::size_t mid = (lo + hi + 1) >> 1U;
    if (t.cum[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const double d = segD(lo);
  return at(lo, d > 0 ? (target - t.cum[lo]) / d : 0);
}

void apply_text_path(std::vector<PlacedGlyph>& glyphs, const std::vector<LineBox>& lines, const Value& tp,
                     const std::string& alignStr, bool vertical) {
  std::vector<std::pair<double, double>> pts;
  for (const auto& p : tp["points"].items()) pts.emplace_back(p["x"].num(0), p["y"].num(0));
  const ArcTable table = arc_table(std::move(pts), tp["closed"].truthy());
  if (table.total <= 0) return;
  const LineAlign align = resolve_align(alignStr).line;
  const double firstMargin = tp["firstMargin"].num(0);
  const double lastMargin = tp["lastMargin"].num(0);
  const bool reversed = tp["reversed"].truthy();
  const bool perpendicular = tp["perpendicular"].truthy();
  const bool force = tp["forceAlignment"].truthy();
  std::vector<int> rank(glyphs.size(), 0);
  std::map<int, int> lineCount;
  if (force) {
    for (std::size_t i = 0; i < glyphs.size(); ++i) {
      const int n = lineCount[glyphs[i].line];
      rank[i] = n;
      lineCount[glyphs[i].line] = n + 1;
    }
  }
  for (std::size_t gi = 0; gi < glyphs.size(); ++gi) {
    PlacedGlyph& g = glyphs[gi];
    const LineBox* line = static_cast<std::size_t>(g.line) < lines.size() ? &lines[static_cast<std::size_t>(g.line)] : nullptr;
    const double lineLeft = line != nullptr ? line->left : 0;
    const double lineWidth = line != nullptr ? line->width : 0;
    const double inLine = vertical ? g.y - (line != nullptr ? line->y : 0) : g.x - lineLeft;
    double along = 0;
    if (force) {
      const double span = table.total + lastMargin - firstMargin;
      const int n = lineCount.count(g.line) != 0 ? lineCount[g.line] : 1;
      const double extra = n > 1 ? (span - lineWidth) / (n - 1) : (span - lineWidth) / 2;
      along = firstMargin + inLine + (n > 1 ? extra * rank[gi] : extra);
    } else {
      double base = 0;
      if (align == LineAlign::center) base = (table.total - lineWidth) / 2 + lastMargin / 2;
      else if (align == LineAlign::right) base = table.total - lineWidth + lastMargin;
      along = firstMargin + base + inLine;
    }
    const double arc = reversed ? table.total - along : along;
    const PointAngle pa = point_and_tangent(table, arc);
    const double heading = reversed ? pa.angle + kJsPi : pa.angle;
    const double normal = heading + kJsPi / 2;
    if (vertical) {
      const double off = -g.x;
      g.x = pa.x + js_cos(normal) * off;
      g.y = pa.y + js_sin(normal) * off;
      g.angle = perpendicular ? heading - kJsPi / 2 + g.angle.value_or(0) : g.angle.value_or(0);
    } else {
      const double off = g.y;
      g.x = pa.x + js_cos(normal) * off;
      g.y = pa.y + js_sin(normal) * off;
      g.angle = perpendicular ? heading : 0;
    }
  }
}

// ── anchor grouping (textMoreOptions.ts groupPivots) ─────────────────────────

std::vector<std::optional<std::pair<double, double>>> group_pivots(const std::vector<PlacedGlyph>& glyphs,
                                                                   const std::string& grouping,
                                                                   const std::optional<std::pair<double, double>>& align) {
  const double ax = (align ? align->first : 0) / 100;
  const double ay = (align ? align->second : 0) / 100;
  const std::string mode = grouping.empty() ? "character" : grouping;
  std::vector<std::optional<std::pair<double, double>>> out(glyphs.size());
  if (mode == "character") {
    if (ax == 0 && ay == 0) return out;
    for (std::size_t i = 0; i < glyphs.size(); ++i) {
      out[i] = std::make_pair(glyphs[i].x + ax * glyphs[i].inkWidth, glyphs[i].y + ay * glyphs[i].style.fontSize);
    }
    return out;
  }
  std::vector<int> ids(glyphs.size(), -1);
  int id = -1;
  int prevLine = -1;
  bool inWord = false;
  for (std::size_t i = 0; i < glyphs.size(); ++i) {
    const auto& g = glyphs[i];
    if (mode == "all") { ids[i] = 0; continue; }
    if (mode == "line") { ids[i] = g.line; continue; }
    const bool space = is_js_blank(g.ch);
    if (g.line != prevLine) inWord = false;
    prevLine = g.line;
    if (space) { ids[i] = -1; inWord = false; continue; }
    if (!inWord) ++id;
    inWord = true;
    ids[i] = id;
  }
  struct Box {
    double l, r, t, b;
  };
  std::map<int, Box> boxes;
  for (std::size_t i = 0; i < glyphs.size(); ++i) {
    const int gid = ids[i];
    if (gid < 0) continue;
    const auto& g = glyphs[i];
    const double half = g.style.fontSize / 2;
    const double l = g.x - g.inkWidth / 2;
    const double r = g.x + g.inkWidth / 2;
    const auto it = boxes.find(gid);
    if (it == boxes.end()) boxes[gid] = {l, r, g.y - half, g.y + half};
    else {
      it->second.l = std::min(it->second.l, l);
      it->second.r = std::max(it->second.r, r);
      it->second.t = std::min(it->second.t, g.y - half);
      it->second.b = std::max(it->second.b, g.y + half);
    }
  }
  for (std::size_t i = 0; i < glyphs.size(); ++i) {
    const auto it = boxes.find(ids[i]);
    if (it == boxes.end()) continue;
    const Box& b = it->second;
    out[i] = std::make_pair((b.l + b.r) / 2 + ax * (b.r - b.l), (b.t + b.b) / 2 + ay * (b.b - b.t));
  }
  return out;
}

std::string_view inter_char_op(const std::string& v) {
  static constexpr auto kMap = std::to_array<std::pair<std::string_view, std::string_view>>({
      {"darken", "darken"}, {"multiply", "multiply"}, {"color-burn", "color-burn"}, {"add", "lighter"},
      {"lighten", "lighten"}, {"screen", "screen"}, {"color-dodge", "color-dodge"}, {"overlay", "overlay"},
      {"soft-light", "soft-light"}, {"hard-light", "hard-light"}, {"difference", "difference"},
      {"exclusion", "exclusion"}, {"hue", "hue"}, {"saturation", "saturation"}, {"color", "color"},
      {"luminosity", "luminosity"},
  });
  for (const auto& [k, op] : kMap) {
    if (k == v) return op;
  }
  return {};
}

std::optional<double> opt_num(const Value& v) {
  if (v.is_number()) return v.num();
  return std::nullopt;
}
std::optional<std::string> opt_str(const Value& v) {
  if (v.is_string()) return v.str();
  if (v.is_number()) return num_str(v.num());  // `${n}` in the TS template strings
  return std::nullopt;
}

}  // namespace

void paint_text_in_box(Canvas2D& ctx, const Value& spec, std::vector<std::string>& unsupported) {
  const TextExtras ex = read_text_extras(spec["textExtras"]);
  double width = spec["width"].num(std::nan(""));
  double height = spec["height"].num(std::nan(""));
  const double offY = ex.boxOffsetY && std::isfinite(*ex.boxOffsetY) ? *ex.boxOffsetY : 0;
  if (offY != 0) ctx.translate(0, offY + std::fabs(offY));
  const double gradientH = offY != 0 ? height - 2 * std::fabs(offY) : height;
  const auto gradient = create_text_gradient_fill(ctx, spec["fillPaint"], width, gradientH);
  const auto strokeGradient = create_text_gradient_fill(ctx, spec["strokePaint"], width, gradientH);
  if (offY != 0) ctx.translate(0, -std::fabs(offY));
  const bool vertical = ex.vertical;
  const std::string bidiDir = !vertical && (ex.direction == "rtl" || ex.direction == "auto") ? ex.direction : "";
  const bool rtl = bidiDir == "rtl";

  // Character panel box transform (measureText.ts textStyleTransform).
  {
    const std::string va(spec["verticalAlign"].str_or(""));
    const double vas = va == "super" || va == "sub" ? 0.65 : 1;
    const double hs = spec["horizontalScale"].is_number() && spec["horizontalScale"].num() > 0 ? spec["horizontalScale"].num() : 100;
    const double vs = spec["verticalScale"].is_number() && spec["verticalScale"].num() > 0 ? spec["verticalScale"].num() : 100;
    const double sx = (hs / 100) * vas;
    const double sy = (vs / 100) * vas;
    double dy = -(spec["baselineShift"].is_number() && std::isfinite(spec["baselineShift"].num()) ? spec["baselineShift"].num() : 0);
    const double fs = spec["fontSize"].num(std::nan(""));
    if (va == "super") dy -= fs * 0.35;
    else if (va == "sub") dy += fs * 0.15;
    if (sx != 1 || sy != 1 || dy != 0) {
      ctx.translate(width / 2, height / 2 + dy);
      ctx.scale(sx, sy);
      ctx.translate(-width / 2, -height / 2);
    }
  }
  const bool fitting = ex.fitScale && *ex.fitScale > 0 && *ex.fitScale < 1;
  if (fitting) {
    const double k = *ex.fitScale;
    const double vw = (width - 2 * kTextPadX) / k + 2 * kTextPadX;
    const double vh = height / k;
    ctx.translate(width / 2, height / 2);
    ctx.scale(k, k);
    ctx.translate(-vw / 2, -vh / 2);
    width = vw;
    height = vh;
  }
  const double boxScale = fitting ? *ex.fitScale : 1;
  if (!ex.stylisticSets.empty() || ex.discretionaryLigatures || ex.contextualAlternatesOff) {
    unsupported.emplace_back("OpenType feature alias faces (fontFaceVariants) — drawn without the features");
  }
  const bool ligaturesOff = ex.ligaturesOff;
  const bool ligatureFallback = ligaturesOff;  // no alias face (see the file note)
  const std::string_view blendOp = inter_char_op(ex.interCharacterBlending);

  TextStyle specStyle;
  specStyle.fontSize = spec["fontSize"].num(std::nan(""));
  specStyle.fontFamily = opt_str(spec["fontFamily"]);
  specStyle.fontWeight = opt_str(spec["fontWeight"]);
  specStyle.fontStyle = opt_str(spec["fontStyle"]);
  (void)ctx.setFont(font_for(specStyle));
  const bool optical = ex.kerningMode == "optical";
  ctx.setSmallCaps(spec["fontVariant"].str_or("") == "small-caps");
  if (optical) ctx.setFontKerning(false);
  ctx.setTextBaseline(TextBaseline::middle);
  if (rtl) ctx.setDirection(Direction::rtl);
  const std::optional<double> letterSpacing = opt_num(spec["letterSpacing"]);
  ctx.setLetterSpacing(letterSpacing && *letterSpacing != 0 ? *letterSpacing : 0);
  const std::string layerFill = to_canvas_color(opt_str(spec["color"]), "#ffffff");
  if (const auto s = color_style(layerFill)) ctx.setFillStyle(*s);

  std::string text = spec["text"].is_string() && !spec["text"].str().empty() ? spec["text"].str() : std::string("Text");
  const std::string tt(spec["textTransform"].str_or(""));
  if (tt == "uppercase") text = to_upper(text);
  else if (tt == "lowercase") text = to_lower(text);
  else if (tt == "capitalize") unsupported.emplace_back("textTransform capitalize");

  const double tsw = spec["textStrokeWidth"].num(0);
  const double layerStrokeW = !ex.noStroke && spec["textStrokeWidth"].is_number() && tsw > 0 ? tsw : 0;
  const std::string layerStrokeColor =
      to_canvas_color(spec["textStroke"].is_string() && !spec["textStroke"].str().empty() ? opt_str(spec["textStroke"]) : std::nullopt, layerFill);
  const LineJoin lineJoin = ex.strokeLineJoin == "miter" ? LineJoin::miter : ex.strokeLineJoin == "bevel" ? LineJoin::bevel : LineJoin::round;
  const bool noFill = ex.noFill;
  std::string order = !ex.strokeOrder.empty() ? ex.strokeOrder : (spec["strokeOverFill"].truthy() ? "stroke-over-fill" : "fill-over-stroke");
  if (ex.fillStrokeMode == "allAsOne") {
    if (order == "fill-over-stroke") order = "all-fills-over-all-strokes";
    else if (order == "stroke-over-fill") order = "all-strokes-over-all-fills";
  }
  const bool strokeFirst = order == "fill-over-stroke" || order == "all-fills-over-all-strokes";
  const bool allPasses = order == "all-fills-over-all-strokes" || order == "all-strokes-over-all-fills";
  enum class Part : std::uint8_t { stroke, fill };
  const std::vector<Part> parts = strokeFirst ? std::vector<Part>{Part::stroke, Part::fill} : std::vector<Part>{Part::fill, Part::stroke};

  TextStyle base;
  base.fontSize = specStyle.fontSize;
  base.fontFamily = specStyle.fontFamily;
  base.fontWeight = specStyle.fontWeight;
  base.fontStyle = specStyle.fontStyle;
  base.letterSpacing = letterSpacing;
  base.fill = layerFill;
  base.fauxBold = ex.fauxBold;
  base.fauxItalic = ex.fauxItalic;
  base.align = spec["align"].str_or("");
  base.lineHeight = opt_num(spec["lineHeight"]);
  base.paragraphSpacing = opt_num(spec["paragraphSpacing"]);
  base.leftIndent = ex.leftIndent;
  base.rightIndent = ex.rightIndent;
  base.firstLineIndent = ex.firstLineIndent;
  base.spaceBefore = ex.spaceBefore;
  base.spaceAfter = ex.spaceAfter;

  std::vector<RichRun> runs;
  for (const auto& r : spec["runs"].items()) runs.push_back({static_cast<int>(r["start"].num(0)), static_cast<int>(r["end"].num(0)), &r["style"]});
  std::vector<GlyphTransform> transforms;
  for (const auto& g : spec["glyphs"].items()) transforms.push_back(read_glyph_transform(g));
  const bool hasTextPath = spec["textPath"].is_object();

  const bool hasGlyphWork = !runs.empty() || !transforms.empty() || hasTextPath || optical || !blendOp.empty() ||
                            ligatureFallback || vertical ||
                            (!bidiDir.empty() && ex.softBreakLines &&
                             ((resolve_align(base.align).justify && (rtl || has_strong_rtl(text))) ||
                              soft_wrap_changes_bidi(text, ex.softBreakLines, bidiDir)));
  const double cx = width / 2;
  const double cy = height / 2;

  const auto paintPart = [&](Part part, const DrawItem& item, const Style& fill, const Style& strokeColor, double strokeW,
                             double fillAlpha, double x, double y, double strokeAlpha) {
    if (part == Part::stroke) {
      if (strokeW <= 0 || strokeAlpha <= 0) return;
      const double prevA = ctx.globalAlpha();
      if (strokeAlpha < 1) ctx.setGlobalAlpha(prevA * strokeAlpha);
      ctx.setLineWidth(strokeW);
      ctx.setLineJoin(lineJoin);
      ctx.setStrokeStyle(strokeColor);
      ctx.strokeText(item.text, x, y);
      if (strokeAlpha < 1) ctx.setGlobalAlpha(prevA);
      return;
    }
    if (noFill || fillAlpha <= 0) return;
    const double prev = ctx.globalAlpha();
    if (fillAlpha < 1) ctx.setGlobalAlpha(prev * fillAlpha);
    if (item.style.fauxBold) {
      ctx.setLineWidth(item.style.fontSize * kFauxBoldStrokeRatio);
      ctx.setLineJoin(LineJoin::round);
      ctx.setStrokeStyle(fill);
      ctx.strokeText(item.text, x, y);
    }
    ctx.setFillStyle(fill);
    ctx.fillText(item.text, x, y);
    if (fillAlpha < 1) ctx.setGlobalAlpha(prev);
  };

  const auto styleOf = [](const std::string& css) {
    Style s;
    if (const auto c = color_style(css)) s = *c;
    return s;
  };

  const auto drawItemInner = [&](const DrawItem& item, const std::vector<Part>& which) {
    const GlyphTransform* tr = item.tr;
    const TextStyle& style = item.style;
    const std::string baseFill = to_canvas_color(style.fill, layerFill);
    ctx.setTextAlign(item.align);
    std::string fill = tr != nullptr && tr->color && tr->colorMix.value_or(0) > 0 ? mix_css_colors(baseFill, tr->color, tr->colorMix.value_or(1)) : baseFill;
    if (tr != nullptr && (tr->fillHue.value_or(0) != 0 || tr->fillSaturation.value_or(0) != 0 || tr->fillBrightness.value_or(0) != 0)) {
      fill = adjust_hsb(fill, tr->fillHue.value_or(0), tr->fillSaturation.value_or(0), tr->fillBrightness.value_or(0));
    }
    const bool useGradient = gradient.has_value() && fill == layerFill;
    const double rangeStrokeW = style.strokeWidth && !ex.noStroke ? std::max(0.0, *style.strokeWidth) : layerStrokeW;
    const double strokeW = tr != nullptr && tr->strokeWidth > 0 ? tr->strokeWidth : rangeStrokeW;
    const std::string strokeBase = style.strokeColor ? to_canvas_color(style.strokeColor, layerStrokeColor)
                                                     : (layerStrokeW > 0 ? layerStrokeColor : fill);
    std::string strokeColor = tr != nullptr && tr->strokeColor ? mix_css_colors(strokeBase, tr->strokeColor, tr->strokeColorMix.value_or(1)) : strokeBase;
    if (tr != nullptr && (tr->strokeHue.value_or(0) != 0 || tr->strokeSaturation.value_or(0) != 0 || tr->strokeBrightness.value_or(0) != 0)) {
      strokeColor = adjust_hsb(strokeColor, tr->strokeHue.value_or(0), tr->strokeSaturation.value_or(0), tr->strokeBrightness.value_or(0));
    }
    const bool useStrokeGradient = strokeGradient.has_value() && layerStrokeW > 0 && !style.strokeColor &&
                                   !(tr != nullptr && tr->strokeColor) &&
                                   !(tr != nullptr && (tr->strokeHue.value_or(0) != 0 || tr->strokeSaturation.value_or(0) != 0 || tr->strokeBrightness.value_or(0) != 0));
    const double strokeAlpha = tr != nullptr && tr->strokeOpacity ? std::max(0.0, *tr->strokeOpacity) : 1;
    const double fillAlpha = tr != nullptr ? std::max(0.0, tr->fillOpacity) : 1;
    const StyleScale gs = glyph_style_scale(style);
    const bool rangeScaled = gs.sx != 1 || gs.sy != 1;
    const std::optional<double> runSpacing = item.run && style.letterSpacing && *style.letterSpacing != 0 ? style.letterSpacing : std::nullopt;
    std::string blendPrev;
    if (!blendOp.empty()) {
      blendPrev = ctx.globalCompositeOperation();
      (void)ctx.setGlobalCompositeOperation(blendOp);
    }
    if (tr == nullptr && !item.angle && !style.fauxItalic && !rangeScaled && !item.pivot) {
      (void)ctx.setFont(font_for(style));
      if (runSpacing) ctx.setLetterSpacing(*runSpacing);
      const Style fs = useGradient ? gradient->style_for(ctx) : styleOf(fill);
      const Style ss = useStrokeGradient ? strokeGradient->style_for(ctx) : styleOf(strokeColor);
      for (const Part p : which) paintPart(p, item, fs, ss, strokeW, 1, cx + item.x, cy + item.y, 1);
      if (runSpacing) ctx.setLetterSpacing(0);
      if (!blendOp.empty()) (void)ctx.setGlobalCompositeOperation(blendPrev);
      return;
    }
    ctx.save();
    const double lift = (tr != nullptr ? tr->lineSpacing : 0) * item.line;
    const double ox = item.pivot ? item.pivot->first : item.x;
    const double oy = item.pivot ? item.pivot->second : item.y;
    ctx.translate(cx + ox + (tr != nullptr ? tr->dx : 0), cy + oy + (tr != nullptr ? tr->dy : 0) + lift);
    if (item.angle && *item.angle != 0) ctx.rotate(*item.angle);
    if (tr != nullptr) {
      if (tr->rotation != 0) ctx.rotate((tr->rotation * kJsPi) / 180);
      if (tr->skew != 0) {
        const double axis = tr->skewAxis && *tr->skewAxis != 0 ? (*tr->skewAxis * kJsPi) / 180 : 0;
        if (axis != 0) ctx.rotate(axis);
        ctx.transform({1, 0, js_tan((-tr->skew * kJsPi) / 180), 1, 0, 0});
        if (axis != 0) ctx.rotate(-axis);
      }
      if (tr->scale != 1 || tr->scaleY != 1) ctx.scale(tr->scale, tr->scaleY);
      if (tr->opacity != 1) ctx.setGlobalAlpha(ctx.globalAlpha() * std::max(0.0, tr->opacity));
      if (tr->blur > 0 && tr->blurY.value_or(tr->blur) == tr->blur) ctx.setFilter({tr->blur});
    }
    if (item.pivot) ctx.translate(item.x - item.pivot->first, item.y - item.pivot->second);
    if (tr != nullptr && (tr->anchorX.value_or(0) != 0 || tr->anchorY.value_or(0) != 0)) ctx.translate(-tr->anchorX.value_or(0), -tr->anchorY.value_or(0));
    if (rangeScaled) ctx.scale(gs.sx, gs.sy);
    if (style.fauxItalic) ctx.transform({1, 0, -js_tan((12 * kJsPi) / 180), 1, 0, 0});  // FAUX_ITALIC_SKEW
    (void)ctx.setFont(font_for(style));
    if (runSpacing) ctx.setLetterSpacing(*runSpacing);
    const Style fs = useGradient ? gradient->style_for(ctx) : styleOf(fill);
    const Style ss = useStrokeGradient ? strokeGradient->style_for(ctx) : styleOf(strokeColor);
    const double bx = tr != nullptr ? std::max(0.0, tr->blur) : 0;
    const double by = tr != nullptr ? std::max(0.0, tr->blurY.value_or(tr->blur)) : 0;
    if (tr != nullptr && bx != by) {
      unsupported.emplace_back("2-D animator blur (anisotropic scratch composite) — drawn isotropic");
      ctx.setFilter({(bx + by) / 2});
    }
    for (const Part p : which) paintPart(p, item, fs, ss, strokeW, fillAlpha, 0, 0, strokeAlpha);
    ctx.restore();
    if (!blendOp.empty()) (void)ctx.setGlobalCompositeOperation(blendPrev);
  };

  const auto drawItem = [&](const DrawItem& item, const std::vector<Part>& which) {
    if (!item.direction) {
      drawItemInner(item, which);
      return;
    }
    const Direction prev = ctx.direction();
    ctx.setDirection(*item.direction);
    drawItemInner(item, which);
    ctx.setDirection(prev);
  };
  const auto paintItems = [&](const std::vector<DrawItem>& items) {
    if (allPasses) {
      for (const Part p : parts) {
        for (const auto& it : items) drawItem(it, {p});
      }
    } else {
      for (const auto& it : items) drawItem(it, parts);
    }
  };

  if (!hasGlyphWork) {
    TextStyle layerStyle;
    layerStyle.fontSize = base.fontSize;
    layerStyle.fontFamily = base.fontFamily;
    layerStyle.fontWeight = base.fontWeight;
    layerStyle.fontStyle = base.fontStyle;
    layerStyle.letterSpacing = base.letterSpacing;
    layerStyle.fill = layerFill;
    layerStyle.fauxBold = ex.fauxBold;
    layerStyle.fauxItalic = ex.fauxItalic;
    WholeLineOptions wo;
    wo.boxWidth = width;
    wo.padX = kTextPadX;
    wo.softBreakLines = ex.softBreakLines;
    wo.direction = bidiDir;
    const auto plans = plan_whole_string_lines(text, base, [&](const std::string& s) { return ctx.measureText(s).width; }, wo);
    std::vector<DrawItem> items;
    std::vector<double> ys;
    for (std::size_t line = 0; line < plans.size(); ++line) {
      ys.push_back(plans[line].y);
      for (const auto& s : plans[line].segments) {
        DrawItem it;
        it.text = s.text;
        it.x = s.x;
        it.y = plans[line].y;
        it.align = s.align == LineAlign::center ? TextAlign::center : s.align == LineAlign::right ? TextAlign::right : TextAlign::left;
        it.style = layerStyle;
        it.line = static_cast<int>(line);
        if (plans[line].rtl) it.direction = Direction::rtl;
        items.push_back(std::move(it));
      }
    }
    paintItems(fit_items_to_box(std::move(items), ys, {base.lineHeight.value_or(kAutoLeading) * base.fontSize}, ex, boxScale));
    return;
  }

  // Optical kerning: pair adjustments from ink profiles (optical_kerning.cpp),
  // the faces at the reference size, exactly as textPaint.ts opticalFaceOf.
  std::optional<OpticalKerner> kerner;
  OpticalKern opticalKern;
  if (optical) {
    kerner.emplace(ctx.options());
    opticalKern = [&](const std::string& a, const TextStyle& sa, const std::string& b, const TextStyle& sb) {
      TextStyle ra = sa;
      TextStyle rb = sb;
      ra.fontSize = OpticalKerner::kRefEmPx;
      rb.fontSize = OpticalKerner::kRefEmPx;
      return kerner->kern_px(font_for(ra), a, sa.fontSize, font_for(rb), b, sb.fontSize);
    };
    if (vertical) unsupported.emplace_back("vertical optical kerning of upright CJK pairs (opticalKernVerticalPx)");
  }

  ctx.setLetterSpacing(0);
  ctx.setTextAlign(TextAlign::left);
  std::map<std::string, double> measureCache;
  const MeasureGlyph measure = [&](const std::string& ch, const TextStyle& style) {
    const std::string font = font_for(style);
    const std::string key = font + " " + ch;
    const auto hit = measureCache.find(key);
    if (hit != measureCache.end()) return hit->second;
    (void)ctx.setFont(font);
    const double w = ctx.measureText(ch).width;
    measureCache.emplace(key, w);
    return w;
  };
  LayoutOptions lo;
  lo.runs = &runs;
  lo.transforms = &transforms;
  lo.boxWidth = width;
  lo.padX = kTextPadX;
  lo.softBreakLines = ex.softBreakLines;
  lo.kerningMode = ex.kerningMode;
  lo.direction = bidiDir;
  lo.opticalKern = opticalKern;
  lo.measureRun = [&](const std::string& run, const TextStyle& style) {
    const std::string font = font_for(style);
    const std::string key = "run|" + font + "|" + num_str(style.letterSpacing.value_or(0)) + "|" + run;
    const auto hit = measureCache.find(key);
    if (hit != measureCache.end()) return hit->second;
    ctx.setLetterSpacing(style.letterSpacing && *style.letterSpacing != 0 ? *style.letterSpacing : 0);
    (void)ctx.setFont(font);
    const double w = ctx.measureText(run).width;
    ctx.setLetterSpacing(0);
    measureCache.emplace(key, w);
    return w;
  };
  bool anyTsume = false;
  for (const auto& r : runs) anyTsume = anyTsume || (r.style != nullptr && (*r.style)["tsume"].truthy());
  if (anyTsume) {
    lo.measureBearings = [&](const std::string& ch, const TextStyle& style) {
      (void)ctx.setFont(font_for(style));
      ctx.setTextAlign(TextAlign::left);
      const TextMetrics m = ctx.measureText(ch);
      return Bearings{-m.actualBoundingBoxLeft, m.width - m.actualBoundingBoxRight};
    };
  }
  TextLayout laid;
  if (vertical) {
    VerticalLayoutOptions vo;
    vo.runs = &runs;
    vo.transforms = &transforms;
    vo.boxWidth = width;
    vo.padX = kTextPadX;
    vo.columnLimit = ex.boxHeight;
    vo.measureRun = lo.measureRun;
    vo.romanUpright = ex.verticalRomanAlignment;
    vo.tateChuYokoDigits = ex.tateChuYokoDigits;
    vo.opticalKern = opticalKern;
    laid = layout_vertical_text(text, base, measure, vo);
  } else {
    laid = layout_text(text, base, measure, lo);
  }
  if (hasTextPath) apply_text_path(laid.glyphs, laid.lines, spec["textPath"], base.align, vertical);

  std::vector<std::optional<std::pair<double, double>>> pivots;
  if (!hasTextPath && (!ex.anchorGrouping.empty() || ex.groupingAlign)) pivots = group_pivots(laid.glyphs, ex.anchorGrouping, ex.groupingAlign);
  std::map<int, std::pair<double, double>> pivotByIndex;
  for (std::size_t i = 0; i < pivots.size(); ++i) {
    const auto& g = laid.glyphs[i];
    if (pivots[i] && g.transform != nullptr && !is_identity_transform(*g.transform)) pivotByIndex[g.index] = *pivots[i];
  }
  std::vector<DrawItem> grouped;
  if (hasTextPath) {
    for (const auto& g : laid.glyphs) grouped.push_back(vertical ? vertical_item(g) : single_item(g));
  } else if (vertical) {
    grouped = group_vertical(laid.glyphs, optical || !blendOp.empty());
  } else {
    grouped = group_for_shaping(laid.glyphs, laid.lines, optical || !blendOp.empty(), !ligaturesOff);
  }
  if (!pivotByIndex.empty()) {
    for (auto& it : grouped) {
      if (it.index && pivotByIndex.count(*it.index) != 0) it.pivot = pivotByIndex[*it.index];
    }
  }
  std::vector<DrawItem> boxed;
  if (hasTextPath || laid.lines.empty()) {
    boxed = std::move(grouped);
  } else if (vertical) {
    for (auto& it : grouped) {
      if (!laid.visibleLines || it.line < *laid.visibleLines) boxed.push_back(std::move(it));
    }
  } else {
    std::vector<double> ys;
    ys.reserve(laid.lines.size());
    for (const auto& l : laid.lines) ys.push_back(l.y);
    std::vector<double> lh;
    if (laid.lineLeading) lh = *laid.lineLeading;
    else lh = {laid.height - (laid.lines.back().y - laid.lines.front().y)};
    boxed = fit_items_to_box(std::move(grouped), ys, lh, ex, boxScale);
  }
  std::vector<DrawItem> visible;
  for (auto& it : boxed) {
    if (!is_js_blank(it.text)) visible.push_back(std::move(it));
  }
  paintItems(visible);
}

}  // namespace premation::raster
