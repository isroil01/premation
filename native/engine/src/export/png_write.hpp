// F1: a PNG sequence frame. The Chromium path encodes the export canvas with
// `toBlob('image/png')`: straight-alpha 8-bit RGBA tagged sRGB (Skia's
// SkPngEncoder writes an sRGB chunk for an sRGB canvas). The engine writes the
// same pixels — the raw pipe's bytes — with the same tag; the compressed bytes
// are its own (Paeth rows, zlib level 6), so frames decode identically but do
// not hash the same.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::exporter {

/// Tight straight RGBA8 rows, top-down → a PNG file. False when compression fails.
bool encode_png_rgba8(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height,
                      std::vector<std::uint8_t>& out);

}  // namespace premation::exporter
