#include "rig_coverage.hpp"

#include <algorithm>
#include <filesystem>
#include <memory>

#include "image_decode.hpp"
#include "media_paths.hpp"
#include "native_effects.hpp"
#include "rig_cache.hpp"
#include "svg_layer.hpp"

namespace premation::scene {

namespace {

/// A cache slot: the mask at the default trace settings (its `source` plane lets
/// rig_mesh.cpp re-cut it for a layer's own settings), or null = the decode
/// failed (remembered, not retried — the bbox grid from then on).
struct CoverageSlot {
  std::shared_ptr<const rig::CoverageMask> mask;
};

/// Process-wide (imageAlphaCoverage.ts's module cache), bounded: 64 images or
/// 96 MB of alpha planes (≤ 1 MB each at kCoverageSourceMax²), least recently
/// used out first. Keyed by `assetId ?? src` + path + file stamp, so a changed
/// file is a different entry.
rig::ValueLru<CoverageSlot>& cache() {
  static rig::ValueLru<CoverageSlot> c(64, std::size_t{96} << 20U);
  return c;
}

/// decode(): the bitmap's alpha (≤ 1024 px on its long side) cut at the default settings.
std::shared_ptr<const rig::CoverageMask> mask_of(const DecodedImage& img) {
  if (img.width == 0 || img.height == 0) return nullptr;
  const auto plane = rig::alpha_plane_from_rgba(img.rgba, static_cast<int>(img.width), static_cast<int>(img.height));
  return std::make_shared<const rig::CoverageMask>(rig::coverage_mask_from_alpha(plane, rig::CoverageSettings{}));
}

}  // namespace

CoverageLookup image_coverage_mask(std::string_view key, std::string_view src, const std::filesystem::path& mediaBase) {
  CoverageLookup out;
  if (src.empty()) return out;
  std::string cacheKey(key);
  DecodedImage img;
  std::string error;
  bool decoded = false;
  if (src.starts_with("blob:") || src.starts_with("http:") || src.starts_with("https:")) {
    out.unreachable = "the image is a session / remote URL, not in the document";
    return out;
  }
  if (is_svg_src(src)) {
    // The TS decodes an SVG through the browser's <img> at its intrinsic size;
    // here the SVG renderer draws it at the size the texture feed draws it
    // (rasterizeSvg), and only its alpha is read.
    std::string path;
    if (!src.starts_with("data:")) {
      std::filesystem::path p = file_url_fs_path(src);
      if (p.is_relative()) {
        if (mediaBase.empty()) {
          out.unreachable = "the image is a relative path (no project folder to resolve it against)";
          return out;
        }
        p = mediaBase / p;
      }
      const FileStamp st = file_stamp(p);
      path = p.lexically_normal().string();
      cacheKey += '|' + path + '|' + std::to_string(st.size) + '|' + std::to_string(st.modified);
    }
    if (const auto slot = cache().find(cacheKey)) {
      out.mask = slot->mask;
      return out;
    }
    raster::RasterOutput svg = rasterize_svg_src(src, std::nullopt, path);
    if (svg.ok && svg.width > 0 && svg.height > 0) {
      // Premultiplied colour, straight alpha: the mask reads alpha only.
      img.width = svg.width;
      img.height = svg.height;
      img.rgba = std::move(svg.rgba);
      decoded = true;
    }
  } else if (src.starts_with("data:")) {
    const auto comma = src.find(',');
    const std::string_view head = src.substr(0, comma == std::string_view::npos ? 0 : comma);
    if (const auto slot = cache().find(cacheKey)) {
      out.mask = slot->mask;
      return out;
    }
    if (comma != std::string_view::npos && head.find(";base64") != std::string_view::npos) {
      if (const auto bytes = doc::native_unbase64(src.substr(comma + 1))) decoded = decode_image_bytes(*bytes, img, error);
    }
  } else {
    std::filesystem::path p = file_url_fs_path(src);
    if (p.is_relative()) {
      if (mediaBase.empty()) {
        out.unreachable = "the image is a relative path (no project folder to resolve it against)";
        return out;
      }
      p = mediaBase / p;
    }
    const FileStamp st = file_stamp(p);
    cacheKey += '|' + p.lexically_normal().string() + '|' + std::to_string(st.size) + '|' + std::to_string(st.modified);
    if (const auto slot = cache().find(cacheKey)) {
      out.mask = slot->mask;
      return out;
    }
    decoded = decode_image_file(p, img, error);
  }
  std::shared_ptr<const rig::CoverageMask> m;
  if (decoded) m = mask_of(img);
  // A failure (null) is remembered too: the bbox grid from now on. The cached entry
  // is the answer (a racing thread may have stored the same key first).
  const std::size_t bytes = m ? m->cells.size() + (m->source ? m->source->alpha.size() : 0) + 64 : 64;
  out.mask = cache().insert(std::move(cacheKey), std::make_shared<const CoverageSlot>(CoverageSlot{std::move(m)}), bytes)->mask;
  return out;
}

}  // namespace premation::scene
