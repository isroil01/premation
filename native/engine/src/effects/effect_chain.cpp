// The bake chain (see effect_chain.hpp): effectBake.ts applyEffectChain and
// bakeWorkerCore.ts runBakeJob, step for step — the same Canvas2D calls in the
// same order, so the program is the TS's and the pixels are the kernels'.

#include "effect_chain.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <utility>

#include "canvas_effects.hpp"
#include "raster/mask_paint.hpp"

namespace premation::effects {
namespace {

using raster::Canvas2D;
using raster::json::Value;

/// Canvas-drawn effects the chain cannot draw yet (canvas2dEffects.ts cases with
/// no port in canvas_effects.cpp). Reported, never drawn wrong.
constexpr std::array<std::string_view, 18> kUnportedCanvas{
    "stroke",   "four-color-gradient", "inner-shadow", "inner-glow",  "satin",          "bevel",
    "directional-blur", "transform", "beam",       "lens-flare",  "cc-repetile",    "vegas",
    "numbers",  "timecode",            "audio-spectrum", "audio-waveform", "lightning", "plexus",
};

/// effectBake.ts DRAWN_CANVAS_EFFECTS: the batch lands before (and is dropped after) these.
constexpr std::array<std::string_view, 24> kDrawn{
    "four-color-gradient", "beam",       "inner-shadow", "inner-glow", "satin",          "directional-blur",
    "linear-wipe",         "transform",  "checkerboard", "grid",       "lens-flare",     "numbers",
    "timecode",            "audio-spectrum", "circle",   "ellipse",    "radio-waves",    "lightning",
    "light-rays",          "light-sweep", "audio-waveform", "fill",    "stroke",         "vegas",
};

bool contains(std::span<const std::string_view> set, std::string_view t) { return std::ranges::find(set, t) != set.end(); }

bool is_canvas_drawn_ported(std::string_view type) { return contains(ported_canvas_effects(), type); }

bool has_canvas2d_implementation(std::string_view type) {
  return is_pixel_effect(type) || is_canvas_drawn_ported(type) || contains(kUnportedCanvas, type);
}

/// A copy of a mask path with `mode` replaced (the scoped blend paints `{...path, mode: 'add'}`).
Value with_mode(const Value& path, std::string_view mode) {
  Value out = Value::make_object();
  for (std::size_t i = 0; i < path.keys().size(); ++i) {
    if (path.keys()[i] != "mode") out.set(path.keys()[i], path.items()[i]);
  }
  out.set("mode", Value::make_string(std::string(mode)));
  return out;
}

raster::Style color(double r, double g, double b) {
  raster::Style s;
  s.color = raster::css::Color{r, g, b, 1};
  return s;
}

void draw_whole(Canvas2D& dst, const Canvas2D& src) {
  const double w = src.width();
  const double h = src.height();
  dst.drawImage(src, 0, 0, w, h, 0, 0, w, h);
}

class Chain final {
 public:
  Chain(Canvas2D& oc, int w, int h, ThreadPool* pool, ChainReport& report) : oc_(oc), w_(w), h_(h), pool_(pool), report_(report) {}

  void run(const Value& effects, double fill_opacity, const Value* masks) {
    masks_ = masks;
    // FILL OPACITY: snapshot the silhouette, fade the contents with a flat destination-in.
    const bool fading = fill_opacity < 1;
    if (fading) {
      silhouette_ = scratch();
      Canvas2D& cc = *silhouette_;
      cc.setTransform({});
      (void)cc.setGlobalCompositeOperation("source-over");
      cc.setGlobalAlpha(1);
      filter(cc, "none");
      cc.clearRect(0, 0, w_, h_);
      draw_whole(cc, oc_);
      oc_.save();
      oc_.setTransform({});
      (void)oc_.setGlobalCompositeOperation("destination-in");
      oc_.setGlobalAlpha(std::max(0.0, std::min(1.0, fill_opacity)));
      oc_.setFillStyle(color(0, 0, 0));
      oc_.fillRect(0, 0, w_, h_);
      oc_.restore();
    }
    for (const Value& e : effects.items()) {
      if (e["enabled"].is_bool() && !e["enabled"].truthy()) continue;
      const Value* scope = nullptr;
      const Value& mask_id = e["maskId"];
      if (mask_id.truthy() && masks_ != nullptr) {
        for (const Value& p : (*masks_)["paths"].items()) {
          if (p["id"].is_string() && mask_id.is_string() && p["id"].str() == mask_id.str()) {
            scope = &p;
            break;
          }
        }
      }
      // effectOpacityOf: a finite number → clamp(pct / 100), else 1.
      const Value& op = e["opacity"];
      const double alpha = op.is_number() && std::isfinite(op.num()) ? std::max(0.0, std::min(1.0, op.num() / 100)) : 1;
      if (scope != nullptr || alpha < 1) {
        if (scope == nullptr && alpha <= 0) continue;
        flush_css();
        const std::unique_ptr<Canvas2D> before = snapshot();
        apply_one(e);
        flush_css();
        composite_blend(*before, scope, alpha);
        continue;
      }
      apply_one(e);
    }
    flush_css();
    flush_batch();
  }

