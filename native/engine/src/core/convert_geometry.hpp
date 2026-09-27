// What the layer conversions (convertLayer / separateLayer, handlers_convert.cpp)
// ask of the engine's text and SVG systems — a header-only interface, so
// engine_core keeps no link dependency on the fonts, the text layout or the
// SVG parser (the sanitizer, fuzz and headless builds compile the core without
// them). The implementation is engine_scene's (scene/convert_geometry.cpp:
// the E3 FontSet + Canvas2D metrics, raster/text_layout, raster/svg_doc) and
// the process injects it (engine_process.cpp, Session::set_convert_geometry).
//
// A Session without one answers every conversion `unsupported` — exactly as
// the TypeScript engine does (its conversions are editor dialogs), so the
// replay-corpus parity fixtures and the cross-engine replay against a
// core-only engine keep comparing like with like.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"

namespace premation::doc {

using js::Json;
class Document;
struct EditorView;
class ExprEnv;
class ExprCache;

/// One Bézier anchor with ABSOLUTE handles (the Geometry / mask point form).
struct GeoPt {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};
struct GeoRun {
  std::vector<GeoPt> points;
  bool closed = true;
};

/// What the geometry reads the document through (the handler's context).
struct GeoCtx {
  const Document& d;
  const EditorView& view;
  const ExprEnv& expr;
  ExprCache& cache;
};

/// A text layer's glyph outlines in LAYER space (centre origin, px), and the
/// layer box they sit in (the text's measured render box).
struct TextOutlines {
  std::vector<GeoRun> runs;
  double width = 0, height = 0;
  /// The font's own Béziers (true) or a trace of the painted text (false).
  bool fromFont = false;
};

/// One non-blank character of a text layer as it is laid out: the centre of
/// its glyph box relative to the layer centre (layer space) and the box.
struct TextGlyphBox {
  std::string ch;
  int index = 0;  ///< grapheme index in the drawn content
  double offsetX = 0, offsetY = 0;
  double width = 0, height = 0;
  /// The rich-text run style covering it (undefined = none).
  Json runStyle;
};

/// One converted part of an SVG document (svgParser.ts ParsedShape), in the
/// document's VIEWPORT px (the root viewBox mapping applied).
struct SvgPart {
  enum class Kind : std::uint8_t { path, text, image };
  Kind kind = Kind::path;
  std::string name;
  /// The part's box: centre and size (a path's bbox; text's measured box).
  double centerX = 0, centerY = 0, width = 0, height = 0;
  /// Path runs relative to the centre.
  std::vector<GeoRun> runs;
  /// CSS colour of the fill ('transparent' for none; fill-opacity folded in).
  std::string fill = "transparent";
  /// A gradient fill as FillPaint JSON (undefined = none).
  Json fillPaint;
  /// The stroke as the `fx.stroke` object, lengths in viewport px (undefined = none).
  Json stroke;
  bool nonScalingStroke = false;
  /// paint-order paints the stroke first (the fill composite "above").
  bool fillAboveStroke = false;
  /// The element's opacity times its ancestors' (0..1).
  double opacity = 1;
  // text
  std::string text;
  double fontSize = 16;
  std::string fontFamily, fontWeight, fontStyle;
  // image
  std::string href;
};

struct SvgShapes {
  /// The viewport the parts are placed in (the SVG's intrinsic px box).
  double width = 0, height = 0;
  std::vector<SvgPart> parts;
  /// Features of the file the conversion does not carry, in the user's words.
  std::vector<std::string> notCarried;
};

class ConvertGeometry {
 public:
  ConvertGeometry() = default;
  virtual ~ConvertGeometry() = default;
  ConvertGeometry(const ConvertGeometry&) = delete;
  ConvertGeometry& operator=(const ConvertGeometry&) = delete;
  ConvertGeometry(ConvertGeometry&&) = delete;
  ConvertGeometry& operator=(ConvertGeometry&&) = delete;

  /// The text layer's outlines at `compSeconds` (its animated text values
  /// sampled then). nullopt + `why` when it cannot be outlined.
  [[nodiscard]] virtual std::optional<TextOutlines> text_outlines(const GeoCtx& c, std::string_view layer, double compSeconds,
                                                                  std::string& why) = 0;
  /// The text layer's characters as laid out at `compSeconds` (blanks skipped).
  [[nodiscard]] virtual std::optional<std::vector<TextGlyphBox>> text_glyphs(const GeoCtx& c, std::string_view layer,
                                                                             double compSeconds, std::string& why) = 0;
  /// An SVG document as editable parts. `fillOverride` = the SVG layer's
  /// recolour (drawn as `fill: X !important` on every shape).
  [[nodiscard]] virtual std::optional<SvgShapes> svg_shapes(std::string_view markup,
                                                            const std::optional<std::string>& fillOverride,
                                                            std::string& why) = 0;
};

}  // namespace premation::doc
