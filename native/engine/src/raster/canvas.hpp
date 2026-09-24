// Canvas2D — the CanvasRenderingContext2D semantics the TypeScript painters are
// written against (src/core/rendering/raster/*, src/core/text/*), implemented
// in C++ on Skia's CPU raster backend (E3, docs/NATIVE_CORE_PLAN.md).
//
// Why an API-level port: Chromium's Canvas2D IS Skia, and the TS text/vector
// rasters are nothing but a sequence of Canvas2D calls. Reproducing the calls'
// semantics on the same library is the shortest road to the same pixels — the
// painters (vector_paint.cpp, text_paint.cpp) port the TS call for call, and the
// replayer (canvas_replay.cpp) runs a recorded TS call log directly, which
// isolates rasterisation parity from layout parity.
//
// This header carries no Skia type: everything Skia lives in canvas_ffi.cpp
// (the only file allowed to include it, per the native FFI rule).
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "css.hpp"

namespace premation::raster {

class FontSet;

/// A 2D affine matrix in Canvas2D order: x' = a·x + c·y + e, y' = b·x + d·y + f.
struct Mat2D {
  double a = 1.0, b = 0.0, c = 0.0, d = 1.0, e = 0.0, f = 0.0;
  [[nodiscard]] Mat2D operator*(const Mat2D& o) const noexcept {
    return {a * o.a + c * o.b, b * o.a + d * o.b, a * o.c + c * o.d, b * o.c + d * o.d,
            a * o.e + c * o.f + e, b * o.e + d * o.f + f};
  }
  [[nodiscard]] std::optional<Mat2D> inverse() const noexcept;
  [[nodiscard]] bool is_identity() const noexcept { return a == 1 && b == 0 && c == 0 && d == 1 && e == 0 && f == 0; }
};

/// A CanvasGradient: geometry + colour stops. Plain data; Skia builds its shader at draw time.
struct Gradient {
  enum class Kind : std::uint8_t { linear, radial, conic };
  Kind kind = Kind::linear;
  // linear: x0 y0 x1 y1 · radial: x0 y0 r0 x1 y1 r1 · conic: angle x y
  std::array<double, 6> p{};
  struct Stop {
    double offset = 0.0;
    css::Color color;
  };
  std::vector<Stop> stops;
  /// addColorStop: Blink keeps stops sorted by offset, stable for equal offsets.
  void add_stop(double offset, const css::Color& c);
};

/// A CanvasPattern: a pixel snapshot of its source canvas at createPattern time.
struct Pattern {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  // premultiplied
  bool repeatX = true;
  bool repeatY = true;
  Mat2D transform;
};

/// fillStyle / strokeStyle. Gradients and patterns are shared: in the Canvas2D
/// API a style holds a REFERENCE to the gradient object, and a stop added after
/// assignment shows up in the next fill — hence shared_ptr, not a copy.
struct Style {
  enum class Kind : std::uint8_t { color, gradient, pattern };
  Kind kind = Kind::color;
  css::Color color;
  std::shared_ptr<Gradient> gradient;  // shared: see above
  std::shared_ptr<Pattern> pattern;    // shared: see above
};

/// A Path2D: the path-building calls, replayed into a path at fill/stroke/clip
/// time under the canvas's transform at that moment (the Path2D itself has none).
struct Path2D {
  enum class Op : std::uint8_t { move, line, quad, cubic, arc, arcTo, ellipse, rect, roundRect, close };
  struct Cmd {
    Op op = Op::move;
    std::array<double, 8> a{};
    bool ccw = false;
    std::vector<double> radii;
  };
  std::vector<Cmd> cmds;
  void moveTo(double x, double y) { cmds.push_back({Op::move, {x, y}, false, {}}); }
  void lineTo(double x, double y) { cmds.push_back({Op::line, {x, y}, false, {}}); }
  void quadraticCurveTo(double cx, double cy, double x, double y) { cmds.push_back({Op::quad, {cx, cy, x, y}, false, {}}); }
  void bezierCurveTo(double a, double b, double c, double d, double x, double y) { cmds.push_back({Op::cubic, {a, b, c, d, x, y}, false, {}}); }
  void arc(double x, double y, double r, double a0, double a1, bool ccw) { cmds.push_back({Op::arc, {x, y, r, a0, a1}, ccw, {}}); }
  void arcTo(double x1, double y1, double x2, double y2, double r) { cmds.push_back({Op::arcTo, {x1, y1, x2, y2, r}, false, {}}); }
  void ellipse(double x, double y, double rx, double ry, double rot, double a0, double a1, bool ccw) {
    cmds.push_back({Op::ellipse, {x, y, rx, ry, rot, a0, a1}, ccw, {}});
  }
  void rect(double x, double y, double w, double h) { cmds.push_back({Op::rect, {x, y, w, h}, false, {}}); }
  void roundRect(double x, double y, double w, double h, std::vector<double> radii) {
    cmds.push_back({Op::roundRect, {x, y, w, h}, false, std::move(radii)});
  }
  void closePath() { cmds.push_back({Op::close, {}, false, {}}); }
};

enum class LineCap : std::uint8_t { butt, round, square };
enum class LineJoin : std::uint8_t { miter, round, bevel };
enum class TextAlign : std::uint8_t { start, end, left, right, center };
enum class TextBaseline : std::uint8_t { alphabetic, top, hanging, middle, ideographic, bottom };
enum class Direction : std::uint8_t { inherit, ltr, rtl };
enum class FillRule : std::uint8_t { nonzero, evenodd };

/// What measureText returns (the fields the painters read).
struct TextMetrics {
  double width = 0.0;
  double actualBoundingBoxLeft = 0.0;
  double actualBoundingBoxRight = 0.0;
  double actualBoundingBoxAscent = 0.0;
  double actualBoundingBoxDescent = 0.0;
  double fontBoundingBoxAscent = 0.0;
  double fontBoundingBoxDescent = 0.0;
};

/// Raster settings chosen per engine, not per call.
struct CanvasOptions {
  /// Fonts for fillText / measureText; null = text draws nothing.
  const FontSet* fonts = nullptr;
  /// The surface's LCD pixel geometry (Skia SkSurfaceProps): Chromium creates
  /// canvas surfaces with an RGB-horizontal geometry, which makes Skia build
  /// grayscale glyph masks FROM LCD (ClearType 3×1) masks — softer edges than
  /// plain grayscale AA. Parity knob; unknown geometry is the deterministic default.
  bool lcdGeometry = false;
};

class Canvas2D {
 public:
  [[nodiscard]] static std::unique_ptr<Canvas2D> make(std::uint32_t width, std::uint32_t height, const CanvasOptions& opts);
  virtual ~Canvas2D();
  Canvas2D(const Canvas2D&) = delete;
  Canvas2D& operator=(const Canvas2D&) = delete;
  Canvas2D(Canvas2D&&) = delete;
  Canvas2D& operator=(Canvas2D&&) = delete;