 private:
  // ── the batched ImageData (effectBake.ts: getImageData / putImageData intercepted on `oc`) ──
  class Pass final : public PixelPass {
   public:
    explicit Pass(Chain& c) : c_(c) {}
    RgbaView frame() override {
      c_.oc_.setTransform({});
      c_.materialise();
      touched_ = true;
      return RgbaView{c_.batch_, c_.w_, c_.h_};
    }
    [[nodiscard]] ThreadPool* pool() const override { return c_.pool_; }
    [[nodiscard]] int w() const override { return c_.w_; }
    [[nodiscard]] int h() const override { return c_.h_; }
    [[nodiscard]] bool touched() const { return touched_; }

   private:
    Chain& c_;
    bool touched_ = false;
  };

  void materialise() {
    if (!has_batch_) {
      batch_ = oc_.getImageData(0, 0, static_cast<std::uint32_t>(w_), static_cast<std::uint32_t>(h_));
      has_batch_ = true;
    }
  }
  void flush_batch() {
    if (has_batch_ && dirty_) oc_.putImageData(batch_, static_cast<std::uint32_t>(w_), static_cast<std::uint32_t>(h_), 0, 0);
    has_batch_ = false;
    dirty_ = false;
  }
  /// One pixel pass: `fn` gets the pass; the frame is written back (marked dirty) iff it was read.
  template <class Fn>
  void pixel_pass(Fn&& fn) {
    Pass pass(*this);
    fn(pass);
    if (pass.touched()) dirty_ = true;
  }

  void filter(Canvas2D& c, std::string_view css) {
    if (!c.setFilterString(css)) report_.unsupported.push_back("CSS filter '" + std::string(css) + "' (the Skia canvas draws blur() only)");
  }

  [[nodiscard]] std::unique_ptr<Canvas2D> scratch() const {
    return oc_.create_canvas(static_cast<std::uint32_t>(w_), static_cast<std::uint32_t>(h_));
  }

  void flush_css() {
    flush_batch();
    if (pending_.empty()) return;
    const std::unique_ptr<Canvas2D> tmp = scratch();
    tmp->setTransform({});
    (void)tmp->setGlobalCompositeOperation("source-over");
    filter(*tmp, "none");
    tmp->clearRect(0, 0, w_, h_);
    draw_whole(*tmp, oc_);
    oc_.setTransform({});
    (void)oc_.setGlobalCompositeOperation("source-over");
    oc_.clearRect(0, 0, w_, h_);
    std::string joined;
    for (const auto& f : pending_) {
      if (!joined.empty()) joined += ' ';
      joined += f;
    }
    filter(oc_, joined);
    draw_whole(oc_, *tmp);
    filter(oc_, "none");
    pending_.clear();
  }

  [[nodiscard]] std::unique_ptr<Canvas2D> snapshot() {
    flush_batch();
    std::unique_ptr<Canvas2D> c = scratch();
    c->setTransform({});
    c->clearRect(0, 0, w_, h_);
    draw_whole(*c, oc_);
    return c;
  }

  /// out = before·(1 − cov) + after·cov (effectBake.ts compositeBlend).
  void composite_blend(const Canvas2D& before, const Value* path, double alpha) {
    flush_batch();
    if (path == nullptr) {
      const double a = std::max(0.0, std::min(1.0, alpha));
      oc_.save();
      oc_.setTransform({});
      filter(oc_, "none");
      (void)oc_.setGlobalCompositeOperation("destination-in");
      oc_.setGlobalAlpha(a);
      oc_.setFillStyle(color(0, 0, 0));
      oc_.fillRect(0, 0, w_, h_);
      (void)oc_.setGlobalCompositeOperation("lighter");
      oc_.setGlobalAlpha(1 - a);
      draw_whole(oc_, before);
      oc_.restore();
      return;
    }
    const std::unique_ptr<Canvas2D> cov = scratch();
    Canvas2D& cc = *cov;
    cc.setTransform({});
    cc.clearRect(0, 0, w_, h_);
    cc.translate(w_ / 2.0, h_ / 2.0);
    Value mask = Value::make_object();
    Value paths = Value::make_array();
    paths.push(with_mode(*path, "add"));
    mask.set("paths", std::move(paths));
    raster::paint_mask_matte(cc, mask, w_, h_, report_.unsupported);
    if (alpha < 1) {
      cc.setTransform({});
      (void)cc.setGlobalCompositeOperation("destination-in");
      cc.setGlobalAlpha(std::max(0.0, alpha));
      cc.setFillStyle(color(0, 0, 0));
      cc.fillRect(0, 0, w_, h_);
      (void)cc.setGlobalCompositeOperation("source-over");
      cc.setGlobalAlpha(1);
    }
    const std::unique_ptr<Canvas2D> after = scratch();
    Canvas2D& ac = *after;
    ac.setTransform({});
    ac.clearRect(0, 0, w_, h_);
    draw_whole(ac, oc_);
    (void)ac.setGlobalCompositeOperation("destination-in");
    draw_whole(ac, cc);
    oc_.setTransform({});
    (void)oc_.setGlobalCompositeOperation("source-over");
    filter(oc_, "none");
    oc_.clearRect(0, 0, w_, h_);
    draw_whole(oc_, before);
    (void)oc_.setGlobalCompositeOperation("destination-out");
    draw_whole(oc_, cc);
    (void)oc_.setGlobalCompositeOperation("source-over");
    draw_whole(oc_, ac);
  }

