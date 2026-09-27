// What a job reads from footage: picture frames as straight RGBA8 and a
// file's sound as float PCM. ffmpeg only in media_input_ffi.cpp (CLAUDE.md:
// FFI only in *_ffi.cpp); the analysis code sees these plain types, so it is
// unit-testable with synthetic frames (tests/test_jobs.cpp).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "json.hpp"

namespace premation::jobs {

/// Straight (unpremultiplied) RGBA, 8 bits per channel, rows top-down, no padding.
struct RgbaImage {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;

  [[nodiscard]] bool empty() const noexcept { return width == 0 || height == 0; }
  [[nodiscard]] std::size_t index(std::uint32_t x, std::uint32_t y) const noexcept {
    return (static_cast<std::size_t>(y) * width + x) * 4U;
  }
};

/// A luma plane as the page's analyses read it (patchMatch.ts LumaPlane):
/// either the decoder's own Y bytes (0…255, `bytes` — lumaExtract.ts 'raw8',
/// what the tracker and scene detection read when the frame is planar YUV) or
/// Rec.601 luma of RGBA in 0…1 (lumaFromRGBA — the canvas fallback).
struct LumaImage {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<float> data;
  bool bytes = false;
};

/// patchMatch.ts lumaFromRGBA: (0.299 r + 0.587 g + 0.114 b) / 255, stored as float.
[[nodiscard]] LumaImage luma_from_rgba(const RgbaImage& img);

/// A footage file's picture, frame by frame, at the source's frame numbering
/// (frame n = source time n / fps()). Reading forward is a decode; reading
/// backward or far ahead seeks. One reader belongs to one thread.
class FrameSource {
 public:
  FrameSource() = default;
  virtual ~FrameSource() = default;
  FrameSource(const FrameSource&) = delete;
  FrameSource& operator=(const FrameSource&) = delete;
  FrameSource(FrameSource&&) = delete;
  FrameSource& operator=(FrameSource&&) = delete;

  /// Output size (the source scaled down so its long edge is at most the
  /// `maxEdge` it was opened with; never scaled up).
  [[nodiscard]] virtual std::uint32_t width() const noexcept = 0;
  [[nodiscard]] virtual std::uint32_t height() const noexcept = 0;
  /// The stored picture size (layer pixels are these: scale results by source_width() / width()).
  [[nodiscard]] virtual std::uint32_t source_width() const noexcept = 0;
  [[nodiscard]] virtual std::uint32_t source_height() const noexcept = 0;
  [[nodiscard]] virtual double fps() const noexcept = 0;
  /// Frames in the stream (a still image: 1).
  [[nodiscard]] virtual std::int64_t frame_count() const noexcept = 0;
  /// Frame `frame` (0 ≤ frame < frame_count()) into `out`. False with `error` on a decode failure.
  virtual bool read(std::int64_t frame, RgbaImage& out, std::string& error) = 0;
  /// Frame `frame`'s luma: the decoder's Y plane when the picture is 8-bit
  /// planar YUV at the output size, else luma_from_rgba(read()).
  virtual bool read_luma(std::int64_t frame, LumaImage& out, std::string& error) {
    RgbaImage rgba;
    if (!read(frame, rgba, error)) return false;
    out = luma_from_rgba(rgba);
    return true;
  }
};

/// Open a video or still image. `maxEdge` 0 = full size. Null with `error` when it cannot be read.
[[nodiscard]] std::unique_ptr<FrameSource> open_frames(const std::string& path, std::uint32_t maxEdge, std::string& error);

/// importFiles' media facts (core/engine_ctx.hpp FilePorts::MediaProbe): a
/// still `image` (width, height, duration 0), a `video` (its picture's size,
/// rate, frames / rate as the duration, whether it has sound) or `audio`
/// (duration, hasAudioTrack). False + `error` when neither decoder reads it.
bool probe_media(const std::string& path, js::Json& facts, std::string& error);

/// A file's sound at its own sample rate, one vector per channel (1 or 2,
/// conformed as the mixer hears it: audio/audio_decode.hpp).
struct AudioPcm {
  int sampleRate = 0;
  std::vector<std::vector<float>> channels;

  [[nodiscard]] std::size_t frames() const noexcept { return channels.empty() ? 0 : channels.front().size(); }
  [[nodiscard]] double seconds() const noexcept {
    return sampleRate > 0 ? static_cast<double>(frames()) / sampleRate : 0.0;
  }
};

/// Decode the whole first audio stream. False with `error` (no audio stream: "no sound").
bool read_audio(const std::string& path, AudioPcm& out, std::string& error);

/// Mono mix (the mean of the channels) — silenceRemoval.ts / audioDriver.ts `mixToMono`.
[[nodiscard]] std::vector<float> mono_of(const AudioPcm& pcm);

}  // namespace premation::jobs
