// Paint strokes → pixels (E3): src/core/paint/paintRaster.ts drawPaint and
// the dab model of src/core/paint/paintDabs.ts, ported call for call onto the
// C++ Canvas2D. Brush, eraser (Layer Source & Paint / Paint Only / Last Stroke
// Only) and clone strokes; the v1 direct pass and the buffered dab pass
// (spacing, elliptical tips, hardness falloff, flow, pen dynamics, trim,
// per-stroke transform, channels, blend modes); Paint On Transparent.
//
// Clone strokes that name another layer or another time need the host's
// clone source (PaintEnv.cloneSource in the TS); a raster source carries
// none, so — exactly as the TS raster does without an env — a stroke naming
// another layer draws nothing and a self-clone at another time samples this
// layer's current pixels.
#pragma once

#include <array>
#include <optional>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"

namespace premation::raster {

/// paintRaster.ts hasPaintStrokes: at least one stroke, or Paint On Transparent.
[[nodiscard]] bool has_paint_strokes(const json::Value& paint);

/// paintRaster.ts drawPaint: composite `paint` (a PaintConfig) onto `ctx` in its
/// current transform (the layer's centred local space).
void draw_paint(Canvas2D& ctx, const json::Value& paint);

// ── paintDabs.ts (exposed for the parity tests) ─────────────────────────────

struct PaintPoint {
  double x = 0, y = 0;
};
struct Dab {
  double x = 0, y = 0, size = 0, angle = 0, roundness = 0, alpha = 0;
};
using Affine = std::array<double, 6>;

/// strokeDabs(stroke, minStep) over a PaintStroke JSON object.
[[nodiscard]] std::vector<Dab> stroke_dabs(const json::Value& stroke, double minStep = 0.25);
/// trimPolyline(points, start, end); nullopt when the trim leaves nothing.
[[nodiscard]] std::optional<std::vector<PaintPoint>> trim_polyline(const std::vector<PaintPoint>& points, double start, double end);
/// strokeTransformMatrix of a StrokeTransform JSON object.
[[nodiscard]] Affine stroke_transform_matrix(const json::Value& t);
/// paintRaster.ts paintReach: how far paint reaches past its polyline, local px.
[[nodiscard]] double paint_reach(const json::Value& paint);

}  // namespace premation::raster
