// F1: a JPEG sequence frame. The editor encodes with canvas.toBlob('image/jpeg'),
// which drops alpha. The bytes are this machine's JPEG codec (WIC on Windows),
// so they do not hash the same as Chromium's; a decoder gets the same picture
// within the codec's quantization.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::exporter {

/// Tight straight RGBA8, top-down. Alpha is discarded. `quality` is 0..1.
[[nodiscard]] bool encode_jpeg_rgba8(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height,
                                     float quality, std::vector<std::uint8_t>& out);

}  // namespace premation::exporter
