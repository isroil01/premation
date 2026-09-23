// The engine's document — D1b: the TypeScript engine's document model, in C++.
//
// premation-engine is a second implementation of docs/ENGINE_API.md whose
// answers must equal the TypeScript engine's (src/core/engine/) request for
// request, bit for bit where the TypeScript is deterministic. The TypeScript
// engine is not a clean schema over a store: its observable behaviour is the
// behaviour of the editor's own model underneath it — scene nodes carrying
// loosely typed components, per-dimension scalar keyframe tracks in seconds on
// each layer's keyframe axis, clip bars in integer frames, composition records
// in a project store. So that model is what this file ports, one structure per
// TypeScript structure:
//
//   Node        SceneGraph's node (packages/scene + src/core/scene/SceneGraph.ts):
//               id, name, parent, back-to-front children, flags, components.
//   NodeAnim    AnimationEngine's per-node state (packages/animation): scalar
//               tracks (Key), data tracks, expressions.
//   comps       projectStore.comps — one JSON record per composition.
//   Timeline    @motion/timeline's Timeline as TimelineController registers it:
//               rate, duration, ranges, composition markers, the bars.
//   Items       assetStore — footage records (JSON) and folders.
//   project / rq / mb / cm  documentExtras' project settings and render queue,
//               the motion-blur store, colour management.
//
// ## Parts, copy-on-write and history
//
// Every entity is held by `std::shared_ptr` and never mutated while shared:
// a write goes through `Document::*_mut`, which first JOURNALS the entity's
// current pointer (once per transaction) and then clones it if anyone else
// still holds it. That journal is the TypeScript engine's `Parts` (state.ts):
// the concrete before/after of exactly what a request changed, captured at
// apply time, so undo writes the befores back and never re-derives anything
// (ENGINE_API.md §5.1). Sharing is also what makes a history entry cheap — it
// holds pointers to the old versions, not copies.
//
// shared_ptr (not unique_ptr) is deliberate and required here: the document,
// the open transaction's journal and every history entry reference the same
// immutable entity versions (structural sharing); ownership is genuinely
// shared and released by whichever holder is dropped last.
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"
#include "ordered_map.hpp"

namespace premation::doc {

namespace api = premation::api;
using js::Json;

inline constexpr api::Time kFlicksPerSecond = 705'600'000;

// ── Scene ────────────────────────────────────────────────────────────────

struct Component {
  std::string id;
  std::string type;
  Json props = Json::object();
  friend bool operator==(const Component&, const Component&) = default;
};

struct Node {
  std::string id;
  std::string name;
  std::optional<std::string> parent;  ///< nullopt = a root (a composition)
  std::vector<std::string> children;  ///< BACK-most first (index 0 paints first)
  bool visible = true;
  bool locked = false;
  bool solo = false;
  bool shy = false;
  std::optional<std::string> color;   ///< label colour hex
  std::vector<Component> components;  ///< one per type, insertion order

