// One linear undo history (docs/ENGINE_API.md §5).
//
// An entry holds, for every entity (layer or composition) its commands
// touched, the entity's state BEFORE the first touch and AFTER the last one.
// That is the "concrete inverse recorded at apply time": undo writes `before`
// back, redo writes `after`, nothing is re-derived. Coalescing inside a
// gesture falls out of the same rule — touching an entity again keeps the
// entry's first `before` and replaces its `after` (§5.2).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "document.hpp"

namespace premation::doc {

struct LayerChange {
  api::LayerId id;
  std::optional<Layer> before;  ///< nullopt: the layer did not exist
  std::optional<Layer> after;   ///< nullopt: the layer was deleted
};

struct CompChange {
  api::ItemId id;
  std::optional<Comp> before;
  std::optional<Comp> after;
};

/// Everything one request (or one gesture) changed.
struct ChangeSet {
  std::vector<LayerChange> layers;
  std::vector<CompChange> comps;

  [[nodiscard]] bool empty() const noexcept { return layers.empty() && comps.empty(); }

  /// Call BEFORE mutating a layer / comp: remembers its current state once.
  void touch_layer(const Document& d, const api::LayerId& id);
  void touch_comp(const Document& d, const api::ItemId& id);
  /// Fill every `after` from the document's current state.
  void seal(const Document& d);
  /// Put every touched entity back to `before` (a failed batch, a cancelled gesture, undo).
  void apply_before(Document& d) const;
  /// Put every touched entity to `after` (redo).
  void apply_after(Document& d) const;
  /// Fold a later, sealed change set into this one (first before, last after).
  void merge(const ChangeSet& later);
  /// Drop entities whose before == after (an edit that changed nothing).
  void prune();
  /// The same changes seen backwards (for undo's events).
  [[nodiscard]] ChangeSet reversed() const;
};

struct Entry {
  std::string label;
  api::Origin origin = api::Origin::ui;
  ChangeSet changes;
};

class History {
 public:
  /// Record a sealed, non-empty change set: into the open gesture if there is
  /// one, else as a new entry (dropping the redo tail and the oldest entries
  /// past the limit).
  void record(std::string label, api::Origin origin, ChangeSet changes);

  [[nodiscard]] bool can_undo() const noexcept { return !gesture_ && position_ > 0; }
  [[nodiscard]] bool can_redo() const noexcept { return !gesture_ && position_ < entries_.size(); }
  /// Moves one entry; returns the entry moved over (caller applies it).
  const Entry* step_back() noexcept;
  const Entry* step_forward() noexcept;

  [[nodiscard]] bool gesture_open() const noexcept { return gesture_.has_value(); }
  [[nodiscard]] std::uint32_t gesture_id() const noexcept { return gestureId_; }
  std::uint32_t begin_gesture(std::string label, api::Origin origin);
  /// Closes the gesture and returns what it accumulated (possibly empty).
  Entry end_gesture();

  void clear();
  void set_limit(std::uint32_t limit);

  [[nodiscard]] api::HistoryState state() const;
  [[nodiscard]] std::string undo_label() const;
  [[nodiscard]] std::string redo_label() const;
  [[nodiscard]] std::size_t position() const noexcept { return position_; }

 private:
  void push(Entry e);

  std::vector<Entry> entries_;
  std::size_t position_ = 0;  ///< entries_[0, position_) are applied
  std::uint32_t limit_ = 500;
  std::optional<Entry> gesture_;
  std::uint32_t gestureId_ = 0;
};

}  // namespace premation::doc
