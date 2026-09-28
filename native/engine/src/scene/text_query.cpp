#include "text_query.hpp"

#include <algorithm>
#include <cmath>
#include <string_view>

#include "fail.hpp"
#include "text_layout.hpp"

namespace premation::scene {
namespace {

using api::ErrorCode;
using js::Json;

/// measureText.ts SUPER_SUB_SCALE / SUPER_SHIFT / SUB_SHIFT.
constexpr double kSuperSubScale = 0.65;
constexpr double kSuperShift = 0.35;
constexpr double kSubShift = 0.15;

struct StyleScale {
  double sx = 1;
  double sy = 1;
  double dy = 0;
};

/// measureText.ts `textStyleTransform`.
StyleScale text_style_transform(const MeasuredStyle& s) {
  const bool ss = s.verticalAlign == "super" || s.verticalAlign == "sub";
  const double va = ss ? kSuperSubScale : 1;
  StyleScale t;
  t.sx = ((s.horizontalScale && *s.horizontalScale > 0 ? *s.horizontalScale : 100) / 100) * va;
  t.sy = ((s.verticalScale && *s.verticalScale > 0 ? *s.verticalScale : 100) / 100) * va;
  t.dy = -(s.baselineShift && std::isfinite(*s.baselineShift) ? *s.baselineShift : 0);
  if (s.verticalAlign == "super") t.dy -= s.fontSize * kSuperShift;
  else if (s.verticalAlign == "sub") t.dy += s.fontSize * kSubShift;
  return t;
}

/// The node with the query's overrides written onto its LAST component: the
/// TypeScript reads every component, then the override bag, last one winning —
/// the same reading order.
doc::Node with_overrides(const doc::Node& n, const api::TextLayoutOverrides* o) {
  doc::Node c = n;
  if (o == nullptr || c.components.empty()) return c;
  Json& p = c.components.back().props;
  if (o->content) p.set("content", Json::string(*o->content));
  if (o->box_width) p.set("boxWidth", Json::number(*o->box_width));
  if (o->box_height) p.set("boxHeight", Json::number(*o->box_height));
  if (o->box_auto_size) p.set("boxAutoSize", Json::string(*o->box_auto_size));
  if (o->font_size) p.set("fontSize", Json::number(*o->font_size));
  if (o->letter_spacing) p.set("letterSpacing", Json::number(*o->letter_spacing));
  if (o->paragraph_spacing) p.set("paragraphSpacing", Json::number(*o->paragraph_spacing));
  return c;
}

/// textExtras.ts `hasTextPath`.
bool has_text_path(const doc::Node& n) { return n.fx().at("textPath").is_object(); }

/// textExtras.ts `readParagraphBox(node)` (the overrides already on the node / in `nums`).
struct ParagraphBoxProps {
  double boxWidth = 0;
  double boxHeight = 0;
  std::string autoSize;
  std::string verticalAlign = "top";
  bool fixedHeight = false;
};
std::optional<ParagraphBoxProps> read_paragraph_box(const doc::Node& n, const std::vector<std::pair<std::string, double>>& nums) {
  if (has_text_path(n)) return std::nullopt;
  double bw = 0;
  double bh = 0;
  std::string autoSize;
  std::string valign = "top";
  for (const doc::Component& c : n.components) {
    const Json& p = c.props;
    if (p.at("boxWidth").is_finite_number()) bw = p.at("boxWidth").num();
    if (p.at("boxHeight").is_finite_number()) bh = p.at("boxHeight").num();
    if (p.at("boxAutoSize").is_string()) {
      const std::string& a = p.at("boxAutoSize").str();
      if (a == "off" || a == "height" || a == "fit") autoSize = a;
    }
    if (p.at("boxVerticalAlign").is_string()) {
      const std::string& v = p.at("boxVerticalAlign").str();
      if (v == "top" || v == "center" || v == "bottom") valign = v;
    }
  }
  for (const auto& [k, v] : nums) {
    if (k == "boxWidth" && std::isfinite(v)) bw = v;
    else if (k == "boxHeight" && std::isfinite(v)) bh = v;
  }
  if (!(bw > 0)) return std::nullopt;
  ParagraphBoxProps out;
  out.boxWidth = bw;
  out.boxHeight = bh > 0 ? bh : 0;
  out.autoSize = bh > 0 ? (autoSize.empty() ? "off" : autoSize) : "height";
  out.verticalAlign = valign;
  out.fixedHeight = out.autoSize != "height";
  return out;
}

/// measureText.ts `measureParagraphBox` for a WRAPPED horizontal style (boxPlacementOf's uniform-leading branch).
struct ParagraphMeasure {
  double fitScale = 1;
  double boxWidth = 0;
  double boxHeight = 0;
  bool fixedHeight = false;
  bool overflow = false;
  double contentHeight = 0;
  int lineCount = 0;
  int visibleLines = 0;
  double lineOffsetY = 0;
};
ParagraphMeasure measure_paragraph_box(const MeasuredStyle& s) {
  const auto n = static_cast<std::size_t>(std::count(s.content.begin(), s.content.end(), '\n') + 1);
  const double lineHeightPx = s.fontSize * (s.lineHeight != 0 ? s.lineHeight : kDefaultLineHeight);
  const auto [offsets, total] = raster::line_offsets(raster::hard_ends_of(n, s.softBreakLines), lineHeightPx + s.paragraphSpacing,
                                                     s.spaceBefore.value_or(0), s.spaceAfter.value_or(0));
  // Fit Text to Box: the lines are laid out at the unscaled font against box / k, then drawn scaled by k.
  const double k = s.fitScale && *s.fitScale > 0 ? *s.fitScale : 1;
  raster::BoxLinePlacement placement{0, static_cast<int>(n), false};
  if (s.boxHeight) {
    std::vector<double> ys(offsets.size());
    for (std::size_t i = 0; i < offsets.size(); ++i) ys[i] = offsets[i] - total / 2;  // centredLineYs
    placement = raster::place_lines_in_box(ys, std::vector<double>{lineHeightPx}, *s.boxHeight / k, s.boxVerticalAlign);
  }
  ParagraphMeasure out;
  out.fitScale = k;
  out.contentHeight = (total + lineHeightPx) * k;
  out.boxWidth = s.boxWidth.value_or(0);
  out.boxHeight = s.boxHeight ? *s.boxHeight : out.contentHeight;
  out.fixedHeight = s.boxHeight.has_value();
  out.overflow = placement.overflow;
  out.lineCount = static_cast<int>(n);
  out.visibleLines = placement.visible;
  // Auto height with an authored height: the TOP edge of that box stays put.
  out.lineOffsetY = !s.boxHeight && s.boxAnchorHeight ? (out.contentHeight - *s.boxAnchorHeight) / 2 : placement.dy * k;
  return out;
}

/// The last `align` a component stores.
std::string align_of(const doc::Node& n) {
  std::string align;
  for (const doc::Component& c : n.components) {
    if (c.props.at("align").is_string()) align = c.props.at("align").str();
  }
  return align;
}

/// textExtras.ts `firstParagraphDirection(direction, content)` over the node's stored props.
bool first_paragraph_rtl(const doc::Node& n) {
  std::string dir;
  std::string content;
  for (const doc::Component& c : n.components) {
    const Json& d = c.props.at("direction");
    if (d.is_string() && (d.str() == "rtl" || d.str() == "ltr" || d.str() == "auto")) dir = d.str();
    if (c.props.at("content").is_string()) content = c.props.at("content").str();
  }
  if (dir != "auto") return dir == "rtl";
  const std::size_t nl = content.find_first_of("\r\n");
  const std::string_view first = nl == std::string::npos ? std::string_view(content) : std::string_view(content).substr(0, nl);
  return raster::resolve_paragraph_direction("auto", first) == "rtl";
}

/// paragraphBox.ts `lineBlockAnchorX`.
double line_block_anchor_x(const std::string& align, double renderWidth, std::optional<std::pair<double, double>> indents, bool rtl) {
  raster::ResolvedAlign a = raster::resolve_align(align);
  if (rtl && a.line != raster::LineAlign::center) a.line = a.line == raster::LineAlign::left ? raster::LineAlign::right : raster::LineAlign::left;
  const double l = indents ? (rtl ? indents->second : indents->first) : 0;
  const double r = indents ? (rtl ? indents->first : indents->second) : 0;
  if (a.line == raster::LineAlign::left) return -renderWidth / 2 + l;
  if (a.line == raster::LineAlign::right) return renderWidth / 2 - r;
  return (l - r) / 2;
}

/// measureText.ts `measureGlyphBoxes` over the laid-out (wrapped) style `s`: one
/// box per grapheme, logical order, a line break counted in the index but boxed
/// not. Empty when the measurer cannot measure the lines.
std::vector<api::GlyphBox> glyph_boxes(TextMeasurer& m, const MeasuredStyle& s, const std::string& align, bool rtl) {
  std::vector<api::GlyphBox> out;
  const auto lines = m.measure_glyph_lines(s);
  if (!lines || lines->empty()) return out;
  const std::size_t n = lines->size();
  const double lineHeightPx = s.fontSize * (s.lineHeight != 0 ? s.lineHeight : kDefaultLineHeight);
  const double gap = lineHeightPx + s.paragraphSpacing;
  const double paraGap = s.spaceBefore.value_or(0) + s.spaceAfter.value_or(0);
  std::vector<double> offsets;
  double total = 0;
  if (paraGap != 0) {
    auto [off, tot] = raster::line_offsets(raster::hard_ends_of(n, s.softBreakLines), gap, s.spaceBefore.value_or(0), s.spaceAfter.value_or(0));
    offsets = std::move(off);
    total = tot;
  }
  const auto lineDy = [&](std::size_t i) {
    return paraGap != 0 ? -total / 2 + offsets[i] : (static_cast<double>(i) - (static_cast<double>(n) - 1) / 2) * gap;
  };
  double widest = 0;
  for (const GlyphLine& l : *lines) widest = std::max(widest, l.width);
  double left = -widest / 2;
  double right = widest / 2;
  if (s.boxWidth) {
    const double k = s.fitScale && *s.fitScale > 0 ? *s.fitScale : 1;
    const double half = *s.boxWidth / k / 2;
    left = -half + (rtl ? s.rightIndent : s.leftIndent).value_or(0);
    right = half - (rtl ? s.leftIndent : s.rightIndent).value_or(0);
  }
  raster::ResolvedAlign a = raster::resolve_align(align);
  if (rtl && a.line != raster::LineAlign::center) a.line = a.line == raster::LineAlign::left ? raster::LineAlign::right : raster::LineAlign::left;
  std::uint32_t index = 0;
  for (std::size_t i = 0; i < n; ++i) {
    const GlyphLine& l = (*lines)[i];
    const double dy = lineDy(i);
    const double start = a.line == raster::LineAlign::left ? left : a.line == raster::LineAlign::right ? right - l.width : (left + right) / 2 - l.width / 2;
    double pen = 0;
    for (std::size_t j = 0; j < l.pens.size(); ++j) {
      api::GlyphBox g;
      g.index = index + static_cast<std::uint32_t>(j);
      g.line = static_cast<std::uint32_t>(i);
      g.box = api::Rect{start + pen, dy - l.ascent, l.pens[j] - pen, l.ascent + l.descent};
      g.baseline = dy;
      g.advance = l.pens[j] - pen;
      out.push_back(g);
      pen = l.pens[j];
    }
    index += static_cast<std::uint32_t>(l.pens.size()) + 1;  // the line break
  }
  return out;
}

[[noreturn]] void outside_port(const std::string& why) {
  doc::fail(ErrorCode::unsupported, "this text style is outside the engine's text port" + (why.empty() ? std::string() : ": " + why));
}

/// The style as laid out: paragraph text wrapped (soft breaks recorded), point text as read.
MeasuredStyle laid_out(TextMeasurer& m, const MeasuredStyle& s) {
  if (!s.boxWidth) return s;
  if (s.vertical) outside_port("vertical paragraph text");
  if (s.hasLineRuns) outside_port("character runs that change a line's size or leading");
  std::string why;
  auto w = m.wrapped_style(s, &why);
  if (!w) outside_port(why);
  return *w;
}

/// measureTextSize, with an anchored auto-height box's offset added (the port's
/// measurer leaves anchored boxes out: its height is rounded before the offset
/// here, so it can read 1 px taller than the TypeScript's).
std::optional<std::pair<double, double>> render_size(TextMeasurer& m, const MeasuredStyle& s) {
  if (s.boxWidth && !s.boxHeight && s.boxAnchorHeight) {
    MeasuredStyle plain = s;
    plain.boxAnchorHeight.reset();
    auto size = m.measure_text_size(plain);
    if (!size) return std::nullopt;
    const double anchorDy = std::abs(measure_paragraph_box(s).lineOffsetY);
    size->second = std::max(16.0, size->second + std::ceil(anchorDy * 2));
    return size;
  }
  return m.measure_text_size(s);
}

}  // namespace

api::TextLayout text_layout_of(TextMeasurer& m, const doc::Node& original, const api::TextLayoutOverrides* overrides) {
  const doc::Node n = with_overrides(original, overrides);
  const std::optional<MeasuredStyle> read = read_measured_text_style(n, {});
  if (!read) doc::fail(ErrorCode::invalid_argument, "text layer '" + n.id + "' has no content", {.layer = n.id});
  if (read->vertical) outside_port("vertical type");
  const MeasuredStyle s = laid_out(m, *read);
  const auto size = render_size(m, s);
  const auto font = m.measure_font_box(s);
  if (!size || !font) outside_port("");

  const StyleScale tr = text_style_transform(s);
  const std::optional<ParagraphBoxProps> pbox = read_paragraph_box(n, {});
  const std::optional<ParagraphMeasure> para = s.boxWidth ? std::optional<ParagraphMeasure>(measure_paragraph_box(s)) : std::nullopt;

  api::TextLayout out;
  out.lines = static_cast<std::uint32_t>(std::count(s.content.begin(), s.content.end(), '\n') + 1);
  out.box = api::Rect{-font->halfWidth, font->top, font->halfWidth * 2, font->bottom - font->top};
  out.size = api::Vec2{size->first, size->second};
  out.wrapped = s.content;
  if (s.softBreakLines) {
    for (const int l : *s.softBreakLines) out.soft_breaks.push_back(static_cast<std::uint32_t>(std::max(0, l)));
  }
  if (para && pbox) {
    api::ParagraphLayout p;
    p.box_width = para->boxWidth;
    p.box_height = para->boxHeight;
    p.fixed_height = para->fixedHeight;
    p.overflow = para->overflow;
    p.fit_scale = para->fitScale;
    p.content_height = para->contentHeight;
    p.line_count = static_cast<std::uint32_t>(para->lineCount);
    p.visible_lines = static_cast<std::uint32_t>(std::max(0, para->visibleLines));
    p.line_offset_y = para->lineOffsetY;
    p.auto_size = pbox->autoSize;
    p.vertical_align = pbox->verticalAlign;
    p.stored_height = pbox->boxHeight;
    out.paragraph = std::move(p);
  }
  // paragraphTextCommands' lineBlockPlacement: where the lines start and how far the block sits off centre.
  const std::optional<std::pair<double, double>> indents =
      s.boxWidth ? std::optional<std::pair<double, double>>({s.leftIndent.value_or(0) * (para ? para->fitScale : 1), s.rightIndent.value_or(0) * (para ? para->fitScale : 1)})
                 : std::nullopt;
  out.line_block.x = tr.sx * line_block_anchor_x(align_of(n), size->first, indents, first_paragraph_rtl(n));
  out.line_block.y = para ? (para->fixedHeight ? tr.sy * para->lineOffsetY : para->lineOffsetY) : 0;
  out.style_scale = api::Vec2{tr.sx, tr.sy};
  out.on_path = has_text_path(n);
  // B4 round 5: per-grapheme boxes (none for text on a path: its glyphs ride the curve).
  if (!out.on_path) out.glyphs = glyph_boxes(m, s, align_of(n), first_paragraph_rtl(n));
  out.font_size = s.fontSize;  // the stored size: a Fit Text to Box bake multiplies it by paragraph.fitScale
  out.letter_spacing = s.letterSpacing;
  out.paragraph_spacing = s.paragraphSpacing;
  return out;
}

std::optional<TextGeometry> text_geometry_of(TextMeasurer& m, const doc::Node& n,
                                             const std::vector<std::pair<std::string, double>>& overrides) {
  const std::optional<MeasuredStyle> read = read_measured_text_style(n, overrides);
  if (!read || read->vertical) return std::nullopt;
  const bool onPath = has_text_path(n);
  // The AUTHORED box width (paragraph text): the override, else the first component's.
  std::optional<double> authored;
  if (!onPath) {
    for (const auto& [k, v] : overrides) {
      if (k == "boxWidth" && v > 0) authored = v;
    }
    if (!authored) {
      for (const doc::Component& c : n.components) {
        const Json& v = c.props.at("boxWidth");
        if (v.is_number() && v.num() > 0) {
          authored = v.num();
          break;
        }
      }
    }
  }
  const std::optional<ParagraphBoxProps> box = read_paragraph_box(n, overrides);
  // A FIXED box is authored in both directions: the box itself, centred on the origin.
  if (box && box->fixedHeight) return TextGeometry{box->boxWidth, box->boxHeight, 0};
  MeasuredStyle s = *read;
  if (s.boxWidth) {
    if (s.hasLineRuns) return std::nullopt;
    auto w = m.wrapped_style(s, nullptr);
    if (!w) return std::nullopt;
    s = std::move(*w);
  }
  const auto font = m.measure_font_box(s);
  if (!font) return std::nullopt;
  // An AUTO-HEIGHT box with an authored height keeps that box's top edge: its text sits `lineOffsetY` below.
  const double anchored = box && box->boxHeight > 0 && s.boxWidth ? measure_paragraph_box(s).lineOffsetY : 0;
  TextGeometry g;
  g.width = authored.value_or(font->halfWidth * 2);
  g.height = font->bottom - font->top;
  g.dy = (font->top + font->bottom) / 2 + anchored;
  return g;
}

}  // namespace premation::scene
