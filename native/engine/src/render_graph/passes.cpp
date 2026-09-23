// Clear, Background, Effect and Overlay passes + the default graph wiring
// (rendergraph/passes/{ClearPass,BackgroundPass,EffectPass,OverlayPass,index}.ts).
#include "passes.hpp"

#include <algorithm>
#include <cmath>
#include <string>

#include "color/color_system.hpp"
#include "render_context.hpp"

namespace premation::rg {
namespace {

class ClearPass final : public RenderPass {
 public:
  [[nodiscard]] std::string_view name() const override { return "clear"; }
  [[nodiscard]] std::vector<std::string> writes() const override { return {std::string(kSceneColor)}; }
  bool execute(PassContext& ctx, std::string& /*error*/) override {
    // toWorkingColor(overlays.background).
    const Color c = to_working(color_of(ctx.file.view.clear_color), ctx.color);
    Attachment att;
    att.target = ctx.target(ctx.activeColorTarget);
    att.clear = true;
    att.clear_r = c.r;
    att.clear_g = c.g;
    att.clear_b = c.b;
    att.clear_a = c.a;
    const bool surface = att.target == nullptr;
    wgpu::RenderPassEncoder p = ctx.dev.begin_pass(att, ctx.viewport.pixelWidth, ctx.viewport.pixelHeight, ctx.surfaceView,
                                                   ctx.surfaceFormat, surface && ctx.surfaceScissor ? &*ctx.surfaceScissor : nullptr,
                                                   false);
    p.End();
    return true;
  }
};

class BackgroundPass final : public RenderPass {
 public:
  [[nodiscard]] std::string_view name() const override { return "background"; }
  [[nodiscard]] std::vector<std::string> writes() const override { return {std::string(kSceneColor)}; }
  [[nodiscard]] std::vector<std::string> after() const override { return {"clear"}; }
  bool execute(PassContext& ctx, std::string& /*error*/) override {
    const auto& scene = ctx.file.scene;
    const Color bg = scene.background ? color_of(*scene.background) : Color{1, 1, 1, 1};
    const Mat3 mvp = mvp_for(ctx.viewport, model_from_rect({0, 0, scene.width, scene.height}));
    cmds_.clear();
    cmds_.add(Mat::SOLID_MATERIAL, Blend::normal, pack_solid(ctx.packer(), mvp, bg, 1));
    ctx.draw_into(ctx.activeColorTarget, cmds_, false);
    return true;
  }

 private:
  Commands cmds_;
};

class EffectPass final : public RenderPass {
 public:
  [[nodiscard]] std::string_view name() const override { return "effect"; }
  [[nodiscard]] std::vector<std::string> reads() const override { return {std::string(kSceneColor)}; }
  [[nodiscard]] std::vector<std::string> after() const override { return {"composition"}; }
  bool execute(PassContext& ctx, std::string& error) override {
    RenderTarget* src = ctx.target(kSceneColor);
    if (src == nullptr) {
      error = "no scene-color target";
      return false;
    }
    // The viewer/monitor LUT (EffectPass: meta set AND the strip uploaded + ready).
    const api::RenderViewerLut* lutMeta =
        ctx.file.view.viewer_lut_active && ctx.file.view.viewer_lut ? &*ctx.file.view.viewer_lut : nullptr;
    const TexRef lutTex = lutMeta != nullptr && ctx.texture_ready(kViewerLutKey) ? ctx.texture(kViewerLutKey) : TexRef{};
    cmds_.clear();
    if (ctx.colorSystem != nullptr && ctx.colorSystem->active()) {
      // D3: working → display/output through the OCIO program, then the viewer LUT.
      ctx.colorSystem->emit_display(ctx, cmds_, src->tex(), lutTex, lutMeta);
    } else if (lutMeta != nullptr && lutTex) {
      // emitSceneBlit with a viewer LUT: scene-blit-lut, packSceneBlitLut.
      ColorTransform ct;
      ct.m = {lutMeta->is1d ? -static_cast<double>(lutMeta->size) : static_cast<double>(lutMeta->size),
              lutMeta->intensity, lutMeta->domain_min, 0, 1, 0, 0, 0, 1};
      ct.offset = {lutMeta->domain_max, 0, 0};
      DrawItem& it = cmds_.add(Mat::SCENE_BLIT_LUT_MATERIAL, Blend::none,
                               pack_textured(ctx.packer(), screen_mvp(), {0, 0, 1, 1}, Color::white(), 1, ct, false));
      it.texture = src->tex();
      it.sampler = ctx.linear_clamp();
      it.mask = lutTex;
    } else {
      // emitSceneBlit: REPLACE (blend none), linear → display encode in the shader.
      DrawItem& it = cmds_.add(Mat::SCENE_BLIT_MATERIAL, Blend::none,
                               pack_textured(ctx.packer(), screen_mvp(), {0, 0, 1, 1}, Color::white(), 1));
      it.texture = src->tex();
      it.sampler = ctx.linear_clamp();
    }
    ctx.draw_into(kSurface, cmds_, false);
    return true;
  }

