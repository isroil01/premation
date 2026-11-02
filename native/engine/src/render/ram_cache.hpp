// The RAM tier of the preview cache — After Effects' RAM cache (the green bar):
// finished viewport frames kept in system memory, between the VRAM frame cache
// (frame_cache.hpp, small and fast) and the disk tier (disk_cache.hpp, large
// and slow). A loop longer than VRAM holds plays back from here: a hit is one
// upload of the frame's pixels instead of its render.
//
//  * Filled from VRAM: a frame the VRAM cache evicts is read back into this
//    tier (render_thread.cpp `on_vram_evict`), so a range that fits VRAM costs
//    no read-back at all, and the frames past it land here instead of being lost.
//  * Sized from the machine (`auto_ram_budget`): half the installed memory,
//    leaving at least 4 GiB to everything else, and shrunk at once when the
//    system runs short (the render thread watches free memory).
//  * No thrash on long loops. Plain LRU over a looped range larger than the
//    cache evicts, every time, the very frame the next pass needs first: no hit
//    ever. So a frame of the range being played (`ProtectedRange`: same scope,
//    index inside the play range) is never evicted to make room; once the
//    cache is full of them, new frames of that range are refused and the
//    cached part keeps playing in real time (AE keeps what it has cached too).
//    Frames of another comp, an older document state or outside the range go
//    first, least recently used first.
//  * Evicted frames are handed back to the caller, which writes the slow ones
//    to the disk tier (they are already in memory: no GPU read-back).
//
// Render-thread only, like the VRAM cache: no locking.
#pragma once

#include <array>
#include <span>
#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

