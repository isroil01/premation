// A Canvas2D that records its program instead of drawing (tests): the op
// grammar of packages/render-tests/harness/rasterRecorder.ts, normalised the
// way the TS fixture recorders normalise it (drawImage always 9 arguments, arc
// with its ccw flag, fill with its rule, colours as rgba(r,g,b,a), filters as
// set), each op one compact JSON string. It tracks the CTM so getTransform
// answers as the TS fake does (same arithmetic, V8's Math).
//
// Pixels (E4, the effect-chain fixture): each canvas holds straight RGBA8, read
// and written by getImageData / putImageData, and the few composites the bake
// chain issues — fillRect / clearRect with a colour and a 1:1 integer
// drawImage, at identity — go through the REFERENCE compositor of
// src/core/rendering/raster/__testHelpers__/recordingCanvas.ts
// (`composite_pixel`, the same double arithmetic). Not Skia's arithmetic: it
// only gives the pixel passes after a composite defined bytes on both engines.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "jsmath.hpp"
#include "numconv.hpp"
#include "raster/canvas.hpp"

namespace premation::raster::test {

struct Recording {
  /// False: keep the pixels and the state, record nothing (the chain bench's CPU canvas).
  bool log = true;
  std::vector<std::string> ops;
  int nextCanvas = 0;
  int nextGrad = 0;
  std::map<const Gradient*, int> grads;
  std::vector<std::shared_ptr<Gradient>> keep;  // pins every recorded gradient: a freed one's address must not be reused
};

namespace detail {

inline bool modeled(std::string_view op) {
  return op == "source-over" || op == "destination-in" || op == "destination-out" || op == "source-atop" ||
         op == "source-in" || op == "lighter" || op == "copy";
}
/// Operations that also clear the destination outside the drawn rectangle.
inline bool unbounded(std::string_view op) { return op == "destination-in" || op == "source-in" || op == "copy"; }
inline std::uint8_t round8(double v) {
  const double r = std::floor(v * 255 + 0.5);
  return static_cast<std::uint8_t>(r < 0 ? 0 : r > 255 ? 255 : r);
}
/// recordingCanvas.ts compositePixel.
inline void composite_pixel(std::uint8_t* d, double sr, double sg, double sb, double as, std::string_view op) {
  const double ad = d[3] / 255.0;
  const double s0 = (sr / 255) * as;
  const double s1 = (sg / 255) * as;
  const double s2 = (sb / 255) * as;
  const double d0 = (d[0] / 255.0) * ad;
  const double d1 = (d[1] / 255.0) * ad;
  const double d2 = (d[2] / 255.0) * ad;
  double ao = 0;
  double c0 = 0;
  double c1 = 0;
  double c2 = 0;
  if (op == "source-over") {
    ao = as + ad * (1 - as);
    c0 = s0 + d0 * (1 - as);
    c1 = s1 + d1 * (1 - as);
    c2 = s2 + d2 * (1 - as);
  } else if (op == "destination-in") {
    ao = ad * as;
    c0 = d0 * as;
    c1 = d1 * as;
    c2 = d2 * as;
  } else if (op == "destination-out") {
    ao = ad * (1 - as);
    c0 = d0 * (1 - as);
    c1 = d1 * (1 - as);
    c2 = d2 * (1 - as);
  } else if (op == "source-atop") {
    ao = ad;
    c0 = s0 * ad + d0 * (1 - as);
    c1 = s1 * ad + d1 * (1 - as);
    c2 = s2 * ad + d2 * (1 - as);
  } else if (op == "source-in") {
    ao = as * ad;
    c0 = s0 * ad;
    c1 = s1 * ad;
    c2 = s2 * ad;
  } else if (op == "lighter") {
    ao = std::min(1.0, as + ad);
    c0 = std::min(1.0, s0 + d0);
    c1 = std::min(1.0, s1 + d1);
    c2 = std::min(1.0, s2 + d2);
  } else {  // copy
    ao = as;
    c0 = s0;
    c1 = s1;
    c2 = s2;
  }
  const std::uint8_t a8 = round8(ao);
  if (a8 == 0) {
    d[0] = d[1] = d[2] = d[3] = 0;
    return;
  }
  d[0] = round8(c0 / ao);
  d[1] = round8(c1 / ao);
  d[2] = round8(c2 / ao);
  d[3] = a8;
}

}  // namespace detail

class RecordingCanvas final : public Canvas2D {
 public:
  RecordingCanvas(std::shared_ptr<Recording> rec, std::uint32_t w, std::uint32_t h)
      : rec_(std::move(rec)), w_(w), h_(h), id_(rec_->nextCanvas++) {
    if (rec_->log) rec_->ops.push_back("[" + std::to_string(id_) + ",\"canvas\"," + std::to_string(w) + "," + std::to_string(h) + "]");
  }