 private:
  Commands cmds_;
};

/// OverlayPass.ts `gridLines`, operation for operation (the loops accumulate in
/// double exactly as the JS numbers do, so the same lines land on the same pixels).
void grid_lines(std::vector<Rect>& lines, const Rect& view, double spacing, double t, std::size_t max,
                api::RenderGridStyle style, double skipMultiplesOf) {
  const double startX = std::floor(view.x / spacing) * spacing;
  const double startY = std::floor(view.y / spacing) * spacing;
  const auto onMajor = [skipMultiplesOf](double v) {
    if (skipMultiplesOf == 0) return false;
    const double m = std::abs(v / skipMultiplesOf);
    return std::abs(m - std::floor(m + 0.5)) < 1e-6;
  };
  const std::size_t base = lines.size();
  const auto count = [&] { return lines.size() - base; };
  if (style == api::RenderGridStyle::dots) {
    const double s = t * 2;
    for (double x = startX; x <= view.x + view.width && count() < max; x += spacing) {
      for (double y = startY; y <= view.y + view.height && count() < max; y += spacing) {
        if (onMajor(x) && onMajor(y)) continue;
        lines.push_back({x - s / 2, y - s / 2, s, s});
      }
    }
    return;
  }
  const double dash = style == api::RenderGridStyle::dashed ? spacing / 8 : 0;
  for (double x = startX; x <= view.x + view.width && count() < max; x += spacing) {
    if (onMajor(x)) continue;
    if (dash > 0) {
      for (double y = std::floor(view.y / (dash * 2)) * (dash * 2); y <= view.y + view.height && count() < max; y += dash * 2) {
        lines.push_back({x, y, t, dash});
      }
    } else {
      lines.push_back({x, view.y, t, view.height});
    }
  }
  for (double y = startY; y <= view.y + view.height && count() < max; y += spacing) {
    if (onMajor(y)) continue;
    if (dash > 0) {
      for (double x = std::floor(view.x / (dash * 2)) * (dash * 2); x <= view.x + view.width && count() < max; x += dash * 2) {
        lines.push_back({x, y, dash, t});
      }
    } else {
      lines.push_back({view.x, y, view.width, t});
    }
  }
}

/// OverlayPass.ts: the grid, the proportional grid and user guides — editor
/// chrome drawn straight onto the surface after the scene blit. Colours go
/// through packSolid (to_working) exactly as the TS pass sends them, i.e. as
/// linearised values into the display-referred surface.
class OverlayPass final : public RenderPass {
 public:
  [[nodiscard]] std::string_view name() const override { return "overlay"; }
  [[nodiscard]] std::vector<std::string> writes() const override { return {std::string(kSurface)}; }
  [[nodiscard]] std::vector<std::string> after() const override { return {"composition", "effect"}; }
  bool execute(PassContext& ctx, std::string& /*error*/) override {
    if (!ctx.file.view.overlays_active || !ctx.file.view.overlays) return true;
    const api::RenderOverlays& o = *ctx.file.view.overlays;
    if (!o.grid && !o.proportional_grid && o.guides.empty()) return true;
    const ViewportState& vp = ctx.viewport;
    const Rect view = vp.visibleWorldRect;
    const double dpr = vp.dpr != 0 ? vp.dpr : 1;
    const double effDpr = std::min(1.0, dpr);
    const double t = 1 / (vp.zoom * effDpr);
    const Color major = o.grid_color ? color_of(*o.grid_color) : Color{1, 1, 1, 0.06};
    const Color minor{major.r, major.g, major.b, major.a * kMinorAlpha};
    cmds_.clear();
    const auto emit = [&](const std::vector<Rect>& rects, const Color& c) {
      for (const Rect& r : rects) cmds_.add(Mat::SOLID_MATERIAL, Blend::normal, pack_solid(ctx.packer(), mvp_for(vp, model_from_rect(r)), c, 1));
    };
    if (o.grid && o.grid_spacing > 0) {
      const auto px = [&](double worldStep) { return worldStep * vp.zoom * dpr; };
      const double subs = std::max(1.0, std::floor(o.grid_subdivisions + 0.5));
      if (subs > 1 && px(o.grid_spacing / subs) >= kMinMinorPx) {
        lines_.clear();
        grid_lines(lines_, view, o.grid_spacing / subs, t, kMaxLines, o.grid_style, o.grid_spacing);
        emit(lines_, minor);
      }
      if (px(o.grid_spacing) >= kMinMajorPx) {
        lines_.clear();
        grid_lines(lines_, view, o.grid_spacing, t, kMaxLines, o.grid_style, 0);
        emit(lines_, major);
      }
    }
    if (o.proportional_grid && o.comp_rect) {
      // proportionalLines: interior divisions only.
      const Rect comp = rect_of(*o.comp_rect);
      const double cols = std::max(1.0, std::floor(o.proportional_columns + 0.5));
      const double rows = std::max(1.0, std::floor(o.proportional_rows + 0.5));
      lines_.clear();
      for (double i = 1; i < cols; ++i) lines_.push_back({comp.x + (comp.width * i) / cols, comp.y, t, comp.height});
      for (double i = 1; i < rows; ++i) lines_.push_back({comp.x, comp.y + (comp.height * i) / rows, comp.width, t});
      emit(lines_, major);
    }
    for (const api::RenderGuide& g : o.guides) {
      const Rect line = g.axis == api::RenderGuideAxis::x ? Rect{g.position, view.y, t, view.height}
                                                         : Rect{view.x, g.position, view.width, t};
      const Color c = g.color ? color_of(*g.color) : Color{0.23, 0.51, 0.96, 0.8};
      cmds_.add(Mat::SOLID_MATERIAL, Blend::normal, pack_solid(ctx.packer(), mvp_for(vp, model_from_rect(line)), c, 1));
    }
    if (cmds_.empty()) return true;
    ctx.draw_into(kSurface, cmds_, false);
    return true;
  }