  void apply_one(const Value& e) {
    const std::string& type = e["type"].str();
    const Value& p = e["params"];
    if (is_lut_effect(type)) {
      flush_css();
      const ChannelLut lut = build_channel_lut(type, p);
      pixel_pass([&](PixelPass& pass) { apply_channel_lut(pass.frame(), lut, pool_); });
      return;
    }
    if (std::string css = effect_css(type, p); !css.empty()) {
      pending_.push_back(std::move(css));
      return;
    }
    if (is_color_matrix_effect(type)) {
      flush_css();
      const ColorMatrix cm = effect_color_matrix(type, p);
      pixel_pass([&](PixelPass& pass) { apply_color_matrix_image(pass.frame(), cm, pool_); });
      return;
    }
    if (is_procedural_effect(type)) {
      flush_css();
      flush_batch();
      apply_procedural_effect(type, p, oc_, w_, h_, noise_);
      return;
    }
    if (type.find('.') != std::string::npos) {  // isPluginEffectType
      flush_css();
      flush_batch();
      report_.unported.push_back(type + ": plugin effect (the G1 SDK runs plugins; no CPU twin in the chain)");
      return;
    }
    if (has_canvas2d_implementation(type)) {
      flush_css();
      const bool drawn = contains(kDrawn, type);
      if (drawn) flush_batch();
      if (is_pixel_effect(type)) {
        pixel_pass([&](PixelPass& pass) { (void)apply_pixel_effect(type, p, pass); });
      } else if (!run_canvas_effect(type, p, oc_, w_, h_)) {
        report_.unported.push_back(type + ": canvas-drawn effect not ported to raster::Canvas2D yet");
      }
      if (drawn) flush_batch();
    }
    // else: a gpuOnly non-colour effect (displacement-map, motion-tile) has no CPU form, as in the TS.
  }

  Canvas2D& oc_;
  int w_;
  int h_;
  ThreadPool* pool_;
  ChainReport& report_;
  const Value* masks_ = nullptr;
  std::vector<std::string> pending_;
  std::vector<std::uint8_t> batch_;
  bool has_batch_ = false;
  bool dirty_ = false;
  std::unique_ptr<Canvas2D> silhouette_;
  std::unique_ptr<Canvas2D> noise_;
};

}  // namespace

void apply_effect_chain(Canvas2D& oc, int w, int h, const Value& effects, double fill_opacity, const Value* masks, ThreadPool* pool,
                        ChainReport& report) {
  Chain(oc, w, h, pool, report).run(effects, fill_opacity, masks);
}

std::vector<std::uint8_t> run_bake_job(Canvas2D& canvas, std::span<const std::uint8_t> pixels, const Value& effects, double fill_opacity,
                                       const Value* masks, ThreadPool* pool, ChainReport& report) {
  const auto w = canvas.width();
  const auto h = canvas.height();
  canvas.setTransform({});
  canvas.clearRect(0, 0, w, h);
  canvas.putImageData(pixels, w, h, 0, 0);
  apply_effect_chain(canvas, static_cast<int>(w), static_cast<int>(h), effects, fill_opacity, masks, pool, report);
  return canvas.getImageData(0, 0, w, h);
}

std::string_view effect_route(const Value& e) {
  const std::string& type = e["type"].str();
  const Value& p = e["params"];
  if (is_lut_effect(type)) return "lut";
  if (!effect_css(type, p).empty()) return "css";
  if (is_color_matrix_effect(type)) return "color";
  if (is_procedural_effect(type)) return "procedural";
  if (has_canvas2d_implementation(type)) return "canvas2d";
  return "none";
}

std::span<const std::string_view> chain_pixel_effects() noexcept {
  static const std::vector<std::string_view> all = [] {
    std::vector<std::string_view> v(pixel_effect_types().begin(), pixel_effect_types().end());
    const auto drawn = ported_canvas_effects();
    v.insert(v.end(), drawn.begin(), drawn.end());
    return v;
  }();
  return all;
}

std::span<const std::string_view> chain_unported_canvas_effects() noexcept { return kUnportedCanvas; }

}  // namespace premation::effects
