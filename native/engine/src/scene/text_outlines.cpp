#include "text_outlines.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <map>
#include <string_view>

#include "css.hpp"
#include "fonts.hpp"
#include "fxstate.hpp"
#include "model.hpp"

namespace premation::scene {
namespace {

using js::Json;

bool has(const Json& spec, std::string_view k) { return !spec.at(k).is_undefined() && !spec.at(k).is_null(); }

std::string css_number(double v) { return js::number_to_string(v); }

/// The lines of the content (`content.split('\n')`).
std::vector<std::string_view> split_lines(std::string_view s) {
  std::vector<std::string_view> out;
  std::size_t start = 0;
  for (;;) {
    const std::size_t nl = s.find('\n', start);
    if (nl == std::string_view::npos) {
      out.push_back(s.substr(start));
      return out;
    }
    out.push_back(s.substr(start, nl - start));
    start = nl + 1;
  }
}

}  // namespace

bool wants_painted_layout(const Json& spec) {
  if (has(spec, "textTransform") || has(spec, "fontVariant") || has(spec, "verticalAlign")) return true;
  if (has(spec, "verticalScale") || has(spec, "horizontalScale") || has(spec, "baselineShift")) return true;
  if (spec.at("textStrokeWidth").is_number() && spec.at("textStrokeWidth").num() > 0) return true;
  if (has(spec, "textExtras")) return true;
  const Json& align = spec.at("align");
  const bool multiLine = spec.at("text").is_string() && spec.at("text").str().find('\n') != std::string::npos;
  return align.is_string() && align.str() != "center" && multiLine;
}

std::string font_variations_of(const doc::Node& n, const MeasuredStyle& s,
                               const std::vector<std::pair<std::string, double>>& sampled) {
  // drawnVariationOf: keyed weight (clamped 1–1000), width, slant over the static props.
  std::string weight = s.fontWeight;
  std::optional<double> width = s.fontWidth;
  std::optional<double> slant = s.fontSlant;
  // resolveFontAxes: the static map, keyed `text.axis.<tag>` values winning.
  std::map<std::string, double> axes;
  const Json stored = doc::read_font_axes_prop(n);
  if (stored.is_object()) {
    for (const auto& [tag, v] : stored.obj()) {
      if (v.is_finite_number()) axes[tag] = v.num();
    }
  }
  for (const auto& [k, v] : sampled) {
    if (!std::isfinite(v)) continue;
    if (k == "fontWeight") weight = css_number(std::max(1.0, std::min(1000.0, v)));
    else if (k == "fontWidth") width = v;
    else if (k == "fontSlant") slant = v;
    else if (const auto tag = doc::parse_axis_prop_path(k); tag && *tag != "wght" && *tag != "wdth" && *tag != "slnt") axes[*tag] = v;
  }
  // fontVariationString (no offsets).
  std::string out;
  const auto part = [&out](std::string_view tag, double v) {
    if (!out.empty()) out += ", ";
    out += "'";
    out += tag;
    out += "' ";
    out += css_number(v);
  };
  const auto w = js::parse(weight);
  if (w && w->is_finite_number()) part("wght", w->num());
  if (width && std::isfinite(*width)) part("wdth", *width);
  if (slant && std::isfinite(*slant)) part("slnt", *slant);
  for (const auto& [tag, v] : axes) part(tag, v);  // std::map: sorted, as the TS sorts the tags
  return out;
}

std::optional<FontOutlines> font_outline_runs(const raster::FontSet& fonts, const MeasuredStyle& s, const std::string& variations) {
  // The painter's font (cssFont(s)): the family, then its fallbacks.
  const std::string style = s.fontStyle == "italic" ? "italic " : "";
  const std::optional<raster::css::Font> font =
      raster::css::parse_font(style + s.fontWeight + " " + css_number(s.fontSize) + "px \"" + s.fontFamily + "\", Inter, system-ui, sans-serif");
  if (!font) return std::nullopt;
  raster::ShapeRequest req;
  req.font = *font;
  req.kerning = true;
  req.variations = variations;
  const std::vector<std::string_view> lines = split_lines(s.content);
  const std::size_t n = lines.size();
  const double gap = s.fontSize * s.lineHeight + s.paragraphSpacing;
  FontOutlines out;
  double widest = 0;
  for (std::size_t li = 0; li < n; ++li) {
    const std::string_view line = lines[li];
    if (line.empty()) continue;
    const raster::ShapedText shaped = fonts.shape(line, req);
    const std::vector<raster::CodePoint> cps = raster::decode_utf8(line);
    const double dy = (static_cast<double>(li) - static_cast<double>(n - 1) / 2) * gap;
    const double spacingTotal = static_cast<double>(std::max<std::size_t>(1, cps.size()) - 1) * s.letterSpacing;
    const double lineWidth = shaped.width + spacingTotal;
    widest = std::max(widest, lineWidth);
    // Centred line (textAlign 'center'); the alphabetic baseline below the
    // `middle` one it is drawn on (BaseRenderingContext2D::GetFontBaseline, float).
    const double penStart = -lineWidth / 2;
    const auto a = static_cast<float>(shaped.emAscent);
    const auto d = static_cast<float>(shaped.emDescent);
    const double baselineY = dy + static_cast<double>((a - d) / 2.0F);
    for (const raster::Glyph& g : shaped.glyphs) {
      // Letter spacing for each gap crossed: the glyph's code-point index.
      const auto ci = static_cast<double>(std::count_if(cps.begin(), cps.end(), [&g](const raster::CodePoint& c) { return c.byte < g.cluster; }));
      const double penX = penStart + g.x + ci * s.letterSpacing;
      const double penY = baselineY + g.y;
      for (const std::vector<raster::OutlineCubic>& contour : fonts.glyph_path(g, shaped)) {
        if (contour.size() < 2) continue;
        // Cubics → anchors: segment i runs from anchor i to anchor i+1 (closed).
        mesh::BezRun run;
        run.open = false;
        const std::size_t m = contour.size();
        run.points.reserve(m);
        for (std::size_t i = 0; i < m; ++i) {
          const raster::OutlineCubic& cur = contour[i];
          const raster::OutlineCubic& prev = contour[(i + m - 1) % m];
          run.points.push_back(mesh::BezPt{penX + cur.x0, penY + cur.y0, penX + prev.c2x, penY + prev.c2y, penX + cur.c1x, penY + cur.c1y});
        }
        out.runs.push_back(std::move(run));
      }
    }
  }
  if (out.runs.empty()) return std::nullopt;
  out.width = widest;
  out.height = static_cast<double>(n) * s.fontSize * s.lineHeight + static_cast<double>(n - 1) * s.paragraphSpacing;
  return out;
}

}  // namespace premation::scene
