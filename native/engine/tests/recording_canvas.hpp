// A Canvas2D that records its program instead of drawing (tests): the op
// grammar of packages/render-tests/harness/rasterRecorder.ts, normalised the
// way the TS fixture recorders normalise it (drawImage always 9 arguments, arc
// with its ccw flag, fill with its rule, colours as rgba(r,g,b,a), filters as
// 'none' / 'blur(Npx)'), each op one compact JSON string. It tracks the CTM so
// getTransform answers as the TS fake does (same arithmetic, V8's Math).
#pragma once

#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "jsmath.hpp"
#include "numconv.hpp"
#include "raster/canvas.hpp"

namespace premation::raster::test {

struct Recording {
  std::vector<std::string> ops;
  int nextCanvas = 0;
  int nextGrad = 0;
  std::map<const Gradient*, int> grads;
  std::vector<std::shared_ptr<Gradient>> keep;  // pins every recorded gradient: a freed one's address must not be reused
};

class RecordingCanvas final : public Canvas2D {
 public:
  RecordingCanvas(std::shared_ptr<Recording> rec, std::uint32_t w, std::uint32_t h)
      : rec_(std::move(rec)), w_(w), h_(h), id_(rec_->nextCanvas++) {
    rec_->ops.push_back("[" + std::to_string(id_) + ",\"canvas\"," + std::to_string(w) + "," + std::to_string(h) + "]");
  }

  [[nodiscard]] int id() const noexcept { return id_; }

  [[nodiscard]] const CanvasOptions& options() const noexcept override { return opts_; }
  [[nodiscard]] std::uint32_t width() const noexcept override { return w_; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return h_; }
  void resize(std::uint32_t w, std::uint32_t h) override {
    w_ = w;
    h_ = h;
  }
  [[nodiscard]] std::vector<std::uint8_t> pixels() const override { return {}; }
  [[nodiscard]] std::unique_ptr<Canvas2D> create_canvas(std::uint32_t w, std::uint32_t h) const override {
    return std::make_unique<RecordingCanvas>(rec_, w, h);
  }

  void save() override {
    stack_.push_back({m_, fill_, stroke_});
    call("save", {});
  }
  void restore() override {
    if (!stack_.empty()) {
      m_ = stack_.back().m;
      fill_ = stack_.back().fill;
      stroke_ = stack_.back().stroke;
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
  void setImageSmoothing(bool on) override { set("imageSmoothingEnabled", on ? "true" : "false"); }

  bool setFont(std::string_view font) override {
    set("font", quote(font));
    return true;
  }
  [[nodiscard]] std::string font() const override { return {}; }
  void setTextAlign(TextAlign /*a*/) override { call("textAlign", {}); }
  void setTextBaseline(TextBaseline /*b*/) override { call("textBaseline", {}); }
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
  void fill(const Path2D& /*path*/, FillRule /*rule*/) override { call("fillPath2D", {}); }
  void stroke(const Path2D& /*path*/) override { call("strokePath2D", {}); }
  void clip(const Path2D& /*path*/, FillRule /*rule*/) override { call("clipPath2D", {}); }
  void fillRect(double x, double y, double w, double h) override { call("fillRect", {num(x), num(y), num(w), num(h)}); }
  void strokeRect(double x, double y, double w, double h) override { call("strokeRect", {num(x), num(y), num(w), num(h)}); }
  void clearRect(double x, double y, double w, double h) override { call("clearRect", {num(x), num(y), num(w), num(h)}); }
  void fillText(std::string_view t, double x, double y) override { call("fillText", {quote(t), num(x), num(y)}); }
  void strokeText(std::string_view t, double x, double y) override { call("strokeText", {quote(t), num(x), num(y)}); }
  [[nodiscard]] TextMetrics measureText(std::string_view /*text*/) override { return {}; }
  void drawImage(const Canvas2D& src, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh) override {
    const auto* r = dynamic_cast<const RecordingCanvas*>(&src);
    const std::string ref = "{\"$c\":" + std::to_string(r != nullptr ? r->id() : -1) + "}";
    call("drawImage", {ref, num(sx), num(sy), num(sw), num(sh), num(dx), num(dy), num(dw), num(dh)});
  }

 private:
  struct Saved {
    Mat2D m;
    Style fill, stroke;
  };

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
  std::string style(const Style& s) {
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
    std::string op = "[" + std::to_string(id_) + ",\"call\"," + quote(name);
    for (const auto& a : args) op += "," + a;
    rec_->ops.push_back(op + "]");
  }
  void set(std::string_view name, const std::string& v) {
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
};

}  // namespace premation::raster::test
