// Fonts for the C++ rasterizer (E3): font files (TTF/OTF/WOFF/WOFF2, variable
// fonts included), CSS font matching (family list, weight, style, unicode-range
// fallback — what Blink does for the `font` shorthand a canvas is given), and
// shaping with HarfBuzz into positioned glyph runs.
//
// Skia-free and HarfBuzz-free interface; fonts_ffi.cpp holds the FFI.
#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "css.hpp"

namespace premation::raster {

/// How glyph metrics and masks are produced. The TS reference is Chromium's
/// canvas, which on Windows rasterises with DirectWrite; FreeType is the same on
/// every OS (the engine's determinism rule). Parity is measured for both.
enum class GlyphBackend : std::uint8_t { freetype, platform };

struct FontOptions {
  /// The settings Chromium's canvas rasterises glyphs with on Windows, found by
  /// measurement against the TS rasters (premation-raster --probe): DirectWrite,
  /// slight hinting, subpixel positioning, LCD edging on an RGB-geometry surface
  /// (grayscale masks made from ClearType 3×1 masks). Replayed TS text rasters
  /// then come out with no pixel more than 16/255 off (most within 1/255).
  /// Windows only; pair with CanvasOptions::lcdGeometry = true.
  [[nodiscard]] static FontOptions chromium_windows() {
    FontOptions o;
    o.backend = GlyphBackend::platform;
    o.hinting = 1;
    o.subpixelPositioning = true;
    o.lcdEdging = true;
    return o;
  }

  GlyphBackend backend = GlyphBackend::freetype;
  /// Glyph positions at fractional px. The recorded TS measureText widths are
  /// unrounded linear advances (e.g. Arimo Bold "Motion" at 56 px = 183.4765625 =
  /// 6710 units × 56/2048), so Chromium's canvas runs with it on; off rounds
  /// every advance to whole px as Blink then does.
  bool subpixelPositioning = true;
  /// Skia hinting: 0 none, 1 slight, 2 normal, 3 full.
  int hinting = 0;
  /// Request subpixel (LCD) edging. On a surface with an LCD pixel geometry
  /// (CanvasOptions::lcdGeometry) Skia then makes large glyphs' grayscale masks
  /// from LCD masks, as Chromium's canvas does.
  bool lcdEdging = false;
};

/// One registered face: a FontFace in CSS terms.
struct FaceInfo {
  std::string family;
  int weight = 400;
  bool italic = false;
  /// Empty = every code point the file maps.
  std::vector<css::Range> unicodeRange;
  std::string file;
  /// Face index inside a collection (.ttc).
  int ttcIndex = 0;
};

/// A variation axis setting ('wght' 700).
struct AxisValue {
  std::uint32_t tag = 0;
  float value = 0.0F;
};

/// The per-draw text state a shaping request carries (from Canvas2D state).
struct ShapeRequest {
  css::Font font;
  bool rtl = false;
  double letterSpacing = 0.0;
  double wordSpacing = 0.0;
  bool kerning = true;
  /// CSS font-feature-settings / font-variation-settings strings ("" = none).
  std::string features;
  std::string variations;
};

/// One positioned glyph, in user-space px relative to the run's pen origin.
struct Glyph {
  std::uint16_t id = 0;
  std::int32_t face = -1;
  /// Pen position of the glyph origin.
  double x = 0.0;
  double y = 0.0;
  double advance = 0.0;
  /// Byte offset of the glyph's cluster in the UTF-8 input.
  std::uint32_t cluster = 0;
  /// Synthetic bold / oblique Blink would apply to this face at this request.
  bool fakeBold = false;
  bool fakeItalic = false;
};

/// One cubic segment of a glyph outline, in font units, y UP.
struct OutlineCubic {
  double x0 = 0, y0 = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, x1 = 0, y1 = 0;
};
/// A glyph's outline as openType.ts hands it to optical kerning: closed
/// contours of cubics (TrueType quadratics degree-elevated), font units, y up.
struct GlyphOutlineUnits {
  std::vector<std::vector<OutlineCubic>> contours;
  double advance = 0;  // font units
  double unitsPerEm = 1000;
};

/// A shaped string in VISUAL order, laid from x = 0.
struct ShapedText {
  std::vector<Glyph> glyphs;
  /// Total advance (letter spacing included, as measureText reports it).
  double width = 0.0;
  /// Font-wide metrics of the primary face at the requested size (Blink rounds
  /// them to whole px: FontMetrics::FloatAscent / FloatDescent).
  double ascent = 0.0;
  double descent = 0.0;
  /// The em box Blink's canvas baselines use (SimpleFontData em-height
  /// metrics): the unrounded ascent : descent proportion scaled to the font
  /// size, in LayoutUnits (1/64 px). `middle` = (emAscent − emDescent) / 2.
  double emAscent = 0.0;
  double emDescent = 0.0;
  /// Ink bounds of every glyph (union), relative to the pen origin, y down.
  double inkLeft = 0.0;
  double inkTop = 0.0;
  double inkRight = 0.0;
  double inkBottom = 0.0;
  bool hasInk = false;
  /// Size in px the glyphs are drawn at, and the variations applied.
  double sizePx = 0.0;
  std::vector<AxisValue> axes;
};

class FontSet {
 public:
  explicit FontSet(FontOptions opts);
  ~FontSet();
  FontSet(const FontSet&) = delete;
  FontSet& operator=(const FontSet&) = delete;
  FontSet(FontSet&&) = delete;
  FontSet& operator=(FontSet&&) = delete;

