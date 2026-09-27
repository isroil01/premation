// The 3D Camera Tracker's solves — src/core/tracking/planarPose.ts,
// triangulate.ts, bundleAdjust.ts and sfmCamera.ts, ported operation for
// operation (transcendentals through motion_jsmath, V8's fdlibm; the
// homography through tracking.hpp's Float32 port of Homography.ts):
//
//   planarPose.ts     solvePlanarPose (Zhang's plane-based pose from ≥ 4
//                     plane ↔ image correspondences and a known lens),
//                     unwrapDegrees
//   triangulate.ts    triangulateMidpoint, projectPoint
//   bundleAdjust.ts   yprToR, bundleAdjust (Levenberg–Marquardt over cameras
//                     1…n and the points, finite-difference Jacobian, Huber)
//   sfmCamera.ts      essentialPose (eight-point E, cheirality), the
//                     incremental path, refineWithBundleAdjust,
//                     solveSfmCameraPath (planar when the first four points are
//                     a quad — AE's hybrid)
//
// Angle conventions are the engine's: world→camera = Rz(−roll)·Rx(−pitch)·
// Ry(−yaw)·(p − C); yaw → orientationY, pitch → orientationX, roll →
// orientationZ. Pure.
#pragma once

#include <array>
#include <optional>
#include <vector>

namespace premation::jobs::camsolve {

struct V2 {
  double x = 0;
  double y = 0;
};
struct V3 {
  double x = 0;
  double y = 0;
  double z = 0;
};
/// Row-major 3×3.
using M3 = std::array<std::array<double, 3>, 3>;

/// planarPose.ts PlanarPose.
struct PlanarPose {
  V3 position;
  double yawDeg = 0;
  double pitchDeg = 0;
  double rollDeg = 0;
  double rmsPx = 0;
};

/// `solvePlanarPose(plane, image, f, cx, cy)`; nullopt when degenerate.
[[nodiscard]] std::optional<PlanarPose> solve_planar_pose(const std::vector<V2>& plane, const std::vector<V2>& image,
                                                          double f, double cx, double cy);
/// `unwrapDegrees(series)` (in place, returned).
std::vector<double>& unwrap_degrees(std::vector<double>& series);

/// triangulate.ts CameraRt: world→camera R and the eye C.
struct CameraRt {
  M3 R{};
  V3 C;
};
[[nodiscard]] std::optional<V3> triangulate_midpoint(const CameraRt& cam1, const CameraRt& cam2, V2 x1, V2 x2);
struct UV {
  double u = 0;
  double v = 0;
};
[[nodiscard]] std::optional<UV> project_point(const M3& R, const V3& C, const V3& X, double f, double cx, double cy);

// ── bundle adjustment ───────────────────────────────────────────────────
struct BaObservation {
  int frame = 0;
  int pointId = 0;
  double x = 0;
  double y = 0;
  double weight = 1;
};
struct BaCamera {
  V3 C;
  double yawDeg = 0;
  double pitchDeg = 0;
  double rollDeg = 0;
};
struct BaOptions {
  double focal = 0;
  double cx = 0;
  double cy = 0;
  int maxIters = 12;
  double lambda0 = 1e-2;
  double huberDelta = 4;
};
struct BaResult {
  std::vector<BaCamera> cameras;
  std::vector<V3> points;
  double rmsPx = 999;
  int iters = 0;
};
[[nodiscard]] M3 ypr_to_r(double yawDeg, double pitchDeg, double rollDeg);
[[nodiscard]] BaResult bundle_adjust(const std::vector<BaObservation>& obs, const std::vector<BaCamera>& cameras,
                                     const std::vector<V3>& points, const BaOptions& opts);

// ── SfM ─────────────────────────────────────────────────────────────────
struct RelativePose {
  M3 R{};
  std::array<double, 3> t{};
};
/// `essentialPose(a, b, f, cx, cy)`.
[[nodiscard]] std::optional<RelativePose> essential_pose(const std::vector<V2>& a, const std::vector<V2>& b, double f,
                                                         double cx, double cy);

/// sfmCamera.ts SfmCameraPose.
struct SfmPose {
  double x = 0;
  double y = 0;
  double z = 0;
  double yawDeg = 0;
  double pitchDeg = 0;
  double rollDeg = 0;
  double error = 0;
};
/// `solveSfmCameraPath(frames, {focalLength, width, height})`: one pose per frame.
[[nodiscard]] std::vector<SfmPose> solve_sfm_camera_path(const std::vector<std::vector<V2>>& frames, double focalLength,
                                                         double width, double height);

}  // namespace premation::jobs::camsolve
