// ffmpeg's swscale as the colour reference for the Y'CbCr → R'G'B' conversion
// (yuv.cpp's matrices, the CPU twin and the GPU pass): the same code values
// through swscale with the stream's matrix and range, read back as 16-bit RGB.
// libswscale is included only by swscale_ref_ffi.cpp.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "media_types.hpp"

namespace premation::media::swsref {

/// One 4:4:4 planar Y'CbCr image of `width` × `height` codes (row-major), `bitDepth` 8/10/12/16.
struct Yuv444 {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint8_t bitDepth = 8;
  std::vector<std::uint16_t> y, cb, cr;
};

/// An 11 × 11 × 11 grid of (Y', Cb, Cr) codes spanning each channel's nominal
/// range at `depth` / `r` (limited: 16–235 / 16–240 scaled; full: 0–max), as a 121 × 11 image.
[[nodiscard]] Yuv444 code_grid(std::uint8_t depth, Range r);

/// swscale's R'G'B' in [0, 1] (interleaved, 3 per pixel), converting with
/// matrix `m` (bt709, smpte170m/bt470bg, bt2020nc, fcc, smpte240m) and range `r`
/// (limited / full). False (with `error`) if swscale refuses the conversion.
bool to_rgb(const Yuv444& in, Matrix m, Range r, std::vector<double>& rgb, std::string& error);

}  // namespace premation::media::swsref
