// OpenEXR decode (src/core/media/exr.ts decodeExr + floatExr.ts exrToFloatRgba)
// for the engine's EXR environment skies (D2w 3D leftovers): single-part
// SCANLINE images, compressions NONE / RLE / ZIPS / ZIP, pixel types HALF /
// FLOAT / UINT, both line orders — the set exr.ts reads. Tiled, deep,
// multi-part, subsampled, PIZ / PXR24 / B44 / DWA refuse with exr.ts's reason.
//
// Pure: the zlib inflate is injected (zlib_inflate_ffi.cpp is the engine's).
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace premation::scene::exr {

struct Channel {
  std::string name;
  /// Row-major, dataWindow width × height. UINT channels are cast to float.
  std::vector<float> data;
};

struct Image {
  int width = 0;
  int height = 0;
  std::vector<Channel> channels;
  /// The header's STRING attributes, by name (Cryptomatte's manifest …).
  std::map<std::string, std::string> attributes;
};

/// zlib-inflate `in` (an RFC 1950 stream) into exactly `expected` bytes; false on a corrupt stream.
using Inflate = std::function<bool(std::span<const std::uint8_t> in, std::size_t expected, std::vector<std::uint8_t>& out)>;

/// exr.ts halfToFloat.
[[nodiscard]] float half_to_float(std::uint16_t h) noexcept;
/// exr.ts exrPredictorDecode: un-delta, then de-interleave.
[[nodiscard]] std::vector<std::uint8_t> predictor_decode(std::span<const std::uint8_t> data);

/// `decodeExr(buf)`; nullopt with `error` = exr.ts's message.
[[nodiscard]] std::optional<Image> decode(std::span<const std::uint8_t> file, const Inflate& inflate, std::string& error);

/// floatExr.ts `exrToFloatRgba(img, exposure)`: linear RGBA (Y fills a missing
/// R / G / B, `.r`-suffixed layer channels match); nullopt when there is no colour.
struct FloatRgba {
  int width = 0;
  int height = 0;
  std::vector<float> rgba;
};
[[nodiscard]] std::optional<FloatRgba> to_float_rgba(const Image& img, double exposure = 0);

/// The engine's inflate (zlib, zlib_inflate_ffi.cpp).
[[nodiscard]] Inflate zlib_inflate();

}  // namespace premation::scene::exr