  [[nodiscard]] const Component* comp(std::string_view type) const noexcept;
  [[nodiscard]] Component* comp_mut(std::string_view type) noexcept;
  [[nodiscard]] const Component* comp_by_id(std::string_view id) const noexcept;
  /// The first component whose props carry `key` as a NUMBER (TS: components.find(typeof === 'number')).
  [[nodiscard]] const Component* comp_with_number(std::string_view key) const noexcept;
  /// `readNodeKind`: the first component's `__kind` string, else 'shape'.
  [[nodiscard]] std::string kind() const;
  /// The `fx` component's props (an empty object when absent).
  [[nodiscard]] const Json& fx() const noexcept;
  friend bool operator==(const Node&, const Node&) = default;
};

// ── Animation ────────────────────────────────────────────────────────────

/// AnimationEngine's `Keyframe` (packages/animation/src/types.ts). Optional
/// fields stay optional: their presence is observable (JSON, equality).
struct Key {
  std::optional<std::string> id;
  std::optional<double> label;
  double t = 0;  ///< seconds on the property's keyframe axis
  double value = 0;
  std::optional<api::Easing> easing;
  std::optional<std::array<double, 4>> bezier;
  std::optional<bool> continuous;
  std::optional<bool> roving;
  std::optional<double> si;
  std::optional<double> so;
  std::optional<api::SpatialInterp> spatial;  ///< never `legacy` (absent means legacy)
  friend bool operator==(const Key&, const Key&) = default;
};

struct DataKey {
  double t = 0;
  Json value;
  std::optional<api::Easing> easing;
  std::optional<std::array<double, 4>> bezier;
  std::optional<std::string> id;
  std::optional<double> label;
  std::optional<Json> so;  ///< spatial tangents per point (Array<{x,y} | null>)
  std::optional<Json> si;
  friend bool operator==(const DataKey&, const DataKey&) = default;
};

struct DataTrack {
  std::string kind;  ///< 'text' | 'points' | 'gradientStops' | 'number'
  std::vector<DataKey> keys;
  friend bool operator==(const DataTrack&, const DataTrack&) = default;
};

struct ExprState {
  std::string src;
  bool enabled = true;
  friend bool operator==(const ExprState&, const ExprState&) = default;
};

struct NodeAnim {
  OrderedMap<std::vector<Key>> tracks;
  OrderedMap<ExprState> exprs;
  OrderedMap<DataTrack> data;
  [[nodiscard]] bool empty() const noexcept { return tracks.empty() && exprs.empty() && data.empty(); }
  friend bool operator==(const NodeAnim&, const NodeAnim&) = default;
};

// ── Timeline (the bars) ──────────────────────────────────────────────────

struct Clip {
  double start = 0;
  double duration = 0;
  double sourceIn = 0;
  std::optional<double> sourceDuration;
  [[nodiscard]] double end() const noexcept { return start + duration; }
  [[nodiscard]] bool contains(double frame) const noexcept { return frame >= start && frame < end(); }
  [[nodiscard]] double source_frame_at(double frame) const noexcept { return sourceIn + (frame - start); }
  friend bool operator==(const Clip&, const Clip&) = default;
};

struct TMarker {
  std::string id;
  double frame = 0;
  double duration = 0;
  std::string name;
  std::optional<std::string> color;
  std::string comment;
  std::string scope = "timeline";
  std::optional<std::string> ownerId;
  std::string chapter;
  std::string url;
  std::string cuePoint;
  bool protectedRegion = false;
  friend bool operator==(const TMarker&, const TMarker&) = default;
};

struct Bar {
  std::string id;
  std::string name;
  Clip clip;
  bool enabled = true;
  bool locked = false;
  std::optional<std::string> sourceId;
  std::vector<TMarker> markers;  ///< sorted by frame (MarkerList)
  [[nodiscard]] bool active_at(double frame) const noexcept { return enabled && clip.contains(frame); }
  friend bool operator==(const Bar&, const Bar&) = default;
};

struct FrameRange {
  double start = 0;
  double duration = 0;
  friend bool operator==(const FrameRange&, const FrameRange&) = default;
};

struct Timeline {
  double fps = 30;
  double duration = 300;  ///< frames
  std::optional<FrameRange> workArea;
  std::optional<FrameRange> loop;
  std::vector<TMarker> markers;  ///< composition markers, sorted by frame
  std::vector<Bar> bars;         ///< the composition track's layers, track order
  friend bool operator==(const Timeline&, const Timeline&) = default;
};

// ── Items, project ───────────────────────────────────────────────────────

struct Folder {
  std::string id;
  std::string name;
  std::optional<std::string> parentId;
  friend bool operator==(const Folder&, const Folder&) = default;
};

struct Items {
  std::vector<Json> assets;  ///< ImportedAsset records
  std::vector<Folder> folders;
  friend bool operator==(const Items&, const Items&) = default;
};

struct MotionBlur {
  bool enabled = true;
  double shutterAngle = 180;
  double shutterPhase = -90;
  double samples = 8;
  double adaptiveSampleLimit = 128;
  friend bool operator==(const MotionBlur&, const MotionBlur&) = default;
};

struct ColorMgmt {
  std::string workingSpace = "srgb-linear";
  std::string displayTransform = "srgb";
  double bitDepth = 16;
  friend bool operator==(const ColorMgmt&, const ColorMgmt&) = default;
};

using RenderQueue = std::vector<api::RenderItemInfo>;
using IdList = std::vector<std::string>;

/// Authored document state no engine command edits (ENGINE_API.md §14.3):
/// saved with the project and read back on open, exactly as the TS stores do
/// (docio.cpp). Not journaled — no command changes it, so no undo entry can.
struct DocExtras {
  /// guidesStore: every persisted field (settings() writes the defaults-omitted form).
  Json guides;
  /// swatchStore.list(): `{id, name, hex}` in the user's order.
  Json swatches;
  /// materialStore.list(): project materials only.
  Json materials;
  /// transitionStore.capture(): comp id → transition records.
  Json transitions;
  /// pluginStorage (project scope): plugin id → key → string.
  Json pluginStorage;
};

/// A new project's extras (projectDocumentIO.createEmpty + the stores' defaults).
[[nodiscard]] DocExtras default_doc_extras();

[[nodiscard]] api::ProjectSettings default_project_settings();

// ── Parts ────────────────────────────────────────────────────────────────

template <class T>
using Ptr = std::shared_ptr<T>;

/// A set of part values: the before or the after of a change (TS `Parts`).
/// A present key with an empty pointer means "did not exist".
struct Parts {
  std::map<std::string, Ptr<Node>, std::less<>> nodes;
  std::map<std::string, Ptr<NodeAnim>, std::less<>> anims;
  std::map<std::string, Ptr<Json>, std::less<>> comps;
  std::map<std::string, Ptr<Timeline>, std::less<>> timelines;
  std::optional<Ptr<IdList>> nodeOrder;
  std::optional<Ptr<IdList>> compOrder;
  std::optional<Ptr<IdList>> tlOrder;
  std::optional<Ptr<Items>> items;
  std::optional<Ptr<api::ProjectSettings>> project;
  std::optional<Ptr<RenderQueue>> rq;
  std::optional<Ptr<MotionBlur>> mb;
  std::optional<Ptr<ColorMgmt>> cm;
  [[nodiscard]] bool empty() const noexcept;
};

/// What one request (or gesture) changed: first-seen befores, last-seen afters.
struct ChangeSet {
  Parts before;
  Parts after;
  [[nodiscard]] bool empty() const noexcept { return before.empty(); }
  /// Fold a LATER change set into this one (gesture coalescing, §5.2).
  void merge(const ChangeSet& later);
  /// Drop parts whose before and after are equal (an edit that changed nothing).
  void prune();
  [[nodiscard]] ChangeSet reversed() const;
  /// Part keys ("node:<id>", "anim:<id>", "comp:<id>", "tl:<id>", "order", "items", …).
  [[nodiscard]] std::vector<std::string> keys() const;
};

// ── The document ─────────────────────────────────────────────────────────

class Document {
 public:
  Document();

