// An insertion-ordered string-keyed map — JavaScript `Map` / object key order.
//
// The TypeScript engine's observable output depends on iteration order in
// several places (a node's animation tracks in `Object.keys(snapshot.tracks)`
// order, compositions in `Object.keys(comps)` order, scene nodes in insertion
// order), so the C++ document keeps the same order instead of sorting. Lookups
// go through a hash index; erasure is O(n) (rare, and n is a layer count).
#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace premation::doc {

struct StringHash {
  using is_transparent = void;
  std::size_t operator()(std::string_view s) const noexcept { return std::hash<std::string_view>{}(s); }
};

template <class V>
class OrderedMap {
 public:
  using Entry = std::pair<std::string, V>;

  [[nodiscard]] std::size_t size() const noexcept { return entries_.size(); }
  [[nodiscard]] bool empty() const noexcept { return entries_.empty(); }
  [[nodiscard]] auto begin() const noexcept { return entries_.begin(); }
  [[nodiscard]] auto end() const noexcept { return entries_.end(); }
  [[nodiscard]] auto begin() noexcept { return entries_.begin(); }
  [[nodiscard]] auto end() noexcept { return entries_.end(); }
  [[nodiscard]] const std::vector<Entry>& entries() const noexcept { return entries_; }

  [[nodiscard]] const V* find(std::string_view k) const {
    const auto it = index_.find(k);
    return it == index_.end() ? nullptr : &entries_[it->second].second;
  }
  [[nodiscard]] V* find(std::string_view k) {
    const auto it = index_.find(k);
    return it == index_.end() ? nullptr : &entries_[it->second].second;
  }
  [[nodiscard]] bool contains(std::string_view k) const { return index_.find(k) != index_.end(); }
  [[nodiscard]] std::size_t index_of(std::string_view k) const {
    const auto it = index_.find(k);
    return it == index_.end() ? entries_.size() : it->second;
  }

  /// `map.set(k, v)`: replace in place, else append.
  V& set(std::string_view k, V v) {
    if (V* cur = find(k)) {
      *cur = std::move(v);
      return *cur;
    }
    index_.emplace(std::string(k), entries_.size());
    entries_.emplace_back(std::string(k), std::move(v));
    return entries_.back().second;
  }
  /// Insert at `pos` (clamped) — a restore that puts an entry back where it was.
  V& insert_at(std::size_t pos, std::string_view k, V v) {
    if (V* cur = find(k)) {
      *cur = std::move(v);
      return *cur;
    }
    pos = pos > entries_.size() ? entries_.size() : pos;
    entries_.insert(entries_.begin() + static_cast<std::ptrdiff_t>(pos), Entry{std::string(k), std::move(v)});
    reindex(pos);
    return entries_[pos].second;
  }
  bool erase(std::string_view k) {
    const auto it = index_.find(k);
    if (it == index_.end()) return false;
    const std::size_t pos = it->second;
    index_.erase(it);
    entries_.erase(entries_.begin() + static_cast<std::ptrdiff_t>(pos));
    reindex(pos);
    return true;
  }
  void clear() {
    entries_.clear();
    index_.clear();
  }
  [[nodiscard]] std::vector<std::string> keys() const {
    std::vector<std::string> out;
    out.reserve(entries_.size());
    for (const auto& e : entries_) out.push_back(e.first);
    return out;
  }
  /// Reorder to `order` (keys not listed keep their relative order at the end).
  void reorder(const std::vector<std::string>& order) {
    std::vector<Entry> next;
    next.reserve(entries_.size());
    std::vector<bool> taken(entries_.size(), false);
    for (const auto& k : order) {
      const auto it = index_.find(k);
      if (it == index_.end() || taken[it->second]) continue;
      taken[it->second] = true;
      next.push_back(std::move(entries_[it->second]));
    }
    for (std::size_t i = 0; i < entries_.size(); ++i) {
      if (!taken[i]) next.push_back(std::move(entries_[i]));
    }
    entries_ = std::move(next);
    index_.clear();
    reindex(0);
  }

  friend bool operator==(const OrderedMap& a, const OrderedMap& b) { return a.entries_ == b.entries_; }

 private:
  void reindex(std::size_t from) {
    for (std::size_t i = from; i < entries_.size(); ++i) index_[entries_[i].first] = i;
  }
  std::vector<Entry> entries_;
  std::unordered_map<std::string, std::size_t, StringHash, std::equal_to<>> index_;
};

}  // namespace premation::doc
