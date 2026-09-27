// Smooth (dense) stabilization's arithmetic — src/core/tracking/globalMotion.ts
// and the frame half of smoothStabilize.ts, ported operation for operation:
//
//   smoothStabilize.ts  the canvas-path luma (Rec.601, 0–255, Float32),
//                       downsampleLuma (integer box filter), the ≤480 px flow
//                       raster, one similarity per adjacent frame pair.
//   pixelMotionFlow.ts  computeFlow over FLOAT luma (the stabilizer feeds it
//                       Float32 planes, not the integer Pixel Motion luma):
//                       the SAD search is here, `finalizeFlow` is the engine's
//                       existing port (scene/pixel_motion.hpp).
//   globalMotion.ts     Sim algebra, flowSamplePoints, fitSimilarity (closed
//                       form + two median trims), stabilizingCorrections
//                       (cumulative path, unwrapped rotation / log scale,
//                       edge-renormalized Gaussian, smooth ∘ actual⁻¹).
//
// Transcendentals go through motion_jsmath (V8's fdlibm), so the corrections
// are the TypeScript's to the bit for the same luma. Pure: no ffmpeg, no
// document (the job glue is kind_stabilize.cpp).
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "scene/pixel_motion.hpp"

namespace premation::jobs::stabilize {

/// x' = a·x − b·y + tx ; y' = b·x + a·y + ty.
struct Sim {
  double a = 1;
  double b = 0;
  double tx = 0;
  double ty = 0;
};

[[nodiscard]] Sim compose_sim(const Sim& outer, const Sim& inner) noexcept;
[[nodiscard]] Sim invert_sim(const Sim& s) noexcept;
struct XY {
  double x = 0;
  double y = 0;
};
[[nodiscard]] XY apply_sim(const Sim& s, double x, double y) noexcept;
/// Radians.
[[nodiscard]] double sim_rotation(const Sim& s) noexcept;
[[nodiscard]] double sim_scale(const Sim& s) noexcept;
[[nodiscard]] Sim sim_from(double rot, double scale, double tx, double ty) noexcept;

/// A Float32 luma plane (0–255 for the stabilizer).
struct FloatLuma {
  int w = 0;
  int h = 0;
  std::vector<float> data;
};

/// smoothStabilize.ts canvasReader: r·0.299 + g·0.587 + b·0.114, 0–255.
[[nodiscard]] FloatLuma luma_255_of(std::span<const std::uint8_t> rgba, int w, int h);
/// `downsampleLuma(data, w, h, factor)`.
[[nodiscard]] FloatLuma downsample_luma(const FloatLuma& in, int factor);
/// smoothStabilize.ts: max(1, floor(max(w, h) / 480)).
[[nodiscard]] int flow_factor(int decodedW, int decodedH) noexcept;

/// `computeFlow(a, b, w, h, opts)` over Float32 luma (`lumaOf` planes are luma_255_of).
[[nodiscard]] scene::pixmo::FlowField compute_flow_f32(const FloatLuma& a, const FloatLuma& b,
                                                       const scene::pixmo::FlowOptions& opts = {});
/// pixelMotionFlow.ts `sampleFlow(f, x, y)`: bilinear at a FLOW-RESOLUTION position, edge-clamped.
[[nodiscard]] XY sample_flow(const scene::pixmo::FlowField& f, double x, double y) noexcept;

struct MotionSamplePoint {
  double x = 0;
  double y = 0;
  double dx = 0;
  double dy = 0;
};
/// `flowSamplePoints(f, scaleX, scaleY)`: the valid grid points only.
[[nodiscard]] std::vector<MotionSamplePoint> flow_sample_points(const scene::pixmo::FlowField& f, double scaleX,
                                                                double scaleY);
/// `fitSimilarity(points, trimRounds = 2)`; nullopt below 3 usable points.
[[nodiscard]] std::optional<Sim> fit_similarity(std::span<const MotionSamplePoint> points, int trimRounds = 2);

/// One adjacent pair: flow a→b, fitted in the caller's grid (flow px × scale).
[[nodiscard]] std::optional<Sim> pair_motion(const FloatLuma& a, const FloatLuma& b, double scaleX, double scaleY);

/// subspaceWarp.ts SubspaceCell: a cell centre (flow-sample coordinates) and its local similarity.
struct Cell {
  double cx = 0;
  double cy = 0;
  Sim sim;
};
/// `fitSubspaceWarp(field, rows, cols, scaleX, scaleY)`: rows×cols local similarities (15 % overlap, one trim
/// round; identity when under-constrained), row-major.
[[nodiscard]] std::vector<Cell> fit_subspace_warp(const scene::pixmo::FlowField& f, int rows, int cols, double scaleX,
                                                  double scaleY);
/// `estimateRollingShutterShear(field, scaleX, scaleY)`: k in dx ≈ k·(y − cy); 0 below 8 samples.
[[nodiscard]] double estimate_rolling_shutter_shear(const scene::pixmo::FlowField& f, double scaleX, double scaleY);
/// `applyRollingShutterRepair(x, y, cy, k)`.
[[nodiscard]] XY apply_rolling_shutter_repair(double x, double y, double cy, double shearK) noexcept;

/// `stabilizingCorrections(pairs, sigmaFrames)`: pairs.size() + 1 corrections.
[[nodiscard]] std::vector<Sim> stabilizing_corrections(std::span<const std::optional<Sim>> pairs, double sigmaFrames);

}  // namespace premation::jobs::stabilize
