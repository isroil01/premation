// Y'CbCr → R'G'B': the matrix the GPU conversion applies, built from a frame's
// resolved matrix coefficients + quantisation range + bit depth (H.273 /
// BT.601 / BT.709 / BT.2020 / SMPTE 240M / FCC / YCgCo), plus a CPU twin the
// tests check the shader against.
//
// The matrix works on INTEGER CODE VALUES (the sample with any storage shift
// removed: a 10-bit P010 sample 0xFFC0 is code 1023), so the same numbers
// serve a CPU-uploaded yuv422p10le plane (read as uint) and a hardware P010
// texture (read as unorm16 and scaled back by `sampleScale`).
//
// Output is the stream's own non-linear R'G'B' (for BT.709 footage that is
// Rec.709-encoded, for PQ footage PQ-encoded) — the render graph's colour
// management (D3, RenderTextureRef.inputSpace) decides what it means.
#pragma once

#include <array>

#include "decoded_frame.hpp"
#include "media_types.hpp"

namespace premation::media {

struct YuvToRgb {
  /// Row-major 3×4: [R' G' B']ᵀ = M · [Y Cb Cr 1]ᵀ, inputs in code values.
  std::array<float, 12> m{};
  /// Alpha code → [0, 1].
  float alphaScale = 1;
};

/// Luma coefficients (Kr, Kb) of a matrix; BT.709's for unknown ones.
struct LumaCoefficients {
  double kr = 0.2126;
  double kb = 0.0722;
};
[[nodiscard]] LumaCoefficients luma_coefficients(Matrix m) noexcept;

/// The file's matrix/range resolved the way ffmpeg and every player do:
/// unspecified matrix → BT.2020 NCL when the primaries are BT.2020, BT.601
/// (SMPTE 170M) for SD heights (< 720), BT.709 otherwise; unspecified range →
/// limited (full for JPEG-style `yuvj` formats, which the caller reports as full).
[[nodiscard]] Matrix resolve_matrix(Matrix m, Primaries p, std::uint32_t height) noexcept;
[[nodiscard]] Range resolve_range(Range r) noexcept;

/// The conversion for a frame format (layout planarRgb / packedRgba → per-channel range scaling only).
[[nodiscard]] YuvToRgb yuv_to_rgb(const FrameFormat& f) noexcept;

/// CPU twin of the shader: code values in, straight R'G'B'A in [0, 1] out
/// (clamped, as the TS 8-bit path clamps).
[[nodiscard]] std::array<double, 4> convert_codes(const YuvToRgb& c, double y, double cb, double cr, double a,
                                                  bool hasAlpha) noexcept;

/// The inputSpace the render graph's colour management should assume for this
/// footage (api::RenderColorSpace numbering: srgb 0, rec709 1, linearSrgb 2,
/// acesCg 3, rec2020 4, linearRec2020 5, aces2065 6). BT.2020 primaries → rec2020;
/// linear transfer → the linear variant; otherwise rec709 (HD/SD video's
/// primaries are BT.709/601 — the 601 primaries difference is below what the
/// working-space conversion models today). PQ / HLG have no RenderColorSpace
/// yet: they report rec2020 and `hdrUnmodelled` = true.
struct InputSpaceGuess {
  int renderColorSpace = 1;
  bool hdrUnmodelled = false;
};
[[nodiscard]] InputSpaceGuess input_space_of(const ColorInfo& c) noexcept;

}  // namespace premation::media
