// A bounded, value-keyed LRU for the rig's rest-state products (rig_mesh.cpp:
// rest meshes, harmonic weights, ARAP factors, bone weights; rig_coverage.cpp:
// decoded alpha coverage). Keys are the full serialised inputs that determine a
// value, never an identity or a time, so a hit hands back exactly what a miss
// would compute (same input, same bytes — CLAUDE.md determinism); values are
// immutable once stored. Bounded by entry count AND a byte budget (a dense
// Cholesky factor is m² doubles), least recently used out first. One mutex per
// cache; the work that fills an entry runs outside it, and on a race the first
// value stored wins (both are bit-identical).
#pragma once

#include <cstddef>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

namespace premation::scene::rig {

struct RigCacheStats {
  std::size_t entries = 0;
  std::size_t bytes = 0;
  std::size_t hits = 0;
  std::size_t misses = 0;
};

template <class V>
class ValueLru {
 public:
  ValueLru(std::size_t maxEntries, std::size_t maxBytes) : maxEntries_(maxEntries), maxBytes_(maxBytes) {}

  /// The value stored under `key` (bumped to most recent), or null.
  [[nodiscard]] std::shared_ptr<const V> find(const std::string& key) {
    const std::scoped_lock lock(mu_);
    const auto it = map_.find(key);
    if (it == map_.end()) {
      ++misses_;
      return nullptr;
    }
    ++hits_;
    order_.splice(order_.begin(), order_, it->second.at);
    return it->second.value;
  }

  /// Stores `value` (`bytes` its estimated size) and returns what the cache now
  /// holds for `key`: the value already there when another thread stored first.
  std::shared_ptr<const V> insert(std::string key, std::shared_ptr<const V> value, std::size_t bytes) {
    const std::scoped_lock lock(mu_);
    if (const auto it = map_.find(key); it != map_.end()) {
      order_.splice(order_.begin(), order_, it->second.at);
      return it->second.value;
    }
    order_.push_front(key);
    map_.emplace(std::move(key), Node{value, bytes, order_.begin()});
    bytes_ += bytes;
    while (map_.size() > maxEntries_ || (bytes_ > maxBytes_ && map_.size() > 1)) {
      const auto victim = map_.find(order_.back());
      bytes_ -= victim->second.bytes;
      map_.erase(victim);
      order_.pop_back();
    }
    return value;
  }

  void clear() {
    const std::scoped_lock lock(mu_);
    map_.clear();
    order_.clear();
    bytes_ = 0;
    hits_ = 0;
    misses_ = 0;
  }

  [[nodiscard]] RigCacheStats stats() {
    const std::scoped_lock lock(mu_);
    return RigCacheStats{map_.size(), bytes_, hits_, misses_};
  }

 private:
  struct Node {
    std::shared_ptr<const V> value;
    std::size_t bytes = 0;
    std::list<std::string>::iterator at;
  };
  std::mutex mu_;
  std::list<std::string> order_;  ///< most recent first
  std::unordered_map<std::string, Node> map_;
  std::size_t maxEntries_;
  std::size_t maxBytes_;
  std::size_t bytes_ = 0;
  std::size_t hits_ = 0;
  std::size_t misses_ = 0;
};

/// FNV-1a 64 over bytes — the cache keys' digest (the full key bytes are what
/// the map compares; the digest only names a value in a key string).
class Fnv64 {
 public:
  void bytes(const void* p, std::size_t n) noexcept {
    const auto* b = static_cast<const unsigned char*>(p);
    for (std::size_t i = 0; i < n; ++i) h_ = (h_ ^ b[i]) * 1099511628211ULL;
  }
  template <class T>
  void pod(const T& v) noexcept {
    bytes(&v, sizeof(T));
  }
  [[nodiscard]] unsigned long long value() const noexcept { return h_; }
  [[nodiscard]] std::string hex() const {
    static constexpr char kDigits[] = "0123456789abcdef";
    std::string s(16, '0');
    unsigned long long v = h_;
    for (std::size_t i = 16; i-- > 0;) {
      s[i] = kDigits[v & 15U];
      v >>= 4U;
    }
    return s;
  }

 private:
  unsigned long long h_ = 14695981039346656037ULL;
};

}  // namespace premation::scene::rig
