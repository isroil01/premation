// The time domain — src/core/timeline/TimelineController.ts (the parts the
// engine API reaches) over doc::Timeline: per-composition registries, the
// scene → bar mirror (`syncFromScene`), exact bar geometry writes
// (`applyClipGeometry`), and the keyframe axis (`compToKeyframeTime` /
// `keyframeToCompTime`) that places every keyframe the API writes.
//
// The editor state TimelineController consults — which composition the ACTIVE
// TAB shows, and its playhead — is modelled by `EditorView`: it is not
// document state, but several TypeScript rules read it (a layer parented to
// another layer finds its bars in the active comp's timeline; a keep-world
// reparent samples at the tab's playhead), so the engine must answer the same.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"

namespace premation::doc {

/// What the TypeScript editor's workspace store holds that engine rules read.
struct EditorView {
  /// The composition the active tab shows (`comp_root` after New Project).
  std::string tabComp = "comp_root";
  /// The active tab's playhead, seconds.
  double tabTime = 0;
};

/// Geometry of one bar — `Clip.toJSON()`.
using Geo = Clip;

/// `mediaSourceFrames(node, fps)`: a source layer's length in frames, or nullopt when unbounded.
[[nodiscard]] std::optional<double> media_source_frames(const Document& d, const Node& n, double fps);

/// `timelineForComp`: build (and sync) a composition's timeline on first touch.
/// False when the comp has no settings record.
bool tl_ensure(Document& d, std::string_view comp);
/// `syncFromScene(comp)`.
void tl_sync_from_scene(Document& d, std::string_view comp);
/// `syncFromScene` for every registered composition (the engine's `syncTimelines`).
void tl_sync_all(Document& d);
/// Would a full `syncFromScene(comp)` change nothing? (the incremental sync's invariant)
[[nodiscard]] bool tl_in_sync(const Document& d, std::string_view comp);

/// `registryForNode`: the comp whose timeline owns the node's bars (its parent
/// when that is a registered comp, else the active tab's comp).
[[nodiscard]] std::string tl_owner_comp(const Document& d, const EditorView& v, std::string_view node);
/// `getLayersForNode`: the node's bars, sorted by start (stable).
[[nodiscard]] std::vector<const Bar*> tl_bars_for_node(const Document& d, const EditorView& v, std::string_view node);

/// While one is alive (on this thread), the document is READ ONLY — a query —
/// and `tl_bars_for_node` answers from a per-timeline index (source id → bars,
/// by start) built once, instead of scanning every bar of the composition per
/// call. A query that samples every property of every layer called it several
/// times per value: O(values × bars). Never open one around an edit.
class TlReadScope {
 public:
  TlReadScope();
  ~TlReadScope();
  TlReadScope(const TlReadScope&) = delete;
  TlReadScope& operator=(const TlReadScope&) = delete;
  TlReadScope(TlReadScope&&) = delete;
  TlReadScope& operator=(TlReadScope&&) = delete;
};
[[nodiscard]] double tl_fps_for_node(const Document& d, const EditorView& v, std::string_view node);
[[nodiscard]] double tl_duration_for_node(const Document& d, const EditorView& v, std::string_view node);

/// `barsOf(layer, comp)`: the layer's bars in its OWN comp's timeline, by start.
[[nodiscard]] std::vector<const Bar*> bars_of(const Document& d, std::string_view layer, std::string_view comp);
/// `geomsOf(layer, comp)`.
[[nodiscard]] std::vector<Geo> geoms_of(const Document& d, std::string_view layer, std::string_view comp);
/// `writeGeoms(comp, layer, geoms)` → `applyClipGeometry({comp: {layer: geoms}})`.
void write_geoms(Document& d, std::string_view comp, std::string_view layer, const std::vector<Geo>& geoms);

/// `compToKeyframeTime(node, seconds, prop?)`.
[[nodiscard]] double comp_to_keyframe_time(const Document& d, const EditorView& v, std::string_view node,
                                           double compTime, std::string_view prop = {});
/// `keyframeToCompTime(node, seconds, prop?)`.
[[nodiscard]] double keyframe_to_comp_time(const Document& d, const EditorView& v, std::string_view node,
                                           double keyTime, std::string_view prop = {});

/// `readNodeLayerTime(node)` (undefined when default) and `getNodeLayerTime`.
struct LayerTime {
  double stretch = 100;
  bool reverse = false;
  bool freeze = false;
  double freezeTime = 0;
  std::string frameBlend = "none";
  friend bool operator==(const LayerTime&, const LayerTime&) = default;
};
[[nodiscard]] LayerTime normalize_layer_time(const Json& v);
[[nodiscard]] std::optional<LayerTime> read_node_layer_time(const Node& n);
[[nodiscard]] LayerTime get_node_layer_time(const Node& n);
[[nodiscard]] bool is_identity_time(const LayerTime& t) noexcept;
[[nodiscard]] Json layer_time_json(const LayerTime& t);
/// `remapTime(t, cfg, span)`.
[[nodiscard]] double remap_time(double t, const LayerTime& cfg, double spanStart, double spanEnd);

/// `transferNodeClips(nodeIds, from, to)`: move those nodes' bars (geometry,
/// switches, layer markers) from one comp's timeline to another's.
void tl_transfer_node_clips(Document& d, const std::vector<std::string>& nodeIds, std::string_view from,
                            std::string_view to);
/// `compIdForNode(node)`: the parent when it has a timeline, else the active tab comp.
[[nodiscard]] std::string tl_comp_id_for_node(const Document& d, const EditorView& v, std::string_view node);

/// MarkerList helpers: sorted insert (lowerBound), stable re-sort.
void markers_insert(std::vector<TMarker>& list, TMarker m);
void markers_reindex(std::vector<TMarker>& list);

/// Timeline.setFrameRate(fps, {preserveTiming: true}) / setDuration(frames).
void tl_set_frame_rate(Timeline& t, double fps);
void tl_set_duration(Timeline& t, double frames);

}  // namespace premation::doc
