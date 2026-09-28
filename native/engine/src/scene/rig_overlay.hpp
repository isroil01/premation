// The rig as the overlays see it (B4 round 5, ENGINE_API.md §15.14): the
// overlay push's `rig` record and `getRigPose`, over the engine's own document —
// the C++ twin of src/core/engine/rigOverlay.ts. The layer's rig inputs are
// assembled as nodeRestMesh assembles them (rigMeshInputs.ts: the layer's box at
// the time, the mesh pad of its stroke / paint, its closed path as the
// silhouette, an image's alpha coverage), then rig_mesh.cpp's RigModel resolves
// pins, bones, IK goals and the deformed mesh. GPU-free (engine_scene_core);
// the media-side inputs (an image's decoded alpha, a paint stroke's reach) are
// injected by the frame builder, and absent in the core tests (the bbox grid).
#pragma once

#include <functional>
#include <memory>
#include <string>

#include "alpha_mesh.hpp"
#include "model.hpp"
#include "session_hooks.hpp"

namespace premation::scene {

/// The media-side inputs of a rig mesh (engine_scene supplies them; unset = none).
struct RigMediaHooks {
  /// rigCoverageMask for an image / SVG layer with no path silhouette: its alpha coverage (null = the bbox
  /// grid). A non-empty `unreachable` means the source cannot be read here — no rig record this frame.
  std::function<std::shared_ptr<const rig::CoverageMask>(const doc::Document& d, const doc::Node& n, std::string& unreachable)>
      coverage;
  /// paintReach of a Paint component's `paint` (paint strokes pad the mesh like the raster); unset = 0.
  std::function<double(const js::Json& paint)> paintReach;
};

class DocRigQueries final : public RigQueries {
 public:
  explicit DocRigQueries(RigMediaHooks hooks = {}) : hooks_(std::move(hooks)) {}

  [[nodiscard]] std::optional<api::OverlayRig> rig_overlay(const doc::Document& d, const doc::EditorView& view,
                                                           const doc::ExprEnv& expr, doc::ExprCache& cache, TextQueries* text,
                                                           std::string_view layer, double seconds,
                                                           const api::OverlayRigOptions& opts) override;
  [[nodiscard]] api::RigPose rig_pose(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                      doc::ExprCache& cache, TextQueries* text, std::string_view layer, double seconds,
                                      const std::vector<api::Vec2>& points, std::optional<std::uint32_t> vertex,
                                      bool authoring) override;

 private:
  RigMediaHooks hooks_;
};

}  // namespace premation::scene
