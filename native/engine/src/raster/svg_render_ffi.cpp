// FFI: the SVG painter on Skia (D2w, svg_render.hpp). Chromium draws an SVG
// <img> with Blink's SVG painters on Skia; this file follows them:
//   SVGShapePainter        fill → stroke → markers (paint-order), AA unless crispEdges
//   SVGObjectPainter       paint servers: colour, gradient, pattern, url(#) fallback
//   SVGMaskPainter / ClipPathClipper / SVGFilterPainter
//                          filter → clip-path → mask → opacity, each an isolated layer
//   LayoutSVGResource*     gradient / pattern / marker / clip / mask attribute
//                          inheritance through href and their unit systems
//   SVGTextLayoutEngine    text chunks, text-anchor, <textPath> glyph placement
// Nothing here is reached for a feature it does not draw: that is named in
// `unsupported` and the frame falls back.

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <numbers>
#include <set>

#include "fonts.hpp"
#include "skia_ffi.hpp"
#include "svg_render.hpp"

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include "include/core/SkBlendMode.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColor.h"
#include "include/core/SkColorFilter.h"
#include "include/core/SkContourMeasure.h"
#include "include/core/SkImage.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkPathEffect.h"
#include "include/core/SkPicture.h"
#include "include/core/SkPictureRecorder.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkRRect.h"
#include "include/core/SkRSXform.h"
#include "include/core/SkSamplingOptions.h"
#include "include/core/SkShader.h"
#include "include/core/SkSurface.h"
#include "include/core/SkTextBlob.h"
#include "include/effects/SkDashPathEffect.h"
#include "include/effects/SkGradient.h"
#include "include/effects/SkImageFilters.h"
#include "include/effects/SkLumaColorFilter.h"
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::raster::svg {
namespace {

constexpr double kPi = std::numbers::pi;
constexpr int kMaxDepth = 48;

float f(double v) { return static_cast<float>(v); }

SkMatrix to_sk(const Mat2D& m) {
  return SkMatrix::MakeAll(f(m.a), f(m.c), f(m.e), f(m.b), f(m.d), f(m.f), 0, 0, 1);
}

Mat2D translate(double x, double y) { return {1, 0, 0, 1, x, y}; }
Mat2D scale(double x, double y) { return {x, 0, 0, y, 0, 0}; }

/// Blink stores colours as 8-bit RGBA and scales alpha by an opacity with rounding.
SkColor sk_color(const css::Color& c, double opacity) {
  const auto ch = [](double v) { return static_cast<U8CPU>(std::clamp(std::lround(v), 0L, 255L)); };
  const U8CPU a = ch(std::clamp(c.a, 0.0, 1.0) * std::clamp(opacity, 0.0, 1.0) * 255.0);
  return SkColorSetARGB(a, ch(c.r), ch(c.g), ch(c.b));
}

SkColor4f sk_color4(const css::Color& c, double opacity) {
  return SkColor4f::FromColor(sk_color(c, opacity));
}

double srgb_to_linear(double v) { return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4); }

struct Vp {
  double w = 0;
  double h = 0;
  [[nodiscard]] double diag() const { return std::sqrt((w * w + h * h) / 2.0); }
};

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r')) s.remove_suffix(1);
  return s;
}

std::string_view href_id(const std::string* h) {
  if (h == nullptr) return {};
  const std::string_view v = trim(*h);
  if (!v.starts_with('#')) return {};
  return v.substr(1);
}

std::vector<float> number_list(std::string_view s) {
  std::vector<float> out;
  s = trim(s);
  while (!s.empty()) {
    const auto v = parse_number(s);
    if (!v) break;
    out.push_back(*v);
    skip_comma_ws(s);
  }
  return out;
}

/// The OS fonts <text> in an SVG image draws with (see RasterizeOptions::fonts).
struct SystemFonts {
  std::recursive_mutex m;
  std::unique_ptr<FontSet> set;
  std::set<std::string> loaded;
};
SystemFonts& system_fonts() {
  static SystemFonts s;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables) — a process-wide font registry, guarded by its mutex
  return s;
}

class Painter {
 public:
  Painter(const Document& doc, const std::vector<Style>& styles, const RasterizeOptions& opts, std::vector<std::string>& notes)
      : doc_(doc), st_(styles), opts_(opts), notes_(notes) {}

  void draw_root(SkCanvas* c, double w, double h) {
    const Node& root = doc_.nodes[static_cast<std::size_t>(doc_.root)];
    const Style& s = style(doc_.root);
    if (s.displayNone) return;
    if (root.attr("transform") != nullptr) note("transform on the root <svg>");
    Mat2D vbm;
    Vp vp{w, h};
    if (const std::string* v = root.attr("viewBox")) {
      if (const auto vb = parse_view_box(*v)) {
        if (vb->w == 0 || vb->h == 0) return;  // a zero-sized viewBox disables rendering
        const std::string* par = root.attr("preserveAspectRatio");
        vbm = view_box_transform(*vb, parse_aspect_ratio(par != nullptr ? *par : ""), w, h);
        vp = {vb->w, vb->h};
      }
    }
    c->save();
    c->concat(to_sk(vbm));
    with_effects(c, doc_.root, vp, 0, [&] { render_children(c, doc_.root, vp, 0); });
    c->restore();
  }

 private:
  // ── helpers ──
  [[nodiscard]] const Node& node(int i) const { return doc_.nodes[static_cast<std::size_t>(i)]; }
  [[nodiscard]] const Style& style(int i) const { return st_[static_cast<std::size_t>(i)]; }
  void note(std::string what) {
    if (std::ranges::find(notes_, what) == notes_.end()) notes_.push_back(std::move(what));
  }
  [[nodiscard]] bool is(int i, std::string_view name) const {
    const Node& n = node(i);
    return n.element && n.svgNs && n.name == name;
  }
  [[nodiscard]] int ref(int from) const {
    const int t = doc_.by_id(href_id(doc_.href(from)));
    return t;
  }
  [[nodiscard]] int by_id(std::string_view id) const { return doc_.by_id(id); }

  /// A length attribute resolved against `ref` (for %), or `def` when absent / invalid.
  [[nodiscard]] double len(int i, std::string_view attr, double def, double ref) const {
    const std::string* v = node(i).attr(attr);
    if (v == nullptr) return def;
    const auto l = parse_length(*v);
    if (!l) return def;
    return resolve(*l, ref, style(i).fontSizePx);
  }
  /// A length in objectBoundingBox units: numbers are fractions, percentages /100.
  [[nodiscard]] static double bbox_len(const std::string* v, double def) {
    if (v == nullptr) return def;
    const auto l = parse_length(*v);
    if (!l) return def;
    if (l->unit == Unit::percent) return l->v / 100.0;
    if (l->unit == Unit::number || l->unit == Unit::px) return l->v;
    return resolve(*l, 0, 16);
  }

  [[nodiscard]] Mat2D transform_of(int i) const {
    const std::string* t = node(i).attr("transform");
    if (t == nullptr) return {};
    const auto m = parse_transform(*t);
    return m ? *m : Mat2D{};
  }

  // ── geometry ──
  struct Shape {
    SkPath path;
    std::vector<PathSeg> segs;  // for markers (path / line / polyline / polygon)
    bool markable = false;
  };

  [[nodiscard]] std::optional<Shape> shape_of(int i, const Vp& vp) {
    const Node& n = node(i);
    const Style& s = style(i);
    SkPathBuilder b;
    Shape out;
    const double fs = s.fontSizePx;
    (void)fs;
    if (n.name == "rect") {
      const double x = len(i, "x", 0, vp.w);
      const double y = len(i, "y", 0, vp.h);
      const double w = len(i, "width", 0, vp.w);
      const double h = len(i, "height", 0, vp.h);
      if (!(w > 0) || !(h > 0)) return std::nullopt;
      double rx = len(i, "rx", -1, vp.w);
      double ry = len(i, "ry", -1, vp.h);
      if (rx < 0 && ry < 0) rx = ry = 0;
      else if (rx < 0) rx = ry;
      else if (ry < 0) ry = rx;
      rx = std::min(rx, w / 2);
      ry = std::min(ry, h / 2);
      const SkRect r = SkRect::MakeXYWH(f(x), f(y), f(w), f(h));
      if (rx > 0 && ry > 0) b.addRRect(SkRRect::MakeRectXY(r, f(rx), f(ry)));
      else b.addRect(r, SkPathDirection::kCW, 0);
    } else if (n.name == "circle") {
      const double cx = len(i, "cx", 0, vp.w);
      const double cy = len(i, "cy", 0, vp.h);
      const double r = len(i, "r", 0, vp.diag());
      if (!(r > 0)) return std::nullopt;
      b.addOval(SkRect::MakeLTRB(f(cx - r), f(cy - r), f(cx + r), f(cy + r)), SkPathDirection::kCW, 1);
    } else if (n.name == "ellipse") {
      const double cx = len(i, "cx", 0, vp.w);
      const double cy = len(i, "cy", 0, vp.h);
      double rx = len(i, "rx", -1, vp.w);
      double ry = len(i, "ry", -1, vp.h);
      if (rx < 0 && ry >= 0) rx = ry;  // SVG 2 `auto`
      if (ry < 0 && rx >= 0) ry = rx;
      if (!(rx > 0) || !(ry > 0)) return std::nullopt;
      b.addOval(SkRect::MakeLTRB(f(cx - rx), f(cy - ry), f(cx + rx), f(cy + ry)), SkPathDirection::kCW, 1);
    } else if (n.name == "line") {
      const auto x1 = static_cast<float>(len(i, "x1", 0, vp.w));
      const auto y1 = static_cast<float>(len(i, "y1", 0, vp.h));
      const auto x2 = static_cast<float>(len(i, "x2", 0, vp.w));
      const auto y2 = static_cast<float>(len(i, "y2", 0, vp.h));
      out.segs = {{PathSeg::Op::move, {x1, y1}}, {PathSeg::Op::line, {x2, y2}}};
      out.markable = true;
    } else if (n.name == "polyline" || n.name == "polygon") {
      const std::string* pts = n.attr("points");
      const auto p = parse_points(pts != nullptr ? *pts : "");
      if (p.empty()) return std::nullopt;
      for (std::size_t k = 0; k < p.size(); ++k) out.segs.push_back({k == 0 ? PathSeg::Op::move : PathSeg::Op::line, {p[k][0], p[k][1]}});
      if (n.name == "polygon") out.segs.push_back({PathSeg::Op::close, {}});
      out.markable = true;
    } else if (n.name == "path") {
      const std::string* d = n.attr("d");
      if (d == nullptr) return std::nullopt;
      out.segs = parse_path_data(*d);
      if (out.segs.empty()) return std::nullopt;
      out.markable = true;
    } else {
      return std::nullopt;
    }
    if (!out.segs.empty()) {
      for (const PathSeg& sg : out.segs) {
        switch (sg.op) {
          case PathSeg::Op::move: b.moveTo(sg.p[0], sg.p[1]); break;
          case PathSeg::Op::line: b.lineTo(sg.p[0], sg.p[1]); break;
          case PathSeg::Op::cubic: b.cubicTo(sg.p[0], sg.p[1], sg.p[2], sg.p[3], sg.p[4], sg.p[5]); break;
          case PathSeg::Op::close: b.close(); break;
        }
      }
    }
    b.setFillType(s.fillEvenOdd ? SkPathFillType::kEvenOdd : SkPathFillType::kWinding);
    out.path = b.detach();
    return out;
  }

