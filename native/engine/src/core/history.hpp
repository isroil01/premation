// One linear undo history (docs/ENGINE_API.md §5) — the app's HistoryService
// (src/core/commands/HistoryService.ts) as the TypeScript engine drives it:
// an undo stack and a redo stack of entries, a capacity (500) past which the
// OLDEST entries drop, and a push that clears the redo tail.
//
// An entry holds the parts its request (or gesture) changed, before and after
// (model.hpp ChangeSet) — the concrete inverse recorded at apply time.
#pragma once

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "model.hpp"

namespace premation::doc {

struct Entry {
  std::string label;
  api::Origin origin = api::Origin::ui;
  ChangeSet changes;
};

class History {
 public:
  void push(Entry e);
  [[nodiscard]] bool can_undo() const noexcept { return !undo_.empty(); }
  [[nodiscard]] bool can_redo() const noexcept { return !redo_.empty(); }
  /// Pop the newest entry onto the redo stack; the caller applies `before`.
  const Entry* undo();
  /// Pop the next redo entry back; the caller applies `after`.
  const Entry* redo();
  /// Entries in chronological order (undo stack, then the redo stack reversed).
  [[nodiscard]] std::vector<const Entry*> entries() const;
  /// `getIndex()`: the applied entry's index (−1 when none).
  [[nodiscard]] std::int64_t index() const noexcept { return static_cast<std::int64_t>(undo_.size()) - 1; }
  [[nodiscard]] std::uint32_t capacity() const noexcept { return capacity_; }
  void set_capacity(std::uint32_t n);
  void clear();
  [[nodiscard]] const Entry* top() const noexcept { return undo_.empty() ? nullptr : &undo_.back(); }
  [[nodiscard]] const Entry* next() const noexcept { return redo_.empty() ? nullptr : &redo_.back(); }

 private:
  std::deque<Entry> undo_;
  std::vector<Entry> redo_;
  std::uint32_t capacity_ = 500;
};

}  // namespace premation::doc
