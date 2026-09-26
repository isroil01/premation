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

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "anim.hpp"
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
};

/// The comp-level inputs the editor's viewport hands buildSnapshot for a
/// composition record (useViewportRenderer: `{...comp, rootId}`).
[[nodiscard]] SnapshotComp snapshot_comp_of(const doc::Document& d, std::string_view comp);

/// The composition's motion blur as the viewport passes it (motionBlurStore + comp fps).
[[nodiscard]] MotionBlurCfg motion_blur_of(const doc::Document& d, std::string_view comp);

/// `buildSnapshot(graph, anim, t, undefined, undefined, view, motionBlur, comp)`.
[[nodiscard]] Snapshot build_snapshot(const BuildContext& c, const SnapshotComp& comp, double t,
                                      const std::optional<MotionBlurCfg>& motionBlur);

}  // namespace premation::scene
