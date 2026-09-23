#include "text_layout.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string_view>
#include <utility>

#include "numconv.hpp"
#include "text_unicode.hpp"

namespace premation::raster {
namespace {

#include "vertical_orientation.inc"

std::optional<double> opt_num(const json::Value& v) {
  if (v.is_number()) return v.num();
  return std::nullopt;
}
std::optional<std::string> opt_str(const json::Value& v) {
  if (v.is_string()) return v.str();
  return std::nullopt;
}
std::string num_str(double v) { return motion::js::number_to_string(v); }

}  // namespace

// ── textExtras.ts ────────────────────────────────────────────────────────────

TextExtras read_text_extras(const json::Value& v) {
  TextExtras x;
  if (!v.is_object()) return x;
  x.leftIndent = opt_num(v["leftIndent"]);
  x.rightIndent = opt_num(v["rightIndent"]);
  x.firstLineIndent = opt_num(v["firstLineIndent"]);
  x.spaceBefore = opt_num(v["spaceBefore"]);
  x.spaceAfter = opt_num(v["spaceAfter"]);
  if (v["softBreakLines"].is_array()) {
    std::vector<int> s;
    for (const auto& n : v["softBreakLines"].items()) s.push_back(static_cast<int>(n.num()));
    x.softBreakLines = std::move(s);
  }
  x.strokeLineJoin = v["strokeLineJoin"].str_or("");
  x.strokeOrder = v["strokeOrder"].str_or("");
  x.fauxBold = v["fauxBold"].truthy();
  x.fauxItalic = v["fauxItalic"].truthy();
  x.noFill = v["noFill"].truthy();
  x.noStroke = v["noStroke"].truthy();
  x.kerningMode = v["kerningMode"].str_or("");
  x.boxHeight = opt_num(v["boxHeight"]);
  x.boxVerticalAlign = v["boxVerticalAlign"].str_or("");
  x.fitScale = opt_num(v["fitScale"]);
  x.anchorGrouping = v["anchorGrouping"].str_or("");
  if (v["groupingAlign"].is_array()) x.groupingAlign = std::make_pair(v["groupingAlign"][0].num(0), v["groupingAlign"][1].num(0));
  x.fillStrokeMode = v["fillStrokeMode"].str_or("");
  x.interCharacterBlending = v["interCharacterBlending"].str_or("");
  x.ligaturesOff = v["ligatures"].is_bool() && !v["ligatures"].truthy();
  x.discretionaryLigatures = v["discretionaryLigatures"].truthy();
  x.contextualAlternatesOff = v["contextualAlternates"].is_bool() && !v["contextualAlternates"].truthy();
  for (const auto& n : v["stylisticSets"].items()) x.stylisticSets.push_back(static_cast<int>(n.num()));
  x.direction = v["direction"].str_or("");
  x.vertical = v["orientation"].str_or("") == "vertical";
  x.verticalRomanAlignment = v["verticalRomanAlignment"].truthy();
  if (v["tateChuYokoDigits"].is_number()) x.tateChuYokoDigits = static_cast<int>(v["tateChuYokoDigits"].num());
  x.boxOffsetY = opt_num(v["boxOffsetY"]);
  return x;
}

ResolvedAlign resolve_align(const std::string& align) {
  if (align == "center") return {LineAlign::center, false, false};
  if (align == "right") return {LineAlign::right, false, false};
  if (align == "justify" || align == "justify-left") return {LineAlign::left, true, false};
  if (align == "justify-center") return {LineAlign::center, true, false};
  if (align == "justify-right") return {LineAlign::right, true, false};
  if (align == "justify-all") return {LineAlign::left, true, true};
  return {LineAlign::left, false, false};
}

bool is_justifiable_space(const std::string& c) { return c == " " || c == "\xC2\xA0" || c == "\xE3\x80\x80"; }

LinePlacement place_line(const LineFacts& line, const ParagraphFrame& frame) {
  const bool rtl = frame.rtl;
  ResolvedAlign a = resolve_align(frame.align);
  if (rtl && a.line != LineAlign::center) a.line = a.line == LineAlign::left ? LineAlign::right : LineAlign::left;
  const double halfW = frame.boxWidth / 2;
  const double startIndent = frame.boxText
                                 ? frame.leftIndent.value_or(0) + (line.paragraphStart ? frame.firstLineIndent.value_or(0) : 0)
                                 : 0;
  const double endIndent = frame.boxText ? frame.rightIndent.value_or(0) : 0;
  const double indentL = rtl ? endIndent : startIndent;
  const double indentR = rtl ? startIndent : endIndent;
  const double L = -halfW + frame.padX + indentL;
  const double R = halfW - frame.padX - indentR;
  const bool stretch = frame.boxText && a.justify && (!line.hardEnd || a.justifyLast) && line.spaces > 0 && R - L > line.width;
  if (stretch) return {L, L, LineAlign::left, (R - L - line.width) / line.spaces};
  if (a.line == LineAlign::center) {
    const double anchor = (L + R) / 2;
    return {anchor - line.width / 2, anchor, LineAlign::center, 0};
  }
  if (a.line == LineAlign::right) return {R - line.width, R, LineAlign::right, 0};
  return {L, L, LineAlign::left, 0};
}

std::pair<std::vector<double>, double> line_offsets(const std::vector<bool>& hardEnds, double baseGap, double spaceBefore,
                                                    double spaceAfter) {
  const std::size_t n = std::max<std::size_t>(1, hardEnds.size());
  std::vector<double> offsets(n);
  const double para = spaceBefore + spaceAfter;
  double extra = 0;
  for (std::size_t i = 0; i < n; ++i) {
    if (i > 0 && para != 0 && hardEnds[i - 1]) extra += para;
    offsets[i] = static_cast<double>(i) * baseGap + extra;
  }
  return {offsets, offsets[n - 1]};
}

std::vector<bool> hard_ends_of(std::size_t lineCount, const std::optional<std::vector<int>>& soft) {
  std::vector<bool> out(lineCount);
  for (std::size_t i = 0; i < lineCount; ++i) {
    bool isSoft = false;
    if (soft) isSoft = std::find(soft->begin(), soft->end(), static_cast<int>(i)) != soft->end();
    out[i] = i == lineCount - 1 || !isSoft;
  }
  return out;
}

BoxLinePlacement place_lines_in_box(const std::vector<double>& lineYs, const std::vector<double>& lineHeightPx,
                                    double boxHeight, const std::string& verticalAlign) {
  const std::size_t n = lineYs.size();
  if (n == 0) return {};
  const auto lh = [&](std::size_t i) {
    if (lineHeightPx.size() == 1) return lineHeightPx[0];
    if (i < lineHeightPx.size()) return lineHeightPx[i];
    return lineHeightPx.empty() ? 0.0 : lineHeightPx.back();
  };
  const double half = boxHeight / 2;
  const double top = lineYs[0] - lh(0) / 2;
  const double bottom = lineYs[n - 1] + lh(n - 1) / 2;
  const bool overflow = bottom - top > boxHeight + 0.5;
  double dy = 0;
  if (overflow || verticalAlign.empty() || verticalAlign == "top") dy = -half - top;
  else if (verticalAlign == "center") dy = -(top + bottom) / 2;
  else dy = half - bottom;
  int visible = 0;
  for (std::size_t i = 0; i < n; ++i) {
    if (lineYs[i] + dy + lh(i) / 2 <= half + 0.5) visible = static_cast<int>(i) + 1;
    else break;
  }
  return {dy, visible, overflow};
}

std::string_view resolve_paragraph_direction(std::string_view direction, std::string_view paragraphText) {
  if (direction == "rtl") return "rtl";
  if (direction == "auto") return paragraph_level_of(paragraphText) == 1 ? "rtl" : "ltr";
  return "ltr";
}

// ── unicode data ─────────────────────────────────────────────────────────────

char vertical_orientation_of(char32_t cp) {
  const auto it = std::ranges::upper_bound(kVoStarts, cp);
  if (it == kVoStarts.begin()) return 'R';
  const auto i = static_cast<std::size_t>(it - kVoStarts.begin() - 1);
  return i < kVoValues.size() ? kVoValues[i] : 'R';
}

bool is_ideographic_unit(const std::string& unit) {
  if (unit.empty() || unit == " " || unit == "\t") return false;
  return vertical_orientation_of(code_points(unit).front()) != 'R';
}

// ── textLayout.ts ────────────────────────────────────────────────────────────

TextStyle TextStyle::merged(const json::Value& r) const {
  TextStyle s = *this;
  if (!r.is_object()) return s;
  for (const auto& k : r.keys()) {
    const json::Value& v = r[k];
    if (k == "fontSize") s.fontSize = v.num(std::nan(""));
    else if (k == "fontFamily") s.fontFamily = opt_str(v);
    else if (k == "fontWeight") s.fontWeight = v.is_number() ? std::optional<std::string>(num_str(v.num())) : opt_str(v);
    else if (k == "fontStyle") s.fontStyle = opt_str(v);
    else if (k == "fill") s.fill = opt_str(v);
    else if (k == "strokeColor") s.strokeColor = opt_str(v);
    else if (k == "verticalAlign") s.verticalAlign = opt_str(v);
    else if (k == "letterSpacing") s.letterSpacing = opt_num(v);
    else if (k == "kerning") s.kerning = opt_num(v);
    else if (k == "strokeWidth") s.strokeWidth = opt_num(v);
    else if (k == "lineHeight") s.lineHeight = opt_num(v);
    else if (k == "horizontalScale") s.horizontalScale = opt_num(v);
    else if (k == "verticalScale") s.verticalScale = opt_num(v);
    else if (k == "baselineShift") s.baselineShift = opt_num(v);
    else if (k == "tsume") s.tsume = opt_num(v);
    else if (k == "fauxBold") s.fauxBold = v.truthy();
    else if (k == "fauxItalic") s.fauxItalic = v.truthy();
    else if (k == "allCaps") s.allCaps = v.truthy();
    else if (k == "smallCaps") s.smallCaps = v.truthy();
    else if (k == "tateChuYoko") s.tateChuYoko = v.truthy();
  }
  return s;
}

GlyphTransform read_glyph_transform(const json::Value& v) {
  GlyphTransform t;
  t.ch = v["char"].str();
  t.displayChar = v["displayChar"].is_string() ? v["displayChar"].str() : t.ch;
  t.dx = v["dx"].num(0);
  t.dy = v["dy"].num(0);
  t.dz = v["dz"].num(0);
  t.rotationX = v["rotationX"].num(0);
  t.rotationY = v["rotationY"].num(0);
  t.scale = v["scale"].num(1);
  t.scaleY = v["scaleY"].num(1);
  t.rotation = v["rotation"].num(0);
  t.opacity = v["opacity"].num(1);
  t.fillOpacity = v["fillOpacity"].num(1);
  t.tracking = v["tracking"].num(0);
  t.lineSpacing = v["lineSpacing"].num(0);
  t.blur = v["blur"].num(0);
  t.skew = v["skew"].num(0);
  t.strokeWidth = v["strokeWidth"].num(0);
  t.blurY = opt_num(v["blurY"]);
  t.colorMix = opt_num(v["colorMix"]);
  t.strokeColorMix = opt_num(v["strokeColorMix"]);
  t.anchorX = opt_num(v["anchorX"]);
  t.anchorY = opt_num(v["anchorY"]);
  t.skewAxis = opt_num(v["skewAxis"]);
  t.trackingBefore = opt_num(v["trackingBefore"]);
  t.fillHue = opt_num(v["fillHue"]);
  t.fillSaturation = opt_num(v["fillSaturation"]);
  t.fillBrightness = opt_num(v["fillBrightness"]);
  t.strokeOpacity = opt_num(v["strokeOpacity"]);
  t.strokeHue = opt_num(v["strokeHue"]);
  t.strokeSaturation = opt_num(v["strokeSaturation"]);
  t.strokeBrightness = opt_num(v["strokeBrightness"]);
  t.lineAnchor = opt_num(v["lineAnchor"]);
  t.color = opt_str(v["color"]);
  t.strokeColor = opt_str(v["strokeColor"]);
  if (v["axes"].is_object() && v["axes"].size() > 0) {
    std::map<std::string, double> ax;
    for (const auto& k : v["axes"].keys()) ax[k] = v["axes"][k].num(0);
    t.axes = std::move(ax);
  }
  return t;
}

namespace {
bool nz(const std::optional<double>& v) { return v.has_value() && *v != 0 && !std::isnan(*v); }
}  // namespace

bool is_identity_transform(const GlyphTransform& t) {
  return t.dx == 0 && t.dy == 0 && t.dz == 0 && t.rotationX == 0 && t.rotationY == 0 && t.scale == 1 && t.scaleY == 1 &&
         t.rotation == 0 && t.opacity == 1 && t.fillOpacity == 1 && t.tracking == 0 && t.lineSpacing == 0 && t.blur == 0 &&
         !nz(t.blurY) && t.skew == 0 && t.strokeWidth == 0 && !(t.color && t.colorMix.value_or(0) > 0) &&
         !(t.strokeColor && t.strokeColorMix.value_or(0) > 0) && t.displayChar == t.ch && !nz(t.anchorX) &&
         !nz(t.anchorY) && !nz(t.skewAxis) && !nz(t.trackingBefore) && !nz(t.fillHue) && !nz(t.fillSaturation) &&
         !nz(t.fillBrightness) && (!t.strokeOpacity || *t.strokeOpacity == 1) && !nz(t.strokeHue) &&
         !nz(t.strokeSaturation) && !nz(t.strokeBrightness) && !(t.axes && !t.axes->empty());
}

TextStyle resolve_glyph_style(const TextStyle& base, const std::vector<RichRun>* runs, int index) {
  if (runs == nullptr || runs->empty()) return base;
  TextStyle s = base;
  for (const auto& r : *runs) {
    if (index >= r.start && index < r.end && r.style != nullptr) s = s.merged(*r.style);
  }
  return s;
}

namespace {

constexpr double kRangeSuperSubScale = 0.65;
constexpr double kRangeSuperShift = 0.35;
constexpr double kRangeSubShift = 0.15;

std::string axes_json(const std::optional<std::map<std::string, double>>& a) {
  if (!a) return "";
  std::string s = "{";
  bool first = true;
  for (const auto& [k, v] : *a) {
    if (!first) s += ',';
    first = false;
    s += "\"" + k + "\":" + num_str(v);
  }
  return s + "}";
}

std::string metric_key(const TextStyle& s) {
  return s.fontStyle.value_or("") + "|" + s.fontWeight.value_or("") + "|" + num_str(s.fontSize) + "|" +
         s.fontFamily.value_or("") + "|" + num_str(s.letterSpacing.value_or(0)) + "|" + (s.smallCaps ? "sc" : "") + "|" +
         (s.horizontalScale ? num_str(*s.horizontalScale) : "") + "|" + s.verticalAlign.value_or("") + "|" +
         (s.tsume ? num_str(*s.tsume) : "") + "|" + axes_json(s.axisOffsets);
}

int last_non_space(const std::vector<std::string>& clusters) {
  for (int i = static_cast<int>(clusters.size()) - 1; i >= 0; --i) {
    if (!is_justifiable_space(clusters[static_cast<std::size_t>(i)])) return i;
  }
  return -1;
}

struct StackResult {
  std::vector<double> offsets;
  double total = 0;
  double lineHeightPx = 0;
  std::optional<std::vector<double>> lineLeading;
};

StackResult stack_lines(const std::vector<std::vector<const TextStyle*>>& lines, const TextStyle& base,
                        const std::optional<std::vector<int>>& soft, bool perRangeLeading) {
  const double lineHeightMul = base.lineHeight.value_or(kAutoLeading);
  const double paragraphSpacing = base.paragraphSpacing.value_or(0);
  const double baseLeading = (base.fontSize != 0 && !std::isnan(base.fontSize) ? base.fontSize : 0) * lineHeightMul;
  double lineHeightPx = baseLeading;
  for (const auto& line : lines) {
    for (const TextStyle* g : line) {
      lineHeightPx = std::max(lineHeightPx, g->fontSize * (perRangeLeading ? g->lineHeight.value_or(lineHeightMul) : lineHeightMul));
    }
  }
  const auto hardEnds = hard_ends_of(lines.size(), soft);
  StackResult r;
  r.lineHeightPx = lineHeightPx;
  if (!perRangeLeading) {
    auto [off, tot] = line_offsets(hardEnds, lineHeightPx + paragraphSpacing, base.spaceBefore.value_or(0), base.spaceAfter.value_or(0));
    r.offsets = std::move(off);
    r.total = tot;
    return r;
  }
  const std::size_t n = std::max<std::size_t>(1, lines.size());
  r.offsets.assign(n, 0);
  const double para = base.spaceBefore.value_or(0) + base.spaceAfter.value_or(0);
  const auto leadingOf = [&](const std::vector<const TextStyle*>& line) {
    if (line.empty()) return baseLeading;
    double m = 0;
    for (const TextStyle* g : line) m = std::max(m, g->fontSize * g->lineHeight.value_or(lineHeightMul));
    return m;
  };
  for (std::size_t i = 1; i < n; ++i) {
    const double leading = i < lines.size() ? leadingOf(lines[i]) : baseLeading;
    r.offsets[i] = r.offsets[i - 1] + leading + paragraphSpacing + (para != 0 && hardEnds[i - 1] ? para : 0);
  }
  r.total = r.offsets[n - 1];
  std::vector<double> ll;
  ll.reserve(lines.size());
  for (const auto& line : lines) ll.push_back(leadingOf(line));
  r.lineLeading = std::move(ll);
  return r;
}

}  // namespace

StyleScale glyph_style_scale(const TextStyle& s) {
  const bool ss = s.verticalAlign && (*s.verticalAlign == "super" || *s.verticalAlign == "sub");
  const double va = ss ? kRangeSuperSubScale : 1;
  StyleScale o;
  o.sx = ((s.horizontalScale && *s.horizontalScale > 0 ? *s.horizontalScale : 100) / 100) * va;
  o.sy = ((s.verticalScale && *s.verticalScale > 0 ? *s.verticalScale : 100) / 100) * va;
  double dy = s.baselineShift && std::isfinite(*s.baselineShift) && *s.baselineShift != 0 ? -*s.baselineShift : 0;
  if (s.verticalAlign && *s.verticalAlign == "super") dy -= s.fontSize * kRangeSuperShift;
  else if (s.verticalAlign && *s.verticalAlign == "sub") dy += s.fontSize * kRangeSubShift;
  o.dy = dy;
  return o;
}

std::vector<LineBidi> paragraph_bidi_lines(const std::vector<std::vector<std::string>>& lines,
                                           const std::vector<bool>& hardEnds, const std::string& direction) {
  std::vector<LineBidi> out;
  std::size_t start = 0;
  for (std::size_t li = 0; li < lines.size(); ++li) {
    if (!hardEnds[li] && li < lines.size() - 1) continue;
    std::vector<std::string> seq;
    std::vector<std::size_t> from;
    for (std::size_t k = start; k <= li; ++k) {
      if (k > start) {
        const auto& prev = lines[k - 1];
        const bool inserted = !prev.empty() && !lines[k].empty() &&
                              (is_ideographic_unit(prev.back()) || is_ideographic_unit(lines[k].front()));
        if (!inserted) seq.emplace_back(" ");
      }
      from.push_back(seq.size());
      for (const auto& c : lines[k]) seq.push_back(c);
    }
    const BidiResolution br = cluster_bidi(seq, direction == "rtl" ? 1 : -1);
    for (std::size_t k = start; k <= li; ++k) {
      const auto& line = lines[k];
      const std::size_t at = from[k - start];
      std::vector<int> lv(br.levels.begin() + static_cast<std::ptrdiff_t>(std::min(at, br.levels.size())),
                          br.levels.begin() + static_cast<std::ptrdiff_t>(std::min(at + line.size(), br.levels.size())));
      reset_line_end(line, lv, br.paragraphLevel);
      const bool plain = direction == "auto" && br.paragraphLevel == 0 &&
                         std::ranges::all_of(lv, [](int l) { return l == 0; });
      LineBidi b;
      b.rtl = br.paragraphLevel == 1;
      if (!plain) b.levels = std::move(lv);
      out.push_back(std::move(b));
    }
    start = li + 1;
  }
  return out;
}

namespace {
std::vector<std::vector<std::string>> grapheme_lines(const std::string& text) {
  std::vector<std::vector<std::string>> lines(1);
  for (auto& c : split_graphemes(text)) {
    if (is_line_break(c)) lines.emplace_back();
    else lines.back().push_back(std::move(c));
  }
  return lines;
}
}  // namespace

bool soft_wrap_changes_bidi(const std::string& text, const std::optional<std::vector<int>>& soft, const std::string& direction) {
  if (!soft || soft->empty() || !has_strong_rtl(text)) return false;
  const auto lines = grapheme_lines(text);
  const auto para = paragraph_bidi_lines(lines, hard_ends_of(lines.size(), soft), direction);
  for (std::size_t i = 0; i < para.size(); ++i) {
    const auto& line = lines[i];
    if (line.empty()) continue;
    const auto own = cluster_bidi(line, para[i].rtl ? 1 : 0).levels;
    for (std::size_t j = 0; j < own.size(); ++j) {
      const auto& paraLevels = para[i].levels;
      const int want = paraLevels.has_value() ? paraLevels->at(j) : 0;
      if (own[j] != want) return true;
    }
  }
  return false;
}

TextLayout layout_text(const std::string& text, const TextStyle& base, const MeasureGlyph& measure, const LayoutOptions& opts) {
  const std::vector<std::string> chars = split_graphemes(text);
  const auto styleAt = [&](std::size_t i) {
    TextStyle s = resolve_glyph_style(base, opts.runs, static_cast<int>(i));
    if (opts.transforms != nullptr && i < opts.transforms->size()) {
      const auto& ax = (*opts.transforms)[i].axes;
      if (ax && !ax->empty()) s.axisOffsets = ax;
    }
    return s;
  };
  const auto transformAt = [&](std::size_t i) -> const GlyphTransform* {
    return opts.transforms != nullptr && i < opts.transforms->size() ? &(*opts.transforms)[i] : nullptr;
  };
  const auto drawnAt = [&](std::size_t i) {
    const GlyphTransform* t = transformAt(i);
    std::string d = t != nullptr ? t->displayChar : chars[i];
    if (opts.runs != nullptr && resolve_glyph_style(base, opts.runs, static_cast<int>(i)).allCaps) d = to_upper(d);
    return d;
  };
  bool perRangeLeading = false;
  if (opts.runs != nullptr) {
    for (const auto& r : *opts.runs) perRangeLeading = perRangeLeading || (r.style != nullptr && r.style->has("lineHeight"));
  }

  std::vector<std::optional<double>> kerned;
  if (opts.measureRun) {
    kerned.assign(chars.size(), std::nullopt);
    std::size_t spanStart = 0;
    const auto flush = [&](std::size_t end) {
      if (end <= spanStart) return;
      const TextStyle style = styleAt(spanStart);
      double prev = 0;
      std::string sofar;
      for (std::size_t i = spanStart; i < end; ++i) {
        sofar += drawnAt(i);
        const double w = opts.measureRun(sofar, style);
        kerned[i] = w - prev;
        prev = w;
      }
    };
    std::string spanKey = chars.empty() ? "" : metric_key(styleAt(0));
    for (std::size_t i = 0; i <= chars.size(); ++i) {
      const bool atEnd = i == chars.size();
      const bool broken = atEnd || is_line_break(chars[i]);
      const std::string key = !atEnd && !broken ? metric_key(styleAt(i)) : spanKey;
      const bool styleChanged = !atEnd && !broken && i > spanStart && key != spanKey;
      if (broken || styleChanged) {
        flush(i);
        spanStart = broken && !atEnd ? i + 1 : i;
        if (!atEnd && spanStart < chars.size()) spanKey = metric_key(styleAt(spanStart));
      }
    }
  }

  struct Pending {  // NOLINT(bugprone-exception-escape): implicit special members only move strings; bad_alloc terminates by design
    std::string ch, drawn;
    int index = 0;
    double advance = 0, inkWidth = 0;
    TextStyle style;
    const GlyphTransform* transform = nullptr;
    double shiftX = 0, shiftY = 0;
  };
  std::vector<std::vector<Pending>> lines(1);
  for (std::size_t i = 0; i < chars.size(); ++i) {
    if (is_line_break(chars[i])) {
      lines.emplace_back();
      continue;
    }
    Pending p;
    p.ch = chars[i];
    p.index = static_cast<int>(i);
    p.style = styleAt(i);
    p.transform = transformAt(i);
    p.drawn = drawnAt(i);
    const double tracking = p.transform != nullptr ? p.transform->tracking : 0;
    const std::optional<double> kern = kerned.empty() ? std::nullopt : kerned[i];
    double advance = kern.has_value() ? *kern + tracking : measure(p.drawn, p.style) + p.style.letterSpacing.value_or(0) + tracking;
    double inkWidth = measure(p.drawn, p.style);
    double shiftX = p.transform != nullptr ? p.transform->trackingBefore.value_or(0) : 0;
    const StyleScale gs = glyph_style_scale(p.style);
    if (gs.sx != 1) {
      advance = (advance - tracking) * gs.sx + tracking;
      inkWidth *= gs.sx;
    }
    if (p.style.tsume && *p.style.tsume != 0 && opts.measureBearings) {
      const Bearings b = opts.measureBearings(p.drawn, p.style);
      const double t = std::max(0.0, std::min(100.0, *p.style.tsume)) / 100;
      const double l = std::max(0.0, b.left) * t * gs.sx;
      const double r = std::max(0.0, b.right) * t * gs.sx;
      shiftX -= l;
      advance -= l + r;
    }
    p.advance = advance;
    p.inkWidth = inkWidth;
    p.shiftX = shiftX;
    p.shiftY = gs.dy;
    lines.back().push_back(std::move(p));
  }

  const bool optical = opts.kerningMode == "optical" && static_cast<bool>(opts.opticalKern);
  for (auto& line : lines) {
    for (std::size_t j = 0; j + 1 < line.size(); ++j) {
      Pending& g = line[j];
      const Pending& next = line[j + 1];
      if (g.style.kerning && *g.style.kerning != 0 && !std::isnan(*g.style.kerning)) g.advance += (*g.style.kerning / 1000) * g.style.fontSize;
      if (optical && !is_js_blank(g.drawn) && !is_js_blank(next.drawn)) {
        g.advance += opts.opticalKern(g.drawn, g.style, next.drawn, next.style) * glyph_style_scale(g.style).sx;
      }
    }
  }

  const auto hardEnds = hard_ends_of(lines.size(), opts.softBreakLines);
  std::vector<std::vector<const TextStyle*>> styleLines;
  for (const auto& line : lines) {
    std::vector<const TextStyle*> sl;
    for (const auto& g : line) sl.push_back(&g.style);
    styleLines.push_back(std::move(sl));
  }
  const StackResult stack = stack_lines(styleLines, base, opts.softBreakLines, perRangeLeading);
  const double startY = -stack.total / 2;
  ParagraphFrame frame;
  frame.boxWidth = opts.boxWidth;
  frame.padX = opts.padX;
  frame.boxText = opts.softBreakLines.has_value();
  frame.align = base.align;
  frame.leftIndent = base.leftIndent;
  frame.rightIndent = base.rightIndent;
  frame.firstLineIndent = base.firstLineIndent;
  ParagraphFrame frameRtl = frame;
  frameRtl.rtl = true;
  std::vector<LineBidi> lineBidi;
  const bool bidi = opts.direction == "rtl" || opts.direction == "auto";
  if (bidi) {
    std::vector<std::vector<std::string>> cl;
    for (const auto& line : lines) {
      std::vector<std::string> c;
      for (const auto& g : line) c.push_back(g.ch);
      cl.push_back(std::move(c));
    }
    lineBidi = paragraph_bidi_lines(cl, hardEnds, opts.direction);
  }

  TextLayout out;
  double widest = 0;
  for (std::size_t li = 0; li < lines.size(); ++li) {
    const auto& line = lines[li];
    double lineWidth = 0;
    for (const auto& g : line) lineWidth += g.advance;
    std::vector<std::string> clusters;
    clusters.reserve(line.size());
    for (const auto& g : line) clusters.push_back(g.ch);
    const int lastInk = last_non_space(clusters);
    int spaces = 0;
    for (std::size_t j = 0; j < line.size(); ++j) {
      if (std::cmp_less(j, lastInk) && is_justifiable_space(line[j].ch)) ++spaces;
    }
    const double y = startY + stack.offsets[li];
    const Pending* anchored = nullptr;
    for (const auto& g : line) {
      if (g.transform != nullptr && g.transform->lineAnchor.has_value()) { anchored = &g; break; }
    }
    double trackExtra = 0;
    if (anchored != nullptr) {
      for (const auto& g : line) trackExtra += g.transform != nullptr ? g.transform->tracking : 0;
    }
    const LineBidi* lb = bidi && li < lineBidi.size() ? &lineBidi[li] : nullptr;
    const LinePlacement placed = place_line(
        {anchored != nullptr ? lineWidth - trackExtra : lineWidth, spaces, hardEnds[li], li == 0 || hardEnds[li - 1]},
        lb != nullptr && lb->rtl ? frameRtl : frame);
    double pen = anchored != nullptr ? placed.left - trackExtra * anchored->transform->lineAnchor.value_or(0) : placed.left;
    const double lineLeft = pen;
    const std::vector<int>* levels = lb != nullptr && lb->levels ? &*lb->levels : nullptr;
    std::vector<int> order;
    if (levels != nullptr) order = visual_order(*levels);
    for (std::size_t k = 0; k < line.size(); ++k) {
      const std::size_t j = levels != nullptr ? static_cast<std::size_t>(order[k]) : k;
      const Pending& g = line[j];
      const double stretch = placed.spaceExtra > 0 && std::cmp_less(j, lastInk) && is_justifiable_space(g.ch) ? placed.spaceExtra : 0;
      PlacedGlyph pg;
      pg.ch = g.ch;
      pg.index = g.index;
      pg.x = g.shiftX != 0 ? pen + g.shiftX + g.inkWidth / 2 : pen + g.inkWidth / 2;
      pg.y = g.shiftY != 0 ? y + g.shiftY : y;
      pg.advance = g.advance + stretch;
      pg.inkWidth = g.inkWidth;
      pg.style = g.style;
      pg.line = static_cast<int>(li);
      pg.transform = g.transform;
      if (g.drawn != g.ch) pg.drawn = g.drawn;
      if (levels != nullptr) pg.level = (*levels)[j];
      out.glyphs.push_back(std::move(pg));
      pen += g.advance + stretch;
    }
    const double consumed = pen - lineLeft;
    widest = std::max(widest, consumed);
    LineBox box;
    box.width = consumed;
    box.y = y;
    box.left = lineLeft;
    box.spaceExtra = placed.spaceExtra > 0 ? placed.spaceExtra : 0;
    if (levels != nullptr && lb != nullptr) box.direction = lb->rtl ? "rtl" : "ltr";
    out.lines.push_back(std::move(box));
  }
  out.width = widest;
  out.height = stack.total + stack.lineHeightPx;
  out.lineLeading = stack.lineLeading;
  return out;
}

std::vector<WholeLinePlan> plan_whole_string_lines(const std::string& text, const TextStyle& base,
                                                   const std::function<double(const std::string&)>& measureLine,
                                                   const WholeLineOptions& opts) {
  // text.split(/\r\n|\n/)
  std::vector<std::string> raw;
  {
    std::string cur;
    for (std::size_t i = 0; i < text.size(); ++i) {
      if (text[i] == '\r' && i + 1 < text.size() && text[i + 1] == '\n') {
        raw.push_back(cur);
        cur.clear();
        ++i;
      } else if (text[i] == '\n') {
        raw.push_back(cur);
        cur.clear();
      } else {
        cur.push_back(text[i]);
      }
    }
    raw.push_back(cur);
  }
  const auto hardEnds = hard_ends_of(raw.size(), opts.softBreakLines);
  std::vector<bool> rtlLine(raw.size(), opts.direction == "rtl");
  if (opts.direction == "auto") {
    std::size_t start = 0;
    for (std::size_t li = 0; li < raw.size(); ++li) {
      if (!hardEnds[li] && li < raw.size() - 1) continue;
      std::string joined;
      for (std::size_t k = start; k <= li; ++k) joined += (k > start ? " " : "") + raw[k];
      const bool rtl = resolve_paragraph_direction("auto", joined) == "rtl";
      for (std::size_t k = start; k <= li; ++k) rtlLine[k] = rtl;
      start = li + 1;
    }
  }
  const double lineHeightPx = base.lineHeight.value_or(kAutoLeading) * base.fontSize;
  const auto [offsets, total] = line_offsets(hardEnds, lineHeightPx + base.paragraphSpacing.value_or(0),
                                             base.spaceBefore.value_or(0), base.spaceAfter.value_or(0));
  ParagraphFrame frame;
  frame.boxWidth = opts.boxWidth;
  frame.padX = opts.padX;
  frame.boxText = opts.softBreakLines.has_value();
  frame.align = base.align;
  frame.leftIndent = base.leftIndent;
  frame.rightIndent = base.rightIndent;
  frame.firstLineIndent = base.firstLineIndent;

  std::vector<WholeLinePlan> out;
  for (std::size_t li = 0; li < raw.size(); ++li) {
    ParagraphFrame f = frame;
    f.rtl = rtlLine[li];
    const std::string& line = raw[li];
    WholeLinePlan plan;
    plan.y = -total / 2 + offsets[li];
    const auto clusters = split_graphemes(line);
    const int lastInk = last_non_space(clusters);
    int spaces = 0;
    for (int j = 0; j < lastInk; ++j) {
      if (is_justifiable_space(clusters[static_cast<std::size_t>(j)])) ++spaces;
    }
    const double width = line.empty() ? 0 : measureLine(line);
    const LinePlacement placed = place_line({width, spaces, hardEnds[li], li == 0 || hardEnds[li - 1]}, f);
    plan.left = placed.left;
    plan.width = width;
    if (placed.spaceExtra <= 0) {
      if (!line.empty()) plan.segments.push_back({line, placed.anchor, placed.lineAlign, placed.left});
    } else {
      std::size_t byte = 0;
      int passed = 0;
      std::optional<std::size_t> wordStart;
      std::string wordText;
      const auto flush = [&] {
        if (!wordStart) return;
        const double left = placed.left + (*wordStart > 0 ? measureLine(line.substr(0, *wordStart)) : 0) + passed * placed.spaceExtra;
        plan.segments.push_back({wordText, left, LineAlign::left, left});
        wordStart.reset();
        wordText.clear();
      };
      for (std::size_t j = 0; j < clusters.size(); ++j) {
        const auto& c = clusters[j];
        if (is_justifiable_space(c)) {
          flush();
          if (std::cmp_less(j, lastInk)) ++passed;
        } else {
          if (!wordStart) wordStart = byte;
          wordText += c;
        }
        byte += c.size();
      }
      flush();
    }
    plan.rtl = opts.direction == "auto" && rtlLine[li];
    out.push_back(std::move(plan));
  }
  return out;
}

// ── verticalForms.ts / lineBreak.ts ──────────────────────────────────────────

VerticalForm resolve_vertical_form(const std::string& cluster, bool alternates, bool romanUpright) {
  const auto plain = [&](bool upright, bool alternate = false) { return VerticalForm{cluster, upright, alternate, false}; };
  if (cluster == " " || cluster == "\t") return plain(false);
  const auto cps = code_points(cluster);
  if (cps.empty()) return plain(false);
  const char32_t cp = cps.front();
  const char vo = vertical_orientation_of(cp);
  std::optional<char32_t> form;
  for (const auto& [from, to] : kVerticalForms) {
    if (from == cp) form = to;
  }
  const auto presentation = [&] {
    std::string drawn;
    append_utf8(drawn, *form);
    for (std::size_t k = 1; k < cps.size(); ++k) append_utf8(drawn, cps[k]);
    return VerticalForm{drawn, true, false, false};
  };
  if (vo == 'R') {
    if (!romanUpright) return plain(false);
    if (alternates) return plain(true, true);
    return form ? presentation() : plain(true);
  }
  if (vo == 'U') return plain(true, alternates);
  if (alternates) return plain(true, true);
  if (form) return presentation();
  if (vo == 'r') return plain(false);
  const bool corner = std::ranges::find(kCornerPunctuation, cp) != kCornerPunctuation.end();
  return VerticalForm{cluster, true, false, corner};
}

namespace {
bool is_break_space(const std::string& u) { return u == " " || u == "\t"; }
}  // namespace

bool kinsoku_allows(const std::vector<std::string>& units, std::size_t i) {
  if (i == 0 || i >= units.size()) return false;
  const auto a = code_points(units[i - 1]);
  const auto b = code_points(units[i]);
  if (!b.empty() && std::ranges::find(kKinsokuNoStart, b.front()) != kKinsokuNoStart.end()) return false;
  if (!a.empty() && std::ranges::find(kKinsokuNoEnd, a.back()) != kKinsokuNoEnd.end()) return false;
  return true;
}

std::vector<bool> break_opportunities(const std::vector<std::string>& units) {
  const std::size_t n = units.size();
  std::vector<bool> out(n, false);
  if (n < 2) return out;
  // The TS also allows a break between two word-like Intl.Segmenter words (ICU's
  // dictionary word breaks: Thai, Lao, Khmer …). Not ported: no ICU here.
  for (std::size_t i = 1; i < n; ++i) {
    const auto& a = units[i - 1];
    const auto& b = units[i];
    if (is_break_space(b)) continue;
    if (!kinsoku_allows(units, i)) continue;
    if (is_break_space(a)) { out[i] = true; continue; }
    if (is_ideographic_unit(a) || is_ideographic_unit(b)) { out[i] = true; continue; }
    const auto acps = code_points(a);
    // a.codePointAt(a.length - 1): the last UTF-16 unit — the last code point for BMP text.
    if (!acps.empty() && (acps.back() == 0x2D || acps.back() == 0x2010)) out[i] = true;
  }
  return out;
}

std::vector<std::size_t> wrap_units(const std::vector<std::string>& units, const std::vector<double>& lengths, double limit) {
  std::vector<std::size_t> starts;
  if (!(limit > 0)) return starts;
  const auto opportunities = break_opportunities(units);
  constexpr double kFitEps = 0.5;
  std::size_t start = 0;
  double len = 0;
  for (std::size_t i = 0; i < units.size(); ++i) {
    const double w = i < lengths.size() ? lengths[i] : 0;
    if (i > start && !is_break_space(units[i]) && len + w > limit + kFitEps) {
      std::size_t b = i;
      while (b > start && !opportunities[b]) --b;
      if (b == start) {
        b = i;
        while (b - 1 > start && !kinsoku_allows(units, b)) --b;
        if (!kinsoku_allows(units, b)) b = i;
      }
      starts.push_back(b);
      start = b;
      len = 0;
      for (std::size_t k = b; k < i; ++k) len += k < lengths.size() ? lengths[k] : 0;
    }
    len += w;
  }
  return starts;
}

// ── verticalLayout.ts ────────────────────────────────────────────────────────

namespace {

bool is_ascii_digit(const std::string& c) { return c.size() == 1 && c[0] >= '0' && c[0] <= '9'; }

std::vector<std::pair<std::size_t, std::size_t>> auto_tcy_runs(const std::vector<std::string>& chars, int maxDigits) {
  std::vector<std::pair<std::size_t, std::size_t>> out;
  if (!(maxDigits >= 1)) return out;
  std::size_t i = 0;
  while (i < chars.size()) {
    if (!is_ascii_digit(chars[i])) { ++i; continue; }
    std::size_t j = i + 1;
    while (j < chars.size() && is_ascii_digit(chars[j])) ++j;
    if (std::cmp_less_equal(j - i, maxDigits)) out.emplace_back(i, j);
    i = j;
  }
  return out;
}

std::string vertical_metric_key(const TextStyle& s) {
  return s.fontStyle.value_or("") + "|" + s.fontWeight.value_or("") + "|" + num_str(s.fontSize) + "|" + s.fontFamily.value_or("") + "|" +
         num_str(s.letterSpacing.value_or(0)) + "|" + (s.smallCaps ? "sc" : "") + "|" +
         (s.horizontalScale ? num_str(*s.horizontalScale) : "") + "|" + s.verticalAlign.value_or("") + "|" + axes_json(s.axisOffsets);
}

}  // namespace

TextLayout layout_vertical_text(const std::string& text, const TextStyle& base, const MeasureGlyph& measure,
                                const VerticalLayoutOptions& opts) {
  const std::vector<std::string> chars = split_graphemes(text);
  const std::size_t n = chars.size();
  const auto styleAt = [&](std::size_t i) {
    TextStyle s = resolve_glyph_style(base, opts.runs, static_cast<int>(i));
    if (opts.transforms != nullptr && i < opts.transforms->size()) {
      const auto& ax = (*opts.transforms)[i].axes;
      if (ax && !ax->empty()) s.axisOffsets = ax;
    }
    return s;
  };
  const auto transformAt = [&](std::size_t i) -> const GlyphTransform* {
    return opts.transforms != nullptr && i < opts.transforms->size() ? &(*opts.transforms)[i] : nullptr;
  };
  const auto drawnAt = [&](std::size_t i) {
    const GlyphTransform* t = transformAt(i);
    std::string d = t != nullptr ? t->displayChar : chars[i];
    if (opts.runs != nullptr && resolve_glyph_style(base, opts.runs, static_cast<int>(i)).allCaps) d = to_upper(d);
    return d;
  };
  std::vector<std::optional<VerticalForm>> forms(n);
  for (std::size_t i = 0; i < n; ++i) {
    if (!is_line_break(chars[i])) forms[i] = resolve_vertical_form(drawnAt(i), false, opts.romanUpright);
  }
  std::vector<std::ptrdiff_t> tcyEnd(n, -1);
  std::vector<bool> inTcy(n, false);
  const auto markTcy = [&](std::size_t a, std::size_t b) {
    if (!(b > a)) return;
    for (std::size_t k = a; k < b; ++k) {
      if (inTcy[k]) return;
    }
    tcyEnd[a] = static_cast<std::ptrdiff_t>(b);
    for (std::size_t k = a; k < b; ++k) inTcy[k] = true;
  };
  bool anyTcyRun = false;
  if (opts.runs != nullptr) {
    for (const auto& r : *opts.runs) anyTcyRun = anyTcyRun || (r.style != nullptr && (*r.style)["tateChuYoko"].truthy());
  }
  if (anyTcyRun) {
    std::size_t i = 0;
    while (i < n) {
      if (is_line_break(chars[i]) || !styleAt(i).tateChuYoko) { ++i; continue; }
      std::size_t j = i + 1;
      while (j < n && !is_line_break(chars[j]) && styleAt(j).tateChuYoko) ++j;
      markTcy(i, j);
      i = j;
    }
  }
  if (opts.tateChuYokoDigits && *opts.tateChuYokoDigits != 0) {
    for (const auto& [a, b] : auto_tcy_runs(chars, *opts.tateChuYokoDigits)) markTcy(a, b);
  }
  const auto sideways = [&](std::size_t i) { return !is_line_break(chars[i]) && !inTcy[i] && !forms[i]->upright; };

  std::vector<std::optional<double>> kerned(n);
  if (opts.measureRun) {
    std::size_t i = 0;
    while (i < n) {
      if (!sideways(i)) { ++i; continue; }
      const std::string key = vertical_metric_key(styleAt(i));
      std::size_t end = i + 1;
      while (end < n && sideways(end) && vertical_metric_key(styleAt(end)) == key) ++end;
      const TextStyle style = styleAt(i);
      double prev = 0;
      std::string soFar;
      for (std::size_t k = i; k < end; ++k) {
        soFar += forms[k]->drawn;
        const double w = opts.measureRun(soFar, style);
        kerned[k] = w - prev;
        prev = w;
      }
      i = end;
    }
  }

  const double mul = base.lineHeight.value_or(kAutoLeading);
  double leading = (base.fontSize != 0 && !std::isnan(base.fontSize) ? base.fontSize : 0) * mul;

  struct Member {  // NOLINT(bugprone-exception-escape): implicit special members only move strings; bad_alloc terminates by design
    std::string ch, drawn;
    int index = 0;
    TextStyle style;
    const GlyphTransform* transform = nullptr;
    VerticalForm form;
    double inkWidth = 0;
  };
  struct Tcy {
    double width = 0, scale = 1, em = 0;
  };
  struct Unit {
    std::vector<Member> members;
    std::string text;
    double advance = 0;
    std::optional<Tcy> tcy;
    bool space = false;
    bool ideographic = false;
  };
  std::vector<std::vector<Unit>> paragraphs(1);
  for (std::size_t i = 0; i < n; ++i) {
    const std::string& ch = chars[i];
    if (is_line_break(ch)) {
      paragraphs.emplace_back();
      continue;
    }
    auto& para = paragraphs.back();
    const TextStyle style = styleAt(i);
    const StyleScale gs = glyph_style_scale(style);
    const double ls = style.letterSpacing.value_or(0);
    const double em = style.fontSize * gs.sy;
    leading = std::max(leading, style.fontSize * mul);
    if (std::cmp_greater(tcyEnd[i], i)) {
      const auto end = static_cast<std::size_t>(tcyEnd[i]);
      Unit u;
      double width = 0;
      double tracking = 0;
      for (std::size_t k = i; k < end; ++k) {
        const TextStyle s = styleAt(k);
        const std::string d = drawnAt(k);
        const double w = measure(d, s) * glyph_style_scale(s).sx;
        u.members.push_back({chars[k], d, static_cast<int>(k), s, transformAt(k), *forms[k], w});
        width += w;
        tracking += transformAt(k) != nullptr ? transformAt(k)->tracking : 0;
        u.text += chars[k];
        leading = std::max(leading, s.fontSize * mul);
      }
      const double scale = width > style.fontSize && width > 0 ? style.fontSize / width : 1;
      u.advance = em + ls + tracking;
      u.tcy = Tcy{width, scale, em};
      u.ideographic = is_ideographic_unit(u.text);
      para.push_back(std::move(u));
      i = end - 1;
      continue;
    }
    const VerticalForm& form = *forms[i];
    const GlyphTransform* transform = transformAt(i);
    const double own = measure(form.drawn, style) * gs.sx;
    double advance = form.upright ? em + ls : (kerned[i] ? *kerned[i] : measure(form.drawn, style) + ls) * gs.sx;
    advance += transform != nullptr ? transform->tracking : 0;
    Unit u;
    u.members.push_back({ch, form.drawn, static_cast<int>(i), style, transform, form, form.upright ? em : own});
    u.text = ch;
    u.advance = advance;
    u.space = is_break_space(form.drawn);
    u.ideographic = is_ideographic_unit(ch);
    para.push_back(std::move(u));
  }

  const std::optional<double> limit = opts.columnLimit && *opts.columnLimit > 0 ? opts.columnLimit : std::nullopt;
  std::vector<std::vector<Unit>> columns;
  std::vector<bool> softEnd;
  for (auto& para : paragraphs) {
    std::vector<std::size_t> breaks;
    if (limit && para.size() > 1) {
      std::vector<std::string> texts;
      std::vector<double> advs;
      for (const auto& u : para) {
        texts.push_back(u.text);
        advs.push_back(u.advance);
      }
      breaks = wrap_units(texts, advs, *limit);
    }
    std::size_t from = 0;
    for (const std::size_t b : breaks) {
      columns.emplace_back(para.begin() + static_cast<std::ptrdiff_t>(from), para.begin() + static_cast<std::ptrdiff_t>(b));
      softEnd.push_back(true);
      from = b;
    }
    columns.emplace_back(para.begin() + static_cast<std::ptrdiff_t>(from), para.end());
    softEnd.push_back(false);
  }

  if (opts.opticalKern) {
    for (auto& col : columns) {
      for (std::size_t j = 0; j + 1 < col.size(); ++j) {
        Unit& u = col[j];
        const Unit& v = col[j + 1];
        if (u.tcy || v.tcy) continue;
        const Member& a = u.members[0];
        const Member& b = v.members[0];
        if (is_js_blank(a.drawn) || is_js_blank(b.drawn)) continue;
        if (!a.form.upright && !b.form.upright) u.advance += opts.opticalKern(a.drawn, a.style, b.drawn, b.style) * glyph_style_scale(a.style).sx;
      }
    }
  }
  for (auto& col : columns) {
    for (std::size_t j = 0; j + 1 < col.size(); ++j) {
      const Member& last = col[j].members.back();
      if (last.style.kerning && *last.style.kerning != 0 && !std::isnan(*last.style.kerning)) {
        col[j].advance += (*last.style.kerning / 1000) * last.style.fontSize;
      }
    }
  }
  std::vector<double> lens;
  for (const auto& col : columns) {
    double s = 0;
    for (const auto& u : col) s += u.advance;
    lens.push_back(s);
  }
  std::vector<int> softIdx;
  for (std::size_t i = 0; i < softEnd.size(); ++i) {
    if (softEnd[i]) softIdx.push_back(static_cast<int>(i));
  }
  const auto hardEnds = hard_ends_of(columns.size(), softIdx);
  const auto [offsets, total] = line_offsets(hardEnds, leading + base.paragraphSpacing.value_or(0), base.spaceBefore.value_or(0),
                                             base.spaceAfter.value_or(0));
  const double padX = opts.padX;
  const double firstX = limit ? opts.boxWidth / 2 - padX - leading / 2 : total / 2;
  double maxLen = 0;
  for (const double l : lens) maxLen = std::max(maxLen, l);
  const double span = limit ? *limit : maxLen;
  const ResolvedAlign ra = resolve_align(base.align);

  TextLayout out;
  int visible = static_cast<int>(columns.size());
  if (limit) {
    const double leftEdge = -opts.boxWidth / 2 + padX;
    visible = 0;
    for (std::size_t c = 0; c < columns.size(); ++c) {
      if (firstX - offsets[c] - leading / 2 >= leftEdge - 0.5) visible = static_cast<int>(c) + 1;
      else break;
    }
  }
  for (std::size_t c = 0; c < columns.size(); ++c) {
    const auto& col = columns[c];
    std::ptrdiff_t lastInk = static_cast<std::ptrdiff_t>(col.size()) - 1;
    while (lastInk >= 0 && col[static_cast<std::size_t>(lastInk)].space) --lastInk;
    double len = lens[c];
    if (softEnd[c]) {
      for (auto j = static_cast<std::size_t>(lastInk + 1); j < col.size(); ++j) len -= col[j].advance;
    }
    std::vector<bool> stretchAfter(col.size(), false);
    std::size_t stretchCount = 0;
    double extra = 0;
    if (limit && ra.justify && (softEnd[c] || ra.justifyLast) && *limit > len + 1e-9) {
      bool cjk = false;
      for (const auto& u : col) cjk = cjk || u.ideographic;
      for (std::ptrdiff_t j = 0; j < lastInk; ++j) {
        const Unit& u = col[static_cast<std::size_t>(j)];
        if (u.space || (cjk && (u.ideographic || col[static_cast<std::size_t>(j) + 1].ideographic))) {
          stretchAfter[static_cast<std::size_t>(j)] = true;
          ++stretchCount;
        }
      }
      if (stretchCount > 0) extra = (*limit - len) / static_cast<double>(stretchCount);
    }
    const bool stretched = extra > 0;
    const double colLen = stretched ? *limit : len;
    const double x = firstX - offsets[c];
    const double top = stretched || ra.line == LineAlign::left ? -span / 2 : ra.line == LineAlign::center ? -colLen / 2 : span / 2 - colLen;
    double pen = top;
    for (std::size_t j = 0; j < col.size(); ++j) {
      const Unit& u = col[j];
      const double ex = stretchAfter[j] ? extra : 0;
      if (u.tcy) {
        const Member& first = u.members[0];
        const StyleScale gs = glyph_style_scale(first.style);
        const double cy = pen + (first.transform != nullptr ? first.transform->trackingBefore.value_or(0) : 0) + u.tcy->em / 2;
        double cum = 0;
        for (std::size_t k = 0; k < u.members.size(); ++k) {
          const Member& m = u.members[k];
          PlacedGlyph g;
          g.ch = m.ch;
          g.index = m.index;
          g.x = x - gs.dy + (cum + m.inkWidth / 2 - u.tcy->width / 2) * u.tcy->scale;
          g.y = cy;
          g.advance = k == 0 ? u.advance + ex : 0;
          g.inkWidth = m.inkWidth * u.tcy->scale;
          g.style = m.style;
          g.line = static_cast<int>(c);
          g.transform = m.transform;
          if (m.drawn != m.ch) g.drawn = m.drawn;
          g.tcyStart = first.index;
          g.tcyScale = u.tcy->scale;
          out.glyphs.push_back(std::move(g));
          cum += m.inkWidth;
        }
      } else {
        const Member& m = u.members[0];
        const StyleScale gs = glyph_style_scale(m.style);
        const bool upright = m.form.upright;
        const double body = upright ? m.style.fontSize * gs.sy : m.inkWidth;
        const double corner = m.form.corner ? m.style.fontSize : 0;
        PlacedGlyph g;
        g.ch = m.ch;
        g.index = m.index;
        g.x = x - gs.dy + corner * 0.5;
        g.y = pen + (m.transform != nullptr ? m.transform->trackingBefore.value_or(0) : 0) + body / 2 - corner * 0.5;
        g.advance = u.advance + ex;
        g.inkWidth = m.inkWidth;
        g.style = m.style;
        g.line = static_cast<int>(c);
        g.transform = m.transform;
        if (!upright) g.angle = kSidewaysAngle;
        if (m.drawn != m.ch) g.drawn = m.drawn;
        g.vertAlternate = m.form.alternate;
        out.glyphs.push_back(std::move(g));
      }
      pen += u.advance + ex;
    }
    LineBox box;
    box.width = colLen;
    box.y = top;
    box.left = x;
    box.spaceExtra = stretched ? extra : 0;
    out.lines.push_back(box);
  }
  out.width = total + leading;
  out.height = maxLen;
  if (limit) out.visibleLines = visible;
  return out;
}

}  // namespace premation::raster
