// Test fixtures made in-process with libavcodec's own encoders, so the media
// tests need no checked-in video and no external ffmpeg. Every frame's content
// encodes its index (see `fixture_code`), so a decoded frame can prove WHICH
// frame it is.
#pragma once

#include <cstdint>
#include <string>

namespace premation::media::fixture {

enum class Kind : std::uint8_t {
  prores422,   // prores_ks HQ, yuv422p10le, .mov — intra
  prores4444,  // prores_ks 4444 + alpha, yuva444p10le, .mov — intra, alpha
  dnxhr,       // dnxhd DNxHR HQ, yuv422p, .mov — intra
  mpeg4,       // mpeg4 part 2, GOP 12 with 2 B-frames, .mp4 — long-GOP, reordered
  vp9alpha,    // libvpx-vp9 yuva420p, .webm — alpha side channel
  ffv1rgb,     // ffv1 gbrp10le, .mkv — planar RGB, lossless
};

struct Spec {
  Kind kind = Kind::prores422;
  int width = 256;
  int height = 144;
  int frames = 30;
  int fpsNum = 24000;
  int fpsDen = 1001;
};

/// The left half of every frame is 8 vertical bands, bit b of the frame index
/// in band b: luma `kBitOn` for 1, `kBitOff` for 0 (8-bit scale) — flat areas
/// that survive lossy coding. The right half is a horizontal ramp.
inline constexpr int kBands = 8;
inline constexpr int kBitOff = 40;
inline constexpr int kBitOn = 200;
/// Luma (8-bit scale) of band `band` in frame `i`.
[[nodiscard]] int fixture_code(int i, int band) noexcept;
/// Alpha (8-bit scale) frame `i` carries (alpha kinds).
[[nodiscard]] int fixture_alpha(int i) noexcept;

/// Encode `spec` to `path`. False (with `error`) when an encoder is missing.
bool write(const Spec& spec, const std::string& path, std::string& error);

}  // namespace premation::media::fixture
