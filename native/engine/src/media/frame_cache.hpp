// Decoded-frame cache: LRU by bytes, keyed by (source, presentation index),
// with separate CPU and GPU budgets (a hardware frame that stayed on the GPU
// costs VRAM, not RAM). Thread-safe: decode threads insert, the render thread
// reads. Frames are shared (see FramePtr) so eviction never pulls a frame out
// from under a reader.
#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <unordered_map>

#include "decoded_frame.hpp"

namespace premation::media {

// shared_ptr, not unique_ptr: a frame is owned jointly by the cache and by
// whoever is reading it (the GPU conversion on the render thread, a decode
// request's waiter). Eviction drops only the cache's reference; the planes /
// surface are released when the last reader is done, on whichever thread.
using FramePtr = std::shared_ptr<const DecodedFrame>;

struct CacheStats {
  std::size_t frames = 0;
  std::size_t cpuBytes = 0;
  std::size_t gpuBytes = 0;
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;
  std::uint64_t evictions = 0;
};

class FrameCache {
 public:
  FrameCache(std::size_t cpuBudget, std::size_t gpuBudget) : cpuBudget_(cpuBudget), gpuBudget_(gpuBudget) {}

  /// Insert (or refresh) a frame and evict least-recently-used frames over budget.
  /// A frame bigger than the whole budget is still kept (alone): the newest frame always fits.
  void put(std::uint32_t source, std::int64_t index, FramePtr frame);
  /// The frame, marking it most recently used; nullptr on a miss.
  [[nodiscard]] FramePtr get(std::uint32_t source, std::int64_t index);
  /// Presence without touching LRU order or the hit counters.
  [[nodiscard]] bool contains(std::uint32_t source, std::int64_t index) const;
  /// The cached frame of `source` closest to `index` (ties → the earlier one); nullptr if none.
  [[nodiscard]] FramePtr nearest(std::uint32_t source, std::int64_t index) const;
  void drop_source(std::uint32_t source);
  void clear();
  void set_budgets(std::size_t cpuBudget, std::size_t gpuBudget);
  [[nodiscard]] CacheStats stats() const;

 private:
  struct Key {
    std::uint32_t source = 0;
    std::int64_t index = 0;
    friend bool operator==(const Key&, const Key&) = default;
  };
  struct KeyHash {
    std::size_t operator()(const Key& k) const noexcept {
      return std::hash<std::int64_t>{}(k.index * 1'000'003 + static_cast<std::int64_t>(k.source));
    }
  };
  struct Entry {
    Key key;
    FramePtr frame;
  };
  using List = std::list<Entry>;

  void evict_locked();
  void erase_locked(List::iterator it);

  mutable std::mutex mu_;
  List lru_;  // front = most recent
  std::unordered_map<Key, List::iterator, KeyHash> byKey_;
  std::unordered_map<std::uint32_t, std::map<std::int64_t, List::iterator>> bySource_;
  std::size_t cpuBudget_;
  std::size_t gpuBudget_;
  std::size_t cpuBytes_ = 0;
  std::size_t gpuBytes_ = 0;
  std::uint64_t hits_ = 0;
  std::uint64_t misses_ = 0;
  std::uint64_t evictions_ = 0;
};

}  // namespace premation::media
