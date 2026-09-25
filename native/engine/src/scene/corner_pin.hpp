// Corner Pin (D2w 3D leftovers — the pin on a 3D layer, and so on any layer):
// the per-layer projective render stage of src/core/scene/cornerPin.ts and
// snapshotToFrameScene's `resolveCornerPin`, with packages/renderer
// Homography.ts (`squareToQuad`, `isConvexQuad`, `isIdentityQuad`).
//
//   snapshot   read_node_corner_pin: the `fx` component's `cornerPin` (four
//              normalised TL,TR,BR,BL points) — none when missing, malformed,
//              the identity or not strictly convex.
//   frame      apply_corner_pin: the render model becomes `model · H` (the
//              unit square onto the pinned quad, float32 like the TS Mat3),
//              the bounds the affine model's pinned corners, every motion
//              sample `sample · H`, and the renderable carries `cornerPin`;
//              a pinned layer stays on the 2D pinned path (no threeD).
//
// Pinned by tests/data/corner_pin_parity.json.
#pragma once

#include <array>
#include <optional>

#include "engine_api.hpp"
#include "model.hpp"
#include "scene_math.hpp"

namespace premation::scene {

using CornerPin = std::array<double, 8>;

[[nodiscard]] bool is_convex_quad(const CornerPin& q);
[[nodiscard]] bool is_identity_quad(const CornerPin& q, double eps = 1e-6);
/// `squareToQuad(quad)`: nullopt when degenerate.
[[nodiscard]] std::optional<Mat3> square_to_quad(const CornerPin& q);

/// `readNodeCornerPin(node)`.
[[nodiscard]] std::optional<CornerPin> read_node_corner_pin(const doc::Node& n);

struct ResolvedPin {
  Mat3 pin;
  Mat3 renderModel;
  api::Rect bounds;
};
/// `resolveCornerPin(cornerPin, model)`.
[[nodiscard]] std::optional<ResolvedPin> resolve_corner_pin(const std::optional<CornerPin>& pin, const Mat3& model);

/// The frame build's hook: after the renderable's model / bounds / motion
/// samples are set from the affine `model`, fold the pin in. No-op without one.
void apply_corner_pin(const std::optional<CornerPin>& pin, const Mat3& model, api::Renderable& r);

}  // namespace premation::scene