  [[nodiscard]] int id() const noexcept { return id_; }
  /// The straight RGBA8 pixels (the model; see the header).
  [[nodiscard]] std::vector<std::uint8_t>& px() const {
    const std::size_t n = static_cast<std::size_t>(w_) * h_ * 4;
    if (px_.size() != n) px_.assign(n, 0);
    return px_;
  }

  [[nodiscard]] const CanvasOptions& options() const noexcept override { return opts_; }
  [[nodiscard]] std::uint32_t width() const noexcept override { return w_; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return h_; }
  void resize(std::uint32_t w, std::uint32_t h) override {
    w_ = w;
    h_ = h;
    px_.clear();
  }
  [[nodiscard]] std::vector<std::uint8_t> pixels() const override { return {}; }
  [[nodiscard]] std::unique_ptr<Canvas2D> create_canvas(std::uint32_t w, std::uint32_t h) const override {
    return std::make_unique<RecordingCanvas>(rec_, w, h);
  }

  void save() override {
    stack_.push_back({m_, fill_, stroke_, gco_, alpha_});
    call("save", {});
  }
  void restore() override {
    if (!stack_.empty()) {
      m_ = stack_.back().m;
      fill_ = stack_.back().fill;
      stroke_ = stack_.back().stroke;
      gco_ = stack_.back().gco;
      alpha_ = stack_.back().alpha;
      stack_.pop_back();
    }
    call("restore", {});
  }
  void scale(double x, double y) override {
    m_ = {m_.a * x, m_.b * x, m_.c * y, m_.d * y, m_.e, m_.f};
    call("scale", {num(x), num(y)});
  }
  void rotate(double t) override {
    const double cos = motion::js::cos(t);
    const double sin = motion::js::sin(t);
    m_ = {m_.a * cos + m_.c * sin, m_.b * cos + m_.d * sin, m_.c * cos - m_.a * sin, m_.d * cos - m_.b * sin, m_.e, m_.f};
    call("rotate", {num(t)});
  }
  void translate(double x, double y) override {
    m_.e = m_.a * x + m_.c * y + m_.e;
    m_.f = m_.b * x + m_.d * y + m_.f;
    call("translate", {num(x), num(y)});
  }
  void transform(const Mat2D& m) override {
    m_ = m_ * m;
    call("transform", {num(m.a), num(m.b), num(m.c), num(m.d), num(m.e), num(m.f)});
  }
  void setTransform(const Mat2D& m) override {
    m_ = m;
    call("setTransform", {num(m.a), num(m.b), num(m.c), num(m.d), num(m.e), num(m.f)});
  }
  [[nodiscard]] Mat2D getTransform() const override { return m_; }

