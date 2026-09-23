#include "frame_index.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <utility>

namespace premation::media {
namespace {

/// JS Math.round for the non-negative-or-small values used here (floor(x + 0.5)).
std::int64_t js_round(double x) noexcept { return static_cast<std::int64_t>(std::floor(x + 0.5)); }

/// frameIndex.ts `toUs(units, timescale)` with timescale = den / num (a MOV time base is 1/timescale exactly).
std::int64_t to_us(std::int64_t units, Rational tb) noexcept {
  if (tb.num == 1) return js_round(static_cast<double>(units) * 1e6 / static_cast<double>(tb.den));
  return js_round(static_cast<double>(units) * 1e6 * static_cast<double>(tb.num) / static_cast<double>(tb.den));
}

}  // namespace

FrameIndex FrameIndex::from_samples(std::span<const SampleEntry> decodeOrder, Rational timeBase) {
  FrameIndex fi;
  fi.exact_ = true;
  fi.timeBase_ = timeBase;
  const std::size_t n = decodeOrder.size();
  if (n == 0 || !timeBase.valid()) return fi;

  // The latest sync at-or-before each decode position (a stream whose first
  // sample is not a sync decodes from the top — the TS rule).
  std::vector<std::size_t> keyOf(n);
  std::size_t lastKey = 0;
  for (std::size_t i = 0; i < n; ++i) {
    if (decodeOrder[i].key) lastKey = i;
    keyOf[i] = lastKey;
  }
  std::vector<std::size_t> order(n);
  std::iota(order.begin(), order.end(), std::size_t{0});
  std::ranges::stable_sort(order, [&](std::size_t a, std::size_t b) { return decodeOrder[a].pts < decodeOrder[b].pts; });

  const std::int64_t pts0 = decodeOrder[order.front()].pts;
  fi.frames_.reserve(n);
  fi.byPts_.reserve(n);
  // Presentation index of each decode position's keyframe (filled as frames are placed).
  std::vector<std::int64_t> presOfDecode(n, -1);
  for (std::size_t p = 0; p < n; ++p) presOfDecode[order[p]] = static_cast<std::int64_t>(p);
  for (std::size_t p = 0; p < n; ++p) {
    const std::size_t d = order[p];
    const SampleEntry& s = decodeOrder[d];
    // Open-GOP leading frames (B-frames decoded after a keyframe but shown
    // BEFORE it) reference the previous GOP: decoding from their own keyframe
    // cannot produce them, so they start at the previous keyframe instead.
    // (frameIndex.ts starts them at their own keyframe; WebCodecs then drops or
    // corrupts them — the C++ index is right where the TS one was not.)
    std::size_t key = keyOf[d];
    while (key > 0 && std::cmp_greater(presOfDecode[key], p)) key = keyOf[key - 1];
    Frame f;
    f.pts = s.pts;
    f.timeUs = to_us(s.pts - pts0, timeBase);
    f.keyPts = decodeOrder[key].pts;
    f.gop = presOfDecode[key];
    fi.byPts_.emplace(s.pts, static_cast<std::int64_t>(p));
    fi.frames_.push_back(f);
  }
  fi.count_ = static_cast<std::int64_t>(n);
  return fi;
}

FrameIndex FrameIndex::constant_rate(std::int64_t count, Rational fps, Rational timeBase, std::int64_t startPts) {
  FrameIndex fi;
  fi.exact_ = false;
  fi.count_ = std::max<std::int64_t>(0, count);
  fi.fps_ = fps;
  fi.timeBase_ = timeBase;
  fi.startPts_ = startPts;
  return fi;
}

std::int64_t FrameIndex::frame_at_us(std::int64_t us) const noexcept {
  if (count_ <= 0 || us <= 0) return 0;
  if (exact_) {
    // Last frame with timeUs ≤ us (frames are sorted by time).
    const auto it = std::ranges::upper_bound(frames_, us, {}, &Frame::timeUs);
    return clamp(static_cast<std::int64_t>(it - frames_.begin()) - 1);
  }
  if (!fps_.valid()) return 0;
  // i = the last i with round(i/fps · 1e6) ≤ us. Start from the exact integer
  // quotient and correct for the rounding of the frame starts.
  using LD = long double;
  auto i = static_cast<std::int64_t>((static_cast<LD>(us) * static_cast<LD>(fps_.num)) / (1'000'000.0L * static_cast<LD>(fps_.den)));
  while (i + 1 < count_ && time_us(i + 1) <= us) ++i;
  while (i > 0 && time_us(i) > us) --i;
  return clamp(i);
}

std::int64_t FrameIndex::frame_at_seconds(double seconds) const noexcept {
  if (!std::isfinite(seconds)) return 0;
  const double us = std::floor(seconds * 1e6 + 0.5) + 1;
  if (us <= 0) return 0;
  if (us >= 9.0e18) return clamp(count_ - 1);
  return frame_at_us(static_cast<std::int64_t>(us));
}

std::int64_t FrameIndex::time_us(std::int64_t i) const noexcept {
  if (count_ <= 0) return 0;
  i = clamp(i);
  if (exact_) return frames_[static_cast<std::size_t>(i)].timeUs;
  if (!fps_.valid()) return 0;
  return js_round(static_cast<double>(i) * 1e6 * static_cast<double>(fps_.den) / static_cast<double>(fps_.num));
}

std::int64_t FrameIndex::pts(std::int64_t i) const noexcept {
  if (count_ <= 0) return startPts_;
  i = clamp(i);
  if (exact_) return frames_[static_cast<std::size_t>(i)].pts;
  if (!fps_.valid() || !timeBase_.valid()) return startPts_;
  // i / fps seconds in time-base units: i · fps.den · tb.den / (fps.num · tb.num), rounded.
  using LD = long double;
  const LD units = static_cast<LD>(i) * static_cast<LD>(fps_.den) * static_cast<LD>(timeBase_.den) /
                   (static_cast<LD>(fps_.num) * static_cast<LD>(timeBase_.num));
  return startPts_ + static_cast<std::int64_t>(std::floor(units + 0.5L));
}

std::int64_t FrameIndex::key_pts(std::int64_t i) const noexcept {
  if (exact_ && count_ > 0) return frames_[static_cast<std::size_t>(clamp(i))].keyPts;
  return pts(i);
}

std::int64_t FrameIndex::gop_of(std::int64_t i) const noexcept {
  if (exact_ && count_ > 0) return frames_[static_cast<std::size_t>(clamp(i))].gop;
  return clamp(i);
}

std::int64_t FrameIndex::index_of_pts(std::int64_t p) const noexcept {
  if (exact_) {
    const auto it = byPts_.find(p);
    return it == byPts_.end() ? -1 : it->second;
  }
  if (!fps_.valid() || !timeBase_.valid()) return -1;
  // Nearest frame slot: round((p - start) · tb · fps).
  using LD = long double;
  const LD idx = static_cast<LD>(p - startPts_) * static_cast<LD>(timeBase_.num) * static_cast<LD>(fps_.num) /
                 (static_cast<LD>(timeBase_.den) * static_cast<LD>(fps_.den));
  const auto i = static_cast<std::int64_t>(std::floor(idx + 0.5L));
  return i < 0 || i >= count_ ? -1 : i;
}

}  // namespace premation::media
