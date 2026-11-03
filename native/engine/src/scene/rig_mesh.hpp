// Puppet pins and skeleton rigs — the C++ port of the rig block of
// buildSnapshot.ts (the `fx.puppet` / `fx.skeleton` → `layer.deformedMesh`
// section) and the rig modules it calls, call for call:
//
//   src/core/rig/puppet.ts        buildRestMesh (grid + silhouette), finishRestMesh,
//                                 deformLbs, overlapDepthField, sortTrianglesByDepth
//   src/core/rig/mesh.ts          earClip, subdivide, polygonArea
//   src/core/rig/bendPins.ts      bend pins (driver solve + 0.8 rigid core via ARAP)
//   src/core/rig/arap.ts          ARAP local/global solve (dense Cholesky / Gauss–Seidel)
//   src/core/rig/livePins.ts      resolveLivePins
//   src/core/rig/liveBones.ts     resolveLiveBones
//   src/core/rig/liveIkTargets.ts resolveActiveIkTargets
//   src/core/rig/rigDeform.ts     applyIk, getSkeletonBinding, skinRigVertices
//   src/core/rig/skeleton.ts, mat2d.ts, skinning.ts, autoWeight.ts,
//   geodesicWeights.ts, weightPaint.ts, ik.ts
//
// Float64 arithmetic with Float32 storage exactly where the TypeScript keeps a
// Float32Array; V8 `Math.*` through motion::js. No threading inside a solve.
//
// Since 2026-11-02 (rigging program, stream C1) the port has moved past the
// TypeScript in four places, each pinned by tests/test_rig_cache.cpp:
//   R1  the per-rest-state products — rest mesh + pin bindings + harmonic
//       weights + Laplacian topology, the ARAP Cholesky factor, the skeleton's
//       geodesic bone weights, a re-cut coverage mask — live in bounded,
//       VALUE-keyed LRU caches (rig_cache.hpp). A key is the serialised inputs
//       that determine the product, so a hit is bit-identical to a miss; a
//       frame only runs the ARAP right-hand side, the skinning and the sort.
//       build_rig_mesh and build_rig_model share the caches.
//   R2  image coverage is cut from the decoded alpha at ~coverage_cell_px per
//       cell (traceAccuracy) and kept by area share over alphaThreshold.
//   R3  a pin binds to its containing triangle (barycentric), and the harmonic
//       weights are solved to tolerance (CG on the cotangent Laplacian).
//   R4  8 ARAP outer iterations with a cached factor; `preserveVolume`
//       dual-quaternion skinning; the IK/FK track blends 0..1.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "alpha_mesh.hpp"
#include "rig_cache.hpp"
#include "scene_types.hpp"
#include "skeleton_pose.hpp"

