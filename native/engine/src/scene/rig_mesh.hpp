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
// Float32Array; V8 `Math.*` through motion::js. Fixed iteration counts, no
// threading, no caches whose state could change a result — same input, same
// bytes (CLAUDE.md determinism).
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
#include "scene_types.hpp"

namespace premation::scene {

/// The animation reads the rig needs (AnimationEngine.sample / sampleData on the layer's node).
struct RigSampler {
  std::function<std::optional<double>(std::string_view path, double t)> sample;
  std::function<std::optional<Json>(std::string_view path, double t)> sampleData;
};

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
};

struct RigResult {
  std::optional<DeformedMeshData> mesh;
  /// Rig features this port does not produce (the layer is reported, not faked).
  std::vector<std::string> unported;
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
/// One stored IK goal, live at the time.
struct RigIkOut {
  std::string bone;
  bool enabled = true;
  double x = 0, y = 0;
  std::optional<std::array<double, 2>> pole;
  std::optional<double> chainLength;
  std::string mode;  ///< 'ik' | 'fk'
};

/// The rig of one layer resolved at a time, for the overlays and getRigPose:
/// nodeRestMesh's mesh (rigMeshInputs.ts — `authoring` = the Puppet Pin tool's
/// pinless preview), the puppet solve, the skeleton pose on top, and the point
/// helpers of rigDeform.ts / puppet.ts over them.
class RigModel {
 public:
  struct Impl;
  explicit RigModel(std::unique_ptr<Impl> impl);
  RigModel(RigModel&&) noexcept;
  RigModel& operator=(RigModel&&) noexcept;
  RigModel(const RigModel&) = delete;
  RigModel& operator=(const RigModel&) = delete;
  ~RigModel();

  std::vector<RigPinOut> pins;
  std::vector<RigBoneOut> bones;
  std::vector<RigIkOut> ik;
  /// What renders: the puppet solve through the skeleton (x, y, u, v per vertex).
  std::vector<float> vertices;

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
};

/// The model for `in` (fx, the layer's box, pad, path, coverage; `rigT` the keyframe-axis time).
/// nullopt: no pins and no bones and not `authoring`, or a mesh this port cannot build (`unported` says why).
[[nodiscard]] std::optional<RigModel> build_rig_model(const RigInputs& in, const RigSampler& anim, bool authoring,
                                                      bool previewSilhouette, std::vector<std::string>& unported);

}  // namespace premation::scene
