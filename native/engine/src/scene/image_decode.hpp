// Still-image footage (PNG / JPEG / WebP / BMP / GIF / TIFF) decoded to RGBA8 —
// the texel layout the TS engine uploads for an image layer (the file's own
// channels, straight alpha, no colour conversion; the layer's
// premultipliedSource flag tells the shader how to read them). ffmpeg in the
// engine's vcpkg build carries no still-image decoders, so stills go through
// the OS codec: WIC on Windows (image_decode_ffi.cpp); elsewhere not yet.
#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace premation::scene {

struct DecodedImage {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  // width × height × 4, rows top-down
};

/// A file's size and last-write stamp (OS units; zeros when it cannot be read) —
/// the still-image cache key, so a re-saved file decodes again.
struct FileStamp {
  std::uint64_t size = 0;
  std::uint64_t modified = 0;
};
[[nodiscard]] FileStamp file_stamp(const std::filesystem::path& p);

/// True for the extensions decode_image_file handles.
[[nodiscard]] bool is_still_image_path(const std::filesystem::path& p);

/// Decode the first frame of an image file. False + `error` on failure.
[[nodiscard]] bool decode_image_file(const std::filesystem::path& p, DecodedImage& out, std::string& error);

}  // namespace premation::scene
