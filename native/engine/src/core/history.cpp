#include "history.hpp"

#include <algorithm>

namespace premation::doc {

void History::push(Entry e) {
  undo_.push_back(std::move(e));
  if (undo_.size() > capacity_) undo_.pop_front();
  redo_.clear();
}

const Entry* History::undo() {
  if (undo_.empty()) return nullptr;
  redo_.push_back(std::move(undo_.back()));
  undo_.pop_back();
  return &redo_.back();
}

const Entry* History::redo() {
  if (redo_.empty()) return nullptr;
  undo_.push_back(std::move(redo_.back()));
  redo_.pop_back();
  return &undo_.back();
}

std::vector<const Entry*> History::entries() const {
  std::vector<const Entry*> out;
  out.reserve(undo_.size() + redo_.size());
  for (const Entry& e : undo_) out.push_back(&e);
  for (auto it = redo_.rbegin(); it != redo_.rend(); ++it) out.push_back(&*it);
  return out;
}

void History::set_capacity(std::uint32_t n) {
  capacity_ = std::max<std::uint32_t>(1, n);
  while (undo_.size() > capacity_) undo_.pop_front();
}

void History::clear() {
  undo_.clear();
  redo_.clear();
}

}  // namespace premation::doc
