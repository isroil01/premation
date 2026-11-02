// buildSnapshot (src/core/rendering/buildSnapshot.ts) over the engine's own
// document: the layers of one composition at one time, resolved — keyframes,
// expressions, clip bars, layer time, parenting, precomp routing, paint,
// masks, mattes, effects, motion-blur shutter samples.
//
// What the port does not produce yet is never dropped silently: each such
// feature is recorded on the layer (`RLayer::unported`) and in
// `Snapshot::layerErrors` with stage 'unported', and the layer renders without
// it. A layer whose build throws is isolated exactly as the TypeScript does it:
// removed with everything it emitted, replaced by an invisible stack stub,
// recorded with stage 'snapshot' — the frame still renders (CLAUDE.md).
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "anim.hpp"
#include "frame_scene.hpp"
#include "model.hpp"
#include "scene_types.hpp"
#include "subjects.hpp"
#include "text_measure.hpp"
#include "timeline.hpp"

namespace premation::scene {

/// What every walk starts from (snapshot_build.cpp): the flattened composition
/// with its collapsed instances expanded and a sealed pass's overrides applied,
/// and its nodes by id. A function of the document, the comp, its overrides and
/// the Layer panel's layer — never of time (cloners, which can read the raw
/// graph at the frame's time, are expanded per frame on top of it).
struct WalkTopology;

/// The frame builder's memo of WalkTopology, one per (comp, overrides, Layer
/// panel layer), kept while the document is unchanged — so a 3000-layer comp
/// is not re-flattened, re-expanded and re-indexed on every played frame.
///
/// The document has no revision counter of its own, so the memo's revision is
/// the document's copy-on-write identity: the memo PINS (holds a reference to)
/// every node and composition record it was built from, in document order. A
/// write to a pinned entity goes through `Document::*_mut` → `unshare`, which
/// clones it because the pin shares it — so an unchanged pointer sequence
/// means an unchanged document (no ABA: a pinned address is never reused), and
/// any edit, add, remove, reorder, undo or load shows up as a pointer change.
/// The outermost build_snapshot (Scope) compares; nested passes share its answer.
///
/// Threading: owned by the frame builder and used only under the session's
/// build lock (the build worker, or the core thread's builder queries); never
/// invalidated by a callback from the core thread.
class WalkCache {
 public:
  WalkCache();
  ~WalkCache();
  WalkCache(const WalkCache&) = delete;
  WalkCache& operator=(const WalkCache&) = delete;
  WalkCache(WalkCache&&) = delete;
  WalkCache& operator=(WalkCache&&) = delete;

  /// The memoised topology (built, and counted, on a miss).
  // shared_ptr: a walk keeps the topology it reads alive while a nested pass
  // may drop the memo's entry (cap) — the walk reads its nodes until it returns.
  [[nodiscard]] std::shared_ptr<const WalkTopology> topology(const doc::Document& d, const std::string& rootId,
                                                             const std::map<std::string, Json, std::less<>>& overrides,
                                                             const std::optional<std::string>& layerViewId);
  /// Stream B3: a layer's stored subject frames indexed (core/subjects.hpp SubjectIndex), memoised
  /// with the topology — rebuilt when the document changes, never per snapshot. `alphaMatte` and
  /// `entries` are the node's own values (the index keeps pointers into them).
  [[nodiscard]] std::shared_ptr<const doc::SubjectIndex> subject_index(const std::string& layerId, const Json& alphaMatte,
                                                                        const Json& entries, double fps);
  /// Topologies built — each one a flatten (tests and benches read it).
  [[nodiscard]] std::uint64_t flattens() const noexcept { return flattens_; }
  /// Times the document was found changed and the memo dropped.
  [[nodiscard]] std::uint64_t revisions() const noexcept { return revisions_; }
  /// Drop everything (and the pins).
  void clear() noexcept;

  /// One build_snapshot (nests): the outermost compares the document with the memo's.
  class Scope {
   public:
    Scope(WalkCache* cache, const doc::Document& d);
    ~Scope();
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
    Scope(Scope&&) = delete;
    Scope& operator=(Scope&&) = delete;

   private:
    WalkCache* cache_;
  };