  [[nodiscard]] virtual const CanvasOptions& options() const noexcept = 0;
  [[nodiscard]] virtual std::uint32_t width() const noexcept = 0;
  [[nodiscard]] virtual std::uint32_t height() const noexcept = 0;
  /// Setting canvas.width/height: reallocates, clears, resets the state.
  virtual void resize(std::uint32_t width, std::uint32_t height) = 0;
  /// Premultiplied RGBA8, rows top-down — the bytes a canvas upload produces.
  [[nodiscard]] virtual std::vector<std::uint8_t> pixels() const = 0;
  /// document.createElement('canvas') sized w × h, with this canvas's options
  /// (the painters' scratch canvases: tip stamps, snapshots, buffers).
  [[nodiscard]] virtual std::unique_ptr<Canvas2D> create_canvas(std::uint32_t width, std::uint32_t height) const = 0;

  // ── state ──
  virtual void save() = 0;
  virtual void restore() = 0;
  virtual void scale(double x, double y) = 0;
  virtual void rotate(double angle) = 0;
  virtual void translate(double x, double y) = 0;
  virtual void transform(const Mat2D& m) = 0;
  virtual void setTransform(const Mat2D& m) = 0;
  [[nodiscard]] virtual Mat2D getTransform() const = 0;

  virtual void setFillStyle(const Style& s) = 0;
  virtual void setStrokeStyle(const Style& s) = 0;
  [[nodiscard]] virtual const Style& fillStyle() const = 0;
  [[nodiscard]] virtual const Style& strokeStyle() const = 0;
  virtual void setLineWidth(double w) = 0;
  virtual void setLineCap(LineCap c) = 0;
  virtual void setLineJoin(LineJoin j) = 0;
  virtual void setMiterLimit(double m) = 0;
  virtual void setLineDash(const std::vector<double>& dash) = 0;
  virtual void setLineDashOffset(double o) = 0;
  virtual void setGlobalAlpha(double a) = 0;
  [[nodiscard]] virtual double globalAlpha() const = 0;
  /// Returns false (state unchanged) for an unknown operation name, as the canvas ignores it.
  virtual bool setGlobalCompositeOperation(std::string_view op) = 0;
  [[nodiscard]] virtual std::string globalCompositeOperation() const = 0;
  virtual void setFilter(const css::Filter& f) = 0;
  virtual void setImageSmoothing(bool on) = 0;

