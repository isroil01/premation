#include "raster_source.hpp"

#include <algorithm>
#include <cmath>

#include "json.hpp"
#include "mask_paint.hpp"
#include "paint_common.hpp"
#include "paint_raster.hpp"
#include "text_paint.hpp"
#include "vector_paint.hpp"

namespace premation::raster {
namespace {

constexpr double kSupersample = 2;
constexpr double kMaxRasterDim = 4096;
constexpr double kDefaultMaxRasterDimension = 8192;

/// Canvas2DVectorRasterizer.supersampleFor.
double supersample_for(double tier, double boxW, double boxH, bool bake, double deviceMax) {
  const double want = bake ? tier : tier * kSupersample;
  const double longest = std::max({1.0, boxW, boxH});
  const double cap = bake ? std::min(kMaxRasterDim, deviceMax) : deviceMax;
  return std::min(want, cap / longest);
}

}  // namespace

RasterOutput draw_raster_source(RasterKind kind, std::string_view specJson, double resolutionScale, double padding,
                                const CanvasOptions& opts, const BakeHook* bakeHook) {
  RasterOutput out;
  json::Value spec;
  if (!json::parse(specJson, spec, out.error)) return out;
  if (kind == RasterKind::mask) {
    // Canvas2DVectorRasterizer.drawMask.
    const double w = spec["width"].num(std::nan(""));
    const double h = spec["height"].num(std::nan(""));
    const double ss = std::min(2.0, kMaxRasterDim / std::max({1.0, w, h}));
    out.width = static_cast<std::uint32_t>(std::max(1.0, js_round(w * ss)));
    out.height = static_cast<std::uint32_t>(std::max(1.0, js_round(h * ss)));
    const auto ctx = Canvas2D::make(out.width, out.height, opts);
    ctx->scale(ss, ss);
    ctx->translate(w / 2, h / 2);
    paint_mask_matte(*ctx, spec["mask"], w, h, out.unsupported);
    out.rgba = ctx->pixels();
    out.ok = true;
    return out;
  }
  const bool bake = spec["__baked"].truthy();
  if (bake && bakeHook == nullptr) out.unsupported.emplace_back("CPU-baked effect chain / fill opacity (applyEffectChain, E4)");
  const double deviceMax = spec["__deviceMax"].is_number() ? spec["__deviceMax"].num() : kDefaultMaxRasterDimension;
  const double w0 = spec["width"].num(std::nan(""));
  const double h0 = spec["height"].num(std::nan(""));
  const double bw = w0 + 2 * padding;
  const double bh = h0 + 2 * padding;
  const double ss = supersample_for(resolutionScale, bw, bh, bake, deviceMax);
  const auto w = static_cast<std::uint32_t>(std::max(1.0, js_round(bw * ss)));
  const auto h = static_cast<std::uint32_t>(std::max(1.0, js_round(bh * ss)));
  const auto ctx = Canvas2D::make(w, h, opts);
  if (bake) ctx->set_will_read_frequently(true);  // bakeContextOptions(bake)
  ctx->scale(ss, ss);
  if (kind == RasterKind::text) {
    ctx->translate(padding, padding);
    paint_text_in_box(*ctx, spec, out.unsupported);
    if (has_paint_strokes(spec["paint"])) {
      // Paint over the glyphs, before the bake's mask and chain — the path
      // raster's order. Strokes live in the box's CENTRED space.
      ctx->save();
      ctx->translate(w0 / 2, h0 / 2);
      draw_paint(*ctx, spec["paint"]);
      ctx->restore();
    }
  } else {
    ctx->translate(bw / 2, bh / 2);
    paint_path_layer(*ctx, spec, out.unsupported);
  }
  // finishBake / drawPath's bake branch: the mask matte, then the effect chain.
  if (bake && bakeHook != nullptr) (*bakeHook)(*ctx, bw, bh, ss, out.unsupported);
  out.width = w;
  out.height = h;
  out.rgba = ctx->pixels();
  out.ok = true;
  std::ranges::sort(out.unsupported);
  const auto dup = std::ranges::unique(out.unsupported);
  out.unsupported.erase(dup.begin(), dup.end());
  return out;
}

}  // namespace premation::raster
