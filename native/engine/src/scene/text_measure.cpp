#include "text_measure.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <mutex>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>

#include "canvas.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "line_break.hpp"
#include "optical_kerning.hpp"
#include "scene_math.hpp"
#include "text_layout.hpp"
#include "text_runs.hpp"
#include "text_unicode.hpp"

namespace premation::scene {
namespace {

using js::Json;

std::optional<double> num(const Json& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }

/// measureText.ts PAD_X (textExtras TEXT_PAD_X) / PAD_Y.
constexpr double kPadX = 12;
constexpr double kPadY = 8;
constexpr double kSuperSubScale = 0.65;
constexpr double kSuperShift = 0.35;
constexpr double kSubShift = 0.15;
/// textExtras.ts FAUX_BOLD_STROKE_RATIO / FAUX_ITALIC_SKEW.
constexpr double kFauxBoldStrokeRatio = 1.0 / 30;
constexpr double kFauxItalicAngleDeg = 12;
double faux_italic_skew() { return motion::js::tan((kFauxItalicAngleDeg * std::numbers::pi) / 180); }

struct StyleTransform {
  double sx = 1, sy = 1, dy = 0;
};

StyleTransform text_style_transform(const MeasuredStyle& s) {
  const bool ss = s.verticalAlign == "super" || s.verticalAlign == "sub";
  const double va = ss ? kSuperSubScale : 1;
  StyleTransform t;
  t.sx = ((s.horizontalScale && *s.horizontalScale > 0 ? *s.horizontalScale : 100) / 100) * va;
  t.sy = ((s.verticalScale && *s.verticalScale > 0 ? *s.verticalScale : 100) / 100) * va;
  t.dy = -(s.baselineShift && std::isfinite(*s.baselineShift) ? *s.baselineShift : 0);
  if (s.verticalAlign == "super") t.dy -= s.fontSize * kSuperShift;
  else if (s.verticalAlign == "sub") t.dy += s.fontSize * kSubShift;
  return t;
}

/// JS `toUpperCase` / `toLowerCase` for the ASCII range (other scripts are
/// reported by the caller: the port does not case-map them).
std::string ascii_case(std::string s, bool upper) {
  for (char& c : s) {
    if (upper && c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    if (!upper && c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::string css_number(double v) { return js::number_to_string(v); }

class CanvasMeasurer final : public TextMeasurer {
 public:
  explicit CanvasMeasurer(raster::CanvasOptions opts) : opts_(opts) {}

  std::optional<std::pair<double, double>> measure_text_size(const MeasuredStyle& input) override {
    if (input.hasFontAxes || input.fontWidth || input.fontSlant) return std::nullopt;
    // Vertical optical pairs and vertical runs are outside the port.
    if (input.vertical && (input.opticalKerning || input.hasLineRuns)) return std::nullopt;
    if (input.textTransform == "capitalize") return std::nullopt;
    // Paragraph text measures its WRAPPED content (measureTextSize → wrappedStyle).
    std::optional<MeasuredStyle> wrapped;
    if (input.boxWidth) {
      // Line runs restack the lines, and an anchored auto-height box offsets them: not ported.
      if (input.hasLineRuns || (!input.boxHeight && input.boxAnchorHeight)) return std::nullopt;
      wrapped = wrapped_style(input, nullptr);
      if (!wrapped) return std::nullopt;
    }
    const MeasuredStyle& s = wrapped ? *wrapped : input;
    const std::scoped_lock lock(m_);
    // A pure function of the style: memoised (the TS caches measureTextBoxes the
    // same way), so a paused or playing frame re-shapes only text that changed.
    std::string key = style_key(s);
    if (const auto it = memo_.find(key); it != memo_.end()) return it->second;
    auto r = measure_uncached(s);
    if (memo_.size() >= kMemoMax) memo_.clear();
    memo_.emplace(std::move(key), r);
    return r;
  }

 private:
  static constexpr std::size_t kMemoMax = 8192;

  static std::string style_key(const MeasuredStyle& s) {
    std::string k;
    k.reserve(s.content.size() + 96);
    const auto num = [&k](double v) {
      k += js::number_to_string(v);
      k += '|';
    };
    const auto opt = [&num, &k](const std::optional<double>& v) {
      if (v) num(*v);
      else k += "u|";
    };
    const auto str = [&k](const std::optional<std::string>& v) {
      k += v.value_or("\x01");
      k += '\x02';
    };
    num(s.fontSize);
    num(s.letterSpacing);
    num(s.lineHeight);
    num(s.paragraphSpacing);
    opt(s.verticalScale);
    opt(s.horizontalScale);
    opt(s.baselineShift);
    opt(s.spaceBefore);
    opt(s.spaceAfter);
    str(s.textTransform);
    str(s.fontVariant);
    str(s.verticalAlign);
    k += s.fauxBold ? '1' : '0';
    k += s.fauxItalic ? '1' : '0';
    k += s.opticalKerning ? 'o' : '-';
    k += s.vertical ? (s.verticalRomanAlignment ? 'V' : 'v') : '-';
    k += s.tateChuYokoDigits ? static_cast<char>('0' + *s.tateChuYokoDigits) : '-';
    opt(s.boxWidth);
    opt(s.boxHeight);
    k += s.fontFamily;
    k += '\x02';
    k += s.fontWeight;
    k += '\x02';
    k += s.fontStyle;
    k += '\x02';
    k += s.content;
    return k;
  }

  std::optional<std::pair<double, double>> measure_uncached(const MeasuredStyle& s) {
    if (!ctx_) ctx_ = raster::Canvas2D::make(1, 1, opts_);
    raster::Canvas2D& g = *ctx_;
    // cssFont(s) + applyFontVariations(g, s).
    const std::string style = s.fontStyle == "italic" ? "italic " : "";
    const std::string font = style + s.fontWeight + " " + css_number(s.fontSize) + "px \"" + s.fontFamily + "\", Inter, system-ui, sans-serif";
    if (!g.setFont(font)) return std::nullopt;
    std::string variation = "normal";
    {
      const auto parsedWeight = js::parse(s.fontWeight);
      const double w = parsedWeight && parsedWeight->is_number() ? parsedWeight->num() : std::nan("");
      if (std::isfinite(w)) variation = "'wght' " + css_number(w);
    }
    g.setFontVariationSettings(variation);
    // applyFontVariations: optical kerning measures with the font's kerning off.
    g.setFontKerning(!s.opticalKerning);
    g.setTextBaseline(raster::TextBaseline::middle);
    std::string content = s.content;
    if (s.textTransform == "uppercase") content = ascii_case(content, true);
    else if (s.textTransform == "lowercase") content = ascii_case(content, false);
    if (s.vertical) return measure_vertical(s, content, g);
    // measureTextBoxes (horizontal).
    std::vector<std::string> lines;
    {
      std::size_t start = 0;
      for (;;) {
        const std::size_t nl = content.find('\n', start);
        lines.push_back(content.substr(start, nl == std::string::npos ? std::string::npos : nl - start));
        if (nl == std::string::npos) break;
        start = nl + 1;
      }
    }
    const auto n = static_cast<double>(lines.size());
    const double lineHeightPx = s.fontSize * (s.lineHeight != 0 ? s.lineHeight : kDefaultLineHeight);
    const double gap = lineHeightPx + s.paragraphSpacing;
    const double paraGap = s.spaceBefore.value_or(0) + s.spaceAfter.value_or(0);
    if (paraGap != 0) return std::nullopt;  // hard-break paragraph offsets: not in the port
    constexpr double kInf = std::numeric_limits<double>::infinity();
    double inkTop = kInf, inkBottom = -kInf, inkHalfW = 0;
    double fontTop = kInf, fontBottom = -kInf, advance = 0;
    for (std::size_t i = 0; i < lines.size(); ++i) {
      const std::string& line = lines[i];
      const raster::TextMetrics m = g.measureText(line);
      const double chars = static_cast<double>(raster::split_graphemes(line).size());
      // Optical kerning's pair adjustments count as spacing (opticalLineDelta).
      const double spacing = (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + optical_line_delta(s, style, line);
      const double dy = (static_cast<double>(i) - (n - 1) / 2) * gap;
      inkTop = std::min(inkTop, dy - m.actualBoundingBoxAscent);
      inkBottom = std::max(inkBottom, dy + m.actualBoundingBoxDescent);
      inkHalfW = std::max(inkHalfW, (m.actualBoundingBoxLeft + m.actualBoundingBoxRight + spacing) / 2);
      fontTop = std::min(fontTop, dy - m.fontBoundingBoxAscent);
      fontBottom = std::max(fontBottom, dy + m.fontBoundingBoxDescent);
      advance = std::max(advance, m.width + spacing);
    }
    if (!std::isfinite(inkTop) || !std::isfinite(inkBottom)) {
      inkTop = fontTop;
      inkBottom = fontBottom;
    }
    if (inkHalfW <= 0) inkHalfW = advance / 2;
    // measureTextSize.
    const double lineBlock = lineHeightPx * n + s.paragraphSpacing * std::max(0.0, n - 1);
    const StyleTransform tr = text_style_transform(s);
    const double fauxW = (s.fauxBold ? (s.fontSize * kFauxBoldStrokeRatio) / 2 : 0) + (s.fauxItalic ? (s.fontSize * faux_italic_skew()) / 2 : 0);
    const double fauxH = s.fauxBold ? (s.fontSize * kFauxBoldStrokeRatio) / 2 : 0;
    const double inkLeft = -inkHalfW;
    const double inkRight = inkHalfW;
    const std::array<double, 3> hw{advance / 2, -inkLeft, inkRight};
    const double halfW = (motion::js::max_of(hw) + fauxW) * tr.sx;
    const std::array<double, 2> hh{-inkTop, inkBottom};
    const double halfH = (motion::js::max_of(hh) + fauxH) * tr.sy + std::abs(tr.dy);
    const double width = halfW * 2;
    const double height = std::max(lineBlock * tr.sy + std::abs(tr.dy) * 2, halfH * 2);
    // Paragraph text's width is AUTHORED; a FIXED box is authored in both directions.
    const double w = s.boxWidth ? std::max(16.0, std::ceil(*s.boxWidth) + kPadX * 2) : std::max(16.0, std::ceil(width) + kPadX * 2);
    const double h = s.boxWidth && s.boxHeight ? std::max(16.0, std::ceil(*s.boxHeight) + kPadY * 2)
                                               : std::max(16.0, std::ceil(height) + kPadY * 2);
    return std::pair<double, double>{w, h};
  }

 public:
  std::optional<MeasuredStyle> wrapped_style(const MeasuredStyle& s, std::string* why) override {
    // wrappedStyle: vertical type breaks its columns at layout time.
    if (!s.boxWidth || s.vertical) return s;
    if (s.boxFit && s.boxHeight) {
      if (why != nullptr) *why = "paragraph text: Fit Text to Box";
      return std::nullopt;
    }
    if (s.softBreakLines) return s;  // idempotent: already wrapped
    const std::scoped_lock lock(m_);
    const auto wrapped = wrap_text(s, why);
    if (!wrapped) return std::nullopt;
    MeasuredStyle out = s;
    out.softBreakLines = soft_break_lines(s.content, *wrapped);
    if (!out.softBreakLines) {
      if (why != nullptr) *why = "paragraph text: inserted line breaks";
      return std::nullopt;
    }
    out.content = *wrapped;
    return out;
  }

 private:
  /// measureText.ts wrapText: greedy word wrap at the box (less the indents);
  /// each break REPLACES one space, so the wrapped string keeps its length.
  std::optional<std::string> wrap_text(const MeasuredStyle& s, std::string* why) {
    if (!ctx_) ctx_ = raster::Canvas2D::make(1, 1, opts_);
    raster::Canvas2D& g = *ctx_;
    const std::string style = s.fontStyle == "italic" ? "italic " : "";
    const std::string font = style + s.fontWeight + " " + css_number(s.fontSize) + "px \"" + s.fontFamily + "\", Inter, system-ui, sans-serif";
    if (!g.setFont(font)) return std::nullopt;
    std::string variation = "normal";
    {
      const auto parsedWeight = js::parse(s.fontWeight);
      const double wt = parsedWeight && parsedWeight->is_number() ? parsedWeight->num() : std::nan("");
      if (std::isfinite(wt)) variation = "'wght' " + css_number(wt);
    }
    g.setFontVariationSettings(variation);
    g.setFontKerning(!s.opticalKerning);
    const auto advance = [&](const std::string& text) {
      const auto chars = static_cast<double>(raster::split_graphemes(text).size());
      return g.measureText(text).width + (chars > 0 ? (chars - 1) * s.letterSpacing : 0) + optical_line_delta(s, style, text);
    };
    const double inner = *s.boxWidth - s.leftIndent.value_or(0) - s.rightIndent.value_or(0);
    std::vector<std::string> out;
    std::size_t start = 0;
    for (;;) {
      const std::size_t nl = s.content.find('\n', start);
      const std::string paragraph = s.content.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
      for (const std::string& c : raster::split_graphemes(paragraph)) {
        if (raster::is_ideographic_unit(c)) {
          if (why != nullptr) *why = "paragraph text: CJK line breaking";
          return std::nullopt;
        }
      }
      std::vector<std::string> words;
      {
        std::size_t ws = 0;
        for (;;) {
          const std::size_t sp = paragraph.find(' ', ws);
          words.push_back(paragraph.substr(ws, sp == std::string::npos ? std::string::npos : sp - ws));
          if (sp == std::string::npos) break;
          ws = sp + 1;
        }
      }
      std::string line = words[0];
      bool first = true;
      for (std::size_t w = 1; w < words.size(); ++w) {
        const std::string& word = words[w];
        const std::string candidate = line + " " + word;
        const double limit = inner - (first ? s.firstLineIndent.value_or(0) : 0);
        if (!raster::is_js_blank(line) && !word.empty() && advance(candidate) > limit) {
          out.push_back(line);
          line = word;
          first = false;
        } else {
          line = candidate;
        }
      }
      out.push_back(line);
      if (nl == std::string::npos) break;
      start = nl + 1;
    }
    std::string joined;
    for (std::size_t i = 0; i < out.size(); ++i) {
      if (i > 0) joined += '\n';
      joined += out[i];
    }
    return joined;
  }
 private:

  /// measureTextSize's vertical branch: verticalLayoutOf(s, g) (layoutVerticalText
  /// over single-cluster canvas widths), scaled by the style transform.
  std::optional<std::pair<double, double>> measure_vertical(const MeasuredStyle& s, const std::string& content, raster::Canvas2D& g) {
    std::unordered_map<std::string, double> widths;
    const auto measureOne = [&](const std::string& t) {
      if (const auto it = widths.find(t); it != widths.end()) return it->second;
      const double w = g.measureText(t).width;
      widths.emplace(t, w);
      return w;
    };
    raster::TextStyle base;
    base.fontSize = s.fontSize;
    base.letterSpacing = s.letterSpacing;
    base.lineHeight = s.lineHeight;
    base.paragraphSpacing = s.paragraphSpacing;
    base.spaceBefore = s.spaceBefore;
    base.spaceAfter = s.spaceAfter;
    raster::VerticalLayoutOptions o;
    o.boxWidth = s.boxWidth ? *s.boxWidth + kPadX * 2 : 0;
    o.padX = kPadX;
    if (s.boxWidth) o.columnLimit = s.boxHeight;
    o.measureRun = [&](const std::string& t, const raster::TextStyle&) {
      return measureOne(t) + static_cast<double>(raster::split_graphemes(t).size()) * s.letterSpacing;
    };
    o.romanUpright = s.verticalRomanAlignment;
    o.tateChuYokoDigits = s.tateChuYokoDigits;
    const raster::TextLayout laid =
        raster::layout_vertical_text(content, base, [&](const std::string& t, const raster::TextStyle&) { return measureOne(t); }, o);
    const StyleTransform vt = text_style_transform(s);
    const double w = s.boxWidth ? std::max(16.0, std::ceil(*s.boxWidth) + kPadX * 2) : std::max(16.0, std::ceil(laid.width * vt.sx) + kPadX * 2);
    const double h = s.boxWidth && s.boxHeight ? std::max(16.0, std::ceil(*s.boxHeight) + kPadY * 2)
                                               : std::max(16.0, std::ceil(laid.height * vt.sy + std::abs(vt.dy) * 2) + kPadY * 2);
    return std::pair<double, double>{w, h};
  }

  /// measureText.ts opticalLineDelta: the sum of the pair kerns the painter adds.
  double optical_line_delta(const MeasuredStyle& s, const std::string& style, const std::string& line) {
    if (!s.opticalKerning || raster::utf16_length(line) < 2) return 0;
    if (!kerner_) kerner_ = std::make_unique<raster::OpticalKerner>(opts_);
    const std::string css = style + s.fontWeight + " " + css_number(raster::OpticalKerner::kRefEmPx) + "px \"" + s.fontFamily +
                            "\", Inter, system-ui, sans-serif";
    const std::vector<std::string> clusters = raster::split_graphemes(line);
    double d = 0;
    for (std::size_t i = 0; i + 1 < clusters.size(); ++i) d += kerner_->kern_px(css, clusters[i], s.fontSize, css, clusters[i + 1], s.fontSize);
    return d;
  }

  raster::CanvasOptions opts_;
  std::mutex m_;
  std::unique_ptr<raster::Canvas2D> ctx_;
  std::unique_ptr<raster::OpticalKerner> kerner_;
  std::unordered_map<std::string, std::optional<std::pair<double, double>>> memo_;
};

}  // namespace

std::optional<MeasuredStyle> read_measured_text_style(const doc::Node& n,
                                                      const std::vector<std::pair<std::string, double>>& overrides) {
  MeasuredStyle s;
  std::optional<std::string> content;
  bool tcyAuto = false;
  double tcyDigits = 2;  // TATE_CHU_YOKO_DEFAULT_DIGITS
  const auto extras = [&s, &tcyAuto, &tcyDigits](const Json& p) {
    for (const char* k : {"leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter"}) {
      const Json& v = p.at(k);
      if (!(v.is_number() && std::isfinite(v.num()))) continue;
      const std::string_view key = k;
      if (key == "leftIndent") s.leftIndent = v.num();
      else if (key == "rightIndent") s.rightIndent = v.num();
      else if (key == "firstLineIndent") s.firstLineIndent = v.num();
      else if (key == "spaceBefore") s.spaceBefore = v.num();
      else s.spaceAfter = v.num();
    }
    if (p.at("fauxBold").is_bool()) s.fauxBold = p.at("fauxBold").b();
    if (p.at("fauxItalic").is_bool()) s.fauxItalic = p.at("fauxItalic").b();
    if (p.at("textTransform").is_string()) s.textTransform = p.at("textTransform").str();
    if (p.at("fontVariant").is_string()) s.fontVariant = p.at("fontVariant").str();
    if (p.at("verticalAlign").is_string()) s.verticalAlign = p.at("verticalAlign").str();
    if (auto v = num(p.at("verticalScale"))) s.verticalScale = v;
    if (auto v = num(p.at("horizontalScale"))) s.horizontalScale = v;
    if (auto v = num(p.at("baselineShift"))) s.baselineShift = v;
    if (p.at("orientation").is_string()) s.vertical = p.at("orientation").str() == "vertical";
    if (p.at("kerningMode").is_string()) s.opticalKerning = p.at("kerningMode").str() == "optical";
    if (p.at("verticalRomanAlignment").is_bool()) s.verticalRomanAlignment = p.at("verticalRomanAlignment").b();
    if (p.at("tateChuYokoAuto").is_bool()) tcyAuto = p.at("tateChuYokoAuto").b();
    if (p.at("tateChuYokoDigits").is_finite_number()) tcyDigits = p.at("tateChuYokoDigits").num();
  };
  for (const auto& c : n.components) {
    const Json& p = c.props;
    extras(p);
    if (p.at("content").is_string()) content = p.at("content").str();
    if (auto v = num(p.at("fontSize"))) s.fontSize = *v;
    if (p.at("fontFamily").is_string()) s.fontFamily = p.at("fontFamily").str();
    if (p.at("fontWeight").is_string()) s.fontWeight = p.at("fontWeight").str();
    else if (p.at("fontWeight").is_number()) s.fontWeight = js::number_to_string(p.at("fontWeight").num());
    if (p.at("fontStyle").is_string()) s.fontStyle = p.at("fontStyle").str();
    if (auto v = num(p.at("fontWidth"))) s.fontWidth = v;
    if (auto v = num(p.at("fontSlant"))) s.fontSlant = v;
    if (auto v = num(p.at("letterSpacing"))) s.letterSpacing = *v;
    if (auto v = num(p.at("lineHeight"))) s.lineHeight = *v;
    if (auto v = num(p.at("paragraphSpacing"))) s.paragraphSpacing = *v;
    if (auto v = num(p.at("boxWidth"))) s.boxWidth = v;
  }
  // overrideProps (the sampled values, as buildSnapshot passes evalMap).
  for (const auto& [k, v] : overrides) {
    if (k == "fontSize") s.fontSize = v;
    else if (k == "fontWidth") s.fontWidth = v;
    else if (k == "fontSlant") s.fontSlant = v;
    else if (k == "letterSpacing") s.letterSpacing = v;
    else if (k == "lineHeight") s.lineHeight = v;
    else if (k == "paragraphSpacing") s.paragraphSpacing = v;
    else if (k == "boxWidth") s.boxWidth = v;
    else if (k == "fontWeight") s.fontWeight = js::number_to_string(v);
    else if (k == "verticalScale") s.verticalScale = v;
    else if (k == "horizontalScale") s.horizontalScale = v;
    else if (k == "baselineShift") s.baselineShift = v;
    else if (k == "leftIndent") s.leftIndent = v;
    else if (k == "rightIndent") s.rightIndent = v;
    else if (k == "firstLineIndent") s.firstLineIndent = v;
    else if (k == "spaceBefore") s.spaceBefore = v;
    else if (k == "spaceAfter") s.spaceAfter = v;
  }
  if (!content) return std::nullopt;
  s.content = *content;
  if (doc::read_text_path_config(n)) s.boxWidth.reset();
  if (s.boxWidth && *s.boxWidth <= 0) s.boxWidth.reset();
  if (s.textTransform == "none") s.textTransform.reset();
  if (s.fontVariant == "normal") s.fontVariant.reset();
  if (s.verticalAlign == "baseline") s.verticalAlign.reset();
  if (s.verticalScale == 100) s.verticalScale.reset();
  if (s.horizontalScale == 100) s.horizontalScale.reset();
  if (s.baselineShift == 0) s.baselineShift.reset();
  const Json axes = doc::read_font_axes_prop(n);
  s.hasFontAxes = axes.is_object() && !axes.obj().empty();
  if (s.vertical && tcyAuto) s.tateChuYokoDigits = static_cast<int>(std::max(1.0, std::min(4.0, std::floor(tcyDigits + 0.5))));
  if (!s.vertical) s.verticalRomanAlignment = false;
  if (s.boxWidth) {
    // readLineRuns: runs that change a line's size or leading.
    for (const auto& c : n.components) {
      if (c.type != "Text" || !c.props.at("__runs").is_array()) continue;
      for (const Json& r : c.props.at("__runs").arr()) {
        const Json& st = r.at("style");
        const auto pos = [&st](const char* k) { return st.at(k).is_number() && st.at(k).num() > 0; };
        if (st.is_object() && (pos("fontSize") || pos("lineHeight"))) s.hasLineRuns = true;
      }
    }
    // readParagraphBox (text on a path has none: boxWidth was already dropped above).
    double bw = 0;
    double bh = 0;
    std::string autoSize;
    std::string valign = "top";
    const auto read = [&](const Json& p) {
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
    };
    for (const auto& c : n.components) read(c.props);
    for (const auto& [k, v] : overrides) {
      if (k == "boxWidth" && std::isfinite(v)) bw = v;
      else if (k == "boxHeight" && std::isfinite(v)) bh = v;
    }
    if (bw > 0) {
      const std::string resolved = bh > 0 ? (autoSize.empty() ? "off" : autoSize) : "height";
      if (resolved != "height") {
        s.boxHeight = bh;
        if (valign != "top") s.boxVerticalAlign = valign;
        s.boxFit = resolved == "fit";
      } else if (bh > 0 && !s.vertical) {
        s.boxAnchorHeight = bh;
      }
    }
  }
  return s;
}

std::optional<std::vector<int>> soft_break_lines(std::string_view raw, std::string_view wrapped) {
  if (raw.size() > wrapped.size()) return std::vector<int>{};
  if (raw.size() < wrapped.size()) return std::nullopt;  // inserted breaks (CJK): not ported
  std::vector<int> out;
  int line = 0;
  for (std::size_t i = 0; i < wrapped.size(); ++i) {
    if (wrapped[i] != '\n') continue;
    if (raw[i] != '\n') out.push_back(line);
    ++line;
  }
  return out;
}

std::unique_ptr<TextMeasurer> make_canvas_measurer(const raster::CanvasOptions& opts) {
  return std::make_unique<CanvasMeasurer>(opts);
}

// ── rich text runs (richText.ts readRuns + normalizeRuns) ─────────────────────

namespace {

constexpr std::array<std::string_view, 20> kRunStyleKeys = {
    "fontSize", "fontFamily", "fontWeight", "fontStyle", "letterSpacing", "fill", "kerning", "fauxBold", "fauxItalic",
    "strokeColor", "strokeWidth", "lineHeight", "horizontalScale", "verticalScale", "baselineShift", "tsume", "allCaps",
    "smallCaps", "verticalAlign", "tateChuYoko"};

Json pick_style(const Json& style) {
  Json out = Json::object();
  for (const std::string_view k : kRunStyleKeys) {
    const Json* v = style.find(k);
    if (v != nullptr && !v->is_undefined()) out.set(k, *v);
  }
  return out;
}

bool is_empty_style(const Json& style) {
  return std::ranges::all_of(kRunStyleKeys, [&](std::string_view k) {
    const Json* v = style.find(k);
    return v == nullptr || v->is_undefined();
  });
}

bool strict_equal(const Json* a, const Json* b) {
  const bool ua = a == nullptr || a->is_undefined();
  const bool ub = b == nullptr || b->is_undefined();
  if (ua || ub) return ua && ub;
  if (a->kind() != b->kind()) return false;
  if (a->is_number()) return a->num() == b->num();
  if (a->is_string()) return a->str() == b->str();
  if (a->is_bool()) return a->b() == b->b();
  if (a->is_null()) return true;
  return a == b;  // objects / arrays: identity (JS ===)
}

bool same_style(const Json& a, const Json& b) {
  return std::ranges::all_of(kRunStyleKeys, [&](std::string_view k) { return strict_equal(a.find(k), b.find(k)); });
}

double cp_to_grapheme(const std::vector<std::string>& gs, double cp, bool roundUp) {
  if (cp <= 0) return 0;
  double acc = 0;
  for (std::size_t i = 0; i < gs.size(); ++i) {
    const auto len = static_cast<double>(raster::code_points(gs[i]).size());
    if (cp == acc) return static_cast<double>(i);
    if (cp < acc + len) return roundUp ? static_cast<double>(i + 1) : static_cast<double>(i);
    acc += len;
  }
  return static_cast<double>(gs.size());
}

}  // namespace

Json normalize_runs(const Json& textProps, const std::string& rawText) {
  const Json& raw = textProps.at("__runs");
  if (!raw.is_array()) return {};
  const std::string content = textProps.at("content").is_string() ? textProps.at("content").str() : "";
  struct Run {
    double start, end;
    Json style;
  };
  std::vector<Run> runs;
  for (const Json& r : raw.arr()) {
    if (!r.is_object()) continue;
    const Json& s = r.at("start");
    const Json& e = r.at("end");
    if (!(s.is_number() && std::isfinite(s.num()) && e.is_number() && std::isfinite(e.num()))) continue;
    if (!r.at("style").is_object()) continue;
    runs.push_back({s.num(), e.num(), r.at("style")});
  }
  const bool grapheme = textProps.at("__runsIndex").is_string() && textProps.at("__runsIndex").str() == "grapheme";
  if (!grapheme) {
    const std::vector<std::string> cgs = raster::split_graphemes(content);
    if (cgs.size() != raster::code_points(content).size()) {
      for (Run& r : runs) {
        r.start = cp_to_grapheme(cgs, r.start, false);
        r.end = cp_to_grapheme(cgs, r.end, true);
      }
    }
  }
  const auto length = static_cast<std::ptrdiff_t>(raster::split_graphemes(rawText).size());
  Json out = Json::array();
  if (length <= 0) return out;
  std::vector<std::optional<Json>> perChar(static_cast<std::size_t>(length));
  for (const Run& run : runs) {
    const auto start = static_cast<std::ptrdiff_t>(std::max(0.0, std::floor(run.start)));
    const auto end = static_cast<std::ptrdiff_t>(std::min(static_cast<double>(length), std::floor(run.end)));
    if (!(end > start) || is_empty_style(run.style)) continue;
    const Json picked = pick_style(run.style);
    for (std::ptrdiff_t i = start; i < end; ++i) {
      auto& slot = perChar[static_cast<std::size_t>(i)];
      Json merged = slot ? *slot : Json::object();
      for (const auto& m : picked.obj()) merged.set(m.key, m.value);
      slot = std::move(merged);
    }
  }
  std::ptrdiff_t i = 0;
  while (i < length) {
    const auto& style = perChar[static_cast<std::size_t>(i)];
    if (!style || is_empty_style(*style)) {
      ++i;
      continue;
    }
    const auto& runStyle = *style;
    const auto continues = [&](std::ptrdiff_t k) {
      const auto& c = perChar[static_cast<std::size_t>(k)];
      return c.has_value() && same_style(*c, runStyle);
    };
    std::ptrdiff_t j = i + 1;
    while (j < length && continues(j)) ++j;
    Json r = Json::object();
    r.set("start", Json::number(static_cast<double>(i)));
    r.set("end", Json::number(static_cast<double>(j)));
    r.set("style", runStyle);
    out.arr_mut().push_back(std::move(r));
    i = j;
  }
  return out.arr().empty() ? Json() : out;
}

}  // namespace premation::scene
