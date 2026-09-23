// MediaSystem — footage decode for the engine (plan §5 E1).
//
//   open(path)      probe on the caller's thread (container, codec, rate, colour,
//                   alpha, the frame index when the container has one); the
//                   source's worker thread then opens the decoder (hardware when
//                   the platform decoder takes the stream, else software).
//   request(i)      non-blocking: the frame if cached, else the worker is told.
//   wait(i)         blocking (export, tests, the bench).
//   playhead(i, d)  playback hint: the worker reads ahead in direction d.
//
// One worker thread per source (libavcodec's own slice/frame threads under
// it), one shared FrameCache (LRU by bytes, CPU and GPU budgets).
//
// Latest-wins (the scrub lane). The TS pipeline's known scrub problem was
// uncancelled serial GOP decodes: every scrub position queued a full GOP decode
// behind the last. Here a `latest` request REPLACES the pending one and bumps a
// generation the worker checks between packets. The in-flight decode then:
//   * RETARGETS when the new frame is further along the same GOP (no restart);
//   * FINISHES when its estimated remaining work is under keepInFlightMs, or
//     when nothing has been delivered for starvationMs (so continuous fast
//     scrubbing still shows frames — exactVideoSource.ts's two rules);
//   * otherwise is ABANDONED and the worker seeks straight to the newest target.
// `exact` requests (export, analysis) are never superseded.
// The clock reads here schedule work; they never decide a pixel (a frame is
// the same frame whichever order it was decoded in).
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

#include "decoder.hpp"
#include "frame_cache.hpp"
#include "frame_index.hpp"
#include "media_types.hpp"

namespace premation::media {

using SourceId = std::uint32_t;

enum class Lane : std::uint8_t {
  latest,  // viewport / scrub: a newer request supersedes this one
  exact,   // export / analysis: always decoded, in order
};

struct MediaConfig {
  std::size_t cpuCacheBytes = std::size_t{2} << 30U;  // 2 GiB of decoded CPU frames
  std::size_t gpuCacheBytes = std::size_t{1} << 30U;  // 1 GiB of GPU-resident hardware frames
  HwPolicy hw = HwPolicy::automatic;
  std::shared_ptr<HwContext> hwContext;  // null → software decode
  bool keepOnGpu = true;
  bool keepHighBitOnGpu = false;  // see DecoderOptions
  int decodeThreads = 0;
  /// Frames decoded ahead of the playhead during playback (capped by half the
  /// cache's capacity in frames of this source, as streamPlanFor does).
  int readahead = 12;
  double keepInFlightMs = 120;
  double starvationMs = 400;
  /// Build the exact presentation index for long-GOP streams whose container
  /// can't give it, with a demux-only scan on a background thread (the source
  /// is usable at once on a constant-rate index; the exact one replaces it).
  bool scanIndex = true;
};

struct SourceStats {
  DecodePath path = DecodePath::software;
  bool ready = false;
  std::string error;
  std::uint64_t framesDecoded = 0;
  std::uint64_t seeks = 0;
  std::uint64_t retargets = 0;   // latest request absorbed into the running GOP decode
  std::uint64_t abandoned = 0;   // in-flight decode dropped for a newer target
  std::uint64_t kept = 0;        // in-flight decode finished despite a newer target (keep/starvation rule)
  std::uint64_t superseded = 0;  // latest requests replaced before they started
  double msPerFrame = 0;         // EMA of decode time per frame
  double indexScanMs = -1;       // background index scan time (-1: none ran / not finished)
};

class MediaSystem {
 public:
  explicit MediaSystem(MediaConfig config);
  ~MediaSystem();
  MediaSystem(const MediaSystem&) = delete;
  MediaSystem& operator=(const MediaSystem&) = delete;
  MediaSystem(MediaSystem&&) = delete;
  MediaSystem& operator=(MediaSystem&&) = delete;

  [[nodiscard]] std::optional<SourceId> open(const std::string& path, std::string& error);
  void close(SourceId id);

  [[nodiscard]] bool info(SourceId id, MediaInfo& out) const;
  // shared_ptr: the index is swapped when the worker's exact scan finishes, while
  // render/scene threads may still be mapping times with the old one.
  [[nodiscard]] std::shared_ptr<const FrameIndex> index(SourceId id) const;
  /// Block until the worker has opened the decoder (or failed). False on failure.
  bool wait_ready(SourceId id, std::chrono::milliseconds timeout);

  [[nodiscard]] FramePtr cached(SourceId id, std::int64_t frame);
  [[nodiscard]] FramePtr nearest(SourceId id, std::int64_t frame) const;
  /// The frame if cached; else schedules it (latest lane: replaces the previous latest request).
  FramePtr request(SourceId id, std::int64_t frame, Lane lane = Lane::latest);
  /// Request and block until it is decoded, fails, or `timeout` passes (then nullptr).
  FramePtr wait(SourceId id, std::int64_t frame, Lane lane, std::chrono::milliseconds timeout);
  /// Playback hint: read ahead from `frame` in `direction` (+1, −1; 0 stops).
  void playhead(SourceId id, std::int64_t frame, int direction);

  [[nodiscard]] SourceStats stats(SourceId id) const;
  [[nodiscard]] CacheStats cache_stats() const { return cache_.stats(); }
  [[nodiscard]] FrameCache& cache() noexcept { return cache_; }
  [[nodiscard]] const MediaConfig& config() const noexcept { return config_; }

 /// One open source's state (defined in media_system.cpp; opaque here).
  struct Source;

 private:
  void run(Source& s);
  /// Decode until `target` is cached. Returns false when abandoned for a newer latest target.
  bool decode_to(Source& s, VideoDecoder& dec, std::int64_t target, Lane lane, bool readahead);
  [[nodiscard]] std::shared_ptr<Source> find(SourceId id) const;
  void signal();
  void shutdown();

  MediaConfig config_;
  FrameCache cache_;
  mutable std::mutex mu_;
  // shared_ptr: a Source is reached by the API (any thread) and owned by its
  // worker loop; close() drops the map's reference while the worker finishes.
  std::unordered_map<SourceId, std::shared_ptr<Source>> sources_;
  SourceId next_ = 1;
  /// Signalled on every decoded frame / failure (wait()).
  std::mutex doneMu_;
  std::condition_variable done_;
};

}  // namespace premation::media