  void setFillStyle(const Style& s) override {
    fill_ = s;
    set("fillStyle", style(s));
  }
  void setStrokeStyle(const Style& s) override {
    stroke_ = s;
    set("strokeStyle", style(s));
  }
  [[nodiscard]] const Style& fillStyle() const override { return fill_; }
  [[nodiscard]] const Style& strokeStyle() const override { return stroke_; }
  void setLineWidth(double w) override { set("lineWidth", num(w)); }
  void setLineCap(LineCap c) override { set("lineCap", c == LineCap::round ? "\"round\"" : c == LineCap::square ? "\"square\"" : "\"butt\""); }
  void setLineJoin(LineJoin j) override { set("lineJoin", j == LineJoin::round ? "\"round\"" : j == LineJoin::bevel ? "\"bevel\"" : "\"miter\""); }
  void setMiterLimit(double m) override { set("miterLimit", num(m)); }
  void setLineDash(const std::vector<double>& /*dash*/) override { call("setLineDash", {}); }
  void setLineDashOffset(double o) override { set("lineDashOffset", num(o)); }
  void setGlobalAlpha(double a) override {
    alpha_ = a;
    set("globalAlpha", num(a));
  }
  [[nodiscard]] double globalAlpha() const override { return alpha_; }
  bool setGlobalCompositeOperation(std::string_view op) override {
    gco_ = std::string(op);
    set("globalCompositeOperation", quote(op));
    return true;
  }
  [[nodiscard]] std::string globalCompositeOperation() const override { return gco_; }
  void setFilter(const css::Filter& f) override { set("filter", f.blurPx > 0 ? quote("blur(" + num(f.blurPx) + "px)") : quote("none")); }
  bool setFilterString(std::string_view css) override {
    set("filter", quote(css));
    return true;
  }
  void setImageSmoothing(bool on) override { set("imageSmoothingEnabled", on ? "true" : "false"); }
  void setShadowColor(const css::Color& c) override { set("shadowColor", color(c)); }
  void setShadowBlur(double b) override { set("shadowBlur", num(b)); }
  void setShadowOffsetX(double x) override { set("shadowOffsetX", num(x)); }
  void setShadowOffsetY(double y) override { set("shadowOffsetY", num(y)); }
  [[nodiscard]] std::vector<std::uint8_t> getImageData(int x, int y, std::uint32_t w, std::uint32_t h) const override {
    const_cast<RecordingCanvas*>(this)->call("getImageData", {std::to_string(x), std::to_string(y), std::to_string(w), std::to_string(h)});  // NOLINT(cppcoreguidelines-pro-type-const-cast): a read is still an op of the program
    std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4, 0);
    const std::vector<std::uint8_t>& p = px();
    for (std::uint32_t j = 0; j < h; ++j) {
      for (std::uint32_t i = 0; i < w; ++i) {
        const long sx = x + static_cast<long>(i);
        const long sy = y + static_cast<long>(j);
        if (sx < 0 || sy < 0 || sx >= static_cast<long>(w_) || sy >= static_cast<long>(h_)) continue;
        const std::size_t s = (static_cast<std::size_t>(sy) * w_ + static_cast<std::size_t>(sx)) * 4;
        const std::size_t o = (static_cast<std::size_t>(j) * w + i) * 4;
        for (std::size_t c = 0; c < 4; ++c) out[o + c] = p[s + c];
      }
    }
    return out;
  }
  void putImageData(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h, int x, int y) override {
    if (rec_->log) {
      std::uint64_t hash = 0xcbf29ce484222325ULL;  // FNV-1a 64 of the bytes, so the log pins the data too
      for (const std::uint8_t b : rgba) hash = (hash ^ b) * 0x100000001b3ULL;
      call("putImageData", {quote(std::to_string(hash)), std::to_string(w), std::to_string(h), std::to_string(x), std::to_string(y)});
    }
    std::vector<std::uint8_t>& p = px();
    for (std::uint32_t j = 0; j < h; ++j) {
      for (std::uint32_t i = 0; i < w; ++i) {
        const long dx = x + static_cast<long>(i);
        const long dy = y + static_cast<long>(j);
        if (dx < 0 || dy < 0 || dx >= static_cast<long>(w_) || dy >= static_cast<long>(h_)) continue;
        const std::size_t o = (static_cast<std::size_t>(dy) * w_ + static_cast<std::size_t>(dx)) * 4;
        const std::size_t s = (static_cast<std::size_t>(j) * w + i) * 4;
        for (std::size_t c = 0; c < 4; ++c) p[o + c] = rgba[s + c];
      }
    }
  }

