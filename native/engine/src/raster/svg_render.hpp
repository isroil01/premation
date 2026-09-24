// SVG rasterisation for the C++ engine (D2w): the engine's twin of
// AppTextureProvider.rasterizeSvg — an SVG image layer or an SVG layer's
// document drawn to premultiplied RGBA8 at the size the TS asks Chromium for.
//
//   svg_doc.cpp         parse + cascade (Skia-free)
//   svg_raster.cpp      rasterizeSvg's sizing: intrinsic size, viewBox backfill,
//                       the 2048 px long edge, the recolour <style>
//   svg_render_ffi.cpp  the painter on Skia, following Blink's SVG painters
//
// Features the painter does not draw are named in RasterOutput::unsupported, so
// the scene builder reports the frame instead of drawing it wrong.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "raster_source.hpp"
#include "svg_doc.hpp"

namespace premation::raster {
class FontSet;
}

namespace premation::raster::svg {

/// A decoded bitmap, STRAIGHT alpha, rows top-down.
struct Bitmap {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;
};
/// Decodes an <image>'s bytes (PNG / JPEG / …). The raster module has no image
/// codecs; the engine passes its still-image decoder (WIC on Windows).
using ImageDecoder = std::function<bool(std::span<const std::uint8_t> bytes, Bitmap& out)>;

struct RasterizeOptions {
  /// The layer's fill: AppTextureProvider appends
  /// `path, circle, rect, polygon, polyline, ellipse, text { fill: X !important }`.
  std::optional<std::string> fillColor;
  /// Fonts for <text>. Null = the OS's installed fonts (an SVG image is its own
  /// document in Chromium: the page's web fonts never reach it).
  const FontSet* fonts = nullptr;
  ImageDecoder decodeImage;
};

/// The document text of an SVG `src`: a `data:` URL decoded as
/// AppTextureProvider.decodeSvgDataUrl does. nullopt: not a data URL / malformed.
[[nodiscard]] std::optional<std::string> svg_markup_from_data_url(std::string_view src);

/// AppTextureProvider.rasterizeSvg(src, fillColor) for a document's text.
[[nodiscard]] RasterOutput rasterize_svg(std::string_view markup, const RasterizeOptions& opts);

/// The painter (svg_render_ffi.cpp): `doc` (uses expanded) with its computed
/// styles, the root <svg> drawn into a w × h viewport. Premultiplied RGBA8.
[[nodiscard]] bool render_document(const Document& doc, const std::vector<Style>& styles, std::uint32_t w,
                                   std::uint32_t h, const RasterizeOptions& opts, std::vector<std::uint8_t>& rgba,
                                   std::vector<std::string>& unsupported, std::string& error);

}  // namespace premation::raster::svg
