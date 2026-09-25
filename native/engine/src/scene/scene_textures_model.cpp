// SceneTextures: an imported model's images (`gltf:<modelKey>#<image>` sources,
// model_carrier.hpp) — the base colour an image-kind model leaf samples and its
// PBR maps. The TS mints an object URL per image and the browser decodes it;
// here the image's bytes come out of the registered model and decode through
// the same still-image codec as footage, premultiplied the same way.
#include <array>
#include <chrono>
#include <cstdio>

#include "image_decode.hpp"
#include "model_carrier.hpp"
#include "scene_textures.hpp"

namespace premation::scene {

std::string SceneTextures::model_ref(const TextureRequest& r, PrepareStats& stats) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  const auto mix = [&h](std::string_view s) {
    for (const char c : s) {
      h ^= static_cast<std::uint8_t>(c);
      h *= 0x100000001b3ULL;
    }
  };
  mix(r.src);  // the model key is its content hash: the source names the bytes
  mix(r.premultiplied ? "|gltf|1" : "|gltf|0");
  std::array<char, 17> hex{};
  std::snprintf(hex.data(), hex.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  std::string hash = "img:" + std::string(hex.data(), 16);
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, "model image did not decode: " + oe->second);
    return {};
  }
  if (find(hash)) return hash;
  const auto t0 = std::chrono::steady_clock::now();
  DecodedImage img;
  std::string error;
  if (!model_image_pixels(r.src, img, error)) {
    openErrors_.emplace(hash, error);
    stats.unsupported.emplace_back(r.key, "model image did not decode: " + error);
    return {};
  }
  if (!r.premultiplied) {
    // As image_ref: the browser's decode premultiplies straight images (SkMulDiv255Round).
    for (std::size_t i = 0; i + 3 < img.rgba.size(); i += 4) {
      const unsigned a = img.rgba[i + 3];
      for (std::size_t c = 0; c < 3; ++c) {
        const unsigned prod = (img.rgba[i + c] * a) + 128U;
        img.rgba[i + c] = static_cast<std::uint8_t>((prod + (prod >> 8U)) >> 8U);
      }
    }
  }
  auto e = std::make_shared<RasterEntry>();
  e->width = img.width;
  e->height = img.height;
  e->rgba = std::move(img.rgba);
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

}  // namespace premation::scene
