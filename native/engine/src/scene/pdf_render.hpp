// PDF and Illustrator (.ai, a PDF inside) footage, drawn by PDFium
// (pdf_render_ffi.cpp) — AE imports both as footage of the first page, sized
// in points (1 pt = 1 px), and redraws a vector at the size it is displayed
// (Continuously Rasterize). The engine does the same through the SVG path:
// a PDF is a vector document the texture feed asks for at its display step
// (scene_textures svg_ref), so it stays sharp at any scale.
#pragma once

#include <string>
#include <string_view>

#include "raster/raster_source.hpp"

namespace premation::scene {

/// `.pdf` / `.ai` (a path or file URL, before any query / fragment).
[[nodiscard]] bool is_pdf_path(std::string_view src);

struct PdfFacts {
  bool ok = false;
  std::string error;
  /// The first page's size in points (its crop box, rotation applied).
  double width = 0;
  double height = 0;
  int pages = 0;
};

/// The first page's size, from the file.
[[nodiscard]] PdfFacts pdf_file_facts(const std::string& path);

/// The first page drawn transparent-backed at `targetLongEdge` px on its long
/// side (0 = its size in points), premultiplied RGBA8. Form fields and
/// annotations are drawn as a viewer shows them.
[[nodiscard]] raster::RasterOutput rasterize_pdf_file(const std::string& path, double targetLongEdge);

}  // namespace premation::scene