  /// Register a face from font bytes (WOFF2 is decoded). False + message on failure.
  bool add_face(const FaceInfo& info, std::span<const std::uint8_t> bytes, std::string& error);
  /// Load `fonts.json` ({"faces": [{family, weight, style, file, unicodeRange}]}),
  /// files relative to the manifest's directory.
  bool load_manifest(const std::filesystem::path& manifest, std::string& error);
  /// Map a generic / unknown family to a registered one (e.g. "system-ui" → "Arial").
  void alias(std::string from, std::string to);
  /// Register every installed face of a SYSTEM family (DirectWrite on Windows;
  /// elsewhere not implemented yet). CSS generic names map the way Blink's
  /// defaults do on this OS (system-ui → Segoe UI, sans-serif → Arial, …).
  /// Returns how many faces were added. Call before shaping from threads:
  /// shaping only reads the set.
  std::size_t add_system_family(const std::string& family);

  [[nodiscard]] std::size_t face_count() const noexcept;
  [[nodiscard]] const FontOptions& options() const noexcept { return opts_; }

  /// Shape `text` (UTF-8) with CSS font matching + fallback per character, bidi
  /// runs resolved under the request's base direction, glyphs in visual order.
  [[nodiscard]] ShapedText shape(std::string_view text, const ShapeRequest& req) const;

  /// The unhinted outline of a single code point in the face CSS matching picks
  /// for `font` (its cmap glyph, no GSUB): opticalKerning.ts's OUTLINE source.
  /// nullopt: not one code point, no covering face, or an empty glyph.
  [[nodiscard]] std::optional<GlyphOutlineUnits> glyph_outline(std::string_view cluster, const css::Font& font) const;

  /// Opaque access for the Skia side (canvas_ffi.cpp).
  struct Impl;
  [[nodiscard]] const Impl& impl() const noexcept { return *impl_; }

 private:
  FontOptions opts_;
  std::unique_ptr<Impl> impl_;
};

/// Decode a UTF-8 string into code points with the byte offset of each.
struct CodePoint {
  char32_t cp = 0;
  std::uint32_t byte = 0;
};
[[nodiscard]] std::vector<CodePoint> decode_utf8(std::string_view s);

}  // namespace premation::raster
