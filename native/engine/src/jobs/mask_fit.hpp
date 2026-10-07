// AE parity 5.4 — whole-mask tracking: the mask moves as ONE shape, by the
// transform that best maps its tracked points from the origin frame onto
// each frame (AE's Mask Tracker methods): Position; Position & Rotation;
// Position, Scale & Rotation; Position, Scale, Rotation & Skew (affine);
// Perspective (homography). `vertices` keeps the per-vertex track (each
// vertex follows its own feature). Pure: points in, transforms / paths out.
#pragma once

#include <optional>
#include <span>

#include "engine_api.hpp"
#include "tracking.hpp"

namespace premation::jobs::maskfit {

enum class Method { vertices, position, positionRotation, positionScaleRotation, affine, perspective };

/// x' = a·x + c·y + tx, y' = b·x + d·y + ty.
struct Affine {
  double a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
};

/// The least-squares transform of `method` (not `vertices` / `perspective`)
/// mapping `src` onto `dst`; nullopt with too few points (1 for position, 2
/// for the similarities, 3 for affine) or a degenerate set.
[[nodiscard]] std::optional<Affine> fit_affine(std::span<const tracking::Pt> src, std::span<const tracking::Pt> dst, Method method);

/// `path` moved by `t`: vertices mapped, tangents (relative to their vertex) by the linear part.
void transform_path(api::BezierPath& path, const Affine& t);
/// `path` moved by the homography `h`: vertices and absolute handle ends projected, tangents re-derived.
void transform_path(api::BezierPath& path, const tracking::Mat3& h);

/// The method from the job's enum.
[[nodiscard]] Method method_of(api::MaskTrackMethod m) noexcept;

}  // namespace premation::jobs::maskfit
