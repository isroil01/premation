// FFI: Canvas2D on Skia's CPU raster backend (E3). The only file that draws with
// Skia. Semantics follow Blink's BaseRenderingContext2D (the implementation the
// TypeScript rasters ran on), cited per behaviour below.

#include "canvas.hpp"
#include "fonts.hpp"
#include "skia_ffi.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <utility>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include "include/core/SkBlendMode.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColor.h"
#include "include/core/SkColorFilter.h"
#include "include/core/SkImage.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkPathEffect.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkRRect.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkShader.h"
#include "include/core/SkSurface.h"
#include "include/core/SkTextBlob.h"
#include "include/effects/SkDashPathEffect.h"
#include "include/effects/SkGradient.h"
#include "include/effects/SkImageFilters.h"
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::raster {
namespace {

constexpr double kPi = std::numbers::pi;

SkMatrix to_sk(const Mat2D& m) {
  return SkMatrix::MakeAll(static_cast<SkScalar>(m.a), static_cast<SkScalar>(m.c), static_cast<SkScalar>(m.e),
                           static_cast<SkScalar>(m.b), static_cast<SkScalar>(m.d), static_cast<SkScalar>(m.f), 0, 0, 1);
}

SkColor4f to_sk4(const css::Color& c) {
  return {static_cast<float>(c.r / 255.0), static_cast<float>(c.g / 255.0), static_cast<float>(c.b / 255.0),
          static_cast<float>(c.a)};
}

/// Blink stores a canvas colour as 8-bit RGBA (Color → SkColor) and scales its
/// alpha by globalAlpha with rounding (ScaleAlpha).
SkColor to_skcolor(const css::Color& c, double globalAlpha) {
  const auto ch = [](double v) { return static_cast<U8CPU>(std::clamp(std::lround(v), 0L, 255L)); };
  const U8CPU a = ch(c.a * 255.0);
  const U8CPU sa = static_cast<U8CPU>(std::clamp(std::lround(static_cast<double>(a) * globalAlpha), 0L, 255L));
  return SkColorSetARGB(sa, ch(c.r), ch(c.g), ch(c.b));
}

std::optional<SkBlendMode> blend_of(std::string_view op) {
  static constexpr std::array<std::pair<std::string_view, SkBlendMode>, 26> kOps{{
      {"source-over", SkBlendMode::kSrcOver}, {"source-in", SkBlendMode::kSrcIn},
      {"source-out", SkBlendMode::kSrcOut}, {"source-atop", SkBlendMode::kSrcATop},
      {"destination-over", SkBlendMode::kDstOver}, {"destination-in", SkBlendMode::kDstIn},
      {"destination-out", SkBlendMode::kDstOut}, {"destination-atop", SkBlendMode::kDstATop},
      {"lighter", SkBlendMode::kPlus}, {"copy", SkBlendMode::kSrc}, {"xor", SkBlendMode::kXor},
      {"multiply", SkBlendMode::kMultiply}, {"screen", SkBlendMode::kScreen}, {"overlay", SkBlendMode::kOverlay},
      {"darken", SkBlendMode::kDarken}, {"lighten", SkBlendMode::kLighten}, {"color-dodge", SkBlendMode::kColorDodge},
      {"color-burn", SkBlendMode::kColorBurn}, {"hard-light", SkBlendMode::kHardLight},
      {"soft-light", SkBlendMode::kSoftLight}, {"difference", SkBlendMode::kDifference},
      {"exclusion", SkBlendMode::kExclusion}, {"hue", SkBlendMode::kHue}, {"saturation", SkBlendMode::kSaturation},
      {"color", SkBlendMode::kColor}, {"luminosity", SkBlendMode::kLuminosity},
  }};
  for (const auto& [n, m] : kOps) {
    if (n == op) return m;
  }
  return std::nullopt;
}

std::string_view blend_name(SkBlendMode m) {
  switch (m) {
    case SkBlendMode::kSrcIn: return "source-in";
    case SkBlendMode::kSrcOut: return "source-out";
    case SkBlendMode::kSrcATop: return "source-atop";
    case SkBlendMode::kDstOver: return "destination-over";
    case SkBlendMode::kDstIn: return "destination-in";
    case SkBlendMode::kDstOut: return "destination-out";
    case SkBlendMode::kDstATop: return "destination-atop";
    case SkBlendMode::kPlus: return "lighter";
    case SkBlendMode::kSrc: return "copy";
    case SkBlendMode::kXor: return "xor";
    case SkBlendMode::kMultiply: return "multiply";
    case SkBlendMode::kScreen: return "screen";
    case SkBlendMode::kOverlay: return "overlay";
    case SkBlendMode::kDarken: return "darken";
    case SkBlendMode::kLighten: return "lighten";
    case SkBlendMode::kColorDodge: return "color-dodge";
    case SkBlendMode::kColorBurn: return "color-burn";
    case SkBlendMode::kHardLight: return "hard-light";
    case SkBlendMode::kSoftLight: return "soft-light";
    case SkBlendMode::kDifference: return "difference";
    case SkBlendMode::kExclusion: return "exclusion";
    case SkBlendMode::kHue: return "hue";
    case SkBlendMode::kSaturation: return "saturation";
    case SkBlendMode::kColor: return "color";
    case SkBlendMode::kLuminosity: return "luminosity";
    default: return "source-over";
  }
}

/// Composite operations whose effect reaches outside the drawn shape; Blink
/// draws these through a full-canvas layer (BaseRenderingContext2D::CompositedDraw).
bool is_full_canvas_op(SkBlendMode m) {
  return m == SkBlendMode::kSrcIn || m == SkBlendMode::kSrcOut || m == SkBlendMode::kDstIn ||
         m == SkBlendMode::kDstATop || m == SkBlendMode::kSrc;
}

float f(double v) { return static_cast<float>(v); }
bool finite(double a, double b) { return std::isfinite(a) && std::isfinite(b); }

/// The Canvas2D path-building calls on an SkPathBuilder (CanvasPath + Blink
/// Path) — shared by the canvas's current path and Path2D objects.
struct PathOps {
  // A short-lived view (built per call as PathOps{path_}), never stored or assigned.
  SkPathBuilder& b;  // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members)

  void ensure_start(double x, double y) {
    if (b.isEmpty()) b.moveTo(f(x), f(y));
  }
  static void append_arc(SkPathBuilder& to, const SkRect& oval, float startDeg, float sweepDeg) {
    // Blink Path::AddEllipse: Skia's arcTo cannot sweep a whole turn, so a
    // full ellipse is two half sweeps.
    if (std::fabs(sweepDeg) >= 360.0F) {
      const float half = std::copysign(180.0F, sweepDeg);
      to.arcTo(oval, startDeg, half, false);
      to.arcTo(oval, startDeg + half, half, false);
      return;
    }
    to.arcTo(oval, startDeg, sweepDeg, false);
  }
  void moveTo(double x, double y) {
    if (!finite(x, y)) return;
    b.moveTo(f(x), f(y));
  }
  void lineTo(double x, double y) {
    if (!finite(x, y)) return;
    ensure_start(x, y);
    b.lineTo(f(x), f(y));
  }
  void quad(double cx, double cy, double x, double y) {
    if (!finite(cx, cy) || !finite(x, y)) return;
    ensure_start(cx, cy);
    b.quadTo(f(cx), f(cy), f(x), f(y));
  }
  void cubic(double c1x, double c1y, double c2x, double c2y, double x, double y) {
    if (!finite(c1x, c1y) || !finite(c2x, c2y) || !finite(x, y)) return;
    ensure_start(c1x, c1y);
    b.cubicTo(f(c1x), f(c1y), f(c2x), f(c2y), f(x), f(y));
  }
  void arcTo(double x1, double y1, double x2, double y2, double r) {
    if (!finite(x1, y1) || !finite(x2, y2) || !std::isfinite(r) || r < 0) return;
    ensure_start(x1, y1);
    b.arcTo(SkPoint::Make(f(x1), f(y1)), SkPoint::Make(f(x2), f(y2)), f(r));
  }
  void ellipse(double x, double y, double rx, double ry, double rot, double a0, double a1, bool ccw) {
    if (!finite(x, y) || !finite(rx, ry) || !std::isfinite(rot) || !finite(a0, a1) || rx < 0 || ry < 0) return;
    // CanvasPath::ellipse: canonicalize the start angle into [0, 2π), clamp the
    // sweep to one turn in the requested direction.
    const double twoPi = 2 * kPi;
    double start = std::fmod(a0, twoPi);
    if (start < 0) start += twoPi;
    const double delta = start - a0;
    double end = a1 + delta;
    if (!ccw && end - start >= twoPi) end = start + twoPi;
    else if (ccw && start - end >= twoPi) end = start - twoPi;
    else if (!ccw && start > end) end = start + (twoPi - std::fmod(start - end, twoPi));
    else if (ccw && start < end) end = start - (twoPi - std::fmod(end - start, twoPi));
    const double cx = rot != 0.0 ? 0.0 : x;
    const double cy = rot != 0.0 ? 0.0 : y;
    const SkRect oval = SkRect::MakeLTRB(f(cx - rx), f(cy - ry), f(cx + rx), f(cy + ry));
    const auto startDeg = static_cast<float>(start * 180.0 / kPi);
    const auto sweepDeg = static_cast<float>((end - start) * 180.0 / kPi);
    if (rot == 0.0) {
      append_arc(b, oval, startDeg, sweepDeg);
      return;
    }
    // Rotated: build in the ellipse's frame and transform into the path.
    const Mat2D local = Mat2D{1, 0, 0, 1, x, y} * Mat2D{std::cos(rot), std::sin(rot), -std::sin(rot), std::cos(rot), 0, 0};
    SkPathBuilder seg;
    append_arc(seg, oval, startDeg, sweepDeg);
    const SkPath p = seg.detach(nullptr);
    b.addPath(p, to_sk(local), b.isEmpty() ? SkPath::kAppend_AddPathMode : SkPath::kExtend_AddPathMode);
  }
  void rect(double x, double y, double w, double h) {
    if (!finite(x, y) || !finite(w, h)) return;
    // Blink Path::AddRect: moveTo + 3 lineTo + close (clockwise as given).
    b.moveTo(f(x), f(y));
    b.lineTo(f(x + w), f(y));
    b.lineTo(f(x + w), f(y + h));
    b.lineTo(f(x), f(y + h));
    b.close();
  }
  void roundRect(double x, double y, double w, double h, const std::vector<double>& radii) {
    const double r = radii.empty() ? 0.0 : radii.front();
    b.addRRect(SkRRect::MakeRectXY(SkRect::MakeXYWH(f(x), f(y), f(w), f(h)), f(r), f(r)));
  }
  void close() {
    if (!b.isEmpty()) b.close();
  }
};

struct State {
  Mat2D ctm;
  Style fill;
  Style stroke;
  double lineWidth = 1.0;
  LineCap cap = LineCap::butt;
  LineJoin join = LineJoin::miter;
  double miterLimit = 10.0;
  std::vector<double> dash;
  double dashOffset = 0.0;
  double globalAlpha = 1.0;
  SkBlendMode blend = SkBlendMode::kSrcOver;
  double blurPx = 0.0;
  std::vector<css::FilterOp> filterOps;  // a filter-function list (the bake chain's CSS effects)
  css::Color shadowColor{0, 0, 0, 0};  // transparent black: no shadow
  double shadowBlur = 0.0;
  double shadowOffsetX = 0.0;
  double shadowOffsetY = 0.0;
  bool smoothing = true;
  std::string fontString = "10px sans-serif";
  css::Font font = [] {
    css::Font f;
    f.families = {"sans-serif"};
    return f;
  }();
  TextAlign align = TextAlign::start;
  TextBaseline baseline = TextBaseline::alphabetic;
  Direction direction = Direction::inherit;
  double letterSpacing = 0.0;
  double wordSpacing = 0.0;
  bool kerning = true;
  bool smallCaps = false;
  std::string variations;
  std::string features;
};

class SkiaCanvas final : public Canvas2D {
 public:
  SkiaCanvas(std::uint32_t w, std::uint32_t h, const CanvasOptions& o) : opts_(o) { alloc(w, h); }
  SkiaCanvas(const SkiaCanvas&) = delete;
  SkiaCanvas& operator=(const SkiaCanvas&) = delete;
  SkiaCanvas(SkiaCanvas&&) = delete;
  SkiaCanvas& operator=(SkiaCanvas&&) = delete;
  ~SkiaCanvas() override = default;

  [[nodiscard]] const CanvasOptions& options() const noexcept override { return opts_; }
  [[nodiscard]] std::uint32_t width() const noexcept override { return w_; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return h_; }
  void resize(std::uint32_t w, std::uint32_t h) override { alloc(w, h); }
  [[nodiscard]] std::unique_ptr<Canvas2D> create_canvas(std::uint32_t w, std::uint32_t h) const override {
    return std::make_unique<SkiaCanvas>(w, h, opts_);
  }

  [[nodiscard]] std::vector<std::uint8_t> pixels() const override {
    std::vector<std::uint8_t> out(static_cast<std::size_t>(w_) * h_ * 4);
    if (surface_ == nullptr) return out;
    const SkImageInfo info = SkImageInfo::Make(static_cast<int>(w_), static_cast<int>(h_), kRGBA_8888_SkColorType,
                                               kPremul_SkAlphaType);
    const SkPixmap pm(info, out.data(), static_cast<std::size_t>(w_) * 4);
    (void)surface_->readPixels(pm, 0, 0);
    return out;
  }

  [[nodiscard]] sk_sp<SkImage> snapshot() const { return surface_ ? surface_->makeImageSnapshot() : nullptr; }

  // ── state ──
  void save() override {
    stack_.push_back(st_);
    canvas()->save();
  }
  void restore() override {
    if (stack_.empty()) return;
    const Mat2D prev = st_.ctm;
    st_ = stack_.back();
    stack_.pop_back();
    canvas()->restore();
    ctm_changed(prev);
  }
  void scale(double x, double y) override { set_ctm(st_.ctm * Mat2D{x, 0, 0, y, 0, 0}); }
  void rotate(double angle) override {
    const double c = std::cos(angle);
    const double s = std::sin(angle);
    set_ctm(st_.ctm * Mat2D{c, s, -s, c, 0, 0});
  }
  void translate(double x, double y) override { set_ctm(st_.ctm * Mat2D{1, 0, 0, 1, x, y}); }
  void transform(const Mat2D& m) override { set_ctm(st_.ctm * m); }
  void setTransform(const Mat2D& m) override { set_ctm(m); }
  [[nodiscard]] Mat2D getTransform() const override { return st_.ctm; }

  void setFillStyle(const Style& s) override { st_.fill = s; }
  void setStrokeStyle(const Style& s) override { st_.stroke = s; }
  [[nodiscard]] const Style& fillStyle() const override { return st_.fill; }
  [[nodiscard]] const Style& strokeStyle() const override { return st_.stroke; }
  void setLineWidth(double w) override {
    if (std::isfinite(w) && w > 0) st_.lineWidth = w;
  }
  void setLineCap(LineCap c) override { st_.cap = c; }
  void setLineJoin(LineJoin j) override { st_.join = j; }
  void setMiterLimit(double m) override {
    if (std::isfinite(m) && m > 0) st_.miterLimit = m;
  }
  void setLineDash(const std::vector<double>& dash) override {
    for (const double d : dash) {
      if (!std::isfinite(d) || d < 0) return;  // the spec ignores the whole call
    }
    st_.dash = dash;
    if (st_.dash.size() % 2 == 1) st_.dash.insert(st_.dash.end(), dash.begin(), dash.end());
  }
  void setLineDashOffset(double o) override {
    if (std::isfinite(o)) st_.dashOffset = o;
  }
  void setGlobalAlpha(double a) override {
    if (std::isfinite(a) && a >= 0 && a <= 1) st_.globalAlpha = a;
  }
  [[nodiscard]] double globalAlpha() const override { return st_.globalAlpha; }
  bool setGlobalCompositeOperation(std::string_view op) override {
    const auto m = blend_of(op);
    if (!m) return false;
    st_.blend = *m;
    return true;
  }
  [[nodiscard]] std::string globalCompositeOperation() const override { return std::string(blend_name(st_.blend)); }
  void setFilter(const css::Filter& f) override {
    st_.blurPx = f.blurPx;
    st_.filterOps = f.ops;
  }
  void setImageSmoothing(bool on) override { st_.smoothing = on; }
  void setShadowColor(const css::Color& c) override { st_.shadowColor = c; }
  void setShadowBlur(double b) override {
    if (std::isfinite(b) && b >= 0) st_.shadowBlur = b;
  }
  void setShadowOffsetX(double x) override {
    if (std::isfinite(x)) st_.shadowOffsetX = x;
  }
  void setShadowOffsetY(double y) override {
    if (std::isfinite(y)) st_.shadowOffsetY = y;
  }

  [[nodiscard]] std::vector<std::uint8_t> getImageData(int x, int y, std::uint32_t w, std::uint32_t h) const override {
    std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4, 0);
    if (surface_ == nullptr || w == 0 || h == 0) return out;
    // Chromium reads canvas pixels back unpremultiplied through Skia's own conversion.
    const SkImageInfo info = SkImageInfo::Make(static_cast<int>(w), static_cast<int>(h), kRGBA_8888_SkColorType,
                                               kUnpremul_SkAlphaType);
    const SkPixmap pm(info, out.data(), static_cast<std::size_t>(w) * 4);
    (void)surface_->readPixels(pm, x, y);
    return out;
  }
  void putImageData(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h, int x, int y) override {
    if (surface_ == nullptr || w == 0 || h == 0 || rgba.size() < static_cast<std::size_t>(w) * h * 4) return;
    const SkImageInfo info = SkImageInfo::Make(static_cast<int>(w), static_cast<int>(h), kRGBA_8888_SkColorType,
                                               kUnpremul_SkAlphaType);
    const SkPixmap pm(info, rgba.data(), static_cast<std::size_t>(w) * 4);
    surface_->writePixels(pm, x, y);
  }

  bool setFont(std::string_view font) override {
    auto f = css::parse_font(font);
    if (!f) return false;
    st_.font = *f;
    st_.fontString = std::string(font);
    return true;
  }
  [[nodiscard]] std::string font() const override { return st_.fontString; }
  void setTextAlign(TextAlign a) override { st_.align = a; }
  void setTextBaseline(TextBaseline b) override { st_.baseline = b; }
  void setDirection(Direction d) override { st_.direction = d; }
  [[nodiscard]] Direction direction() const override { return st_.direction; }
  void setLetterSpacing(double px) override { st_.letterSpacing = px; }
  void setWordSpacing(double px) override { st_.wordSpacing = px; }
  void setFontKerning(bool on) override { st_.kerning = on; }
  void setSmallCaps(bool on) override { st_.smallCaps = on; }
  void setFontVariationSettings(std::string_view s) override { st_.variations = std::string(s); }
  void setFontFeatureSettings(std::string_view s) override { st_.features = std::string(s); }

  // ── path (user space of the current transform, as Blink keeps it) ──
  void beginPath() override { path_.reset(); }
  void moveTo(double x, double y) override { PathOps{path_}.moveTo(x, y); }
  void lineTo(double x, double y) override { PathOps{path_}.lineTo(x, y); }
  void quadraticCurveTo(double cx, double cy, double x, double y) override { PathOps{path_}.quad(cx, cy, x, y); }
  void bezierCurveTo(double c1x, double c1y, double c2x, double c2y, double x, double y) override {
    PathOps{path_}.cubic(c1x, c1y, c2x, c2y, x, y);
  }
  void arc(double x, double y, double r, double a0, double a1, bool ccw) override {
    PathOps{path_}.ellipse(x, y, r, r, 0, a0, a1, ccw);
  }
  void arcTo(double x1, double y1, double x2, double y2, double r) override { PathOps{path_}.arcTo(x1, y1, x2, y2, r); }
  void ellipse(double x, double y, double rx, double ry, double rot, double a0, double a1, bool ccw) override {
    PathOps{path_}.ellipse(x, y, rx, ry, rot, a0, a1, ccw);
  }
  void rect(double x, double y, double w, double h) override { PathOps{path_}.rect(x, y, w, h); }
  void roundRect(double x, double y, double w, double h, const std::vector<double>& radii) override {
    PathOps{path_}.roundRect(x, y, w, h, radii);
  }
  void closePath() override { PathOps{path_}.close(); }

  void fill(FillRule rule) override { fill_sk(path_.snapshot(), rule); }
  void stroke() override { stroke_sk(path_.snapshot()); }
  void clip(FillRule rule) override { clip_sk(path_.snapshot(), rule); }
  void fill(const Path2D& path, FillRule rule) override { fill_sk(build(path), rule); }
  void stroke(const Path2D& path) override { stroke_sk(build(path)); }
  void clip(const Path2D& path, FillRule rule) override { clip_sk(build(path), rule); }

  static SkPath build(const Path2D& path) {
    SkPathBuilder b;
    PathOps ops{b};
    for (const auto& c : path.cmds) {
      const auto& a = c.a;
      switch (c.op) {
        case Path2D::Op::move: ops.moveTo(a[0], a[1]); break;
        case Path2D::Op::line: ops.lineTo(a[0], a[1]); break;
        case Path2D::Op::quad: ops.quad(a[0], a[1], a[2], a[3]); break;
        case Path2D::Op::cubic: ops.cubic(a[0], a[1], a[2], a[3], a[4], a[5]); break;
        case Path2D::Op::arc: ops.ellipse(a[0], a[1], a[2], a[2], 0, a[3], a[4], c.ccw); break;
        case Path2D::Op::arcTo: ops.arcTo(a[0], a[1], a[2], a[3], a[4]); break;
        case Path2D::Op::ellipse: ops.ellipse(a[0], a[1], a[2], a[3], a[4], a[5], a[6], c.ccw); break;
        case Path2D::Op::rect: ops.rect(a[0], a[1], a[2], a[3]); break;
        case Path2D::Op::roundRect: ops.roundRect(a[0], a[1], a[2], a[3], c.radii); break;
        case Path2D::Op::close: ops.close(); break;
      }
    }
    return b.detach(nullptr);
  }
  void fill_sk(SkPath p, FillRule rule) {
    p = p.makeFillType(rule == FillRule::evenodd ? SkPathFillType::kEvenOdd : SkPathFillType::kWinding);
    draw([&](SkCanvas* c, const SkPaint& paint) { c->drawPath(p, paint); }, fill_paint());
  }
  void stroke_sk(const SkPath& p) {
    draw([&](SkCanvas* c, const SkPaint& paint) { c->drawPath(p, paint); }, stroke_paint());
  }
  void clip_sk(SkPath p, FillRule rule) {
    p = p.makeFillType(rule == FillRule::evenodd ? SkPathFillType::kEvenOdd : SkPathFillType::kWinding);
    canvas()->setMatrix(to_sk(st_.ctm));
    canvas()->clipPath(p, SkClipOp::kIntersect, true);
  }
  void fillRect(double x, double y, double w, double h) override {
    if (!finite(x, y) || !finite(w, h)) return;
    const SkRect r = SkRect::MakeXYWH(f(x), f(y), f(w), f(h)).makeSorted();
    draw([&](SkCanvas* c, const SkPaint& paint) { c->drawRect(r, paint); }, fill_paint());
  }
  void strokeRect(double x, double y, double w, double h) override {
    if (!finite(x, y) || !finite(w, h)) return;
    const SkRect r = SkRect::MakeXYWH(f(x), f(y), f(w), f(h)).makeSorted();
    draw([&](SkCanvas* c, const SkPaint& paint) { c->drawRect(r, paint); }, stroke_paint());
  }
  void clearRect(double x, double y, double w, double h) override {
    if (!finite(x, y) || !finite(w, h)) return;
    SkPaint clear;
    clear.setBlendMode(SkBlendMode::kClear);
    clear.setAntiAlias(true);
    canvas()->setMatrix(to_sk(st_.ctm));
    canvas()->drawRect(SkRect::MakeXYWH(f(x), f(y), f(w), f(h)).makeSorted(), clear);
  }

  // ── text ──
  void fillText(std::string_view text, double x, double y) override { draw_text(text, x, y, false); }
  void strokeText(std::string_view text, double x, double y) override { draw_text(text, x, y, true); }

  [[nodiscard]] TextMetrics measureText(std::string_view text) override {
    TextMetrics m;
    if (opts_.fonts == nullptr) return m;
    const ShapedText s = opts_.fonts->shape(text, request());
    m.width = s.width;
    const bool rtl = st_.direction == Direction::rtl;
    // TextMetrics::Update: the ink box relative to the text-align anchor.
    double dx = 0;
    const TextAlign a = resolved_align(rtl);
    if (a == TextAlign::center) dx = static_cast<double>(static_cast<float>(s.width) / 2.0F);
    else if (a == TextAlign::right) dx = s.width;
    const double baseline = baseline_offset(s);
    m.actualBoundingBoxLeft = s.hasInk ? -s.inkLeft + dx : dx;
    m.actualBoundingBoxRight = s.hasInk ? s.inkRight - dx : -dx;
    m.actualBoundingBoxAscent = s.hasInk ? -s.inkTop - baseline : -baseline;
    m.actualBoundingBoxDescent = s.hasInk ? s.inkBottom + baseline : baseline;
    m.fontBoundingBoxAscent = s.ascent - baseline;
    m.fontBoundingBoxDescent = s.descent + baseline;
    return m;
  }

  // ── images ──
  void drawImage(const Canvas2D& src, double sx, double sy, double sw, double sh, double dx, double dy, double dw,
                 double dh) override {
    const auto* s = dynamic_cast<const SkiaCanvas*>(&src);
    if (s == nullptr) return;
    const sk_sp<SkImage> img = s->snapshot();
    if (!img) return;
    SkRect srcR = SkRect::MakeXYWH(f(sx), f(sy), f(sw), f(sh)).makeSorted();
    const SkRect dstR = SkRect::MakeXYWH(f(dx), f(dy), f(dw), f(dh)).makeSorted();
    if (!srcR.intersect(SkRect::MakeWH(static_cast<float>(img->width()), static_cast<float>(img->height())))) return;
    SkPaint paint;
    paint.setAntiAlias(true);
    paint.setAlphaf(static_cast<float>(st_.globalAlpha));
    const SkSamplingOptions sampling = st_.smoothing ? SkSamplingOptions(SkFilterMode::kLinear) : SkSamplingOptions();
    draw([&](SkCanvas* c, const SkPaint& p) {
      c->drawImageRect(img, srcR, dstR, sampling, &p, SkCanvas::kStrict_SrcRectConstraint);
    }, paint);
  }

 private:
  CanvasOptions opts_;
  std::uint32_t w_ = 0;
  std::uint32_t h_ = 0;
  sk_sp<SkSurface> surface_;
  State st_;
  std::vector<State> stack_;
  SkPathBuilder path_;

  SkCanvas* canvas() { return surface_->getCanvas(); }

  /// FilterEffectBuilder + PaintFilterBuilder for a filter-function list: each
  /// function's effect takes the previous one as its input, in sRGB (the CSS
  /// shorthand functions' operating space), unclipped. Lengths are canvas px
  /// (the filter layer is saved under an identity matrix, as for blur).
  [[nodiscard]] static sk_sp<SkImageFilter> filter_chain(const std::vector<css::FilterOp>& ops) {
    sk_sp<SkImageFilter> prev;
    for (const css::FilterOp& op : ops) {
      switch (op.kind) {
        case css::FilterOp::Kind::blur:
          prev = SkImageFilters::Blur(f(op.sigma), f(op.sigma), SkTileMode::kDecal, prev);
          break;
        case css::FilterOp::Kind::matrix:
          prev = SkImageFilters::ColorFilter(SkColorFilters::Matrix(op.matrix.data()), prev);
          break;
        case css::FilterOp::Kind::table:
          prev = SkImageFilters::ColorFilter(
              SkColorFilters::TableARGB(op.table[3].data(), op.table[0].data(), op.table[1].data(), op.table[2].data()), prev);
          break;
        case css::FilterOp::Kind::dropShadow:
          prev = SkImageFilters::DropShadow(f(op.dx), f(op.dy), f(op.sigma), f(op.sigma), to_skcolor(op.color, 1.0), prev);
          break;
      }
    }
    return prev;
  }

  void alloc(std::uint32_t w, std::uint32_t h) {
    w_ = std::max<std::uint32_t>(w, 1);
    h_ = std::max<std::uint32_t>(h, 1);
    const SkSurfaceProps props(0, opts_.lcdGeometry ? kRGB_H_SkPixelGeometry : kUnknown_SkPixelGeometry);
    surface_ = SkSurfaces::Raster(SkImageInfo::Make(static_cast<int>(w_), static_cast<int>(h_), kRGBA_8888_SkColorType,
                                                    kPremul_SkAlphaType),
                                  &props);
    st_ = State{};
    stack_.clear();
    path_.reset();
  }

  /// A CTM change keeps the current path where it is on the canvas: Blink
  /// re-expresses the path in the new user space.
  void ctm_changed(const Mat2D& prev) {
    if (path_.isEmpty()) return;
    const auto inv = st_.ctm.inverse();
    if (!inv) return;
    path_.transform(to_sk(*inv * prev));
  }
  void set_ctm(const Mat2D& m) {
    const Mat2D prev = st_.ctm;
    st_.ctm = m;
    ctm_changed(prev);
  }

  void apply_style(SkPaint& p, const Style& s) const {
    p.setAntiAlias(true);
    switch (s.kind) {
      case Style::Kind::color:
        p.setColor(to_skcolor(s.color, st_.globalAlpha));
        break;
      case Style::Kind::gradient:
        p.setShader(gradient_shader(*s.gradient));
        p.setAlphaf(static_cast<float>(st_.globalAlpha));
        if (!p.getShader()) p.setColor(SK_ColorTRANSPARENT);
        break;
      case Style::Kind::pattern:
        p.setShader(pattern_shader(*s.pattern));
        p.setAlphaf(static_cast<float>(st_.globalAlpha));
        break;
    }
  }

  [[nodiscard]] SkPaint fill_paint() const {
    SkPaint p;
    apply_style(p, st_.fill);
    p.setStyle(SkPaint::kFill_Style);
    return p;
  }

  [[nodiscard]] SkPaint stroke_paint() const {
    SkPaint p;
    apply_style(p, st_.stroke);
    p.setStyle(SkPaint::kStroke_Style);
    p.setStrokeWidth(f(st_.lineWidth));
    p.setStrokeCap(st_.cap == LineCap::round ? SkPaint::kRound_Cap
                   : st_.cap == LineCap::square ? SkPaint::kSquare_Cap : SkPaint::kButt_Cap);
    p.setStrokeJoin(st_.join == LineJoin::round ? SkPaint::kRound_Join
                    : st_.join == LineJoin::bevel ? SkPaint::kBevel_Join : SkPaint::kMiter_Join);
    p.setStrokeMiter(f(st_.miterLimit));
    if (!st_.dash.empty()) {
      bool any = false;
      std::vector<SkScalar> iv;
      iv.reserve(st_.dash.size());
      for (const double d : st_.dash) {
        iv.push_back(f(d));
        any = any || d > 0;
      }
      if (any) p.setPathEffect(SkDashPathEffect::Make({iv.data(), iv.size()}, f(st_.dashOffset)));
    }
    return p;
  }

  static sk_sp<SkShader> gradient_shader(const Gradient& g) {
    // Blink Gradient::FillSkiaStops: no stops = transparent; the first / last
    // stop is repeated at 0 / 1 when missing.
    std::vector<SkColor4f> colors;
    std::vector<float> pos;
    if (g.stops.empty()) {
      colors = {SkColors::kTransparent, SkColors::kTransparent};
      pos = {0.0F, 1.0F};
    } else {
      if (g.stops.front().offset > 0) {
        colors.push_back(to_sk4(g.stops.front().color));
        pos.push_back(0.0F);
      }
      for (const auto& s : g.stops) {
        colors.push_back(to_sk4(s.color));
        pos.push_back(static_cast<float>(std::clamp(s.offset, 0.0, 1.0)));
      }
      if (g.stops.back().offset < 1) {
        colors.push_back(to_sk4(g.stops.back().color));
        pos.push_back(1.0F);
      }
    }
    // Canvas gradients interpolate UNpremultiplied (Gradient::ColorInterpolation::kUnpremultiplied).
    const SkGradient grad(SkGradient::Colors({colors.data(), colors.size()}, {pos.data(), pos.size()}, SkTileMode::kClamp),
                          SkGradient::Interpolation{});
    switch (g.kind) {
      case Gradient::Kind::linear: {
        const std::array<SkPoint, 2> pts{SkPoint{f(g.p[0]), f(g.p[1])}, SkPoint{f(g.p[2]), f(g.p[3])}};
        if (pts[0] == pts[1]) return nullptr;  // degenerate: paints nothing
        return SkShaders::LinearGradient(pts.data(), grad);
      }
      case Gradient::Kind::radial: {
        if (g.p[0] == g.p[3] && g.p[1] == g.p[4] && g.p[2] == g.p[5]) return nullptr;
        return SkShaders::TwoPointConicalGradient({f(g.p[0]), f(g.p[1])}, f(g.p[2]), {f(g.p[3]), f(g.p[4])}, f(g.p[5]),
                                                  grad);
      }
      case Gradient::Kind::conic: {
        const SkMatrix rot = SkMatrix::RotateDeg(f(g.p[0] * 180.0 / kPi), {f(g.p[1]), f(g.p[2])});
        return SkShaders::SweepGradient({f(g.p[1]), f(g.p[2])}, grad, &rot);
      }
    }
    return nullptr;
  }

  [[nodiscard]] sk_sp<SkShader> pattern_shader(const Pattern& p) const {
    const SkImageInfo info = SkImageInfo::Make(static_cast<int>(p.width), static_cast<int>(p.height),
                                               kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    const SkPixmap pm(info, p.rgba.data(), static_cast<std::size_t>(p.width) * 4);
    const sk_sp<SkImage> img = SkImages::RasterFromPixmapCopy(pm);
    if (!img) return nullptr;
    const SkMatrix lm = to_sk(p.transform);
    return img->makeShader(p.repeatX ? SkTileMode::kRepeat : SkTileMode::kDecal,
                           p.repeatY ? SkTileMode::kRepeat : SkTileMode::kDecal,
                           st_.smoothing ? SkSamplingOptions(SkFilterMode::kLinear) : SkSamplingOptions(), &lm);
  }

  /// BaseRenderingContext2D::Draw + CompositedDraw: plain draws go straight to
  /// the canvas with the blend mode on the paint; a filter or a composite
  /// operation that reaches outside the shape goes through a full-canvas layer.
  template <typename F>
  void draw(const F& fn, SkPaint paint) {
    SkCanvas* c = canvas();
    // CanvasRenderingContext2DState::ShouldDrawShadows.
    const bool shadows = st_.shadowColor.a > 0 && (st_.shadowBlur > 0 || st_.shadowOffsetX != 0 || st_.shadowOffsetY != 0);
    const bool layer = st_.blurPx > 0 || !st_.filterOps.empty() || shadows || is_full_canvas_op(st_.blend);
    if (!layer) {
      paint.setBlendMode(st_.blend);
      c->setMatrix(to_sk(st_.ctm));
      fn(c, paint);
      return;
    }
    SkPaint lp;
    lp.setBlendMode(st_.blend);
    if (!st_.filterOps.empty()) {
      lp.setImageFilter(filter_chain(st_.filterOps));
    } else if (st_.blurPx > 0) {
      // BaseRenderingContext2D::CompositedDraw saves the filter layer under an
      // IDENTITY matrix, so a canvas filter length is canvas (device) pixels —
      // the transform does not scale it. Measured on mask-feather (2× raster).
      lp.setImageFilter(SkImageFilters::Blur(f(st_.blurPx), f(st_.blurPx), SkTileMode::kDecal, nullptr));
    }
    if (shadows) {
      // Shadow and foreground in one drop-shadow filter, under the same
      // identity-matrix layer: offset and blur are canvas pixels, σ = blur / 2
      // (the HTML shadow model Blink implements).
      const float sigma = f(st_.shadowBlur / 2);
      lp.setImageFilter(SkImageFilters::DropShadow(f(st_.shadowOffsetX), f(st_.shadowOffsetY), sigma, sigma,
                                                   to_skcolor(st_.shadowColor, 1.0), lp.refImageFilter()));
    }
    c->setMatrix(SkMatrix::I());
    c->saveLayer(nullptr, &lp);
    c->setMatrix(to_sk(st_.ctm));
    paint.setBlendMode(SkBlendMode::kSrcOver);
    fn(c, paint);
    c->restore();
  }

  [[nodiscard]] ShapeRequest request() const {
    ShapeRequest r;
    r.font = st_.font;
    r.rtl = st_.direction == Direction::rtl;
    r.letterSpacing = st_.letterSpacing;
    r.wordSpacing = st_.wordSpacing;
    r.kerning = st_.kerning;
    r.variations = st_.variations;
    r.features = st_.features;
    if (st_.smallCaps || st_.font.smallCaps) {
      r.features += r.features.empty() ? "'smcp' 1" : ", 'smcp' 1";
    }
    return r;
  }

  [[nodiscard]] TextAlign resolved_align(bool rtl) const {
    switch (st_.align) {
      case TextAlign::start: return rtl ? TextAlign::right : TextAlign::left;
      case TextAlign::end: return rtl ? TextAlign::left : TextAlign::right;
      default: return st_.align;
    }
  }

  /// BaseRenderingContext2D::GetFontBaseline: the em box, not the rounded
  /// ascent/descent (measured: Arimo Bold 56 px middle = 17.375 in Chromium).
  [[nodiscard]] double baseline_offset(const ShapedText& s) const {
    const auto a = static_cast<float>(s.emAscent);
    const auto d = static_cast<float>(s.emDescent);
    switch (st_.baseline) {
      case TextBaseline::top: return static_cast<double>(a);
      case TextBaseline::hanging: return static_cast<double>(a * 80.0F / 100.0F);
      case TextBaseline::middle: return static_cast<double>((a - d) / 2.0F);
      case TextBaseline::bottom:
      case TextBaseline::ideographic: return static_cast<double>(-d);
      case TextBaseline::alphabetic: return 0.0;
    }
    return 0.0;
  }

  void draw_text(std::string_view text, double x, double y, bool strokeIt) {
    if (opts_.fonts == nullptr || !finite(x, y)) return;
    const ShapedText s = opts_.fonts->shape(text, request());
    if (s.glyphs.empty()) return;
    const bool rtl = st_.direction == Direction::rtl;
    // DrawTextInternal: location is a gfx::PointF (float).
    auto lx = static_cast<float>(x);
    const auto ly = static_cast<float>(y + baseline_offset(s));
    const auto width = static_cast<float>(s.width);
    const TextAlign a = resolved_align(rtl);
    if (a == TextAlign::center) lx -= width / 2.0F;
    else if (a == TextAlign::right) lx -= width;

    SkTextBlobBuilder builder;
    std::size_t i = 0;
    while (i < s.glyphs.size()) {
      std::size_t j = i + 1;
      while (j < s.glyphs.size() && s.glyphs[j].face == s.glyphs[i].face && s.glyphs[j].fakeBold == s.glyphs[i].fakeBold &&
             s.glyphs[j].fakeItalic == s.glyphs[i].fakeItalic) {
        ++j;
      }
      const SkFont font = ffi::sk_font_for(*opts_.fonts, s.glyphs[i].face, s.axes, s.sizePx, s.glyphs[i].fakeBold,
                                           s.glyphs[i].fakeItalic);
      const auto& run = builder.allocRunPos(font, static_cast<int>(j - i));
      for (std::size_t k = i; k < j; ++k) {
        run.glyphs[k - i] = s.glyphs[k].id;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        run.points()[k - i] = SkPoint::Make(static_cast<float>(s.glyphs[k].x), static_cast<float>(s.glyphs[k].y));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      i = j;
    }
    const sk_sp<SkTextBlob> blob = builder.make();
    if (!blob) return;
    draw([&](SkCanvas* c, const SkPaint& p) { c->drawTextBlob(blob, lx, ly, p); }, strokeIt ? stroke_paint() : fill_paint());
  }
};

}  // namespace

std::unique_ptr<Canvas2D> Canvas2D::make(std::uint32_t width, std::uint32_t height, const CanvasOptions& opts) {
  return std::make_unique<SkiaCanvas>(width, height, opts);
}

}  // namespace premation::raster
