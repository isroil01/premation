#include "env_asset.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <span>
#include <system_error>
#include <map>
#include <mutex>

#include "exr_read.hpp"
#include "image_decode.hpp"
#include "jsmath.hpp"
#include "native_effects.hpp"
#include "raster/canvas.hpp"
#include "scene.hpp"
#include "scene_textures.hpp"

namespace premation::scene {
namespace {

constexpr double kDecodeMaxWidth = 1024;  // environmentImage.ts DECODE_MAX_WIDTH

struct Cache {
  std::mutex mu;
  std::map<std::string, std::shared_ptr<const EnvAsset>, std::less<>> skies;
};

Cache& cache() {
  static Cache c;  // process-wide, like environmentLight.ts's asset caches
  return c;
}

bool ends_with_ci(std::string_view s, std::string_view suffix) {
  if (s.size() < suffix.size()) return false;
  for (std::size_t i = 0; i < suffix.size(); ++i) {
    if (std::tolower(static_cast<unsigned char>(s[s.size() - suffix.size() + i])) != suffix[i]) return false;
  }
  return true;
}

/// An EXR sky from `src` (when it is an .exr file) or the asset's original
/// `path`: decoded (exr_read), converted to linear RGBA (exrToFloatRgba),
/// resampled to the 256×128 equirect as linear data, projected and
/// prefiltered like an 8-bit sky. Null (with `why` when a file was found but
/// did not read) when no .exr file is reachable.
std::shared_ptr<const EnvAsset> exr_sky(const std::string& assetId, const std::string& src, const std::string& path,
                                        std::string& why) {
  std::filesystem::path file;
  for (const std::string* cand : {&src, &path}) {
    if (!ends_with_ci(*cand, ".exr") || cand->starts_with("data:") || cand->starts_with("blob:") || cand->starts_with("http")) continue;
    const std::string p = file_url_path(*cand);
    std::filesystem::path fp{std::u8string(p.begin(), p.end())};
    if (fp.is_relative()) continue;
    if (std::error_code ec; std::filesystem::is_regular_file(fp, ec)) {
      file = std::move(fp);
      break;
    }
  }
  if (file.empty()) return nullptr;
  const FileStamp st = file_stamp(file);
  const std::string key = assetId + "|exr|" + file.lexically_normal().string() + "|" + std::to_string(st.size) + "|" +
                          std::to_string(st.modified);
  {
    const std::scoped_lock lock(cache().mu);
    if (const auto it = cache().skies.find(key); it != cache().skies.end()) return it->second;
  }
  std::vector<std::uint8_t> bytes;
  {
    std::ifstream in(file, std::ios::binary);
    if (!in) {
      why = "the EXR sky did not open";
      return nullptr;
    }
    bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  }
  std::string err;
  const std::optional<exr::Image> img = exr::decode(bytes, exr::zlib_inflate(), err);
  if (!img) {
    why = "the EXR sky did not decode: " + err;
    return nullptr;
  }
  const std::optional<exr::FloatRgba> rgba = exr::to_float_rgba(*img);
  if (!rgba) {
    why = "the EXR sky has no displayable color channels";
    return nullptr;
  }
  auto out = std::make_shared<EnvAsset>();
  // shProjectEquirect(float.rgba, …, {isLinear: true}) and resampleEquirect to
  // ENV_SPEC: both 256×128, the same box average — one resample feeds both.
  const EnvPixels base = resample_equirect(std::span<const float>(rgba->rgba), rgba->width, rgba->height, kEnvSpecWidth,
                                           kEnvSpecHeight, true);
  out->sh = sh_project(base);
  out->specular = build_env_specular_atlas(base, env_atlas_key("asset:" + assetId + "#" + hash_env_pixels(base)));
  const std::scoped_lock lock(cache().mu);
  return cache().skies.emplace(key, std::move(out)).first->second;
}

}  // namespace

std::shared_ptr<const EnvAsset> environment_asset(const doc::Document& d, std::string_view sky, std::string& why) {
  why.clear();
  if (!sky.starts_with("asset:")) return nullptr;
  const std::string assetId(sky.substr(6));
  if (assetId.empty()) return nullptr;  // "Image… chosen, none picked": the default preset
  const js::Json* asset = doc::find_asset(d, assetId);
  if (asset == nullptr || !asset->at("src").is_string() || asset->at("src").str().empty()) {
    why = "the sky's image asset is not in the document";
    return nullptr;
  }
  const std::string& src = asset->at("src").str();
  const std::string name = asset->at("name").is_string() ? asset->at("name").str() : std::string();
  if (ends_with_ci(name, ".exr") || ends_with_ci(src, ".exr")) {
    // environmentImage.ts projects an EXR's LINEAR float planes (floatExr.ts),
    // not the tone-mapped PNG import leaves as the asset's src — the sun keeps
    // its energy. The planes come from the .exr file: the src when it is one,
    // else the asset's original path. Only when neither is reachable does the
    // sky fall back to the PNG, as the TS does once its float cache is gone.
    std::string exrWhy;
    if (auto loaded = exr_sky(assetId, src, asset->at("path").is_string() ? asset->at("path").str() : std::string(), exrWhy)) {
      return loaded;
    }
    if (ends_with_ci(src, ".exr")) {
      why = exrWhy.empty() ? "the EXR sky could not be read" : exrWhy;
      return nullptr;
    }
  }
  if (asset->at("type").is_string() && asset->at("type").str() != "image") return nullptr;  // the TS: failed → default preset

  DecodedImage img;
  std::string err;
  std::string key = assetId;
  if (src.starts_with("data:")) {
    const auto comma = src.find(',');
    if (comma == std::string::npos || src.substr(0, comma).find(";base64") == std::string::npos) {
      why = "the sky image's data: URL is not base64";
      return nullptr;
    }
    key += "|data|" + std::to_string(src.size());
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().skies.find(key); it != cache().skies.end()) return it->second;
    }
    const auto bytes = doc::native_unbase64(std::string_view(src).substr(comma + 1));
    if (!bytes || !decode_image_bytes(*bytes, img, err)) {
      why = "the sky image did not decode: " + err;
      return nullptr;
    }
  } else if (src.starts_with("blob:") || src.starts_with("http:") || src.starts_with("https:")) {
    why = "the sky image is a session URL, not in the document";
    return nullptr;
  } else {
    const std::filesystem::path p = file_url_path(src);
    if (p.is_relative()) {
      why = "the sky image is a relative path (no project folder to resolve it against)";
      return nullptr;
    }
    const FileStamp st = file_stamp(p);
    key += "|" + p.lexically_normal().string() + "|" + std::to_string(st.size) + "|" + std::to_string(st.modified);
    {
      const std::scoped_lock lock(cache().mu);
      if (const auto it = cache().skies.find(key); it != cache().skies.end()) return it->second;
    }
    if (!decode_image_file(p, img, err)) {
      why = "the sky image did not decode: " + err;
      return nullptr;
    }
  }

  // decodeSrgbPixels: at most 1024 px wide, drawn into a canvas, read back straight.
  const double natW = img.width;
  const double natH = img.height;
  const double scale = std::min(1.0, kDecodeMaxWidth / natW);
  const auto w = static_cast<std::uint32_t>(std::max(1.0, motion::js::round(natW * scale)));
  const auto h = static_cast<std::uint32_t>(std::max(1.0, motion::js::round(natH * scale)));
  const raster::CanvasOptions opts;
  const auto srcCanvas = raster::Canvas2D::make(img.width, img.height, opts);
  if (!srcCanvas) {
    why = "no canvas for the sky image";
    return nullptr;
  }
  srcCanvas->putImageData(img.rgba, img.width, img.height, 0, 0);
  std::vector<std::uint8_t> px;
  if (w == img.width && h == img.height) {
    px = srcCanvas->getImageData(0, 0, w, h);
  } else {
    const auto dst = raster::Canvas2D::make(w, h, opts);
    if (!dst) {
      why = "no canvas for the sky image";
      return nullptr;
    }
    dst->drawImage(*srcCanvas, 0, 0, img.width, img.height, 0, 0, w, h);
    px = dst->getImageData(0, 0, w, h);
  }

  auto out = std::make_shared<EnvAsset>();
  // shProjectEquirect resamples to ENV_PROJECT_MAX (256×128) and the specular
  // base to ENV_SPEC (256×128): the same box average, so one resample feeds both.
  const EnvPixels base = resample_equirect(px, static_cast<int>(w), static_cast<int>(h), kEnvSpecWidth, kEnvSpecHeight, false);
  out->sh = sh_project(base);
  out->specular = build_env_specular_atlas(base, env_atlas_key("asset:" + assetId + "#" + hash_env_pixels(base)));
  const std::scoped_lock lock(cache().mu);
  return cache().skies.emplace(key, std::move(out)).first->second;
}

void clear_environment_assets() {
  const std::scoped_lock lock(cache().mu);
  cache().skies.clear();
}

}  // namespace premation::scene