  bool setFont(std::string_view font) override {
    set("font", quote(font));
    return true;
  }
  [[nodiscard]] std::string font() const override { return {}; }
  void setTextAlign(TextAlign a) override {
    static constexpr std::array<std::string_view, 5> kNames{"start", "end", "left", "right", "center"};
    set("textAlign", quote(kNames[static_cast<std::size_t>(a)]));
  }
  void setTextBaseline(TextBaseline b) override {
    static constexpr std::array<std::string_view, 6> kNames{"alphabetic", "top", "hanging", "middle", "ideographic", "bottom"};
    set("textBaseline", quote(kNames[static_cast<std::size_t>(b)]));
  }
  void setDirection(Direction /*d*/) override { call("direction", {}); }
  [[nodiscard]] Direction direction() const override { return Direction::inherit; }
  void setLetterSpacing(double px) override { set("letterSpacing", num(px)); }
  void setWordSpacing(double px) override { set("wordSpacing", num(px)); }
  void setFontKerning(bool /*on*/) override { call("fontKerning", {}); }
  void setSmallCaps(bool /*on*/) override { call("smallCaps", {}); }
  void setFontVariationSettings(std::string_view /*s*/) override { call("fontVariationSettings", {}); }
  void setFontFeatureSettings(std::string_view /*s*/) override { call("fontFeatureSettings", {}); }

