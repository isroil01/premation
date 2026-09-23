// Conformed audio: a source decoded once, in order, resampled to the mix rate
// (AE's "conformed audio" cache). Random access is then trivially
// sample-exact — every read of frame n returns the same sample however the
// playhead got there — and the waveform peaks are built in the same pass.
//
// Storage is a table of fixed-size chunks. The decoder thread appends chunks
// and publishes `framesReady` with release order; any thread (the audio
// callback included) reads below it without a lock. Chunks are never moved or
// freed while the SourceData lives, so a reader never races a writer.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace premation::audio {

/// Multi-resolution waveform peaks: level 0 holds min/max/Σx² per 256 frames
/// for each channel and for the mono mix (the TS envelope is computed on the
/// mono average — waveform.ts `mixToMono`), each level above folds 4 buckets.
class PeakPyramid {
 public:
  static constexpr std::size_t kBase = 256;
  static constexpr std::size_t kFold = 4;

  struct Bucket {
    float mn = 0, mx = 0;
    double sumSq = 0;
    std::uint32_t n = 0;
  };
  /// channels 0..nch-1 are the source channels; index nch is the mono mix.
  explicit PeakPyramid(int channels);
  void append(const float* const* planes, std::size_t n);
  void finish();
  [[nodiscard]] int channels() const noexcept { return channels_; }
  /// Level `l` buckets for channel `c` (c == channels() → mono mix).
  [[nodiscard]] const std::vector<Bucket>& level(std::size_t l, int c) const { return levels_[l][static_cast<std::size_t>(c)]; }
  [[nodiscard]] std::size_t levels() const noexcept { return levels_.size(); }
  [[nodiscard]] std::size_t bucket_frames(std::size_t l) const noexcept;

 private:
  void fold_up(std::size_t fromLevel);
  int channels_;
  std::vector<std::vector<std::vector<Bucket>>> levels_;  // [level][channel][bucket]
  std::vector<Bucket> partial_;                            // level-0 bucket being filled, per channel
};

class SourceData {
 public:
  static constexpr std::size_t kChunkShift = 15;
  static constexpr std::size_t kChunk = std::size_t{1} << kChunkShift;  // 32768 frames

  /// `maxFrames` caps the chunk table (a source can never grow past it).
  SourceData(int channels, double sampleRate, std::int64_t maxFrames);
  ~SourceData();
  SourceData(const SourceData&) = delete;
  SourceData& operator=(const SourceData&) = delete;
  SourceData(SourceData&&) = delete;
  SourceData& operator=(SourceData&&) = delete;

  /// A finished source from planar buffers (tests, generated audio).
  [[nodiscard]] static std::shared_ptr<SourceData> from_planes(const std::vector<std::vector<float>>& planes,
                                                               double sampleRate);

  [[nodiscard]] int channels() const noexcept { return channels_; }
  [[nodiscard]] double sample_rate() const noexcept { return sampleRate_; }
  [[nodiscard]] std::int64_t frames_ready() const noexcept { return ready_.load(std::memory_order_acquire); }
  /// Total frames once complete, else −1.
  [[nodiscard]] std::int64_t total_frames() const noexcept {
    return complete_.load(std::memory_order_acquire) ? ready_.load(std::memory_order_acquire) : -1;
  }
  [[nodiscard]] bool complete() const noexcept { return complete_.load(std::memory_order_acquire); }
  [[nodiscard]] bool failed() const noexcept { return failed_.load(std::memory_order_acquire); }
  /// Sample `i` of channel `ch` (0 outside [0, frames_ready)). Lock-free.
  [[nodiscard]] float at(int ch, std::int64_t i) const noexcept {
    if (i < 0 || i >= ready_.load(std::memory_order_acquire)) return 0;
    const auto u = static_cast<std::size_t>(i);
    const float* chunk = chunks_[u >> kChunkShift].load(std::memory_order_relaxed);
    return chunk[static_cast<std::size_t>(ch) * kChunk + (u & (kChunk - 1))];
  }
  /// Copy frames [from, from+n) of channel `ch` (zeros outside).
  void read(int ch, std::int64_t from, float* out, std::size_t n) const noexcept;

  // ── writer (one thread) ──
  /// Append planar frames. Returns false when the table is full (truncated).
  bool append(const float* const* planes, std::size_t n);
  void finish();
  void fail(std::string message);
  [[nodiscard]] std::string error() const;

  /// Block until `frames` are ready or the source is complete/failed.
  bool wait_for(std::int64_t frames) const;

  /// Waveform peaks (built while conforming). Guarded: queries run off the
  /// audio thread, concurrently with the decoder.
  template <class F>
  auto with_peaks(const F& f) const {
    const std::scoped_lock lock(peakMu_);
    return f(peaks_);
  }

  [[nodiscard]] std::size_t bytes() const noexcept;

 private:
  int channels_;
  double sampleRate_;
  std::size_t capacity_;  // chunks
  // Sized once at construction and never resized: readers index it without
  // a lock while the writer publishes chunk pointers into it.
  std::vector<std::atomic<float*>> chunks_;
  // Chunk storage (writer only). A moved std::vector keeps its buffer, so the
  // published pointers stay valid when `owned_` grows.
  std::vector<std::vector<float>> owned_;
  std::atomic<std::int64_t> ready_{0};
  std::atomic<bool> complete_{false};
  std::atomic<bool> failed_{false};
  mutable std::mutex mu_;
  mutable std::condition_variable cv_;
  std::string error_;
  mutable std::mutex peakMu_;
  PeakPyramid peaks_;
};

using SourcePtr = std::shared_ptr<const SourceData>;

}  // namespace premation::audio
