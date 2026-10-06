// Animated SVG for the C++ rasterizer: SMIL and CSS animations sampled at one
// document time, the way a browser shows an animated SVG image at that moment.
// Applied to the parsed document before the cascade (svg_raster.cpp
// rasterize_svg), so the painter draws a still of time `t` and rendering stays
// deterministic: the time is the layer's source time, never the wall clock.
//
//   SMIL  <animate>, <set>, <animateColor>, <animateTransform>, <animateMotion>:
//         begin offsets and syncbase `id.begin` / `id.end` ± offset, dur,
//         repeatCount / repeatDur, an end offset, fill="freeze", values / from /
//         to / by, keyTimes, calcMode discrete / linear / paced / spline with
//         keySplines, additive transforms, motion along a path (rotate auto).
//         Event begins (click …) never start, as in an <img>.
//   CSS   @keyframes with animation / animation-*: duration, delay, iteration
//         count, direction, fill mode, timing functions incl. steps(). Values
//         go in as `!important` rules after the document's own; transforms as
//         the matched elements' transform attribute (transform-origin in px, %
//         or keywords of the view box, or of the fill box).
#pragma once

#include <string>
#include <vector>

#include "svg_doc.hpp"

namespace premation::raster::svg {

struct AnimationInfo {
  bool animated = false;
  /// One pass in seconds: the latest end of a first SMIL interval or of a CSS
  /// animation's iterations (one iteration when it repeats forever). 0 = static.
  double durationSec = 0;
};

[[nodiscard]] AnimationInfo animation_info(const Document& doc);

/// Put every animation's value at `t` seconds into the document: SMIL values
/// as attributes (CSS properties also as inline style, which beats <style>
/// rules as an animation does), CSS @keyframes as rules appended to `extraCss`.
/// The @keyframes blocks are taken out of the <style> text it has read.
/// What it cannot animate is named in `unsupported` (once each).
void apply_animations(Document& doc, double t, std::string& extraCss, std::vector<std::string>& unsupported);

}  // namespace premation::raster::svg
