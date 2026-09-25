// A text / vector raster drawn from its SOURCE (E3): the drawable the TS
// Canvas2DVectorRasterizer received (a TextSpec or a RenderLayer, as JSON —
// RenderRasterSource.specJson), rasterised by the C++ painters that port
// src/core/rendering/raster/{Canvas2DVectorRasterizer,vectorDraw,textPaint}.ts
// call for call onto the C++ Canvas2D.
#pragma once

#include <cstdint>
#include <functional>
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
};

/// A layer's CPU bake (the mask matte + applyEffectChain), run on the raster
/// canvas after its content is painted: (canvas, padded box w, h in layer px,
/// raster scale, unsupported). Supplied by the scene builder (bake_chain.cpp).
using BakeHook = std::function<void(Canvas2D&, double, double, double, std::vector<std::string>&)>;

/// Draw one raster: Canvas2DVectorRasterizer.rasterize's miss path.
/// `resolutionScale` and `padding` are the RasterRequest's.
[[nodiscard]] RasterOutput draw_raster_source(RasterKind kind, std::string_view specJson, double resolutionScale,
                                              double padding, const CanvasOptions& opts, const BakeHook* bake = nullptr);

}  // namespace premation::raster