 private:
  static constexpr std::size_t kMaxLines = 2000;
  static constexpr double kMinorAlpha = 0.45;
  static constexpr double kMinMinorPx = 4;
  static constexpr double kMinMajorPx = 2;
  Commands cmds_;
  std::vector<Rect> lines_;
};

TargetDeclFn full(std::string format, bool depth = false, std::uint32_t samples = 1) {
  return [format = std::move(format), depth, samples](std::uint32_t w, std::uint32_t h) {
    return TargetDesc{w, h, format, depth, samples};
  };
}

TargetDeclFn scaled(std::uint32_t divisor) {
  return [divisor](std::uint32_t w, std::uint32_t h) {
    return TargetDesc{std::max(1U, w / divisor), std::max(1U, h / divisor), "rgba16float", false, 1};
  };
}

}  // namespace

std::unique_ptr<RenderPass> make_clear_pass() { return std::make_unique<ClearPass>(); }
std::unique_ptr<RenderPass> make_background_pass() { return std::make_unique<BackgroundPass>(); }
std::unique_ptr<RenderPass> make_effect_pass() { return std::make_unique<EffectPass>(); }
std::unique_ptr<RenderPass> make_overlay_pass() { return std::make_unique<OverlayPass>(); }

std::unique_ptr<RenderGraph> build_default_graph() {
  auto g = std::make_unique<RenderGraph>();
  g->add_pass(make_clear_pass());
  g->add_pass(make_background_pass());
  g->add_pass(make_composition_pass());
  g->add_pass(make_effect_pass());
  g->add_pass(make_overlay_pass());
  // passes/index.ts declarations, same names, formats, MSAA and depth.
  g->declare_target(std::string(kSceneColor), full("rgba16float", true, kMsaaSamples));
  for (const std::string_view n : {kLayerTarget, kBlur1, kBlur2, kBlur3}) g->declare_target(std::string(n), full("rgba16float"));
  g->declare_target(std::string(kMatteTarget), full("rgba8unorm"));
  g->declare_target(std::string(kBackdropHalf1), scaled(kBackdropDownscale));
  g->declare_target(std::string(kBackdropHalf2), scaled(kBackdropDownscale));
  g->declare_target("plugin-half1", scaled(2));
  g->declare_target("plugin-half2", scaled(2));
  g->declare_target("plugin-quarter1", scaled(4));
  g->declare_target("plugin-quarter2", scaled(4));
  g->declare_target(std::string(kGeneratorTarget), full("rgba16float"));
  g->declare_target(std::string(kPluginOrigin), full("rgba16float"));
  g->declare_target(std::string(kDofTarget), full("rgba16float", true, 1));
  for (const std::string_view n : {kFxHist, kFxLut}) {
    g->declare_target(std::string(n), [](std::uint32_t, std::uint32_t) { return TargetDesc{256, 1, "rgba16float", false, 1}; });
  }
  for (const std::string_view n : kPrecompTargets) g->declare_target(std::string(n), full("rgba16float", true, kMsaaSamples));
  return g;
}

}  // namespace premation::rg
