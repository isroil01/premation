// Presentation-order frame index of one video stream — the C++ twin of
// src/core/video/frameIndex.ts, so a source time lands on the SAME frame in
// both engines.
//
//   * presentation order = samples sorted by pts, ties broken by decode order;
//   * times are rebased to the first displayed pts (absorbs B-frame delay and
//     edit lists) and stored as INTEGER microseconds, rounded
//     (`Math.round((cts - cts0) * 1e6 / timescale)`);
//   * `frame_at_us(t)` is a floor over half-open [start, next): the last frame
//     whose time ≤ t; before the first frame → 0, past the end → the last;
//   * callers look up `round(seconds × 1e6) + 1` (exactVideoFrames.ts: the
//     +1 µs keeps a time computed as k/fps from landing one frame early).
//
// Without a per-sample index (a container that only indexes keyframes and was
// not scanned) the index is constant-frame-rate: frame i at round(i/fps · 1e6).
#pragma once

#include <cstdint>
#include <span>
#include <unordered_map>
#include <vector>

#include "media_types.hpp"

namespace premation::media {

/// One compressed sample as the demuxer reports it.
struct SampleEntry {
  std::int64_t pts = 0;  // stream time base
  bool key = false;
};

// NOLINTNEXTLINE(bugprone-exception-escape): the implicit special members copy an unordered_map (bad_alloc only)
class FrameIndex {
 public:
  /// Exact index from every sample, in DECODE order.
  static FrameIndex from_samples(std::span<const SampleEntry> decodeOrder, Rational timeBase);
  /// Constant-rate index: `count` frames at `fps`, first pts `startPts`, keyframes unknown
  /// (every frame treated as a possible seek point; the decoder still starts at a real keyframe).
  static FrameIndex constant_rate(std::int64_t count, Rational fps, Rational timeBase, std::int64_t startPts);

  [[nodiscard]] std::int64_t size() const noexcept { return count_; }
  [[nodiscard]] bool exact() const noexcept { return exact_; }

  /// frameIndex.ts `frameAtTime`: the presentation index shown at `us`.
  [[nodiscard]] std::int64_t frame_at_us(std::int64_t us) const noexcept;
  /// The index shown at `seconds` — `frame_at_us(round(seconds·1e6) + 1)`, clamped at 0 (exactVideoFrames.ts:485).
  [[nodiscard]] std::int64_t frame_at_seconds(double seconds) const noexcept;
  /// Presentation time of frame `i` in µs (rebased: frame 0 = 0).
  [[nodiscard]] std::int64_t time_us(std::int64_t i) const noexcept;
  /// Stream pts of presentation frame `i` (what the decoder stamps on it).
  [[nodiscard]] std::int64_t pts(std::int64_t i) const noexcept;
  /// Pts of the keyframe a decoder must start from to reach frame `i`.
  [[nodiscard]] std::int64_t key_pts(std::int64_t i) const noexcept;
  /// Presentation index of the keyframe that starts frame `i`'s GOP (same GOP ⇔ same value).
  [[nodiscard]] std::int64_t gop_of(std::int64_t i) const noexcept;
  /// A decoded frame's pts → its presentation index (-1 when it is not in the index).
  [[nodiscard]] std::int64_t index_of_pts(std::int64_t pts) const noexcept;
  [[nodiscard]] std::int64_t clamp(std::int64_t i) const noexcept {
    return count_ <= 0 ? 0 : (i < 0 ? 0 : (i >= count_ ? count_ - 1 : i));
  }

 private:
  struct Frame {
    std::int64_t pts = 0;
    std::int64_t timeUs = 0;
    std::int64_t keyPts = 0;
    std::int64_t gop = 0;  // presentation index of the frame's keyframe
  };
  std::vector<Frame> frames_;       // exact: presentation order
  std::unordered_map<std::int64_t, std::int64_t> byPts_;
  std::int64_t count_ = 0;
  bool exact_ = false;
  // constant-rate
  Rational fps_;
  Rational timeBase_;
  std::int64_t startPts_ = 0;
};

}  // namespace premation::media