  // ── text state ──
  /// The `font` shorthand; returns false (unchanged) if it does not parse.
  virtual bool setFont(std::string_view font) = 0;
  [[nodiscard]] virtual std::string font() const = 0;
  virtual void setTextAlign(TextAlign a) = 0;
  virtual void setTextBaseline(TextBaseline b) = 0;
  virtual void setDirection(Direction d) = 0;
  [[nodiscard]] virtual Direction direction() const = 0;
  virtual void setLetterSpacing(double px) = 0;
  virtual void setWordSpacing(double px) = 0;
  virtual void setFontKerning(bool on) = 0;
  virtual void setSmallCaps(bool on) = 0;
  /// CSS font-variation-settings ("'wght' 700, 'wdth' 80") — applied on top of the face.
  virtual void setFontVariationSettings(std::string_view s) = 0;
  /// CSS font-feature-settings for the next draws (features the TS applies through alias faces).
  virtual void setFontFeatureSettings(std::string_view s) = 0;

  // ── path ──
  virtual void beginPath() = 0;
  virtual void moveTo(double x, double y) = 0;
  virtual void lineTo(double x, double y) = 0;
  virtual void quadraticCurveTo(double cx, double cy, double x, double y) = 0;
  virtual void bezierCurveTo(double c1x, double c1y, double c2x, double c2y, double x, double y) = 0;
  virtual void arc(double x, double y, double r, double a0, double a1, bool ccw) = 0;
  virtual void arcTo(double x1, double y1, double x2, double y2, double r) = 0;
  virtual void ellipse(double x, double y, double rx, double ry, double rot, double a0, double a1, bool ccw) = 0;
  virtual void rect(double x, double y, double w, double h) = 0;
  virtual void roundRect(double x, double y, double w, double h, const std::vector<double>& radii) = 0;
  virtual void closePath() = 0;

  virtual void fill(FillRule rule) = 0;
  virtual void stroke() = 0;
  virtual void clip(FillRule rule) = 0;
  virtual void fill(const Path2D& path, FillRule rule) = 0;
  virtual void stroke(const Path2D& path) = 0;
  virtual void clip(const Path2D& path, FillRule rule) = 0;
  virtual void fillRect(double x, double y, double w, double h) = 0;
  virtual void strokeRect(double x, double y, double w, double h) = 0;
  virtual void clearRect(double x, double y, double w, double h) = 0;

  // ── text ──
  virtual void fillText(std::string_view text, double x, double y) = 0;
  virtual void strokeText(std::string_view text, double x, double y) = 0;
  [[nodiscard]] virtual TextMetrics measureText(std::string_view text) = 0;

  // ── images ──
  /// drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) with another canvas as the source.
  virtual void drawImage(const Canvas2D& src, double sx, double sy, double sw, double sh, double dx, double dy, double dw,
                         double dh) = 0;
  [[nodiscard]] std::shared_ptr<Pattern> createPattern(std::string_view repetition) const;

 protected:
  Canvas2D() = default;
};

}  // namespace premation::raster