namespace premation::render {

/// Where a cached frame sits, for the eviction rule. `scope` names the
/// composition plus the document and view state the frame was drawn for
/// (RenderJob::cacheScope); `frame` is its index in that composition.
struct FrameTag {
  std::uint64_t scope = 0;
  std::int64_t frame = -1;
};

/// The frames eviction keeps: those of `scope` with an index in [first, last]
/// (the play range: the work area, a custom range or the whole comp), and the
/// frames `pinned` by key — the frame each open surface shows NOW (the comp
/// viewport's, the Layer panel's, a pop-out's). A store for one view used to
/// evict another view's current frame, which then blinked (a build) on its
/// next draw; a pinned frame is never evicted to make room, whatever its scope.
struct ProtectedRange {
  std::uint64_t scope = 0;
  std::int64_t first = 0;
  std::int64_t last = -1;
  /// Content keys of every open surface's current frame (0 = none). Fixed
  /// size: no allocation on the render thread's per-frame path.
  static constexpr std::size_t kMaxPinned = 8;
  std::array<std::uint64_t, kMaxPinned> pinned{};
  [[nodiscard]] bool covers(const FrameTag& t) const noexcept {
    return scope != 0 && t.scope == scope && t.frame >= first && t.frame <= last;
  }
  [[nodiscard]] bool pins(std::uint64_t key) const noexcept {
    if (key == 0) return false;
    for (const std::uint64_t k : pinned) {
      if (k == key) return true;
    }
    return false;
  }
  /// Whether eviction must keep the entry `key` tagged `t`.
  [[nodiscard]] bool keeps(std::uint64_t key, const FrameTag& t) const noexcept { return covers(t) || pins(key); }
  /// Pin `key` (a no-op when 0 or already pinned; the oldest pin goes when all slots are taken).
  void pin(std::uint64_t key) noexcept {
    if (key == 0 || pins(key)) return;
    for (std::uint64_t& k : pinned) {
      if (k == 0) {
        k = key;
        return;
      }
    }
    const std::span<std::uint64_t> slots(pinned);
    for (std::size_t i = 1; i < kMaxPinned; ++i) slots[i - 1] = slots[i];
    slots.back() = key;
  }
  void clear_pins() noexcept { pinned.fill(0); }
};

/// One frame in the RAM tier.
struct RamFrame {
  /// RGBA8, width × height, rows tightly packed. shared_ptr: a hit hands the
  /// pixels to the GPU upload while the cache stays free to evict the entry,
  /// and an evicted frame on its way to the disk writer is moved, not copied,
  /// when nothing else holds it.
  std::shared_ptr<std::vector<std::uint8_t>> rgba;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  /// What drawing it cost, ms (the disk tier takes only frames slower than a read).
  double drawMs = 0;
  /// Its disk-cache key (0 = it never goes to disk).
  std::uint64_t diskKey = 0;
  FrameTag tag;
  [[nodiscard]] std::size_t bytes() const noexcept { return std::size_t{width} * height * 4; }
};

struct RamCacheStats {
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;
  std::uint64_t stores = 0;
  std::uint64_t evictions = 0;
  /// Frames not kept: the cache was full of frames of the range being played.
  std::uint64_t refused = 0;
  std::size_t entries = 0;
  std::size_t bytes = 0;
  std::size_t budget = 0;
};

/// The RAM tier's default size on a machine with `physicalBytes` installed:
/// half of it, leaving at least 4 GiB to everything else, within [512 MiB, 64 GiB].
/// A small machine (12 GiB or less — an 8 GiB laptop) gets a quarter: Chromium,
/// the engine's own textures, decode buffers and the integrated GPU's frame
/// cache all live in that same memory, and half of it in frames paged the
/// rest out. Unknown memory (0) gets 2 GiB.
[[nodiscard]] inline std::uint64_t auto_ram_budget(std::uint64_t physicalBytes) noexcept {
  constexpr std::uint64_t kGiB = std::uint64_t{1} << 30U;
  if (physicalBytes == 0) return 2 * kGiB;
  const std::uint64_t half = physicalBytes <= 12 * kGiB ? physicalBytes / 4 : physicalBytes / 2;
  const std::uint64_t leave = physicalBytes > 4 * kGiB ? physicalBytes - 4 * kGiB : 0;
  const std::uint64_t want = half < leave ? half : leave;
  if (want < kGiB / 2) return kGiB / 2;
  return want > 64 * kGiB ? 64 * kGiB : want;
}

/// The tier's limit now, holding `held` bytes, on a machine with `physicalBytes`
/// installed and `availableBytes` free: `target`, but never pushing the machine
/// into its page file — a reserve stays free for the system and the other
/// applications (AE's "RAM reserved for other applications"). Free memory above
/// the reserve is room to grow; free memory below it is given back, so a model
/// worker loading next to a full cache pages out cached frames, not the editor.
/// A shortfall under 256 MiB is ignored: the limit does not chase every reading.
/// Unknown memory (0) leaves `target`.
[[nodiscard]] inline std::uint64_t ram_budget_now(std::uint64_t target, std::uint64_t held, std::uint64_t physicalBytes,
                                                  std::uint64_t availableBytes) noexcept {
  if (physicalBytes == 0 || availableBytes == 0) return target;
  constexpr std::uint64_t kMiB = std::uint64_t{1} << 20U;
  const std::uint64_t reserve = physicalBytes / 10 > 1536 * kMiB ? physicalBytes / 10 : 1536 * kMiB;
  std::uint64_t limit = held;
  if (availableBytes >= reserve) {
    limit = held + (availableBytes - reserve);
  } else if (const std::uint64_t shortfall = reserve - availableBytes; shortfall >= 256 * kMiB) {
    limit = held > shortfall ? held - shortfall : 0;
  }
  return limit < target ? limit : target;
}

class RamFrameCache {
 public:
  explicit RamFrameCache(std::size_t budgetBytes = 0) : budget_(budgetBytes) {}

  [[nodiscard]] std::size_t budget() const noexcept { return budget_; }
  [[nodiscard]] std::size_t bytes() const noexcept { return bytes_; }
  [[nodiscard]] bool contains(std::uint64_t key) const { return index_.contains(key); }

