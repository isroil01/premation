// SVG in the scene builder (D2w):
//   svg_layer_source   svgLayer.ts readSvgLayer + svgLayerSrc — an SVG LAYER's
//                      stored document as the `data:` URL the texture feed
//                      rasterises (buildSnapshot sends kind 'svg' down the image path)
//   is_svg_src /
//   rasterize_svg_src  AppTextureProvider's SVG branch — `data:image/svg+xml`
//                      and `.svg` sources drawn by the C++ SVG renderer
//                      (raster/svg_render.hpp) at rasterizeSvg's size
#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "raster_source.hpp"
#include "svg_render.hpp"

namespace premation::scene {

struct SvgLayerSource {
  /// The render source; nullopt when the node carries no stored document
  /// (the TS then falls back to the node's own `src`).
  std::optional<std::string> src;
  /// Why the layer is not ported (reported, the frame falls back).
  std::vector<std::string> unported;
};

/// `svgLayerSrc(node)` for an SVG layer.
[[nodiscard]] SvgLayerSource svg_layer_source(const doc::Node& n);

/// AppTextureProvider's `isSvgBlob` test on a media src.
[[nodiscard]] bool is_svg_src(std::string_view src);

/// `rasterizeSvg(src, fillColor)`: a data URL or a file path. Premultiplied RGBA8.
/// `time`: the document time an animated SVG is drawn at (seconds).
[[nodiscard]] raster::RasterOutput rasterize_svg_src(std::string_view src, const std::optional<std::string>& fill,
                                                     const std::string& filePath, double time = 0);

/// An .svg file's import facts (size, animated) for the media probe; !ok + error when it does not read.
[[nodiscard]] raster::svg::SvgFacts svg_file_facts(const std::filesystem::path& p);

}  // namespace premation::scene