namespace premation::scene {

using rig::RigCacheStats;
/// Drops every cached rest-state product (tests; a hit must equal a miss).
void rig_cache_clear();
/// The caches' entry / byte / hit / miss totals.
[[nodiscard]] RigCacheStats rig_cache_stats();

/// The layer-side inputs buildSnapshot hands the rig block.
struct RigInputs {
  const Json* fx = nullptr;          ///< the node's fx props
  double width = 100, height = 100;  ///< layer.width ?? 100, layer.height ?? 100
  double pad = 0;                    ///< rasterPadding(layer) at the rig point
  const Json* pathPoints = nullptr;  ///< BezierPoint[] | undefined
  bool pathOpen = false;
  double rigT = 0;                   ///< layer.sourceTime ?? t
  /// An image layer's alpha coverage (rigCoverageMask; null = the bbox grid).
  const rig::CoverageMask* coverage = nullptr;
  /// A character (a group layer with bones, bone_link.hpp): the skeleton's pose with no mesh — build_rig_model
  /// answers the bones and IK goals over an empty rest mesh, nothing skinned.
  bool poseOnly = false;
};

struct RigResult {
  std::optional<DeformedMeshData> mesh;
  /// What the rig was built WITHOUT (a malformed density read as the default, a
  /// fractional density floored, a weight paint with no bones map ignored): the
  /// caller reports these as `warning` layer errors; the mesh still deforms.
  std::vector<std::string> warnings;
};

/// `hasPuppet || hasSkel` (pins / bones non-empty).
[[nodiscard]] bool rig_present(const Json& fx);

/// buildRestMesh's output for these inputs (x, y, u, v + triangles) — the cross-
/// engine tests of the image-alpha coverage paths; nullopt when build_rig_mesh
/// would report the layer.
struct RestMeshView {
  std::vector<float> vertices;
  std::vector<std::uint16_t> triangles;
};
[[nodiscard]] std::optional<RestMeshView> rest_mesh_for(const RigInputs& in);

/// The rig block: rest mesh → puppet deform → skeleton skinning → overlap order.
[[nodiscard]] RigResult build_rig_mesh(const RigInputs& in, const RigSampler& anim);

// ── B4 round 5: the rig as the overlays see it (rig_overlay.cpp; src/core/engine/rigOverlay.ts) ──

/// One puppet pin at the time (layer space): drawn point (through the skeleton), its pre-skeleton
/// point (a bend pin's solved vertex), live rotation (degrees) and scale.
struct RigPinOut {
  std::string id;
  std::string kind;  ///< pinKindOf: 'advanced' when absent
  double x = 0, y = 0, cx = 0, cy = 0, rotation = 0, scale = 1;
};
/// One bone: live pose (before IK), solved pose, solved world matrix (a, b, c, d, e, f).
struct RigBoneOut {
  std::string id;
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
  double posedX = 0, posedY = 0, posedRotation = 0;
  std::optional<std::array<double, 6>> world;
};
/// The rig of one layer resolved at a time, for the overlays and getRigPose:
/// nodeRestMesh's mesh (rigMeshInputs.ts — `authoring` = the Puppet Pin tool's
/// pinless preview), the puppet solve, the skeleton pose on top, and the point
/// helpers of rigDeform.ts / puppet.ts over them.
class RigModel {
 public:
  struct Impl;
  /// The resolved pose the overlays and getRigPose read.
  struct Pose {
    std::vector<RigPinOut> pins;
    std::vector<RigBoneOut> bones;
    std::vector<RigIkOut> ik;
    /// What renders: the puppet solve through the skeleton (x, y, u, v per vertex).
    std::vector<float> vertices;
  };
  RigModel(std::unique_ptr<Impl> impl, Pose pose);
  RigModel(RigModel&&) noexcept;
  RigModel& operator=(RigModel&&) noexcept;
  RigModel(const RigModel&) = delete;
  RigModel& operator=(const RigModel&) = delete;
  ~RigModel();

  [[nodiscard]] const std::vector<RigPinOut>& pins() const noexcept { return pose_.pins; }
  [[nodiscard]] const std::vector<RigBoneOut>& bones() const noexcept { return pose_.bones; }
  [[nodiscard]] const std::vector<RigIkOut>& ik() const noexcept { return pose_.ik; }
  [[nodiscard]] const std::vector<float>& vertices() const noexcept { return pose_.vertices; }

  /// The rest mesh (x, y, u, v) and its triangles.
  [[nodiscard]] const std::vector<float>& rest() const noexcept;
  [[nodiscard]] const std::vector<std::uint16_t>& triangles() const noexcept;
  /// The puppet lattice (PuppetOverlay puppetLatticePath) as index pairs.
  [[nodiscard]] std::vector<std::uint32_t> lattice_edges() const;
  /// `bone`'s bind weight per rest vertex (empty without a skeleton).
  [[nodiscard]] std::vector<double> bone_weights(std::string_view bone) const;
  /// Vertex `v`'s bind weights, strongest first (empty without a skeleton / past the mesh).
  [[nodiscard]] std::vector<std::pair<std::string, double>> vertex_weights(std::size_t v) const;
  /// skinPointAt(p, p) — identity without a skeleton.
  [[nodiscard]] std::array<double, 2> skin(double x, double y) const;
  /// unskinPoint — identity without a skeleton.
  [[nodiscard]] std::array<double, 2> unskin(double x, double y) const;
  /// restPointFromDeformed over the puppet solve (nullopt off the mesh).
  [[nodiscard]] std::optional<std::array<double, 2>> rest_from_deformed(double x, double y) const;

 private:
  std::unique_ptr<Impl> impl_;
  Pose pose_;
};

/// The model for `in` (fx, the layer's box, pad, path, coverage; `rigT` the keyframe-axis time).
/// nullopt: no pins and no bones and not `authoring`. `warnings` says what the mesh was built without (RigResult).
[[nodiscard]] std::optional<RigModel> build_rig_model(const RigInputs& in, const RigSampler& anim, bool authoring,
                                                      bool previewSilhouette, std::vector<std::string>& warnings);

}  // namespace premation::scene