  void beginPath() override { call("beginPath", {}); }
  void moveTo(double x, double y) override { call("moveTo", {num(x), num(y)}); }
  void lineTo(double x, double y) override { call("lineTo", {num(x), num(y)}); }
  void quadraticCurveTo(double cx, double cy, double x, double y) override { call("quadraticCurveTo", {num(cx), num(cy), num(x), num(y)}); }
  void bezierCurveTo(double a, double b, double c, double d, double x, double y) override {
    call("bezierCurveTo", {num(a), num(b), num(c), num(d), num(x), num(y)});
  }
  void arc(double x, double y, double r, double a0, double a1, bool ccw) override {
    call("arc", {num(x), num(y), num(r), num(a0), num(a1), ccw ? "true" : "false"});
  }
  void arcTo(double x1, double y1, double x2, double y2, double r) override { call("arcTo", {num(x1), num(y1), num(x2), num(y2), num(r)}); }
  void ellipse(double x, double y, double rx, double ry, double rot, double a0, double a1, bool ccw) override {
    call("ellipse", {num(x), num(y), num(rx), num(ry), num(rot), num(a0), num(a1), ccw ? "true" : "false"});
  }
  void rect(double x, double y, double w, double h) override { call("rect", {num(x), num(y), num(w), num(h)}); }
  void roundRect(double x, double y, double w, double h, const std::vector<double>& /*radii*/) override {
    call("roundRect", {num(x), num(y), num(w), num(h)});
  }
  void closePath() override { call("closePath", {}); }
  void fill(FillRule rule) override { call("fill", {rule == FillRule::evenodd ? "\"evenodd\"" : "\"nonzero\""}); }
  void stroke() override { call("stroke", {}); }
  void clip(FillRule rule) override { call("clip", {rule == FillRule::evenodd ? "\"evenodd\"" : "\"nonzero\""}); }
  void fill(const Path2D& path, FillRule rule) override {
    call("fillPath2D", {rule == FillRule::evenodd ? "\"evenodd\"" : "\"nonzero\"", path_json(path)});
  }
  void stroke(const Path2D& /*path*/) override { call("strokePath2D", {}); }
  void clip(const Path2D& /*path*/, FillRule /*rule*/) override { call("clipPath2D", {}); }
  void fillRect(double x, double y, double w, double h) override {
    call("fillRect", {num(x), num(y), num(w), num(h)});
    if (fill_.kind != Style::Kind::color || !m_.is_identity() || !detail::modeled(gco_)) return;
    const css::Color c = fill_.color;
    const double as = c.a * alpha_;
    const std::string op = gco_;
    visit_rect(x, y, w, h, !detail::unbounded(op), [&](std::uint8_t* d, bool inside) {
      if (inside) detail::composite_pixel(d, c.r, c.g, c.b, as, op);
      else detail::composite_pixel(d, 0, 0, 0, 0, op);
    });
  }
  void strokeRect(double x, double y, double w, double h) override { call("strokeRect", {num(x), num(y), num(w), num(h)}); }
  void clearRect(double x, double y, double w, double h) override {
    call("clearRect", {num(x), num(y), num(w), num(h)});
    if (!m_.is_identity()) return;
    visit_rect(x, y, w, h, true, [](std::uint8_t* d, bool /*inside*/) { d[0] = d[1] = d[2] = d[3] = 0; });
  }
  void fillText(std::string_view t, double x, double y) override { call("fillText", {quote(t), num(x), num(y)}); }
  void strokeText(std::string_view t, double x, double y) override { call("strokeText", {quote(t), num(x), num(y)}); }
  [[nodiscard]] TextMetrics measureText(std::string_view /*text*/) override { return {}; }
  void drawImage(const Canvas2D& src, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh) override {
    const auto* r = dynamic_cast<const RecordingCanvas*>(&src);
    const std::string ref = "{\"$c\":" + std::to_string(r != nullptr ? r->id() : -1) + "}";
    call("drawImage", {ref, num(sx), num(sy), num(sw), num(sh), num(dx), num(dy), num(dw), num(dh)});
    // The model: a 1:1 integer blit at identity. Scaled / transformed draws leave the pixels.
    if (r == nullptr || !m_.is_identity() || !detail::modeled(gco_) || sw != dw || sh != dh) return;
    for (const double v : {sx, sy, sw, sh, dx, dy}) {
      if (v != std::floor(v)) return;
    }
    const std::vector<std::uint8_t>& sp = r->px();
    const auto iw = static_cast<long>(r->width());
    const auto ih = static_cast<long>(r->height());
    const std::string op = gco_;
    const double ga = alpha_;
    const std::uint8_t* base = px().data();
    visit_rect(dx, dy, dw, dh, !detail::unbounded(op), [&](std::uint8_t* d, bool inside) {
      const auto p = static_cast<long>((d - base) / 4);
      const long qx = p % static_cast<long>(w_);
      const long qy = p / static_cast<long>(w_);
      const long ux = qx - static_cast<long>(dx) + static_cast<long>(sx);
      const long uy = qy - static_cast<long>(dy) + static_cast<long>(sy);
      if (!inside || ux < 0 || uy < 0 || ux >= iw || uy >= ih) {
        detail::composite_pixel(d, 0, 0, 0, 0, op);
        return;
      }
      const std::size_t s = (static_cast<std::size_t>(uy) * static_cast<std::size_t>(iw) + static_cast<std::size_t>(ux)) * 4;
      detail::composite_pixel(d, sp[s], sp[s + 1], sp[s + 2], (sp[s + 3] / 255.0) * ga, op);
    });
  }

 private:
  struct Saved {
    Mat2D m;
    Style fill, stroke;
    std::string gco;
    double alpha = 1;
  };

  /// Pixels whose centres lie in [x, x + w) × [y, y + h) (`inside`), and — unless `bounded` — all the others too.
  template <class Fn>
  void visit_rect(double x, double y, double w, double h, bool bounded, Fn&& fn) {
    std::vector<std::uint8_t>& p = px();
    for (std::uint32_t py = 0; py < h_; ++py) {
      for (std::uint32_t qx = 0; qx < w_; ++qx) {
        const bool inside = qx + 0.5 >= x && qx + 0.5 < x + w && py + 0.5 >= y && py + 0.5 < y + h;
        if (inside || !bounded) fn(&p[(static_cast<std::size_t>(py) * w_ + qx) * 4], inside);
      }
    }
  }

