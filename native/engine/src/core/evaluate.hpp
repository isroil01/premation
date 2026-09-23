// Evaluation: keyframed properties → values at a comp time, and a
// composition → the FrameScene the render thread draws.
//
// Interpolation is motion_eval (native/libs/motion_eval), the bit-exact port
// of the TypeScript sampler: each numeric component of a keyframed value is
// sampled as one scalar track.
#pragma once

#include <array>
#include <span>
#include <vector>

#include "document.hpp"
#include "frame_scene.hpp"
#include "motion/motion_eval.h"

namespace premation::eval {

namespace api = premation::api;

/// Reusable scratch so evaluation does not allocate per frame once warm.
/// Owned by the document core thread (one instance, never shared).
struct Scratch {
  std::vector<motion_keyframe> track;
};

/// The property's value at `t` (its static value when it has no keyframes).
[[nodiscard]] api::Value value_at(const doc::Property& prop, api::Time t, Scratch& scratch);

/// Numeric components of the value at `t`; returns the count (0 for non-numeric).
std::size_t components_at(const doc::Property& prop, api::Time t, Scratch& scratch, std::span<double, 4> out);

/// Layer → comp pixel affine [a b c d e f] at `t` (After Effects 2D order:
/// translate(position) · rotate · scale · translate(−anchor)).
[[nodiscard]] std::array<double, 6> layer_matrix(const doc::Layer& layer, api::Time t, Scratch& scratch);

/// The composition at `t`, back to front. Layers outside their in/out range,
/// hidden, non-rendering kinds and fully transparent layers are skipped.
void build_scene(const doc::Document& document, const doc::Comp& comp, api::Time t, Scratch& scratch,
                 FrameScene& out);

/// api::Easing → motion_easing (the two enums number their members differently).
[[nodiscard]] std::int32_t to_motion_easing(api::Easing e) noexcept;

}  // namespace premation::eval