  /// SVGGraphicsElement::getBBox in the element's own user space (fill geometry).
  // NOLINTNEXTLINE(misc-no-recursion)
  std::optional<SkRect> bbox_of(int i, const Vp& vp, int depth) {
    if (depth > kMaxDepth) return std::nullopt;
    const Node& n = node(i);
    if (!n.element || !n.svgNs || style(i).displayNone) return std::nullopt;
    if (auto sh = shape_of(i, vp)) {
      const SkRect r = sh->path.computeTightBounds();
      return r;
    }
    if (n.name == "text") return text_bbox(i, vp);
    if (n.name == "image") {
      return SkRect::MakeXYWH(f(len(i, "x", 0, vp.w)), f(len(i, "y", 0, vp.h)), f(len(i, "width", 0, vp.w)),
                              f(len(i, "height", 0, vp.h)));
    }
    if (n.name == "g" || n.name == "a" || n.name == "switch" || n.name == "use" || n.name == "svg" || n.name == "symbol") {
      std::optional<SkRect> u;
      Mat2D pre;
      Vp inner = vp;
      if (n.name == "use") pre = translate(len(i, "x", 0, vp.w), len(i, "y", 0, vp.h));
      for (const int k : n.children) {
        if (!node(k).element) continue;
        auto r = bbox_of(k, inner, depth + 1);
        if (!r) continue;
        const SkMatrix m = to_sk(pre * transform_of(k));
        const SkRect mr = m.mapRect(*r);
        if (!u) u = mr;
        else u->join(mr);
      }
      return u;
    }
    return std::nullopt;
  }

  // ── paint servers ──

  /// href chain of a paint server / pattern (cycle-safe), starting at `i`.
  [[nodiscard]] std::vector<int> chain(int i) const {
    std::vector<int> out;
    for (int k = i; k >= 0 && out.size() < 32; k = ref(k)) {
      if (std::ranges::find(out, k) != out.end()) break;
      out.push_back(k);
    }
    return out;
  }
  [[nodiscard]] const std::string* chain_attr(const std::vector<int>& ch, std::string_view a,
                                              bool (*accept)(const Node&) = nullptr) const {
    for (const int k : ch) {
      const Node& n = node(k);
      if (accept != nullptr && !accept(n)) continue;
      if (const std::string* v = n.attr(a)) return v;
    }
    return nullptr;
  }
  static bool is_linear(const Node& n) { return n.name == "linearGradient"; }
  static bool is_radial(const Node& n) { return n.name == "radialGradient"; }
  static bool is_gradient(const Node& n) { return n.name == "linearGradient" || n.name == "radialGradient"; }
  static bool is_pattern(const Node& n) { return n.name == "pattern"; }

  struct ShaderResult {
    bool paintsNothing = false;
    std::optional<css::Color> solid;  // a one-stop gradient
    sk_sp<SkShader> shader;
  };