  static std::string num(double v) { return motion::js::number_to_string(v); }
  static std::string quote(std::string_view s) {
    std::string out = "\"";
    for (const char c : s) {
      if (c == '"' || c == '\\') out += '\\';
      out += c;
    }
    return out + "\"";
  }
  static std::string color(const css::Color& c) {
    return quote("rgba(" + num(c.r) + "," + num(c.g) + "," + num(c.b) + "," + num(c.a) + ")");
  }
  /// A Path2D's commands as the TS RecordingPath2D logs them.
  static std::string path_json(const Path2D& path) {
    std::string out = "[";
    bool first = true;
    for (const auto& c : path.cmds) {
      if (!first) out += ",";
      first = false;
      const auto nums = [&](std::string_view name, std::size_t n) {
        std::string s = "[" + quote(name);
        for (std::size_t i = 0; i < n; ++i) s += "," + num(c.a[i]);
        return s;
      };
      switch (c.op) {
        case Path2D::Op::move: out += nums("moveTo", 2) + "]"; break;
        case Path2D::Op::line: out += nums("lineTo", 2) + "]"; break;
        case Path2D::Op::quad: out += nums("quadraticCurveTo", 4) + "]"; break;
        case Path2D::Op::cubic: out += nums("bezierCurveTo", 6) + "]"; break;
        case Path2D::Op::arc: out += nums("arc", 5) + (c.ccw ? ",true]" : ",false]"); break;
        case Path2D::Op::arcTo: out += nums("arcTo", 5) + "]"; break;
        case Path2D::Op::ellipse: out += nums("ellipse", 7) + (c.ccw ? ",true]" : ",false]"); break;
        case Path2D::Op::rect: out += nums("rect", 4) + "]"; break;
        case Path2D::Op::roundRect: out += nums("roundRect", 4) + "]"; break;
        case Path2D::Op::close: out += "[\"closePath\"]"; break;
      }
    }
    return out + "]";
  }
  std::string style(const Style& s) {
    if (!rec_->log) return {};
    if (s.kind == Style::Kind::gradient && s.gradient) {
      const Gradient* g = s.gradient.get();
      auto it = rec_->grads.find(g);
      if (it == rec_->grads.end()) {
        const int gid = rec_->nextGrad++;
        it = rec_->grads.emplace(g, gid).first;
        rec_->keep.push_back(s.gradient);
        const char* kind = g->kind == Gradient::Kind::radial ? "radial" : g->kind == Gradient::Kind::conic ? "conic" : "linear";
        std::string op = "[" + std::to_string(id_) + ",\"grad\"," + std::to_string(gid) + "," + quote(kind);
        const std::size_t n = g->kind == Gradient::Kind::radial ? 6 : g->kind == Gradient::Kind::linear ? 4 : 3;
        for (std::size_t i = 0; i < n; ++i) op += "," + num(g->p[i]);
        rec_->ops.push_back(op + "]");
        for (const auto& st : g->stops) {
          rec_->ops.push_back("[-1,\"stop\"," + std::to_string(gid) + "," + num(st.offset) + "," + color(st.color) + "]");
        }
      }
      return "{\"$g\":" + std::to_string(it->second) + "}";
    }
    return color(s.color);
  }
  void call(std::string_view name, std::initializer_list<std::string> args) {
    if (!rec_->log) return;
    std::string op = "[" + std::to_string(id_) + ",\"call\"," + quote(name);
    for (const auto& a : args) op += "," + a;
    rec_->ops.push_back(op + "]");
  }
  void set(std::string_view name, const std::string& v) {
    if (!rec_->log) return;
    rec_->ops.push_back("[" + std::to_string(id_) + ",\"set\"," + quote(name) + "," + v + "]");
  }

  std::shared_ptr<Recording> rec_;  // shared: every canvas of one program appends to one log
  std::uint32_t w_, h_;
  int id_;
  CanvasOptions opts_;
  Mat2D m_;
  Style fill_, stroke_;
  double alpha_ = 1;
  std::string gco_ = "source-over";
  std::vector<Saved> stack_;
  mutable std::vector<std::uint8_t> px_;  // lazily sized: a canvas that never holds pixels costs nothing
};

}  // namespace premation::raster::test