 private:
  void revalidate(const doc::Document& d);
  struct State;
  std::unique_ptr<State> s_;
  int depth_ = 0;
  /// The document last compared (only read inside a Scope, which compared it
  /// on entry; a nested build over another document compares again).
  const doc::Document* validatedDoc_ = nullptr;
  std::uint64_t flattens_ = 0;
  std::uint64_t revisions_ = 0;
};

/// The topology a walk builds for itself when there is no WalkCache.
[[nodiscard]] std::shared_ptr<const WalkTopology> make_walk_topology(const doc::Document& d, const std::string& rootId,
                                                                     const std::map<std::string, Json, std::less<>>& overrides,
                                                                     const std::optional<std::string>& layerViewId);

struct BuildContext {
  const doc::Document& d;
  const doc::EditorView& view;
  const doc::ExprEnv& expr;
  doc::ExprCache& cache;
  /// Text measurement (fonts); null = text layers report unported.
  TextMeasurer* measurer = nullptr;
  /// Decoded mono envelope of an audio layer, once its source has conformed.
  /// False = not ready yet (the waveform stays reported). True with empty peaks
  /// = silence, which draws a zero-area path.
  std::function<bool(std::string_view layerId, std::vector<float>& peaks, double& duration)> waveform;
  /// getThumbnail of a layer: only this layer (and what it holds) draws in the
  /// walk that holds it, as if it were the one soloed layer. '' = the comp.
  std::string isolateLayer{};
  /// More layers drawn alone together with `isolateLayer` (Rig Logo renders a
  /// multi-layer selection as one picture); each with what it holds.
  std::vector<std::string> isolateAlso{};
  /// The Layer panel (setViewport `layer`, buildSnapshot `comp.layerView`):
  /// this one layer and nothing else — not the layers parented to it — with
  /// its eye on, un-soloed, sealed if a collapsed comp, live at every time;
  /// placed untransformed at the frame's centre, with none of what the comp
  /// does to it. `render` false = the untouched source (no masks, effects,
  /// paint, corner pin, glass, backdrop blur). `sourceTime` overrides the
  /// layer's own source time (the panel scrubbing in layer time).
  struct LayerView {
    std::string id;
    bool render = true;
    std::optional<double> sourceTime;
    /// A checkerboard behind the layer's bounds (setViewport `transparencyGrid`).
    bool grid = false;
    /// How the layer's alpha is shown (setViewport `layerAlphaView`): '' = as
    /// it is, 'alpha' = the matte white on black, 'boundary' = the source with
    /// the matte's edge outlined, 'overlay' = the source, red outside the matte.
    std::string alphaView{};
    /// The Alpha Overlay tint (`#rrggbb`, AE's default magenta) and its opacity 0..1.
    std::string overlayColor{"#ff3df5"};
    double overlayOpacity = 0.5;
  };
  std::optional<LayerView> layerView{};
  /// Layers the viewport being built does not draw (setViewportHiddenLayers:
  /// the text layer under the in-place editor). Like an off eye switch, for this
  /// frame only. Empty = none.
  std::vector<std::string> hiddenLayers{};
  /// Focus Mode (setViewportFocus): non-empty = a layer outside this set is a
  /// dim reference (12 % of its opacity) in the viewport being built.
  std::vector<std::string> focusLayers{};
  /// setViewport `subjectView` (Subjects Pro view modes): viewer-only effects on that layer that show its
  /// subject — tinted, over black or white, as its matte, or by its edge. Never set for an export or a thumbnail.
  std::optional<api::SubjectView> subjectView{};
  /// The project folder relative media paths resolve against (the texture
  /// feed's mediaBase); empty = none (a relative path is reported).
  std::filesystem::path mediaBase{};
  /// Use Proxies (setUseProxies, a viewport frame only): a video layer whose
  /// item has an enabled proxy file decodes from it (RLayer::proxySrc), drawn in
  /// the original's box at the original's timing. Off for everything else —
  /// exports, the Render Queue, stills — by polarity: nothing sets it there.
  bool useProxies = false;
  /// Program X1: build the time taps temporal deep effects read (off inside a
  /// tap's own build, so taps never nest).
  bool timeTaps = true;
  /// Non-zero = an edit is waiting for the build lock (Session::BuildLock):
  /// the walk stops at its next layer with BuildCancelled instead of finishing
  /// a frame of a document that is about to change. Null = never cancelled
  /// (stills, thumbnails, exports — the core thread's own builds).
  const std::atomic<std::uint32_t>* cancel = nullptr;
  /// The frame builder's walk memo (flatten / instance expansion / by-id map
  /// across frames); null = every walk builds its own (tests, one-off builds).
  WalkCache* walkCache = nullptr;
};

/// The comp-level inputs the editor's viewport hands buildSnapshot for a
/// composition record (useViewportRenderer: `{...comp, rootId}`).
[[nodiscard]] SnapshotComp snapshot_comp_of(const doc::Document& d, std::string_view comp);

/// The viewport's 3D view onto the comp (setViewport `view` / `customView`):
/// what buildSnapshot read from the editor's camera3dMode / customViewCamera.
/// '' / 'active' leave the comp's camera; an axis view or `camera:<id>` is the
/// snapshot's camera3dMode; 'custom' resolves customViews.ts customViewCamera —
/// the eye `distance` behind the point of interest along −z, orbited by
/// yaw / pitch, looking at it, with the comp's default lens — which replaces
/// the scene camera (threed_port: no DOF, no camera motion blur).
[[nodiscard]] SnapshotComp with_viewport_view(SnapshotComp sc, const ViewportConfig& viewport);

/// The composition's motion blur as the viewport passes it (motionBlurStore + comp fps).
[[nodiscard]] MotionBlurCfg motion_blur_of(const doc::Document& d, std::string_view comp);

/// `buildSnapshot(graph, anim, t, undefined, undefined, view, motionBlur, comp)`.
[[nodiscard]] Snapshot build_snapshot(const BuildContext& c, const SnapshotComp& comp, double t,
                                      const std::optional<MotionBlurCfg>& motionBlur);

/// mediaSlots.ts `coverUvRect`: the texture sub-rect a cover slot samples.
/// Null when a dimension is missing or the aspects already match (full texture).
/// Order is x, y, width, height, each in 0..1.
[[nodiscard]] std::optional<std::array<double, 4>> cover_uv_rect(double sourceW, double sourceH, double slotW,
                                                                  double slotH);

}  // namespace premation::scene