  /// A new size limit. A smaller one evicts least recently used frames down
  /// to it — protected ones too: the machine running short of memory comes
  /// before the play range. Evicted frames go to `evicted`.
  void set_budget(std::size_t budgetBytes, std::vector<RamFrame>& evicted) {
    budget_ = budgetBytes;
    while (bytes_ > budget_ && !lru_.empty()) evict(std::prev(lru_.end()), evicted);
  }

  /// `key`'s frame at width × height, now the most recently used and tagged
  /// `tag` (a hit under a new scope belongs to that scope now). nullopt = a miss.
  [[nodiscard]] std::optional<RamFrame> find(std::uint64_t key, std::uint32_t width, std::uint32_t height, const FrameTag& tag) {
    const auto it = index_.find(key);
    if (it == index_.end() || it->second->frame.width != width || it->second->frame.height != height) {
      ++stats_.misses;
      return std::nullopt;
    }
    lru_.splice(lru_.begin(), lru_, it->second);
    it->second->frame.tag = tag;
    ++stats_.hits;
    return it->second->frame;
  }

  /// Whether `store` would keep a frame of `bytes` tagged `tag` under `protect` (no side effect).
  [[nodiscard]] bool would_keep(std::size_t bytes, const ProtectedRange& protect) const {
    if (bytes == 0 || bytes > budget_) return false;
    if (bytes_ + bytes <= budget_) return true;
    std::size_t freeable = 0;
    for (const Entry& e : lru_) {
      if (!protect.keeps(e.key, e.frame.tag)) freeable += e.frame.bytes();
      if (bytes_ - freeable + bytes <= budget_) return true;
    }
    return false;
  }

  /// Keep `frame` as `key`'s. Room is made by evicting least recently used
  /// frames that `protect` does not cover (into `evicted`); when that is not
  /// enough the frame is refused (false) and nothing is evicted. A key already
  /// here is refreshed (most recently used, re-tagged), not stored twice.
  bool store(std::uint64_t key, RamFrame frame, const ProtectedRange& protect, std::vector<RamFrame>& evicted) {
    if (const auto it = index_.find(key); it != index_.end()) {
      lru_.splice(lru_.begin(), lru_, it->second);
      it->second->frame.tag = frame.tag;
      return true;
    }
    const std::size_t need = frame.bytes();
    if (frame.rgba == nullptr || frame.rgba->size() < need || !would_keep(need, protect)) {
      ++stats_.refused;
      return false;
    }
    for (auto it = lru_.end(); bytes_ + need > budget_ && it != lru_.begin();) {
      --it;
      if (protect.keeps(it->key, it->frame.tag)) continue;
      it = evict(it, evicted);
    }
    lru_.push_front(Entry{key, std::move(frame)});
    index_.emplace(key, lru_.begin());
    bytes_ += need;
    ++stats_.stores;
    return true;
  }

  /// Drop every frame (Purge ▸ All Memory).
  void clear() {
    lru_.clear();
    index_.clear();
    bytes_ = 0;
  }

  [[nodiscard]] RamCacheStats stats() const {
    RamCacheStats s = stats_;
    s.entries = index_.size();
    s.bytes = bytes_;
    s.budget = budget_;
    return s;
  }

 private:
  struct Entry {
    std::uint64_t key = 0;
    RamFrame frame;
  };
  using Iter = std::list<Entry>::iterator;

  /// Remove `it` (its frame into `evicted`); returns the iterator after it.
  Iter evict(Iter it, std::vector<RamFrame>& evicted) {
    bytes_ -= it->frame.bytes();
    index_.erase(it->key);
    evicted.push_back(std::move(it->frame));
    ++stats_.evictions;
    return lru_.erase(it);
  }

  std::size_t budget_ = 0;
  std::size_t bytes_ = 0;
  /// Front = most recently used.
  std::list<Entry> lru_;
  std::unordered_map<std::uint64_t, Iter> index_;
  RamCacheStats stats_;
};

}  // namespace premation::render
