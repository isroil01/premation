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
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "anim.hpp"
#include "frame_scene.hpp"
#include "model.hpp"
#include "scene_types.hpp"
#include "text_measure.hpp"
#include "timeline.hpp"

namespace premation::scene {

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
  };
  std::optional<LayerView> layerView{};
  /// Layers the viewport being built does not draw (setViewportHiddenLayers:
  /// the text layer under the in-place editor). Like an off eye switch, for this
  /// frame only. Empty = none.
  std::vector<std::string> hiddenLayers{};
  /// The project folder relative media paths resolve against (the texture
  /// feed's mediaBase); empty = none (a relative path is reported).
  std::filesystem::path mediaBase{};
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