  ShaderResult gradient(int g, const SkRect& bbox, const Vp& vp) {
    ShaderResult r;
    const auto ch = chain(g);
    // Stops: the first element in the chain that has any <stop> children.
    std::vector<SkColor4f> colors;
    std::vector<float> pos;
    for (const int k : ch) {
      if (!is_gradient(node(k))) continue;
      bool any = false;
      float last = 0;
      for (const int c : node(k).children) {
        if (!is(c, "stop")) continue;
        any = true;
        const std::string* o = node(c).attr("offset");
        double off = 0;
        if (o != nullptr) {
          std::string_view t = trim(*o);
          if (const auto v = parse_number(t)) {
            off = static_cast<double>(*v);
            if (trim(t) == "%") off /= 100.0;
          }
        }
        auto fo = static_cast<float>(std::clamp(off, 0.0, 1.0));
        fo = std::max(fo, last);
        last = fo;
        const Style& ss = style(c);
        colors.push_back(sk_color4(ss.stopColor, ss.stopOpacity));
        pos.push_back(fo);
      }
      if (any) break;
    }
    if (colors.empty()) {
      r.paintsNothing = true;
      return r;
    }
    const std::string* units = chain_attr(ch, "gradientUnits", is_gradient);
    const bool bboxUnits = units == nullptr || trim(*units) != "userSpaceOnUse";
    if (bboxUnits && (bbox.width() <= 0 || bbox.height() <= 0)) {
      r.paintsNothing = true;  // objectBoundingBox on an empty box: no paint
      return r;
    }
    if (colors.size() == 1) {
      css::Color c{colors[0].fR * 255.0, colors[0].fG * 255.0, colors[0].fB * 255.0, colors[0].fA};
      r.solid = c;
      return r;
    }
    const std::string* spread = chain_attr(ch, "spreadMethod", is_gradient);
    SkTileMode tile = SkTileMode::kClamp;
    if (spread != nullptr && trim(*spread) == "reflect") tile = SkTileMode::kMirror;
    else if (spread != nullptr && trim(*spread) == "repeat") tile = SkTileMode::kRepeat;
    Mat2D lm;
    if (bboxUnits) lm = translate(bbox.x(), bbox.y()) * scale(bbox.width(), bbox.height());
    if (const std::string* gt = chain_attr(ch, "gradientTransform", is_gradient)) {
      if (const auto m = parse_transform(*gt)) lm = lm * *m;
    }
    const SkMatrix skm = to_sk(lm);
    const SkGradient grad(SkGradient::Colors({colors.data(), colors.size()}, {pos.data(), pos.size()}, tile),
                          SkGradient::Interpolation{});
    const auto length = [&](const std::string* v, double def, double ref) {
      if (bboxUnits) return bbox_len(v, def);
      if (v == nullptr) return def * ref;  // defaults are percentages
      const auto l = parse_length(*v);
      return l ? resolve(*l, ref, 16) : def * ref;
    };
    const bool linear = is_linear(node(ch.front()));
    if (linear) {
      const double x1 = length(chain_attr(ch, "x1", is_linear), 0, vp.w);
      const double y1 = length(chain_attr(ch, "y1", is_linear), 0, vp.h);
      const double x2 = length(chain_attr(ch, "x2", is_linear), 1, vp.w);
      const double y2 = length(chain_attr(ch, "y2", is_linear), 0, vp.h);
      if (x1 == x2 && y1 == y2) {
        // Degenerate: the area paints with the last stop's colour.
        const SkColor4f& lc = colors.back();
        r.solid = css::Color{lc.fR * 255.0, lc.fG * 255.0, lc.fB * 255.0, lc.fA};
        return r;
      }
      const std::array<SkPoint, 2> pts{SkPoint{f(x1), f(y1)}, SkPoint{f(x2), f(y2)}};
      r.shader = SkShaders::LinearGradient(pts.data(), grad, &skm);
    } else {
      const double cx = length(chain_attr(ch, "cx", is_radial), 0.5, vp.w);
      const double cy = length(chain_attr(ch, "cy", is_radial), 0.5, vp.h);
      const double rr = length(chain_attr(ch, "r", is_radial), 0.5, vp.diag());
      const std::string* fxa = chain_attr(ch, "fx", is_radial);
      const std::string* fya = chain_attr(ch, "fy", is_radial);
      const double fx = fxa != nullptr ? length(fxa, 0.5, vp.w) : cx;
      const double fy = fya != nullptr ? length(fya, 0.5, vp.h) : cy;
      const double fr = length(chain_attr(ch, "fr", is_radial), 0, vp.diag());
      if (!(rr > 0)) {
        const SkColor4f& lc = colors.back();
        r.solid = css::Color{lc.fR * 255.0, lc.fG * 255.0, lc.fB * 255.0, lc.fA};
        return r;
      }
      r.shader = SkShaders::TwoPointConicalGradient({f(fx), f(fy)}, f(fr), {f(cx), f(cy)}, f(rr), grad, &skm);
    }
    if (!r.shader) r.paintsNothing = true;
    return r;
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  ShaderResult pattern(int p, const SkRect& bbox, const Vp& vp, int depth) {
    ShaderResult r;
    if (depth > 8 || std::ranges::find(patternStack_, p) != patternStack_.end()) {
      r.paintsNothing = true;
      return r;
    }
    const auto ch = chain(p);
    const std::string* units = chain_attr(ch, "patternUnits", is_pattern);
    const std::string* cunits = chain_attr(ch, "patternContentUnits", is_pattern);
    const bool bboxUnits = units == nullptr || trim(*units) != "userSpaceOnUse";
    const bool bboxContent = cunits != nullptr && trim(*cunits) == "objectBoundingBox";
    double x = 0, y = 0, w = 0, h = 0;
    if (bboxUnits) {
      if (bbox.width() <= 0 || bbox.height() <= 0) {
        r.paintsNothing = true;
        return r;
      }
      x = bbox.x() + bbox_len(chain_attr(ch, "x", is_pattern), 0) * bbox.width();
      y = bbox.y() + bbox_len(chain_attr(ch, "y", is_pattern), 0) * bbox.height();
      w = bbox_len(chain_attr(ch, "width", is_pattern), 0) * bbox.width();
      h = bbox_len(chain_attr(ch, "height", is_pattern), 0) * bbox.height();
    } else {
      const auto l = [&](std::string_view a, double ref) {
        const std::string* v = chain_attr(ch, a, is_pattern);
        if (v == nullptr) return 0.0;
        const auto ll = parse_length(*v);
        return ll ? resolve(*ll, ref, 16) : 0.0;
      };
      x = l("x", vp.w);
      y = l("y", vp.h);
      w = l("width", vp.w);
      h = l("height", vp.h);
    }
    if (!(w > 0) || !(h > 0)) {
      r.paintsNothing = true;
      return r;
    }
    int content = -1;
    for (const int k : ch) {
      if (!is_pattern(node(k))) continue;
      if (std::ranges::any_of(node(k).children, [&](int c) { return node(c).element; })) {
        content = k;
        break;
      }
    }
    Mat2D contentM;
    Vp innerVp = vp;
    if (const std::string* vbv = chain_attr(ch, "viewBox", is_pattern)) {
      if (const auto vb = parse_view_box(*vbv)) {
        if (vb->w == 0 || vb->h == 0) {
          r.paintsNothing = true;
          return r;
        }
        const std::string* par = chain_attr(ch, "preserveAspectRatio", is_pattern);
        contentM = view_box_transform(*vb, parse_aspect_ratio(par != nullptr ? *par : ""), w, h);
        innerVp = {vb->w, vb->h};
      }
    } else if (bboxContent) {
      contentM = scale(bbox.width(), bbox.height());
    }
    SkPictureRecorder rec;
    SkCanvas* pc = rec.beginRecording(SkRect::MakeWH(f(w), f(h)));
    pc->clipRect(SkRect::MakeWH(f(w), f(h)));
    pc->concat(to_sk(contentM));
    if (content >= 0) {
      patternStack_.push_back(p);
      render_children(pc, content, innerVp, depth + 1);
      patternStack_.pop_back();
    }
    const sk_sp<SkPicture> pic = rec.finishRecordingAsPicture();
    Mat2D lm = translate(x, y);
    if (const std::string* pt = chain_attr(ch, "patternTransform", is_pattern)) {
      if (const auto m = parse_transform(*pt)) lm = *m * lm;
    }
    const SkMatrix skm = to_sk(lm);
    const SkRect tile = SkRect::MakeWH(f(w), f(h));
    r.shader = pic->makeShader(SkTileMode::kRepeat, SkTileMode::kRepeat, SkFilterMode::kLinear, &skm, &tile);
    if (!r.shader) r.paintsNothing = true;
    return r;
  }

  /// SVGObjectPainter::PreparePaint. False = paints nothing.
  // NOLINTNEXTLINE(misc-no-recursion)
  bool setup_paint(SkPaint& p, const Paint& paint, double opacity, const Style& s, const SkRect& bbox, const Vp& vp, int depth) {
    p.setAntiAlias(!s.crispEdges);
    const auto solid = [&](const css::Color& c) {
      p.setColor(sk_color(c, opacity));
      return true;
    };
    switch (paint.kind) {
      case Paint::Kind::none: return false;
      case Paint::Kind::color: return solid(paint.color);
      case Paint::Kind::current: return solid(s.color);
      case Paint::Kind::url: break;
    }
    const int t = by_id(paint.url);
    ShaderResult sr;
    bool valid = t >= 0 && node(t).svgNs;
    if (valid && is_gradient(node(t))) sr = gradient(t, bbox, vp);
    else if (valid && is_pattern(node(t))) sr = pattern(t, bbox, vp, depth);
    else valid = false;
    if (!valid) {
      if (paint.fallback == Paint::Kind::color) return solid(paint.fallbackColor);
      if (paint.fallback == Paint::Kind::current) return solid(s.color);
      return false;
    }
    if (sr.paintsNothing) return false;
    if (sr.solid) return solid(*sr.solid);
    p.setShader(sr.shader);
    p.setColor(sk_color({0, 0, 0, 1}, opacity));
    return true;
  }

  void setup_stroke(SkPaint& p, const Style& s, const Vp& vp, double lengthScale) {
    p.setStyle(SkPaint::kStroke_Style);
    p.setStrokeWidth(f(resolve(s.strokeWidth, vp.diag(), s.fontSizePx)));
    p.setStrokeCap(s.cap == Cap::round ? SkPaint::kRound_Cap : s.cap == Cap::square ? SkPaint::kSquare_Cap : SkPaint::kButt_Cap);
    p.setStrokeJoin(s.join == Join::round ? SkPaint::kRound_Join : s.join == Join::bevel ? SkPaint::kBevel_Join : SkPaint::kMiter_Join);
    p.setStrokeMiter(f(s.miterLimit));
    if (!s.dashArray.empty()) {
      std::vector<SkScalar> iv;
      double sum = 0;
      for (const Length& l : s.dashArray) {
        const double v = resolve(l, vp.diag(), s.fontSizePx) * lengthScale;
        iv.push_back(f(v));
        sum += v;
      }
      if (iv.size() % 2 == 1) {
        const std::vector<SkScalar> copy = iv;
        iv.insert(iv.end(), copy.begin(), copy.end());
      }
      if (sum > 0) {
        p.setPathEffect(SkDashPathEffect::Make({iv.data(), iv.size()},
                                               f(resolve(s.dashOffset, vp.diag(), s.fontSizePx) * lengthScale)));
      }
    }
  }

  // ── effects: filter → clip-path → mask → opacity (each an isolated layer) ──

  template <typename F>
  // NOLINTNEXTLINE(misc-no-recursion)
  void with_effects(SkCanvas* c, int i, const Vp& vp, int depth, const F& content) {
    const Style& s = style(i);
    const bool hasClip = !s.clipPath.empty() && by_id(s.clipPath) >= 0 && is(by_id(s.clipPath), "clipPath");
    const bool hasMask = !s.mask.empty() && by_id(s.mask) >= 0 && is(by_id(s.mask), "mask");
    if (!s.clipPath.empty() && !hasClip) {
      // CSS Masking: an invalid clip-path reference is ignored.
    }
    if (!s.mask.empty() && !hasMask) note("mask reference that is not a <mask>");
    const int filterEl = !s.filter.empty() ? by_id(s.filter) : -1;
    if (!s.filter.empty() && (filterEl < 0 || !is(filterEl, "filter"))) return;  // a broken filter reference: not rendered
    if (s.filterUnsupported) return;
    std::optional<SkRect> bbox;
    const auto get_bbox = [&]() -> SkRect {
      if (!bbox) {
        bbox = bbox_of(i, vp, depth);
        if (!bbox) bbox = SkRect::MakeEmpty();
      }
      return *bbox;
    };
    const bool opacityLayer = s.opacity < 1.0 || !s.blendMode.empty() || s.isolate;
    if (opacityLayer) {
      SkPaint lp;
      lp.setAlphaf(f(s.opacity));
      if (!s.blendMode.empty()) {
        const auto mode = blend_of(s.blendMode);
        if (mode) lp.setBlendMode(*mode);
        else note("mix-blend-mode: " + s.blendMode);
      }
      c->saveLayer(nullptr, &lp);
    }
    const bool group = hasClip || hasMask;
    if (group) c->saveLayer(nullptr, nullptr);
    bool filtered = false;
    if (filterEl >= 0) {
      SkRect region;
      const sk_sp<SkImageFilter> fx = build_filter(filterEl, get_bbox(), vp, region);
      if (region.isEmpty()) {
        if (group) c->restore();
        if (opacityLayer) c->restore();
        return;  // an empty filter region renders nothing
      }
      SkPaint fp;
      fp.setImageFilter(fx);
      c->saveLayer(&region, &fp);
      filtered = true;
    }
    content();
    if (filtered) c->restore();
    if (hasClip) apply_clip(c, by_id(s.clipPath), get_bbox(), vp, depth + 1);
    if (hasMask) apply_mask(c, by_id(s.mask), get_bbox(), vp, depth + 1);
    if (group) c->restore();
    if (opacityLayer) c->restore();
  }

  static std::optional<SkBlendMode> blend_of(std::string_view m) {
    static constexpr std::array<std::pair<std::string_view, SkBlendMode>, 15> kModes{{
        {"multiply", SkBlendMode::kMultiply}, {"screen", SkBlendMode::kScreen}, {"overlay", SkBlendMode::kOverlay},
        {"darken", SkBlendMode::kDarken}, {"lighten", SkBlendMode::kLighten}, {"color-dodge", SkBlendMode::kColorDodge},
        {"color-burn", SkBlendMode::kColorBurn}, {"hard-light", SkBlendMode::kHardLight},
        {"soft-light", SkBlendMode::kSoftLight}, {"difference", SkBlendMode::kDifference},
        {"exclusion", SkBlendMode::kExclusion}, {"hue", SkBlendMode::kHue}, {"saturation", SkBlendMode::kSaturation},
        {"color", SkBlendMode::kColor}, {"luminosity", SkBlendMode::kLuminosity},
    }};
    for (const auto& [n, mode] : kModes) {
      if (n == m) return mode;
    }
    if (m == "normal") return SkBlendMode::kSrcOver;
    return std::nullopt;
  }

  /// LayoutSVGResourceClipper: the clip's children as coverage, DstIn over the group.
  // NOLINTNEXTLINE(misc-no-recursion)
  void apply_clip(SkCanvas* c, int clip, const SkRect& bbox, const Vp& vp, int depth) {
    if (depth > kMaxDepth || std::ranges::find(clipStack_, clip) != clipStack_.end()) return;
    clipStack_.push_back(clip);
    SkPaint dstIn;
    dstIn.setBlendMode(SkBlendMode::kDstIn);
    c->saveLayer(nullptr, &dstIn);
    c->save();
    Mat2D m = transform_of(clip);
    const std::string* units = node(clip).attr("clipPathUnits");
    if (units != nullptr && trim(*units) == "objectBoundingBox") {
      m = m * translate(bbox.x(), bbox.y()) * scale(bbox.width(), bbox.height());
    }
    c->concat(to_sk(m));
    for (const int k : node(clip).children) draw_clip_child(c, k, vp, depth + 1);
    c->restore();
    // The clipPath's own clip-path intersects.
    const Style& cs = style(clip);
    if (!cs.clipPath.empty()) {
      const int nested = by_id(cs.clipPath);
      if (nested >= 0 && is(nested, "clipPath")) apply_clip(c, nested, bbox, vp, depth + 1);
    }
    c->restore();
    clipStack_.pop_back();
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_clip_child(SkCanvas* c, int k, const Vp& vp, int depth) {
    const Node& n = node(k);
    if (!n.element || !n.svgNs) return;
    const Style& s = style(k);
    if (s.displayNone || s.hidden) return;
    int target = k;
    Mat2D m = transform_of(k);
    if (n.name == "use") {
      // A use in a clipPath must reference a shape or text directly.
      m = m * translate(len(k, "x", 0, vp.w), len(k, "y", 0, vp.h));
      if (n.children.empty()) return;
      target = n.children.front();
      m = m * transform_of(target);
      if (style(target).displayNone || style(target).hidden) return;
    }
    const Node& t = node(target);
    const bool childClip = !style(target).clipPath.empty() || (target != k && !s.clipPath.empty());
    c->save();
    c->concat(to_sk(m));
    if (childClip) c->saveLayer(nullptr, nullptr);
    SkPaint p;
    p.setAntiAlias(!style(target).crispEdges);
    p.setColor(SK_ColorBLACK);
    if (auto sh = shape_of(target, vp)) {
      SkPath path = sh->path;
      path.setFillType(style(target).clipEvenOdd ? SkPathFillType::kEvenOdd : SkPathFillType::kWinding);
      c->drawPath(path, p);
    } else if (t.name == "text") {
      draw_text(c, target, vp, depth, true);
    } else {
      note("<" + t.name + "> inside a clipPath");
    }
    if (childClip) {
      const std::string& id = !style(target).clipPath.empty() ? style(target).clipPath : s.clipPath;
      const int nested = by_id(id);
      if (nested >= 0 && is(nested, "clipPath")) {
        const auto bb = bbox_of(target, vp, depth);
        apply_clip(c, nested, bb ? *bb : SkRect::MakeEmpty(), vp, depth + 1);
      }
      c->restore();
    }
    c->restore();
  }

  /// SVGMaskPainter: luminance (or alpha) of the mask content, DstIn over the group.
  // NOLINTNEXTLINE(misc-no-recursion)
  void apply_mask(SkCanvas* c, int mask, const SkRect& bbox, const Vp& vp, int depth) {
    if (depth > kMaxDepth || std::ranges::find(maskStack_, mask) != maskStack_.end()) return;
    maskStack_.push_back(mask);
    const Node& n = node(mask);
    const std::string* units = n.attr("maskUnits");
    const std::string* cunits = n.attr("maskContentUnits");
    const bool bboxUnits = units == nullptr || trim(*units) != "userSpaceOnUse";
    const bool bboxContent = cunits != nullptr && trim(*cunits) == "objectBoundingBox";
    SkRect region;
    if (bboxUnits) {
      region = SkRect::MakeXYWH(f(bbox.x() + bbox_len(n.attr("x"), -0.1) * bbox.width()),
                                f(bbox.y() + bbox_len(n.attr("y"), -0.1) * bbox.height()),
                                f(bbox_len(n.attr("width"), 1.2) * bbox.width()),
                                f(bbox_len(n.attr("height"), 1.2) * bbox.height()));
    } else {
      region = SkRect::MakeXYWH(f(len(mask, "x", -0.1 * vp.w, vp.w)), f(len(mask, "y", -0.1 * vp.h, vp.h)),
                                f(len(mask, "width", 1.2 * vp.w, vp.w)), f(len(mask, "height", 1.2 * vp.h, vp.h)));
    }
    SkPaint mp;
    mp.setBlendMode(SkBlendMode::kDstIn);
    if (!style(mask).maskAlpha) mp.setColorFilter(SkLumaColorFilter::Make());
    c->saveLayer(nullptr, &mp);
    if (!region.isEmpty() && (!bboxContent || (bbox.width() > 0 && bbox.height() > 0))) {
      c->clipRect(region);
      if (bboxContent) c->concat(to_sk(translate(bbox.x(), bbox.y()) * scale(bbox.width(), bbox.height())));
      render_children(c, mask, vp, depth + 1);
    }
    c->restore();
    maskStack_.pop_back();
  }

  // ── filters ──

  struct FNode {
    sk_sp<SkImageFilter> f;  // null = SourceGraphic
    bool linear = false;
  };

  static sk_sp<SkImageFilter> in_space(const FNode& n, bool linear) {
    if (n.linear == linear) return n.f;
    return SkImageFilters::ColorFilter(linear ? SkColorFilters::SRGBToLinearGamma() : SkColorFilters::LinearToSRGBGamma(), n.f);
  }

  /// SVGFilterBuilder: the primitives as one Skia filter graph, in the filter
  /// element's operating spaces (color-interpolation-filters per primitive).
  sk_sp<SkImageFilter> build_filter(int fe, const SkRect& bbox, const Vp& vp, SkRect& region) {
    const Node& n = node(fe);
    const std::string* units = n.attr("filterUnits");
    const std::string* punits = n.attr("primitiveUnits");
    const bool bboxUnits = units == nullptr || trim(*units) != "userSpaceOnUse";
    const bool bboxPrim = punits != nullptr && trim(*punits) == "objectBoundingBox";
    if (n.attr("href") != nullptr || n.attr("xlink:href") != nullptr) note("filter href");
    if (bboxUnits) {
      if (bbox.width() <= 0 || bbox.height() <= 0) {
        region = SkRect::MakeEmpty();
        return nullptr;
      }
      region = SkRect::MakeXYWH(f(bbox.x() + bbox_len(n.attr("x"), -0.1) * bbox.width()),
                                f(bbox.y() + bbox_len(n.attr("y"), -0.1) * bbox.height()),
                                f(bbox_len(n.attr("width"), 1.2) * bbox.width()),
                                f(bbox_len(n.attr("height"), 1.2) * bbox.height()));
    } else {
      region = SkRect::MakeXYWH(f(len(fe, "x", -0.1 * vp.w, vp.w)), f(len(fe, "y", -0.1 * vp.h, vp.h)),
                                f(len(fe, "width", 1.2 * vp.w, vp.w)), f(len(fe, "height", 1.2 * vp.h, vp.h)));
    }
    if (region.isEmpty()) return nullptr;
    const SkImageFilters::CropRect crop(region);
    std::map<std::string, FNode, std::less<>> results;
    FNode last{nullptr, false};
    bool first = true;
    const auto input = [&](const std::string* in) -> FNode {
      const std::string_view v = in != nullptr ? trim(*in) : std::string_view();
      if (v.empty()) return first ? FNode{nullptr, false} : last;
      if (v == "SourceGraphic") return {nullptr, false};
      if (v == "SourceAlpha") {
        const std::array<float, 20> m{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0};
        return {SkImageFilters::ColorFilter(SkColorFilters::Matrix(m.data()), nullptr), false};
      }
      if (const auto it = results.find(v); it != results.end()) return it->second;
      if (v == "BackgroundImage" || v == "BackgroundAlpha" || v == "FillPaint" || v == "StrokePaint") {
        note("filter input " + std::string(v));
      }
      return first ? FNode{nullptr, false} : last;
    };
    const auto std_dev = [&](int k) -> std::optional<std::array<double, 2>> {
      const std::string* v = node(k).attr("stdDeviation");
      std::vector<float> nums = number_list(v != nullptr ? *v : "0");
      if (nums.empty() || nums.size() > 2) return std::array<double, 2>{0, 0};
      double sx = nums[0];
      double sy = nums.size() == 2 ? nums[1] : nums[0];
      if (sx < 0 || sy < 0) return std::nullopt;
      if (bboxPrim) {
        sx *= bbox.width();
        sy *= bbox.height();
      }
      return std::array<double, 2>{sx, sy};
    };
    const auto num_attr = [&](int k, std::string_view a, double def) {
      const std::string* v = node(k).attr(a);
      if (v == nullptr) return def;
      std::string_view t = trim(*v);
      const auto x = parse_number(t);
      return x ? static_cast<double>(*x) : def;
    };
    for (const int k : n.children) {
      const Node& p = node(k);
      if (!p.element || !p.svgNs) continue;
      const bool linear = style(k).filtersLinearRGB;
      if (p.attr("x") != nullptr || p.attr("y") != nullptr || p.attr("width") != nullptr || p.attr("height") != nullptr) {
        note("filter primitive subregions");
      }
      FNode out{nullptr, linear};
      const FNode in = input(p.attr("in"));
      if (p.name == "feGaussianBlur") {
        const auto sd = std_dev(k);
        if (!sd) {
          region = SkRect::MakeEmpty();  // a negative deviation disables the filter: nothing renders
          return nullptr;
        }
        if ((*sd)[0] == 0 && (*sd)[1] == 0) {
          out = {in_space(in, linear), linear};
        } else {
          out.f = SkImageFilters::Blur(f((*sd)[0]), f((*sd)[1]), SkTileMode::kDecal, in_space(in, linear), crop);
        }
      } else if (p.name == "feOffset") {
        double dx = num_attr(k, "dx", 0);
        double dy = num_attr(k, "dy", 0);
        if (bboxPrim) {
          dx *= bbox.width();
          dy *= bbox.height();
        }
        out.f = SkImageFilters::Offset(f(dx), f(dy), in_space(in, linear), crop);
      } else if (p.name == "feDropShadow") {
        const auto sd = std_dev(k);
        double dx = num_attr(k, "dx", 2);
        double dy = num_attr(k, "dy", 2);
        if (bboxPrim) {
          dx *= bbox.width();
          dy *= bbox.height();
        }
        const Style& ps = style(k);
        SkColor4f col = sk_color4(ps.floodColor, ps.floodOpacity);
        if (linear) {
          col.fR = f(srgb_to_linear(static_cast<double>(col.fR)));
          col.fG = f(srgb_to_linear(static_cast<double>(col.fG)));
          col.fB = f(srgb_to_linear(static_cast<double>(col.fB)));
        }
        const std::array<double, 2> s = sd ? *sd : std::array<double, 2>{0, 0};
        out.f = SkImageFilters::DropShadow(f(dx), f(dy), f(s[0]), f(s[1]), col, nullptr, in_space(in, linear), crop);
      } else if (p.name == "feFlood") {
        const Style& ps = style(k);
        SkColor4f col = sk_color4(ps.floodColor, ps.floodOpacity);
        if (linear) {
          col.fR = f(srgb_to_linear(static_cast<double>(col.fR)));
          col.fG = f(srgb_to_linear(static_cast<double>(col.fG)));
          col.fB = f(srgb_to_linear(static_cast<double>(col.fB)));
        }
        out.f = SkImageFilters::Shader(SkShaders::Color(col, nullptr), crop);
      } else if (p.name == "feColorMatrix") {
        const std::string* ty = p.attr("type");
        const std::string_view type = ty != nullptr ? trim(*ty) : std::string_view("matrix");
        const std::string* vals = p.attr("values");
        const std::vector<float> v = number_list(vals != nullptr ? *vals : "");
        std::array<float, 20> m{1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0};
        if (type == "matrix") {
          if (v.size() == 20) std::ranges::copy(v, m.begin());
        } else if (type == "saturate") {
          const float s = v.empty() ? 1.0F : v[0];
          m = {0.213F + 0.787F * s, 0.715F - 0.715F * s, 0.072F - 0.072F * s, 0, 0,
               0.213F - 0.213F * s, 0.715F + 0.285F * s, 0.072F - 0.072F * s, 0, 0,
               0.213F - 0.213F * s, 0.715F - 0.715F * s, 0.072F + 0.928F * s, 0, 0,
               0, 0, 0, 1, 0};
        } else if (type == "hueRotate") {
          const double a = (v.empty() ? 0.0 : static_cast<double>(v[0])) * kPi / 180.0;
          const auto cs = f(std::cos(a));
          const auto sn = f(std::sin(a));
          m = {0.213F + cs * 0.787F - sn * 0.213F, 0.715F - cs * 0.715F - sn * 0.715F, 0.072F - cs * 0.072F + sn * 0.928F, 0, 0,
               0.213F - cs * 0.213F + sn * 0.143F, 0.715F + cs * 0.285F + sn * 0.140F, 0.072F - cs * 0.072F - sn * 0.283F, 0, 0,
               0.213F - cs * 0.213F - sn * 0.787F, 0.715F - cs * 0.715F + sn * 0.715F, 0.072F + cs * 0.928F + sn * 0.072F, 0, 0,
               0, 0, 0, 1, 0};
        } else if (type == "luminanceToAlpha") {
          m = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125F, 0.7154F, 0.0721F, 0, 0};
        }
        out.f = SkImageFilters::ColorFilter(SkColorFilters::Matrix(m.data()), in_space(in, linear), crop);
      } else if (p.name == "feMerge") {
        std::vector<sk_sp<SkImageFilter>> ins;
        for (const int mn : p.children) {
          if (!is(mn, "feMergeNode")) continue;
          ins.push_back(in_space(input(node(mn).attr("in")), linear));
        }
        out.f = SkImageFilters::Merge(ins.data(), static_cast<int>(ins.size()), crop);
      } else if (p.name == "feBlend" || p.name == "feComposite") {
        const FNode in2 = input(p.attr("in2"));
        const std::string* modeAttr = p.attr(p.name == "feBlend" ? "mode" : "operator");
        const std::string_view mode = modeAttr != nullptr ? trim(*modeAttr) : std::string_view(p.name == "feBlend" ? "normal" : "over");
        std::optional<SkBlendMode> bm;
        if (p.name == "feBlend") {
          bm = blend_of(mode);
        } else if (mode == "over") bm = SkBlendMode::kSrcOver;
        else if (mode == "in") bm = SkBlendMode::kSrcIn;
        else if (mode == "out") bm = SkBlendMode::kSrcOut;
        else if (mode == "atop") bm = SkBlendMode::kSrcATop;
        else if (mode == "xor") bm = SkBlendMode::kXor;
        else if (mode == "lighter") bm = SkBlendMode::kPlus;
        if (p.name == "feComposite" && mode == "arithmetic") {
          out.f = SkImageFilters::Arithmetic(f(num_attr(k, "k1", 0)), f(num_attr(k, "k2", 0)), f(num_attr(k, "k3", 0)),
                                             f(num_attr(k, "k4", 0)), true, in_space(in2, linear), in_space(in, linear), crop);
        } else if (bm) {
          out.f = SkImageFilters::Blend(*bm, in_space(in2, linear), in_space(in, linear), crop);
        } else {
          note(std::string(p.name) + " " + std::string(mode));
          out = {in_space(in, linear), linear};
        }
      } else {
        note("<" + p.name + ">");
        out = {in_space(in, linear), linear};
      }
      if (const std::string* res = p.attr("result"); res != nullptr && !trim(*res).empty()) results[std::string(trim(*res))] = out;
      last = out;
      first = false;
    }
    if (first) {
      region = SkRect::MakeEmpty();  // a filter with no primitives: the element is not rendered
      return nullptr;
    }
    return SkImageFilters::Crop(region, in_space(last, false));
  }

  // ── rendering ──

  // NOLINTNEXTLINE(misc-no-recursion)
  void render_children(SkCanvas* c, int parent, const Vp& vp, int depth) {
    for (const int k : node(parent).children) render(c, k, vp, depth + 1);
  }

  // NOLINTNEXTLINE(misc-no-recursion, readability-function-cognitive-complexity)
  void render(SkCanvas* c, int i, const Vp& vp, int depth) {
    if (depth > kMaxDepth) return;
    const Node& n = node(i);
    if (!n.element) return;
    if (!n.svgNs) return;
    const Style& s = style(i);
    if (s.displayNone) return;
    const std::string& name = n.name;
    if (name == "defs" || name == "clipPath" || name == "mask" || name == "pattern" || name == "marker" ||
        name == "linearGradient" || name == "radialGradient" || name == "filter" || name == "style" || name == "title" ||
        name == "desc" || name == "metadata" || name == "symbol" || name == "script" || name == "stop") {
      return;
    }
    if (name == "animate" || name == "set" || name == "animateTransform" || name == "animateMotion" ||
        name == "animateColor") {
      note("SMIL animation");
      return;
    }
    if (name == "foreignObject") {
      note("<foreignObject>");
      return;
    }
    const bool shape = name == "rect" || name == "circle" || name == "ellipse" || name == "line" || name == "polyline" ||
                       name == "polygon" || name == "path";
    const bool container = name == "g" || name == "a" || name == "switch";
    if (!shape && !container && name != "svg" && name != "use" && name != "text" && name != "image") {
      return;  // unknown elements do not render (nor their children)
    }
    c->save();
    c->concat(to_sk(transform_of(i)));
    if (shape) {
      with_effects(c, i, vp, depth, [&] { draw_shape(c, i, vp, depth); });
    } else if (container) {
      with_effects(c, i, vp, depth, [&] {
        if (name == "switch") {
          for (const int k : n.children) {
            if (!node(k).element || !node(k).svgNs) continue;
            if (!passes_tests(k)) continue;
            render(c, k, vp, depth + 1);
            break;
          }
        } else {
          render_children(c, i, vp, depth);
        }
      });
    } else if (name == "svg") {
      draw_nested_svg(c, i, i, vp, depth, std::nullopt, std::nullopt);
    } else if (name == "use") {
      const double x = len(i, "x", 0, vp.w);
      const double y = len(i, "y", 0, vp.h);
      c->concat(to_sk(translate(x, y)));
      with_effects(c, i, vp, depth, [&] {
        if (n.children.empty()) return;
        const int t = n.children.front();
        const Node& tn = node(t);
        if (tn.name == "symbol" || tn.name == "svg") {
          std::optional<double> uw;
          std::optional<double> uh;
          if (n.attr("width") != nullptr) uw = len(i, "width", 0, vp.w);
          if (n.attr("height") != nullptr) uh = len(i, "height", 0, vp.h);
          if (style(t).displayNone) return;
          c->save();
          c->concat(to_sk(transform_of(t)));
          draw_nested_svg(c, t, t, vp, depth + 1, uw, uh);
          c->restore();
        } else {
          render(c, t, vp, depth + 1);
        }
      });
    } else if (name == "text") {
      with_effects(c, i, vp, depth, [&] { draw_text(c, i, vp, depth, false); });
    } else if (name == "image") {
      with_effects(c, i, vp, depth, [&] { draw_image(c, i, vp); });
    }
    c->restore();
  }

  [[nodiscard]] bool passes_tests(int k) const {
    const Node& n = node(k);
    if (const std::string* e = n.attr("requiredExtensions"); e != nullptr && !trim(*e).empty()) return false;
    if (const std::string* l = n.attr("systemLanguage")) {
      // Chromium matches the UI language (the render machines run en-US).
      std::string_view t = *l;
      bool ok = false;
      while (!t.empty() && !ok) {
        const std::size_t comma = t.find(',');
        const std::string_view tag = trim(t.substr(0, comma));
        ok = tag == "en" || tag.starts_with("en-");
        t = comma == std::string_view::npos ? std::string_view() : t.substr(comma + 1);
      }
      if (!ok) return false;
    }
    return true;
  }

  /// A nested <svg> or a <use>d <symbol> / <svg>: a new viewport.
  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_nested_svg(SkCanvas* c, int i, int contentOf, const Vp& vp, int depth, std::optional<double> useW,
                       std::optional<double> useH) {
    const Node& n = node(i);
    const double x = len(i, "x", 0, vp.w);
    const double y = len(i, "y", 0, vp.h);
    const double w = useW ? *useW : len(i, "width", vp.w, vp.w);
    const double h = useH ? *useH : len(i, "height", vp.h, vp.h);
    if (!(w > 0) || !(h > 0)) return;
    c->save();
    c->concat(to_sk(translate(x, y)));
    const Style& s = style(i);
    if (!s.overflowVisible) c->clipRect(SkRect::MakeWH(f(w), f(h)));
    Vp inner{w, h};
    if (const std::string* vbv = n.attr("viewBox")) {
      if (const auto vb = parse_view_box(*vbv)) {
        if (vb->w == 0 || vb->h == 0) {
          c->restore();
          return;
        }
        const std::string* par = n.attr("preserveAspectRatio");
        c->concat(to_sk(view_box_transform(*vb, parse_aspect_ratio(par != nullptr ? *par : ""), w, h)));
        inner = {vb->w, vb->h};
      }
    }
    with_effects(c, i, inner, depth, [&] { render_children(c, contentOf, inner, depth); });
    c->restore();
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_shape(SkCanvas* c, int i, const Vp& vp, int depth) {
    const Style& s = style(i);
    auto sh = shape_of(i, vp);
    if (!sh) return;
    const SkRect bbox = sh->path.computeTightBounds();
    double lengthScale = 1;
    if (const std::string* pl = node(i).attr("pathLength")) {
      std::string_view t = trim(*pl);
      if (const auto v = parse_number(t); v && *v > 0) {
        double total = 0;
        SkContourMeasureIter it(sh->path, false);
        while (const sk_sp<SkContourMeasure> cm = it.next()) total += static_cast<double>(cm->length());
        lengthScale = total / static_cast<double>(*v);
      }
    }
    const auto fill = [&] {
      if (s.hidden) return;
      SkPaint p;
      if (!setup_paint(p, s.fill, s.fillOpacity, s, bbox, vp, depth)) return;
      p.setStyle(SkPaint::kFill_Style);
      c->drawPath(sh->path, p);
    };
    const auto stroke = [&] {
      if (s.hidden) return;
      if (!(resolve(s.strokeWidth, vp.diag(), s.fontSizePx) > 0)) return;
      SkPaint p;
      if (!setup_paint(p, s.stroke, s.strokeOpacity, s, bbox, vp, depth)) return;
      setup_stroke(p, s, vp, lengthScale);
      c->drawPath(sh->path, p);
    };
    const auto markers = [&] {
      if (sh->markable) draw_markers(c, i, sh->segs, vp, depth);
    };
    if (s.paintOrderStrokeFirst) {
      if (s.paintOrderMarkersBeforeStroke) markers();
      stroke();
      fill();
      if (!s.paintOrderMarkersBeforeStroke) markers();
    } else {
      fill();
      if (s.paintOrderMarkersBeforeStroke) markers();
      stroke();
      if (!s.paintOrderMarkersBeforeStroke) markers();
    }
  }

  // ── markers (SVGMarkerData + LayoutSVGResourceMarker) ──

  struct Vertex {
    double x = 0, y = 0;
    double inAngle = 0, outAngle = 0;
    bool hasIn = false, hasOut = false;
  };

  static double angle_of(double dx, double dy) { return std::atan2(dy, dx) * 180.0 / kPi; }

  static std::vector<Vertex> vertices(const std::vector<PathSeg>& segs) {
    std::vector<Vertex> v;
    double cx = 0, cy = 0, sx = 0, sy = 0;
    std::size_t subStart = 0;
    for (const PathSeg& s : segs) {
      switch (s.op) {
        case PathSeg::Op::move:
          cx = sx = s.p[0];
          cy = sy = s.p[1];
          subStart = v.size();
          v.push_back({cx, cy});
          break;
        case PathSeg::Op::line: {
          const double x = s.p[0];
          const double y = s.p[1];
          const double a = angle_of(x - cx, y - cy);
          if (!v.empty()) {
            v.back().outAngle = a;
            v.back().hasOut = true;
          }
          v.push_back({x, y, a, 0, true, false});
          cx = x;
          cy = y;
          break;
        }
        case PathSeg::Op::cubic: {
          const double x = s.p[4];
          const double y = s.p[5];
          double ox = s.p[0] - cx, oy = s.p[1] - cy;
          if (ox == 0 && oy == 0) {
            ox = s.p[2] - cx;
            oy = s.p[3] - cy;
          }
          if (ox == 0 && oy == 0) {
            ox = x - cx;
            oy = y - cy;
          }
          double ix = x - s.p[2], iy = y - s.p[3];
          if (ix == 0 && iy == 0) {
            ix = x - s.p[0];
            iy = y - s.p[1];
          }
          if (ix == 0 && iy == 0) {
            ix = x - cx;
            iy = y - cy;
          }
          if (!v.empty()) {
            v.back().outAngle = angle_of(ox, oy);
            v.back().hasOut = true;
          }
          v.push_back({x, y, angle_of(ix, iy), 0, true, false});
          cx = x;
          cy = y;
          break;
        }
        case PathSeg::Op::close: {
          const double a = angle_of(sx - cx, sy - cy);
          if (!v.empty()) {
            v.back().outAngle = a;
            v.back().hasOut = true;
          }
          Vertex end{sx, sy, a, 0, true, false};
          if (subStart < v.size() && v[subStart].hasOut) {
            end.outAngle = v[subStart].outAngle;
            end.hasOut = true;
            v[subStart].inAngle = a;
            v[subStart].hasIn = true;
          }
          v.push_back(end);
          cx = sx;
          cy = sy;
          break;
        }
      }
    }
    return v;
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_markers(SkCanvas* c, int i, const std::vector<PathSeg>& segs, const Vp& vp, int depth) {
    const Style& s = style(i);
    if (s.markerStart.empty() && s.markerMid.empty() && s.markerEnd.empty()) return;
    const std::vector<Vertex> v = vertices(segs);
    if (v.empty()) return;
    const double sw = resolve(s.strokeWidth, vp.diag(), s.fontSizePx);
    for (std::size_t k = 0; k < v.size(); ++k) {
      const bool first = k == 0;
      const bool last = k + 1 == v.size();
      const std::string& id = first ? s.markerStart : last ? s.markerEnd : s.markerMid;
      if (id.empty()) continue;
      const int m = by_id(id);
      if (m < 0 || !is(m, "marker")) continue;
      double angle = 0;
      const Vertex& x = v[k];
      if (first) angle = x.hasOut ? x.outAngle : x.inAngle;
      else if (last) angle = x.hasIn ? x.inAngle : x.outAngle;
      else {
        double a = x.inAngle;
        const double b = x.outAngle;
        if (std::fabs(a - b) > 180) a += 360;
        angle = (a + b) / 2;
      }
      draw_marker(c, m, x.x, x.y, angle, first, sw, vp, depth);
    }
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_marker(SkCanvas* c, int m, double x, double y, double autoAngle, bool isStart, double strokeWidth,
                   const Vp& vp, int depth) {
    if (depth > kMaxDepth || std::ranges::find(markerStack_, m) != markerStack_.end()) return;
    const Node& n = node(m);
    const double mw = len(m, "markerWidth", 3, vp.w);
    const double mh = len(m, "markerHeight", 3, vp.h);
    if (!(mw > 0) || !(mh > 0)) return;
    double angle = 0;
    const std::string* orient = n.attr("orient");
    if (orient != nullptr) {
      const std::string_view o = trim(*orient);
      if (o == "auto") angle = autoAngle;
      else if (o == "auto-start-reverse") angle = isStart ? autoAngle + 180 : autoAngle;
      else {
        std::string_view t = o;
        if (const auto a = parse_number(t)) {
          angle = static_cast<double>(*a);
          if (t == "rad") angle = angle * 180 / kPi;
          else if (t == "grad") angle = angle * 0.9;
          else if (t == "turn") angle *= 360;
        }
      }
    }
    Mat2D vbm;
    Vp inner{mw, mh};
    if (const std::string* vbv = n.attr("viewBox")) {
      if (const auto vb = parse_view_box(*vbv)) {
        if (vb->w == 0 || vb->h == 0) return;
        const std::string* par = n.attr("preserveAspectRatio");
        vbm = view_box_transform(*vb, parse_aspect_ratio(par != nullptr ? *par : ""), mw, mh);
        inner = {vb->w, vb->h};
      }
    }
    const double refX = len(m, "refX", 0, inner.w);
    const double refY = len(m, "refY", 0, inner.h);
    const double mrx = vbm.a * refX + vbm.c * refY + vbm.e;
    const double mry = vbm.b * refX + vbm.d * refY + vbm.f;
    const std::string* mu = n.attr("markerUnits");
    const double sc = mu != nullptr && trim(*mu) == "userSpaceOnUse" ? 1.0 : strokeWidth;
    const double rad = angle * kPi / 180.0;
    Mat2D t = translate(x, y) * Mat2D{std::cos(rad), std::sin(rad), -std::sin(rad), std::cos(rad), 0, 0} * scale(sc, sc) *
              translate(-mrx, -mry);
    markerStack_.push_back(m);
    c->save();
    c->concat(to_sk(t));
    if (!style(m).overflowVisible) c->clipRect(SkRect::MakeWH(f(mw), f(mh)));
    c->concat(to_sk(vbm));
    render_children(c, m, inner, depth + 1);
    c->restore();
    markerStack_.pop_back();
  }

  // ── images ──

  void draw_image(SkCanvas* c, int i, const Vp& vp) {
    const Node& n = node(i);
    const Style& s = style(i);
    if (s.hidden) return;
    const std::string* href = doc_.href(i);
    if (href == nullptr || trim(*href).empty()) return;
    std::string mime;
    const auto bytes = data_url_bytes(*href, &mime);
    if (!bytes) {
      note("<image> that is not a data: URL");
      return;
    }
    if (mime == "image/svg+xml") {
      note("<image> of an SVG");
      return;
    }
    if (!opts_.decodeImage) {
      note("<image> (no decoder)");
      return;
    }
    Bitmap bm;
    if (!opts_.decodeImage(*bytes, bm) || bm.width == 0 || bm.height == 0) return;  // a broken image draws nothing
    // Premultiply as the browser's image decode does (SkMulDiv255Round).
    for (std::size_t k = 0; k + 3 < bm.rgba.size(); k += 4) {
      const unsigned a = bm.rgba[k + 3];
      for (std::size_t ch = 0; ch < 3; ++ch) {
        const unsigned prod = (bm.rgba[k + ch] * a) + 128U;
        bm.rgba[k + ch] = static_cast<std::uint8_t>((prod + (prod >> 8U)) >> 8U);
      }
    }
    const SkImageInfo info =
        SkImageInfo::Make(static_cast<int>(bm.width), static_cast<int>(bm.height), kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    const sk_sp<SkImage> img = SkImages::RasterFromPixmapCopy(SkPixmap(info, bm.rgba.data(), static_cast<std::size_t>(bm.width) * 4));
    if (!img) return;
    const double iw = bm.width;
    const double ih = bm.height;
    const double x = len(i, "x", 0, vp.w);
    const double y = len(i, "y", 0, vp.h);
    double w = n.attr("width") != nullptr ? len(i, "width", -1, vp.w) : -1;
    double h = n.attr("height") != nullptr ? len(i, "height", -1, vp.h) : -1;
    if (w < 0 && h < 0) {
      w = iw;
      h = ih;
    } else if (w < 0) {
      w = h * iw / ih;
    } else if (h < 0) {
      h = w * ih / iw;
    }
    if (!(w > 0) || !(h > 0)) return;
    const std::string* par = n.attr("preserveAspectRatio");
    const AspectRatio ar = parse_aspect_ratio(par != nullptr ? *par : "");
    const Mat2D m = translate(x, y) * view_box_transform(ViewBox{0, 0, iw, ih}, ar, w, h);
    c->save();
    if (ar.slice) c->clipRect(SkRect::MakeXYWH(f(x), f(y), f(w), f(h)));
    c->concat(to_sk(m));
    const SkSamplingOptions sampling =
        s.pixelatedImages ? SkSamplingOptions(SkFilterMode::kNearest) : SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kLinear);
    SkPaint p;
    p.setAntiAlias(true);
    c->drawImageRect(img, SkRect::MakeWH(f(iw), f(ih)), SkRect::MakeWH(f(iw), f(ih)), sampling, &p,
                     SkCanvas::kFast_SrcRectConstraint);
    c->restore();
  }

  // ── text (SVGTextLayoutEngine, simplified to horizontal LTR chunks) ──

  struct TextRun {
    int styleOf = -1;             // the element whose style paints the run
    ShapedText shaped;
    double x = 0, y = 0;          // pen origin of the run
    std::vector<double> dys;      // per-glyph extra y (dy lists)
  };

  struct TextLayout {
    std::vector<TextRun> runs;
    SkRect bounds = SkRect::MakeEmpty();
    int textPath = -1;  // the <textPath> element when the text rides a path
  };

  const FontSet* fonts_for(const Style& s) {
    if (opts_.fonts != nullptr) return opts_.fonts;
    SystemFonts& sf = system_fonts();
    if (!sf.set) {
#if defined(_WIN32)
      sf.set = std::make_unique<FontSet>(FontOptions::chromium_windows());
#else
      sf.set = std::make_unique<FontSet>(FontOptions{});
#endif
    }
    std::vector<std::string> fams = s.fontFamily;
    fams.emplace_back("serif");  // Blink's standard font family
    for (const auto& fam : fams) {
      if (sf.loaded.insert(fam).second) sf.set->add_system_family(fam);
    }
    return sf.set.get();
  }

  static css::Font css_font(const Style& s) {
    css::Font fo;
    fo.italic = s.italic;
    fo.weight = s.fontWeight;
    fo.sizePx = s.fontSizePx;
    fo.families = s.fontFamily;
    if (fo.families.empty()) fo.families = {"serif"};
    return fo;
  }

  /// SVG 1.1 xml:space="default" whitespace: newlines removed, tabs → spaces,
  /// runs of spaces collapsed across the whole <text> (leading / trailing trimmed later).
  static std::string collapse(std::string_view in, bool& lastWasSpace, bool preserve) {
    std::string out;
    for (const char ch : in) {
      if (preserve) {
        out.push_back(ch == '\n' || ch == '\r' || ch == '\t' ? ' ' : ch);
        continue;
      }
      if (ch == '\n' || ch == '\r') continue;
      const char c2 = ch == '\t' ? ' ' : ch;
      if (c2 == ' ') {
        if (lastWasSpace) continue;
        lastWasSpace = true;
      } else {
        lastWasSpace = false;
      }
      out.push_back(c2);
    }
    return out;
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void collect_text(int el, const Vp& vp, TextLayout& lay, double& penX, double& penY, bool& lastSpace, bool preserve,
                    std::vector<std::pair<std::size_t, Anchor>>& chunks, const FontSet* fonts, int depth) {
    if (depth > kMaxDepth) return;
    for (const int k : node(el).children) {
      const Node& n = node(k);
      if (!n.element) {
        std::string t = collapse(n.text, lastSpace, preserve);
        if (t.empty()) continue;
        if (lay.runs.empty() && !preserve) {
          while (!t.empty() && t.front() == ' ') t.erase(t.begin());
          if (t.empty()) continue;
        }
        const Style& s = style(el);
        ShapeRequest req;
        req.font = css_font(s);
        req.letterSpacing = s.letterSpacing;
        req.wordSpacing = s.wordSpacing;
        TextRun r;
        r.styleOf = el;
        r.shaped = fonts_for(s)->shape(t, req);
        r.x = penX;
        r.y = penY;
        penX += r.shaped.width;
        lay.runs.push_back(std::move(r));
        continue;
      }
      if (!n.svgNs || style(k).displayNone) continue;
      if (n.name == "tspan" || n.name == "a") {
        const std::string* xs = n.attr("x");
        const std::string* ys = n.attr("y");
        if (xs != nullptr || ys != nullptr) {
          if (xs != nullptr) penX = len(k, "x", penX, vp.w);
          if (ys != nullptr) penY = len(k, "y", penY, vp.h);
          chunks.emplace_back(lay.runs.size(), style(k).anchor);
        }
        if (const std::string* dx = n.attr("dx")) {
          if (const auto l = parse_length(*dx)) penX += resolve(*l, vp.w, style(k).fontSizePx);
        }
        if (const std::string* dy = n.attr("dy")) {
          if (const auto l = parse_length(*dy)) penY += resolve(*l, vp.h, style(k).fontSizePx);
        }
        if (n.attr("rotate") != nullptr) note("text rotate");
        collect_text(k, vp, lay, penX, penY, lastSpace, preserve, chunks, fonts, depth + 1);
      } else if (n.name == "textPath") {
        if (lay.textPath >= 0 || !lay.runs.empty()) note("text mixed with a textPath");
        lay.textPath = k;
        collect_text(k, vp, lay, penX, penY, lastSpace, preserve, chunks, fonts, depth + 1);
      } else if (n.name != "title" && n.name != "desc") {
        note("<" + n.name + "> inside <text>");
      }
    }
  }

  TextLayout layout_text(int i, const Vp& vp) {
    TextLayout lay;
    const Node& n = node(i);
    const FontSet* fonts = fonts_for(style(i));
    if (fonts == nullptr || fonts->face_count() == 0) {
      note("<text> (no fonts)");
      return lay;
    }
    const std::string* sp = n.attr("xml:space");
    const bool preserve = sp != nullptr && trim(*sp) == "preserve";
    const auto first = [&](std::string_view a, double ref) {
      const std::string* v = n.attr(a);
      if (v == nullptr) return 0.0;
      std::string_view t = trim(*v);
      std::size_t k = 0;
      while (k < t.size() && t[k] != ' ' && t[k] != ',') ++k;
      if (k < t.size()) note("<text> " + std::string(a) + " lists");
      const auto l = parse_length(t.substr(0, k));
      return l ? resolve(*l, ref, style(i).fontSizePx) : 0.0;
    };
    double penX = first("x", vp.w) + first("dx", vp.w);
    double penY = first("y", vp.h) + first("dy", vp.h);
    if (n.attr("rotate") != nullptr) note("text rotate");
    if (n.attr("textLength") != nullptr) note("textLength");
    bool lastSpace = false;
    std::vector<std::pair<std::size_t, Anchor>> chunks{{0, style(i).anchor}};
    collect_text(i, vp, lay, penX, penY, lastSpace, preserve, chunks, fonts, 0);
    // Trailing space of the whole text.
    if (!preserve && !lay.runs.empty()) {
      TextRun& lastRun = lay.runs.back();
      if (!lastRun.shaped.glyphs.empty() && lastSpace) {
        // The collapsed trailing space is the last glyph (a space advance).
        const Glyph g = lastRun.shaped.glyphs.back();
        lastRun.shaped.glyphs.pop_back();
        lastRun.shaped.width -= g.advance;
      }
    }
    if (lay.textPath >= 0) return lay;
    // text-anchor per chunk.
    for (std::size_t c = 0; c < chunks.size(); ++c) {
      const std::size_t from = chunks[c].first;
      const std::size_t to = c + 1 < chunks.size() ? chunks[c + 1].first : lay.runs.size();
      if (from >= to) continue;
      double w = 0;
      for (std::size_t r = from; r < to; ++r) w += lay.runs[r].shaped.width;
      const double shift = chunks[c].second == Anchor::middle ? -w / 2 : chunks[c].second == Anchor::end ? -w : 0;
      for (std::size_t r = from; r < to; ++r) lay.runs[r].x += shift;
    }
    for (const TextRun& r : lay.runs) {
      const SkRect b = SkRect::MakeLTRB(f(r.x), f(r.y - r.shaped.ascent), f(r.x + r.shaped.width), f(r.y + r.shaped.descent));
      lay.bounds.join(b);
    }
    return lay;
  }

  std::optional<SkRect> text_bbox(int i, const Vp& vp) {
    const std::scoped_lock lock(system_fonts().m);
    const TextLayout lay = layout_text(i, vp);
    if (lay.bounds.isEmpty()) return std::nullopt;
    return lay.bounds;
  }

  sk_sp<SkTextBlob> blob_for(const FontSet& fonts, const TextRun& r) {
    const ShapedText& s = r.shaped;
    SkTextBlobBuilder builder;
    std::size_t i = 0;
    while (i < s.glyphs.size()) {
      std::size_t j = i + 1;
      while (j < s.glyphs.size() && s.glyphs[j].face == s.glyphs[i].face && s.glyphs[j].fakeBold == s.glyphs[i].fakeBold &&
             s.glyphs[j].fakeItalic == s.glyphs[i].fakeItalic) {
        ++j;
      }
      const SkFont font = ffi::sk_font_for(fonts, s.glyphs[i].face, s.axes, s.sizePx, s.glyphs[i].fakeBold, s.glyphs[i].fakeItalic);
      const auto& run = builder.allocRunPos(font, static_cast<int>(j - i));
      for (std::size_t k = i; k < j; ++k) {
        run.glyphs[k - i] = s.glyphs[k].id;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        run.points()[k - i] = SkPoint::Make(f(s.glyphs[k].x), f(s.glyphs[k].y));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      i = j;
    }
    return builder.make();
  }

  /// Glyphs of a run placed along a path (SVGTextPathChunkBuilder): each
  /// glyph's advance midpoint sits on the path, rotated to its tangent; a glyph
  /// whose midpoint falls off the path is not drawn.
  sk_sp<SkTextBlob> path_blob(const FontSet& fonts, const TextRun& r, const SkContourMeasure& cm, double offset) {
    const ShapedText& s = r.shaped;
    SkTextBlobBuilder builder;
    for (const Glyph& g : s.glyphs) {
      const double mid = offset + r.x + g.x + g.advance / 2;
      if (mid < 0 || mid > static_cast<double>(cm.length())) continue;
      SkPoint pos;
      SkVector tan;
      if (!cm.getPosTan(f(mid), &pos, &tan)) continue;
      const SkFont font = ffi::sk_font_for(fonts, g.face, s.axes, s.sizePx, g.fakeBold, g.fakeItalic);
      const auto& run = builder.allocRunRSXform(font, 1);
      run.glyphs[0] = g.id;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const float half = f(g.advance / 2);
      const float dy = f(g.y);
      // Glyph origin = pos + R·(−advance/2, dy), R the unit tangent's rotation.
      run.xforms()[0] = SkRSXform::Make(tan.fX, tan.fY, pos.fX - tan.fX * half - tan.fY * dy,  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
                                        pos.fY - tan.fY * half + tan.fX * dy);
    }
    return builder.make();
  }

  // NOLINTNEXTLINE(misc-no-recursion)
  void draw_text(SkCanvas* c, int i, const Vp& vp, int depth, bool clipMode) {
    const std::scoped_lock lock(system_fonts().m);
    const TextLayout lay = layout_text(i, vp);
    if (lay.runs.empty()) return;
    const FontSet* fonts = fonts_for(style(i));
    std::optional<SkPath> tpath;
    double startOffset = 0;
    sk_sp<SkContourMeasure> cm;
    if (lay.textPath >= 0) {
      const int pe = ref(lay.textPath);
      if (pe < 0 || !is(pe, "path")) {
        if (pe >= 0) note("<textPath> on a <" + node(pe).name + ">");
        return;
      }
      if (node(lay.textPath).attr("path") != nullptr) note("textPath path attribute");
      auto sh = shape_of(pe, vp);
      if (!sh) return;
      tpath = sh->path.makeTransform(to_sk(transform_of(pe)));
      SkContourMeasureIter it(*tpath, false);
      cm = it.next();
      if (!cm) return;
      if (const std::string* so = node(lay.textPath).attr("startOffset")) {
        if (const auto l = parse_length(*so)) {
          startOffset = l->unit == Unit::percent ? l->v / 100.0 * static_cast<double>(cm->length()) : resolve(*l, 0, 16);
        }
      }
      const Anchor a = style(lay.textPath).anchor;
      double w = 0;
      for (const TextRun& r : lay.runs) w += r.shaped.width;
      if (a == Anchor::middle) startOffset -= w / 2;
      else if (a == Anchor::end) startOffset -= w;
      if (node(lay.textPath).attr("method") != nullptr || node(lay.textPath).attr("spacing") != nullptr ||
          node(lay.textPath).attr("side") != nullptr) {
        note("textPath method / spacing / side");
      }
    }
    const SkRect bbox = lay.bounds;
    for (const TextRun& r : lay.runs) {
      const Style& s = style(r.styleOf);
      const sk_sp<SkTextBlob> blob = cm ? path_blob(*fonts, r, *cm, startOffset) : blob_for(*fonts, r);
      if (!blob) continue;
      const float ox = cm ? 0.0F : f(r.x);
      const float oy = cm ? 0.0F : f(r.y);
      if (clipMode) {
        SkPaint p;
        p.setAntiAlias(true);
        p.setColor(SK_ColorBLACK);
        c->drawTextBlob(blob, ox, oy, p);
        continue;
      }
      if (s.hidden) continue;
      const auto fill = [&] {
        SkPaint p;
        if (!setup_paint(p, s.fill, s.fillOpacity, s, bbox, vp, depth)) return;
        p.setAntiAlias(true);
        c->drawTextBlob(blob, ox, oy, p);
      };
      const auto stroke = [&] {
        if (!(resolve(s.strokeWidth, vp.diag(), s.fontSizePx) > 0)) return;
        SkPaint p;
        if (!setup_paint(p, s.stroke, s.strokeOpacity, s, bbox, vp, depth)) return;
        p.setAntiAlias(true);
        setup_stroke(p, s, vp, 1);
        c->drawTextBlob(blob, ox, oy, p);
      };
      if (s.paintOrderStrokeFirst) {
        stroke();
        fill();
      } else {
        fill();
        stroke();
      }
    }
  }

  const Document& doc_;
  const std::vector<Style>& st_;
  const RasterizeOptions& opts_;
  std::vector<std::string>& notes_;
  std::vector<int> patternStack_;
  std::vector<int> clipStack_;
  std::vector<int> maskStack_;
  std::vector<int> markerStack_;
};

}  // namespace

bool render_document(const Document& doc, const std::vector<Style>& styles, std::uint32_t w, std::uint32_t h,
                     const RasterizeOptions& opts, std::vector<std::uint8_t>& rgba, std::vector<std::string>& unsupported,
                     std::string& error) {
  if (doc.root < 0 || styles.size() != doc.nodes.size() || w == 0 || h == 0) {
    error = "bad SVG document";
    return false;
  }
  const SkImageInfo info = SkImageInfo::Make(static_cast<int>(w), static_cast<int>(h), kRGBA_8888_SkColorType, kPremul_SkAlphaType);
  const SkSurfaceProps props(0, kUnknown_SkPixelGeometry);
  const sk_sp<SkSurface> surface = SkSurfaces::Raster(info, &props);
  if (!surface) {
    error = "could not allocate the SVG surface";
    return false;
  }
  SkCanvas* c = surface->getCanvas();
  c->clear(SK_ColorTRANSPARENT);
  Painter p(doc, styles, opts, unsupported);
  p.draw_root(c, static_cast<double>(w), static_cast<double>(h));
  rgba.assign(static_cast<std::size_t>(w) * h * 4, 0);
  const SkPixmap pm(info, rgba.data(), static_cast<std::size_t>(w) * 4);
  if (!surface->readPixels(pm, 0, 0)) {
    error = "SVG surface read-back failed";
    return false;
  }
  return true;
}

}  // namespace premation::raster::svg
