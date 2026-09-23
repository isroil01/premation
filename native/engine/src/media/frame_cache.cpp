#include "frame_cache.hpp"

#include <utility>

namespace premation::media {

void FrameCache::put(std::uint32_t source, std::int64_t index, FramePtr frame) {
  if (!frame) return;
  const std::scoped_lock lock(mu_);
  const Key key{source, index};
  if (const auto found = byKey_.find(key); found != byKey_.end()) erase_locked(found->second);
  cpuBytes_ += frame->cpuBytes;
  gpuBytes_ += frame->gpuBytes;
  lru_.push_front(Entry{key, std::move(frame)});
  byKey_.emplace(key, lru_.begin());
  bySource_[source].emplace(index, lru_.begin());
  evict_locked();
}

FramePtr FrameCache::get(std::uint32_t source, std::int64_t index) {
  const std::scoped_lock lock(mu_);
  const auto it = byKey_.find(Key{source, index});
  if (it == byKey_.end()) {
    ++misses_;
    return nullptr;
  }
  ++hits_;
  lru_.splice(lru_.begin(), lru_, it->second);  // iterators stay valid
  return it->second->frame;
}

bool FrameCache::contains(std::uint32_t source, std::int64_t index) const {
  const std::scoped_lock lock(mu_);
  return byKey_.contains(Key{source, index});
}

FramePtr FrameCache::nearest(std::uint32_t source, std::int64_t index) const {
  const std::scoped_lock lock(mu_);
  const auto s = bySource_.find(source);
  if (s == bySource_.end() || s->second.empty()) return nullptr;
  const auto& m = s->second;
  auto hi = m.lower_bound(index);
  if (hi == m.end()) return std::prev(hi)->second->frame;
  if (hi->first == index || hi == m.begin()) return hi->second->frame;
  auto lo = std::prev(hi);
  return (index - lo->first) <= (hi->first - index) ? lo->second->frame : hi->second->frame;
}

void FrameCache::drop_source(std::uint32_t source) {
  const std::scoped_lock lock(mu_);
  const auto s = bySource_.find(source);
  if (s == bySource_.end()) return;
  // Copy the iterators first: erase_locked edits bySource_.
  std::vector<List::iterator> its;
  its.reserve(s->second.size());
  for (const auto& [idx, it] : s->second) its.push_back(it);
  for (const auto it : its) erase_locked(it);
  bySource_.erase(source);
}

void FrameCache::clear() {
  const std::scoped_lock lock(mu_);
  lru_.clear();
  byKey_.clear();
  bySource_.clear();
  cpuBytes_ = 0;
  gpuBytes_ = 0;
}

void FrameCache::set_budgets(std::size_t cpuBudget, std::size_t gpuBudget) {
  const std::scoped_lock lock(mu_);
  cpuBudget_ = cpuBudget;
  gpuBudget_ = gpuBudget;
  evict_locked();
}

CacheStats FrameCache::stats() const {
  const std::scoped_lock lock(mu_);
  return {lru_.size(), cpuBytes_, gpuBytes_, hits_, misses_, evictions_};
}

void FrameCache::evict_locked() {
  // Evict the least recently used frame of the KIND that is over budget (a CPU
  // frame never makes room for VRAM, nor the reverse). The entry just inserted
  // (the front) is never evicted: the newest frame always fits.
  while (lru_.size() > 1) {
    const bool cpuOver = cpuBytes_ > cpuBudget_;
    const bool gpuOver = gpuBytes_ > gpuBudget_;
    if (!cpuOver && !gpuOver) return;
    auto victim = lru_.end();
    for (auto it = std::prev(lru_.end()); it != lru_.begin(); --it) {
      if ((cpuOver && it->frame->cpuBytes > 0) || (gpuOver && it->frame->gpuBytes > 0)) {
        victim = it;
        break;
      }
    }
    if (victim == lru_.end()) return;  // only the newest frame holds the over-budget kind
    erase_locked(victim);
    ++evictions_;
  }
}

void FrameCache::erase_locked(List::iterator it) {
  const Key key = it->key;
  cpuBytes_ -= it->frame->cpuBytes;
  gpuBytes_ -= it->frame->gpuBytes;
  byKey_.erase(key);
  if (const auto s = bySource_.find(key.source); s != bySource_.end()) {
    s->second.erase(key.index);
    if (s->second.empty()) bySource_.erase(s);
  }
  lru_.erase(it);
}

}  // namespace premation::media
