#include "history.hpp"

#include <algorithm>
#include <utility>

namespace premation::doc {
namespace {

template <class Change, class Id>
Change* find_change(std::vector<Change>& v, const Id& id) {
  for (auto& c : v) {
    if (c.id == id) return &c;
  }
  return nullptr;
}

void put_layer(Document& d, const api::LayerId& id, const std::optional<Layer>& state) {
  if (state) {
    d.layers.insert_or_assign(id, *state);
  } else {
    d.layers.erase(id);
  }
}

void put_comp(Document& d, const api::ItemId& id, const std::optional<Comp>& state) {
  const bool existed = d.comps.contains(id);
  if (state) {
    d.comps.insert_or_assign(id, *state);
    if (!existed) d.itemOrder.push_back(id);
  } else {
    d.comps.erase(id);
    std::erase(d.itemOrder, id);
  }
}

}  // namespace

void ChangeSet::touch_layer(const Document& d, const api::LayerId& id) {
  if (find_change(layers, id) != nullptr) return;
  LayerChange c;
  c.id = id;
  if (const Layer* l = d.layer(id)) c.before = *l;
  layers.push_back(std::move(c));
}

void ChangeSet::touch_comp(const Document& d, const api::ItemId& id) {
  if (find_change(comps, id) != nullptr) return;
  CompChange c;
  c.id = id;
  if (const Comp* k = d.comp(id)) c.before = *k;
  comps.push_back(std::move(c));
}

void ChangeSet::seal(const Document& d) {
  for (auto& c : layers) {
    const Layer* l = d.layer(c.id);
    c.after = l != nullptr ? std::optional<Layer>(*l) : std::nullopt;
  }
  for (auto& c : comps) {
    const Comp* k = d.comp(c.id);
    c.after = k != nullptr ? std::optional<Comp>(*k) : std::nullopt;
  }
}

void ChangeSet::apply_before(Document& d) const {
  // Comps first when restoring deletions is irrelevant here (layers and comps
  // are independent maps); reverse order keeps itemOrder appends stable.
  for (auto it = comps.rbegin(); it != comps.rend(); ++it) put_comp(d, it->id, it->before);
  for (auto it = layers.rbegin(); it != layers.rend(); ++it) put_layer(d, it->id, it->before);
}

void ChangeSet::apply_after(Document& d) const {
  for (const auto& c : comps) put_comp(d, c.id, c.after);
  for (const auto& c : layers) put_layer(d, c.id, c.after);
}

void ChangeSet::merge(const ChangeSet& later) {
  for (const auto& c : later.layers) {
    if (LayerChange* mine = find_change(layers, c.id)) {
      mine->after = c.after;
    } else {
      layers.push_back(c);
    }
  }
  for (const auto& c : later.comps) {
    if (CompChange* mine = find_change(comps, c.id)) {
      mine->after = c.after;
    } else {
      comps.push_back(c);
    }
  }
}

void ChangeSet::prune() {
  std::erase_if(layers, [](const LayerChange& c) { return c.before == c.after; });
  std::erase_if(comps, [](const CompChange& c) { return c.before == c.after; });
}

ChangeSet ChangeSet::reversed() const {
  ChangeSet r;
  r.layers.reserve(layers.size());
  for (auto it = layers.rbegin(); it != layers.rend(); ++it) r.layers.push_back({it->id, it->after, it->before});
  r.comps.reserve(comps.size());
  for (auto it = comps.rbegin(); it != comps.rend(); ++it) r.comps.push_back({it->id, it->after, it->before});
  return r;
}

void History::record(std::string label, api::Origin origin, ChangeSet changes) {
  if (changes.empty()) return;
  if (gesture_) {
    gesture_->changes.merge(changes);
    return;
  }
  push(Entry{std::move(label), origin, std::move(changes)});
}

void History::push(Entry e) {
  entries_.resize(position_);  // a new entry drops the redo tail
  entries_.push_back(std::move(e));
  if (entries_.size() > limit_) {
    const std::size_t extra = entries_.size() - limit_;
    entries_.erase(entries_.begin(), entries_.begin() + static_cast<std::ptrdiff_t>(extra));
  }
  position_ = entries_.size();
}

const Entry* History::step_back() noexcept {
  if (!can_undo()) return nullptr;
  --position_;
  return &entries_[position_];
}

const Entry* History::step_forward() noexcept {
  if (!can_redo()) return nullptr;
  return &entries_[position_++];
}

std::uint32_t History::begin_gesture(std::string label, api::Origin origin) {
  gesture_ = Entry{std::move(label), origin, {}};
  return ++gestureId_;
}

Entry History::end_gesture() {
  Entry e = gesture_ ? std::move(*gesture_) : Entry{};
  gesture_.reset();
  return e;
}

void History::clear() {
  entries_.clear();
  position_ = 0;
}

void History::set_limit(std::uint32_t limit) {
  limit_ = std::max<std::uint32_t>(limit, 1);
  if (entries_.size() > limit_) {
    const std::size_t extra = entries_.size() - limit_;
    entries_.erase(entries_.begin(), entries_.begin() + static_cast<std::ptrdiff_t>(extra));
    position_ = position_ > extra ? position_ - extra : 0;
  }
}

api::HistoryState History::state() const {
  api::HistoryState s;
  s.entries.reserve(entries_.size());
  for (const auto& e : entries_) s.entries.push_back(api::HistoryEntry{e.label, e.origin});
  s.position = static_cast<std::uint32_t>(position_);
  s.can_undo = can_undo();
  s.can_redo = can_redo();
  s.gesture_open = gesture_.has_value();
  s.limit = limit_;
  return s;
}

std::string History::undo_label() const { return position_ > 0 ? entries_[position_ - 1].label : std::string(); }
std::string History::redo_label() const {
  return position_ < entries_.size() ? entries_[position_].label : std::string();
}

}  // namespace premation::doc
