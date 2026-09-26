#include "per_char3d.hpp"

#include <algorithm>
#include <map>
#include <memory>
#include <numbers>

#include "json.hpp"
#include "text_layout.hpp"
#include "text_unicode.hpp"

namespace premation::scene {

namespace {

namespace rj = raster::json;

rj::Value to_raster(const Json& v) {
  rj::Value out;
  std::string err;
  if (v.is_undefined() || !rj::parse(js::stringify(v), out, err)) return rj::Value{};
  return out;
}

std::optional<double> num_of(const Json& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }

}  // namespace

Json glyph_extras_of(const Json& textExtras) {
  if (!textExtras.is_object()) return Json{};
  Json rest = Json::object();
  bool any = false;
  for (const Json::Member& m : textExtras.obj()) {
    if (m.key == "boxOffsetY" || m.key == "orientation" || m.key == "verticalRomanAlignment" || m.key == "direction") continue;
    rest.set(m.key, m.value);
    any = true;
  }
  return any ? rest : Json{};
}

std::vector<GlyphPlacement> layout_per_char_3d(const RLayer& layer, double boxWidth, const raster::CanvasOptions& canvas) {
  std::vector<GlyphPlacement> out;
  const std::string text = layer.text.value_or("");
  if (text.empty()) return out;
  const Json& ex = layer.textExtras;

  raster::TextStyle style;
  style.fontSize = layer.fontSize;
  style.fontFamily = layer.fontFamily;
  style.fontWeight = layer.fontWeight;
  style.fontStyle = layer.fontStyle;
  style.letterSpacing = layer.letterSpacing;
  style.fill = layer.fill;
  style.align = layer.align.value_or("");
  style.lineHeight = layer.lineHeight;
  style.paragraphSpacing = layer.paragraphSpacing;
  style.leftIndent = num_of(ex.at("leftIndent"));
  style.rightIndent = num_of(ex.at("rightIndent"));
  style.firstLineIndent = num_of(ex.at("firstLineIndent"));
  style.spaceBefore = num_of(ex.at("spaceBefore"));
  style.spaceAfter = num_of(ex.at("spaceAfter"));

  // The runs' style objects and the animator transforms, in the painter's types.
  const rj::Value runsJ = to_raster(layer.runs);
  std::vector<raster::RichRun> runs;
  for (const auto& r : runsJ.items()) runs.push_back({static_cast<int>(r["start"].num(0)), static_cast<int>(r["end"].num(0)), &r["style"]});
  const rj::Value glyphsJ = to_raster(layer.glyphs);
  std::vector<raster::GlyphTransform> transforms;
  for (const auto& g : glyphsJ.items()) transforms.push_back(raster::read_glyph_transform(g));

  // createGlyphMeasure: `${fontStyle ?? 'normal'} ${fontWeight ?? '400'} ${fontSize}px ${fontFamily ?? 'sans-serif'}`.
  const std::unique_ptr<raster::Canvas2D> ctx = raster::Canvas2D::make(1, 1, canvas);
  if (!ctx) return out;
  std::map<std::string, double, std::less<>> cache;
  const raster::MeasureGlyph measure = [&](const std::string& ch, const raster::TextStyle& st) {
    const std::string font = st.fontStyle.value_or("normal") + " " + st.fontWeight.value_or("400") + " " + js::number_to_string(st.fontSize) +
                             "px " + st.fontFamily.value_or("sans-serif");
    const std::string key = font + " " + ch;
    if (const auto it = cache.find(key); it != cache.end()) return it->second;
    (void)ctx->setFont(font);  // an unparsable font leaves the previous one, as ctx.font does
    const double w = ctx->measureText(ch).width;
    cache.emplace(key, w);
    return w;
  };

  const bool vertical = ex.at("orientation").is_string() && ex.at("orientation").str() == "vertical";
  raster::TextLayout laid;
  if (vertical) {
    raster::VerticalLayoutOptions vo;
    vo.runs = &runs;
    vo.transforms = &transforms;
    vo.boxWidth = boxWidth;
    vo.padX = raster::kTextPadX;
    vo.columnLimit = num_of(ex.at("boxHeight"));
    vo.romanUpright = ex.at("verticalRomanAlignment").is_bool() && ex.at("verticalRomanAlignment").b();
    if (const auto d = num_of(ex.at("tateChuYokoDigits"))) vo.tateChuYokoDigits = static_cast<int>(*d);
    laid = raster::layout_vertical_text(text, style, measure, vo);
  } else {
    raster::LayoutOptions lo;
    lo.runs = &runs;
    lo.transforms = &transforms;
    lo.boxWidth = boxWidth;
    lo.padX = raster::kTextPadX;
    if (ex.at("softBreakLines").is_array()) {
      std::vector<int> soft;
      for (const Json& v : ex.at("softBreakLines").arr()) soft.push_back(v.is_number() ? static_cast<int>(v.num()) : 0);
      lo.softBreakLines = std::move(soft);
    }
    if (ex.at("direction").is_string()) lo.direction = ex.at("direction").str();
    laid = raster::layout_text(text, style, measure, lo);
  }

  const double offY = num_of(ex.at("boxOffsetY")).value_or(0);
  const double fontSize = style.fontSize;
  const double lineHeight = fontSize * style.lineHeight.value_or(raster::kAutoLeading);
  const Json& glyphsIn = layer.glyphs;
  for (const raster::PlacedGlyph& g : laid.glyphs) {
    if (raster::is_js_blank(g.ch)) continue;
    const raster::GlyphTransform* t = g.transform;
    // The glyph box: its advance (at least 1) and one line, padded for overhanging ink.
    const double pad = fontSize * 0.25;
    GlyphPlacement p;
    p.index = g.index;
    p.ch = g.ch;
    p.offsetX = g.x + (t != nullptr ? t->dx : 0);
    p.offsetY = g.y + offY + (t != nullptr ? t->dy : 0);
    p.offsetZ = t != nullptr ? t->dz : 0;
    p.width = std::max(1.0, g.advance) + (pad * 2);
    p.height = lineHeight + (pad * 2);
    p.rotation = (t != nullptr ? t->rotation : 0) + (g.angle ? (*g.angle * 180) / std::numbers::pi : 0);
    p.rotationX = t != nullptr ? t->rotationX : 0;
    p.rotationY = t != nullptr ? t->rotationY : 0;
    p.scale = t != nullptr ? t->scale : 1;
    p.opacity = t != nullptr ? t->opacity : 1;
    p.fill = g.style.fill;
    p.anchorX = t != nullptr ? t->anchorX.value_or(0) : 0;
    p.anchorY = t != nullptr ? t->anchorY.value_or(0) : 0;
    // anchorZ is not in the painter's GlyphTransform: read it off the animator output.
    if (t != nullptr && glyphsIn.is_array() && static_cast<std::size_t>(g.index) < glyphsIn.arr().size()) {
      p.anchorZ = num_of(glyphsIn.arr()[static_cast<std::size_t>(g.index)].at("anchorZ")).value_or(0);
    }
    out.push_back(std::move(p));
  }
  if (out.size() > kMaxPerCharGlyphs) out.clear();
  return out;
}

}  // namespace premation::scene
