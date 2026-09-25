// A text / vector raster drawn from its SOURCE (E3): the drawable the TS
// Canvas2DVectorRasterizer received (a TextSpec or a RenderLayer, as JSON —
// RenderRasterSource.specJson), rasterised by the C++ painters that port
// src/core/rendering/raster/{Canvas2DVectorRasterizer,vectorDraw,textPaint}.ts
// call for call onto the C++ Canvas2D.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "canvas.hpp"

namespace premation::raster {

enum class RasterKind : std::uint8_t { text, path, mask };

struct RasterOutput {
  bool ok = false;
  std::string error;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  // premultiplied RGBA8
  /// Features of the spec the C++ painters do not draw yet (each once).
  std::vector<std::string> unsupported;
  /// Where the time went (ms, this thread): painting the content, the bake
  /// (mask matte + effect chain), the read-back of the pixels.
  double contentMs = 0;
  double bakeMs = 0;
  double readMs = 0;
};

/// A layer's CPU bake (the mask matte + applyEffectChain), run on the raster
/// canvas after its content is painted: (canvas, padded box w, h in layer px,
/// raster scale, unsupported). Supplied by the scene builder (bake_chain.cpp).
using BakeHook = std::function<void(Canvas2D&, double, double, double, std::vector<std::string>&)>;

/// A baked raster's CONTENT — its canvas as painted, before the bake — kept by
/// the caller so a re-bake (the stack's params or fill opacity changed, the
/// content did not) starts from a copy instead of repainting. The caller keys
/// it by everything the painters read (the drawable without its effects, fill
/// opacity and mask, × kind × scale × padding).
struct BakedContent {
  std::unique_ptr<Canvas2D> canvas;
  std::vector<std::string> unsupported;  ///< what painting it reported
  mutable std::mutex m;                  ///< one clone at a time (raster workers share the cache)
};
struct ContentReuse {
  /// A cached content for this raster (read-only; copied with Canvas2D::clone), or null.
  const BakedContent* cached = nullptr;
  /// Out: the content this draw painted (when `cached` was null or unusable), for the caller to keep.
  std::shared_ptr<BakedContent> painted;
};

/// Draw one raster: Canvas2DVectorRasterizer.rasterize's miss path.
/// `resolutionScale` and `padding` are the RasterRequest's. `reuse` (baked
/// rasters only) supplies / receives the painted content.
[[nodiscard]] RasterOutput draw_raster_source(RasterKind kind, std::string_view specJson, double resolutionScale,
                                              double padding, const CanvasOptions& opts, const BakeHook* bake = nullptr,
                                              ContentReuse* reuse = nullptr);

}  // namespace premation::raster
