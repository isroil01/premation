// Alpha distance fields by jump flooding (see fx_distance.hpp).
#include "fx_distance.hpp"

#include <algorithm>
#include <cmath>

#include "effect_stats.hpp"
#include "fx_cache.hpp"

namespace premation::rg {
namespace {

constexpr wgpu::TextureFormat kFieldFormat = wgpu::TextureFormat::RGBA16Float;

/// One full-buffer quad of `m` reading `tex` (binding 1) and `second` (binding 3).
void pass(PassContext& ctx, Commands& cmds, RenderTarget& dest, Mat m, const TexRef& tex, const TexRef& second, double p0) {
  cmds.clear();
  Packer pk = ctx.packer();
  pk.mat3(screen_mvp()).rect({0, 0, 1, 1}).vec4(p0, 0, 0, 0);
  DrawItem& it = cmds.add(m, Blend::none, pk.span());
  it.texture = tex;
  it.sampler = ctx.nearest_clamp();
  if (second) it.mask = second;
  draw_to_target(ctx, dest, cmds);
}

}  // namespace

void draw_to_target(PassContext& ctx, RenderTarget& t, const Commands& cmds) {
  Attachment att;
  att.target = &t;
  att.clear = true;
  wgpu::RenderPassEncoder rp = ctx.dev.begin_pass(att, t.width, t.height, ctx.surfaceView, ctx.surfaceFormat, nullptr, false);
  if (!cmds.empty()) ctx.dev.execute(rp, cmds, t.format, t.samples);
  rp.End();
}

/// The next power of two at least `asked`, capped at the field maximum. A stroke
/// that grows from 4 px to 6 px stays inside one bucket, so the field built for
/// the first width is reused (fx_cache.hpp).
double field_depth(double asked) {
  double built = 1;
  while (built < asked && built < kMaxSdfRange) built *= 2;
  return built;
}

DistanceField distance_field(PassContext& ctx, const TexRef& src, double range, std::uint64_t key) {
  if (!src || src.width == 0 || src.height == 0) return {};
  const std::uint32_t w = src.width;
  const std::uint32_t h = src.height;
  const double asked = std::clamp(std::ceil(range), 1.0, kMaxSdfRange);
  const double r = field_depth(asked);
  FxCache* cache = ctx.fxCache;
  if (cache != nullptr && key != 0) {
    if (FxCache::Slot* s = cache->find(key, asked, w, h)) {
      bool created = false;
      RenderTarget& t = ctx.dev.target(s->name, w, h, kFieldFormat, 1, false, &created);
      if (!created) {
        s->used = ctx.dev.frame();
        if (ctx.effectStats != nullptr) ++ctx.effectStats->sdfReused;
        return {t.tex(), true};
      }
      cache->forget(*s);  // the pool collected it: rebuild below
    }
  }
  // Reused across fields and frames (render thread only): no allocation once warm.
  thread_local Commands cmds;
  RenderTarget& a = ctx.dev.target("fx-jfa-a", w, h, kFieldFormat, 1, false);
  RenderTarget& b = ctx.dev.target("fx-jfa-b", w, h, kFieldFormat, 1, false);
  RenderTarget* out = nullptr;
  if (cache != nullptr && key != 0) {
    FxCache::Slot& slot = cache->claim(key, r, w, h, ctx.dev.frame());
    out = &ctx.dev.target(slot.name, w, h, kFieldFormat, 1, false);
  } else {
    out = &ctx.dev.target("fx-sdf-frame", w, h, kFieldFormat, 1, false);
  }

  pass(ctx, cmds, a, Mat::SDF_SEED_FX_MATERIAL, src, {}, 0);
  RenderTarget* cur = &a;
  RenderTarget* other = &b;
  double step = 1;
  while (step * 2 <= r) step *= 2;
  // The flood at halving steps, then the "1+JFA" unit step.
  for (bool extra = false;;) {
    pass(ctx, cmds, *other, Mat::SDF_FLOOD_FX_MATERIAL, cur->tex(), {}, step);
    std::swap(cur, other);
    if (step > 1) {
      step /= 2;
    } else if (!extra) {
      extra = true;
    } else {
      break;
    }
  }
  pass(ctx, cmds, *out, Mat::SDF_RESOLVE_FX_MATERIAL, cur->tex(), src, 0);
  if (ctx.effectStats != nullptr) ++ctx.effectStats->sdfBuilt;
  return {out->tex(), false};
}

}  // namespace premation::rg
