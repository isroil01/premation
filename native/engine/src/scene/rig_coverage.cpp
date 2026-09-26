#include "rig_coverage.hpp"

#include <algorithm>
#include <filesystem>
#include <map>
#include <mutex>

#include "image_decode.hpp"
#include "native_effects.hpp"
#include "svg_layer.hpp"
#include "raster/canvas.hpp"

namespace premation::scene {

// scene_textures.hpp (declared here so this file does not pull the GPU headers in).
[[nodiscard]] std::string file_url_path(std::string_view src);

namespace {

struct CoverageCache {
  std::mutex mu;
  /// key (+ file stamp) → the mask; null = the decode failed (not retried).
  std::map<std::string, std::shared_ptr<const rig::CoverageMask>, std::less<>> masks;
};

CoverageCache& cache() {
  static CoverageCache c;  // process-wide, like imageAlphaCoverage.ts's module cache
  return c;
}

/// decode(): drawImage into a ≤64² canvas, getImageData, coverageMaskFromImageData.
std::shared_ptr<const rig::CoverageMask> mask_of(const DecodedImage& img) {
  const auto samples = static_cast<std::uint32_t>(rig::kCoverageSamples);
  const std::uint32_t w = std::max(1U, std::min(samples, img.width));
  const std::uint32_t h = std::max(1U, std::min(samples, img.height));
  const raster::CanvasOptions opts;
  const auto src = raster::Canvas2D::make(img.width, img.height, opts);
  if (!src) return nullptr;
  src->putImageData(img.rgba, img.width, img.height, 0, 0);
  std::vector<std::uint8_t> px;
  if (w == img.width && h == img.height) {
    px = src->getImageData(0, 0, w, h);
  } else {
    const auto dst = raster::Canvas2D::make(w, h, opts);
    if (!dst) return nullptr;
    dst->set_will_read_frequently(true);  // `getContext('2d', { willReadFrequently: true })`
    dst->drawImage(*src, 0, 0, img.width, img.height, 0, 0, w, h);
    px = dst->getImageData(0, 0, w, h);
  }
  return std::make_shared<const rig::CoverageMask>(
      rig::coverage_mask_from_image_data(px, static_cast<int>(w), static_cast<int>(h), rig::kCoverageSamples, rig::kCoverageAlphaThreshold));
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
      std::filesystem::path p = file_url_path(src);
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
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().masks.find(cacheKey); it != cache().masks.end()) {
        out.mask = it->second;
        return out;
      }
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
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().masks.find(cacheKey); it != cache().masks.end()) {
        out.mask = it->second;
        return out;
      }
    }
    if (comma != std::string_view::npos && head.find(";base64") != std::string_view::npos) {
      if (const auto bytes = doc::native_unbase64(src.substr(comma + 1))) decoded = decode_image_bytes(*bytes, img, error);
    }
  } else {
    std::filesystem::path p = file_url_path(src);
    if (p.is_relative()) {
      if (mediaBase.empty()) {
        out.unreachable = "the image is a relative path (no project folder to resolve it against)";
        return out;
      }
      p = mediaBase / p;
    }
    const FileStamp st = file_stamp(p);
    cacheKey += '|' + p.lexically_normal().string() + '|' + std::to_string(st.size) + '|' + std::to_string(st.modified);
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().masks.find(cacheKey); it != cache().masks.end()) {
        out.mask = it->second;
        return out;
      }
    }
    decoded = decode_image_file(p, img, error);
  }
  std::shared_ptr<const rig::CoverageMask> m = decoded ? mask_of(img) : nullptr;
  const std::scoped_lock lock(cache().mu);
  cache().masks.emplace(cacheKey, m);  // a failure is remembered: the bbox grid from now on
  out.mask = std::move(m);
  return out;
}

}  // namespace premation::scene
