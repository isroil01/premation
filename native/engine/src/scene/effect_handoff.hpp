// buildSnapshot's resolved-param hand-offs for the path and paint effects (D2w
// effects): the geometry the CPU bake's kernels read from their params, written
// at the frame's time where the document is reachable (buildSnapshot.ts, the
// `all = withAudio.map(...)` block):
//
//   Energy Beam ▸ Text                      `pathPoints`: the layer's traced text
//        runs (traceTextRuns, the extrusion trace) flattened at 6 samples a
//        segment, letters separated by BEAM_PEN_UP;
//   Stroke / Scribble / Vegas ▸ All Masks   every mask, packed (packMaskPaths:
//        `maskPathsMeta` + `maskPathsXY`) with `pathMaskIndex`, from the mask the
//        layer is cut by this frame (shape track + property tracks);
//   Scribble                                `wiggleState` (scribbleWiggleState);
//   any effect with a `pathMaskId`          `pathPoints` (maskPathPolyline, 16
//        samples a segment, after the mask's expansion) + `pathClosed`.
//
// Not ported, and reported: Write-on's brush form (the dab history, sampled at
// past times). Energy Beam on text, point or paragraph, traces the painted runs.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

class TextMeasurer;

/// Apply the hand-offs to `effects` (resolveEffectParams output) in place;
/// features outside the port are appended to `unported`. `measurer` supplies the
/// fonts a text outline is traced with (null = none).
void resolve_effect_handoffs(std::vector<Json>& effects, const doc::Node& n, const Values& a, std::optional<double> layerTimeSec,
                             TextMeasurer* measurer, std::vector<std::string>& unported);

}  // namespace premation::scene
