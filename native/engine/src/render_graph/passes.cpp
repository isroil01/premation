// Clear, Background and Effect passes + the default graph wiring
// (rendergraph/passes/{ClearPass,BackgroundPass,EffectPass,index}.ts).
#include "passes.hpp"

#include <algorithm>
#include <string>

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
    if (ctx.file.view.viewer_lut_active) {
      error = "viewer LUT blit is not ported (viewport-only; exports never set it)";
      return false;
    }
    // emitSceneBlit: REPLACE (blend none), linear → display encode in the shader.
    cmds_.clear();
    DrawItem& it = cmds_.add(Mat::SCENE_BLIT_MATERIAL, Blend::none,
                             pack_textured(ctx.packer(), screen_mvp(), {0, 0, 1, 1}, Color::white(), 1));
    it.texture = src->tex();
    it.sampler = ctx.linear_clamp();
    ctx.draw_into(kSurface, cmds_, false);
    return true;
  }

 private:
  Commands cmds_;
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

std::unique_ptr<RenderGraph> build_default_graph() {
  auto g = std::make_unique<RenderGraph>();
  g->add_pass(make_clear_pass());
  g->add_pass(make_background_pass());
  g->add_pass(make_composition_pass());
  g->add_pass(make_effect_pass());
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