  // ── reads ──
  [[nodiscard]] const Node* node(std::string_view id) const;
  [[nodiscard]] const NodeAnim* anim(std::string_view id) const;
  [[nodiscard]] const Json* comp(std::string_view id) const;
  [[nodiscard]] const Timeline* timeline(std::string_view comp) const;
  [[nodiscard]] const Items& items() const noexcept { return *items_; }
  [[nodiscard]] const api::ProjectSettings& project() const noexcept { return *project_; }
  [[nodiscard]] const RenderQueue& render_queue() const noexcept { return *rq_; }
  [[nodiscard]] const MotionBlur& motion_blur() const noexcept { return *mb_; }
  [[nodiscard]] const ColorMgmt& color() const noexcept { return *cm_; }
  /// Swatches, materials, guides, transitions, plugin storage (not journaled).
  [[nodiscard]] const DocExtras& extras() const noexcept { return extras_; }
  DocExtras& extras_mut() noexcept { return extras_; }
  [[nodiscard]] const OrderedMap<Ptr<Node>>& nodes() const noexcept { return nodes_; }
  [[nodiscard]] const OrderedMap<Ptr<NodeAnim>>& anims() const noexcept { return anims_; }
  [[nodiscard]] const OrderedMap<Ptr<Json>>& comps() const noexcept { return comps_; }
  [[nodiscard]] const OrderedMap<Ptr<Timeline>>& timelines() const noexcept { return timelines_; }

