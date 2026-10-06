// The Track Motion PLANS (src/core/tracking/applyTrack.ts), over the engine's
// document (core thread, inside a JobResult's apply): tracked samples in the
// footage's source display pixels → keys per legacy track at composition
// seconds (track_apply.hpp Plan), sent by send_plan as the job's one entry.
//
//   follow        planTrackToLayer / planTrackToCamera (+ poiX / poiY)
//   stabilize     planStabilize (the tracked layer moved against its feature)
//   transform     planTransformTrack (2 points: position, rotation, scale)
//   cameraTrack   planCameraSolveTrack (a camera: follow + orientationZ)
//   corner        planCornerPinTrack (4 corners; more: RANSAC plane, smoothed)
//   meshWarp      planMeshWarpTrack (Mesh Warp's 4×4 lattice on the plane)
//   nullSeed      trackedNullSeed (Create Null & Apply's null, beside the footage)
//   ontoNull      planOntoNull (follow | transform | corner onto that null)
//   subspaceMesh  planSubspaceMeshSequence (the Warp Stabilizer's mesh keys)
//
// Every plan measures through the layers' CURRENT transforms (all deltas
// planned before anything is written — the planExpressionBake discipline).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "stabilize.hpp"
#include "track_apply.hpp"

namespace premation::jobs::trackapply {

/// trackVideoLayer.ts CompTrackSample: composition seconds, source display px.
struct CompSample {
  double compTime = 0;
  double x = 0;
  double y = 0;
  double confidence = 0;
  bool coasted = false;
};
using Track = std::vector<CompSample>;

/// The footage the samples were measured in.
struct Source {
  std::string video;
  /// The source display grid the samples are in (trackerSource.ts sourceDisplaySize).
  double width = 0;
  double height = 0;
  /// The video's box when `readGeometry` reports none (the footage's stored size).
  P2 box;
};

/// applyTrack.ts NullTrackMode.
enum class NullMode : std::uint8_t { follow, transform, corner };

/// trackedNullSeed: where Create Null & Apply puts the null.
struct NullSeed {
  /// The video's layer parent (createNullCommand's `apiParentOf`), none at the top level.
  std::optional<std::string> parent;
  double x = 160;
  double y = 120;
};

/// subspaceWarp.ts SubspaceCell.
struct SubspaceCell {
  double cx = 0;
  double cy = 0;
  stabilize::Sim sim;
};

/// One frame of the subspace stabilizer's mesh path.
struct MeshFrame {
  std::vector<SubspaceCell> cells;
  double compTime = 0;
};

class Planner {
 public:
  Planner(const DocView& v, Source s) : v_(v), s_(std::move(s)) {}

  /// trackSampleToComp.
  [[nodiscard]] std::optional<P2> to_comp(double x, double y, double compTime) const;
  /// A comp point in `target`'s parent space (comp space when it has none); nullopt when unmeasurable.
  [[nodiscard]] std::optional<P2> to_parent(const std::string& target, P2 c, double compTime) const;

  [[nodiscard]] std::optional<Plan> follow(const std::string& target, const Track& samples, bool camera) const;
  [[nodiscard]] std::optional<Plan> stabilize(const Track& samples) const;
  /// AE parity 3.6: two points stabilize position AND rotation (and scale):
  /// each frame the video layer is moved by the similarity that takes the
  /// pair back to where it was on the first frame.
  [[nodiscard]] std::optional<Plan> stabilize_transform(const std::vector<Track>& tracks, bool wantScale) const;
  /// AE parity 3.6: a point track onto any 2D point param of an effect
  /// (`<param>X` / `<param>Y`, layer px from the layer's centre).
  [[nodiscard]] std::optional<Plan> effect_point(const std::string& target, const std::string& effectId,
                                                 const std::string& effectType, const std::string& param,
                                                 const Track& samples) const;
  [[nodiscard]] std::optional<Plan> transform(const std::string& target, const std::vector<Track>& tracks, bool wantScale) const;
  [[nodiscard]] std::optional<Plan> camera_track(const std::string& target, const std::vector<Track>& tracks) const;
  /// `effectId` '' = the target's first Corner Pin (added by send_plan when it has none).
  [[nodiscard]] std::optional<Plan> corner(const std::string& target, const std::vector<Track>& tracks,
                                           const std::string& effectId) const;
  [[nodiscard]] std::optional<Plan> mesh_warp(const std::string& target, const std::vector<Track>& tracks) const;

  [[nodiscard]] std::optional<NullSeed> null_seed(NullMode mode, const Track& samples, const std::vector<Track>& tracks) const;
  [[nodiscard]] std::optional<Plan> onto_null(const std::string& nullId, NullMode mode, const Track& samples,
                                              const std::vector<Track>& tracks) const;

  [[nodiscard]] const DocView& view() const noexcept { return v_; }
  [[nodiscard]] const Source& source() const noexcept { return s_; }

 private:
  const DocView& v_;
  Source s_;
};

/// planSubspaceMeshSequence: Mesh Warp lattice keys (v{i}X / v{i}Y) for every frame of a subspace path.
[[nodiscard]] std::optional<Plan> plan_subspace_mesh(const std::string& layer, const std::vector<MeshFrame>& frames,
                                                     int rows, int cols, double fieldW, double fieldH, double layerW,
                                                     double layerH);

/// subspaceWarp.ts `sampleSubspace`: the grid at (x, y), the four nearest cells' sims blended bilinearly.
[[nodiscard]] P2 sample_subspace(const std::vector<SubspaceCell>& cells, int rows, int cols, double x, double y,
                                 double fieldW, double fieldH);

/// "Tracked Null", "Tracked Null 2", … counted over every layer of the document (nextTrackedNullNameIn).
[[nodiscard]] std::string next_tracked_null_name(const doc::Document& d);

}  // namespace premation::jobs::trackapply
