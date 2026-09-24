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

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

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
};

struct RigResult {
  std::optional<DeformedMeshData> mesh;
  /// Rig features this port does not produce (the layer is reported, not faked).
  std::vector<std::string> unported;
};

/// `hasPuppet || hasSkel` (pins / bones non-empty).
[[nodiscard]] bool rig_present(const Json& fx);

/// The rig block: rest mesh → puppet deform → skeleton skinning → overlap order.
[[nodiscard]] RigResult build_rig_mesh(const RigInputs& in, const RigSampler& anim);

}  // namespace premation::scene