  // ── writes (journaled, copy-on-write) ──
  Node& node_mut(std::string_view id);  ///< precondition: exists
  /// Append a new node at the end of the insertion order (or at `index`).
  Node& add_node(Node n, std::optional<std::size_t> index = std::nullopt);
  void remove_node_only(std::string_view id);
  /// The node's animation, created on demand.
  NodeAnim& anim_mut(std::string_view id);
  /// Replace (nullopt / empty = clear) a node's animation.
  void set_anim(std::string_view id, std::optional<NodeAnim> a);
  Json& comp_mut(std::string_view id);  ///< creates an empty record (appended) when absent
  void remove_comp(std::string_view id);
  Timeline& timeline_mut(std::string_view comp);  ///< creates when absent (appended)
  void remove_timeline(std::string_view comp);
  Items& items_mut();
  api::ProjectSettings& project_mut();
  RenderQueue& render_queue_mut();
  MotionBlur& motion_blur_mut();
  ColorMgmt& color_mut();
  /// Reorder the node insertion order (the saved order).
  void reorder_nodes(const IdList& order);

  // ── transactions ──
  /// Start recording befores. Nested begins are an error (asserted by callers).
  void begin();
  /// Stop recording; the parts changed since begin() (pruned).
  [[nodiscard]] ChangeSet commit();
  /// Stop recording and put every journaled part back (a failed command).
  void rollback();
  [[nodiscard]] bool recording() const noexcept { return journal_ != nullptr; }
  /// Write a Parts back (undo writes `before`, redo `after`). Not journaled
  /// unless a transaction is open.
  void apply(const Parts& p);

  /// A full copy of the part POINTERS (O(entities), no deep copies) — for tests and replay checks.
  [[nodiscard]] Parts capture_all() const;
  /// The current values of the parts `keys` names (the same keys, live pointers).
  [[nodiscard]] Parts current_of(const Parts& keys) const;
  // ── timeline-sync bookkeeping (derived state, not the document) ──
  /// Nodes written since the timelines were last reconciled (tl_sync_all):
  /// the only nodes whose bars can be out of date, so the per-command sync is
  /// O(touched), not O(layers). `tl_all_dirty` = reconcile everything
  /// (a fresh document, or parts written back by undo/redo/rollback).
  [[nodiscard]] const std::unordered_set<std::string>& tl_touched() const noexcept { return tlTouched_; }
  [[nodiscard]] bool tl_all_dirty() const noexcept { return tlAllDirty_; }
  void tl_mark_clean() noexcept {
    tlTouched_.clear();
    tlAllDirty_ = false;
  }

  /// The open transaction's journal so far (its befores); empty when none is open.
  void peek_journal(Parts& out) const {
    if (journal_) out = *journal_;
  }

 private:
  void note_node(std::string_view id);
  void note_anim(std::string_view id);
  void note_comp(std::string_view id);
  void note_tl(std::string_view id);
  void note_node_order();
  void note_comp_order();
  void note_tl_order();

  OrderedMap<Ptr<Node>> nodes_;
  OrderedMap<Ptr<NodeAnim>> anims_;
  OrderedMap<Ptr<Json>> comps_;
  OrderedMap<Ptr<Timeline>> timelines_;
  Ptr<Items> items_;
  Ptr<api::ProjectSettings> project_;
  Ptr<RenderQueue> rq_;
  Ptr<MotionBlur> mb_;
  Ptr<ColorMgmt> cm_;
  DocExtras extras_ = default_doc_extras();
  std::unique_ptr<Parts> journal_;
  std::unordered_set<std::string> tlTouched_;
  bool tlAllDirty_ = true;
};

/// Clone-on-write: the entity behind `p`, unshared.
template <class T>
T& unshare(Ptr<T>& p) {
  if (!p) p = std::make_shared<T>();
  else if (p.use_count() > 1) p = std::make_shared<T>(*p);
  return *p;
}

}  // namespace premation::doc
