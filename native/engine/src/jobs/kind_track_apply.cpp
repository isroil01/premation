// Job kind `trackApply` — a track the UI already holds, applied by the engine
// (src/layout/Inspector/trackMotion/trackMotionActions.ts onApply /
// onCreateNullAndApply / onCreateNullsForPlanes, trackApplyEdits.ts,
// applyTrack.ts plans — track_plans.hpp). The samples are the tracker's own
// (a trackMotion job's summary `tracks`, or the page tracker's), in the
// footage's source display pixels at composition times.
//
//   follow          planTrackToLayer; a camera target: planTrackToCamera
//   transform       planTransformTrack (rotation and scale, 2 tracks); a
//                   camera target: planCameraSolveTrack
//   corner          planCornerPinTrack (≥ 4 tracks; more: RANSAC plane)
//   stabilize       planStabilize on `layer`
//   meshWarp        planMeshWarpTrack: the target's first Mesh Warp (added when
//                   it has none) — its 4×4 lattice on the tracked plane
//                   (bilinear from 4 corners; RANSAC plane over a dense grid)
//   createNull      Create Null & Apply: `createLayer` null "Tracked Null N"
//                   beside the footage (its layer parent), seeded on the first
//                   sample in that parent's space (trackedNullSeed), keyed per
//                   `nullMode` (follow | transform | corner — planOntoNull)
//   nullsForPlanes  one such null per four tracks, each a corner pin (≥ 8)
//
// Work: nothing to compute (the samples are copied at prepare); apply plans
// against the document as it stands then and sends ONE entry. The summary is
// refreshed after the apply with what it made: {mode, keyframes, nullIds}.
#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "model.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_plans.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using api::TrackApplyMode;
using doc::fail;
namespace ta = trackapply;

namespace {

struct ApplyJob {
  std::string video;
  std::string comp;
  TrackApplyMode mode = TrackApplyMode::follow;
  ta::NullMode nullMode = ta::NullMode::follow;
  std::string target;
  std::vector<ta::Track> tracks;
  double sourceWidth = 0;
  double sourceHeight = 0;
};

ta::NullMode null_mode_of(TrackApplyMode m) {
  switch (m) {
    case TrackApplyMode::follow: return ta::NullMode::follow;
    case TrackApplyMode::transform: return ta::NullMode::transform;
    case TrackApplyMode::corner: return ta::NullMode::corner;
    default: fail(ErrorCode::invalid_argument, "nullMode must be follow, transform or corner");
  }
}

std::string mode_name(TrackApplyMode m) { return std::string(api::to_string(m)); }

class TrackApplyResult final : public JobResult {
 public:
  explicit TrackApplyResult(ApplyJob job) : job_(std::move(job)) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"mode\":" + json_string(mode_name(job_.mode)) + ",\"keyframes\":" + std::to_string(keyframes_) +
                    ",\"nullIds\":[";
    for (std::size_t i = 0; i < nullIds_.size(); ++i) s += (i > 0 ? "," : "") + json_string(nullIds_[i]);
    return s + "]}";
  }

  [[nodiscard]] std::string label() const override {
    switch (job_.mode) {
      case TrackApplyMode::follow: return "Apply Motion Track";
      case TrackApplyMode::transform: return "Apply Motion Track (rotation & scale)";
      case TrackApplyMode::corner: return "Apply Corner Pin Track";
      case TrackApplyMode::stabilize: return "Stabilize Motion";
      case TrackApplyMode::mesh_warp: return "Apply Mesh Warp Track";
      case TrackApplyMode::create_null: return "Create Null & Apply Track";
      case TrackApplyMode::nulls_for_planes: return "Create Nulls for Planes";
      default: break;
    }
    return "Apply Track";
  }

  [[nodiscard]] bool has_edits() const override {
    return std::any_of(job_.tracks.begin(), job_.tracks.end(), [](const ta::Track& t) { return !t.empty(); });
  }

  void apply(JobApply& a) const override {
    keyframes_ = 0;
    nullIds_.clear();
    const ta::Source src{job_.video, job_.sourceWidth, job_.sourceHeight, ta::P2{job_.sourceWidth, job_.sourceHeight}};
    const ta::Track& first = job_.tracks.front();
    const auto send = [&](const std::optional<ta::Plan>& plan) {
      if (!plan) return;
      ta::send_plan(a, *plan);
      keyframes_ += plan->count;
    };
    switch (job_.mode) {
      case TrackApplyMode::follow:
      case TrackApplyMode::transform:
      case TrackApplyMode::corner:
      case TrackApplyMode::mesh_warp:
      case TrackApplyMode::stabilize: {
        const ta::DocView v(a.document(), job_.comp);
        const ta::Planner planner(v, src);
        if (!job_.target.empty() && v.node(job_.target) == nullptr) {
          fail(ErrorCode::not_found, "no layer '" + job_.target + "' to apply the track to", {.layer = job_.target});
        }
        const bool camera = !job_.target.empty() && v.is_camera(job_.target);
        if (job_.mode == TrackApplyMode::follow) send(planner.follow(job_.target, first, camera));
        if (job_.mode == TrackApplyMode::transform) {
          send(camera ? planner.camera_track(job_.target, job_.tracks) : planner.transform(job_.target, job_.tracks, true));
        }
        if (job_.mode == TrackApplyMode::corner) send(planner.corner(job_.target, job_.tracks, {}));
        if (job_.mode == TrackApplyMode::mesh_warp) send(planner.mesh_warp(job_.target, job_.tracks));
        if (job_.mode == TrackApplyMode::stabilize) send(planner.stabilize(first));
        break;
      }
      case TrackApplyMode::create_null: make_null(a, src, job_.nullMode, first, job_.tracks); break;
      case TrackApplyMode::nulls_for_planes:
        for (std::size_t p = 0; p + 4 <= job_.tracks.size(); p += 4) {
          const std::vector<ta::Track> slice(job_.tracks.begin() + static_cast<std::ptrdiff_t>(p),
                                             job_.tracks.begin() + static_cast<std::ptrdiff_t>(p + 4));
          make_null(a, src, ta::NullMode::corner, slice[0], slice);
        }
        break;
      default: fail(ErrorCode::unsupported, "this track apply mode is not handled by the engine");
    }
  }

 private:
  /// createNullCommand + planOntoNull, in the job's entry.
  void make_null(JobApply& a, const ta::Source& src, ta::NullMode mode, const ta::Track& samples,
                 const std::vector<ta::Track>& tracks) const {
    std::optional<ta::NullSeed> seed;
    std::string name;
    {
      const ta::DocView v(a.document(), job_.comp);
      seed = ta::Planner(v, src).null_seed(mode, samples, tracks);
      name = ta::next_tracked_null_name(a.document());
    }
    if (!seed) fail(ErrorCode::invalid_argument, "Could not create null — there is nothing to apply.", {.layer = job_.video});
    api::CreateLayer create;
    create.comp = job_.comp;
    create.kind = api::LayerKind::null;
    create.name = name;
    create.parent = seed->parent;
    create.init.push_back(api::PropertyInit{"transform/position", doc::v_vec2(seed->x, seed->y)});
    const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(create))));
    if (!made) fail(ErrorCode::internal, "createLayer returned no layer");
    nullIds_.push_back(made->layer);
    const ta::DocView v(a.document(), job_.comp);
    const std::optional<ta::Plan> plan = ta::Planner(v, src).onto_null(made->layer, mode, samples, tracks);
    if (!plan) return;
    ta::send_plan(a, *plan);
    keyframes_ += plan->count;
  }

  ApplyJob job_;
  // What the apply made (the summary is refreshed from these after it).
  mutable std::size_t keyframes_ = 0;
  mutable std::vector<std::string> nullIds_;
};

}  // namespace

PreparedJob prepare_track_apply(const api::TrackApplyJob& spec, const JobDocContext& ctx) {
  ApplyJob job;
  job.video = spec.layer;
  const doc::Node* n = ctx.doc.node(spec.layer);
  const std::optional<std::string> comp = n != nullptr ? doc::comp_of_layer(ctx.doc, spec.layer) : std::nullopt;
  if (!comp || *comp == spec.layer) fail(ErrorCode::not_found, "no layer '" + spec.layer + "'", {.layer = spec.layer});
  job.comp = *comp;
  job.mode = spec.mode;
  if (!(spec.source_width > 0) || !(spec.source_height > 0)) {
    fail(ErrorCode::invalid_argument, "sourceWidth / sourceHeight must be the tracked footage's size (> 0)");
  }
  job.sourceWidth = spec.source_width;
  job.sourceHeight = spec.source_height;
  for (const api::TrackSeries& s : spec.tracks) {
    ta::Track t;
    t.reserve(s.samples.size());
    for (const api::TrackSampleRow& r : s.samples) t.push_back(ta::CompSample{seconds_of(r.time), r.x, r.y, r.confidence, r.coasted});
    job.tracks.push_back(std::move(t));
  }
  const std::size_t nTracks = job.tracks.size();
  if (nTracks == 0) fail(ErrorCode::invalid_argument, "no tracks to apply");
  const auto need = [&](std::size_t k, const char* what) {
    if (nTracks < k) fail(ErrorCode::invalid_argument, what);
  };
  const bool wantsTarget = spec.mode == TrackApplyMode::follow || spec.mode == TrackApplyMode::transform ||
                           spec.mode == TrackApplyMode::corner || spec.mode == TrackApplyMode::mesh_warp;
  if (wantsTarget) {
    if (!spec.target || spec.target->empty()) fail(ErrorCode::invalid_argument, "this apply needs a target layer");
    const std::optional<std::string> tc = ctx.doc.node(*spec.target) != nullptr ? doc::comp_of_layer(ctx.doc, *spec.target) : std::nullopt;
    if (!tc || *tc == *spec.target) fail(ErrorCode::not_found, "no layer '" + *spec.target + "' to apply the track to", {.layer = *spec.target});
    job.target = *spec.target;
  }
  switch (spec.mode) {
    case TrackApplyMode::follow:
    case TrackApplyMode::stabilize: break;
    case TrackApplyMode::transform:
      if (nTracks != 2) fail(ErrorCode::invalid_argument, "a rotation / scale apply needs exactly two tracks (anchor, reference)");
      break;
    case TrackApplyMode::corner: need(4, "a corner pin needs four tracks (top left, top right, bottom right, bottom left)"); break;
    case TrackApplyMode::mesh_warp: need(4, "a mesh warp needs four corner tracks (top left, top right, bottom right, bottom left)"); break;
    case TrackApplyMode::create_null:
      job.nullMode = null_mode_of(spec.null_mode.value_or(TrackApplyMode::follow));
      if (job.nullMode == ta::NullMode::transform && nTracks < 2) fail(ErrorCode::invalid_argument, "a rotation / scale null needs two tracks");
      if (job.nullMode == ta::NullMode::corner) need(4, "a corner pin null needs four tracks");
      break;
    case TrackApplyMode::nulls_for_planes: need(8, "Need at least two quads (8 tracks) for multi-plane nulls."); break;
    case TrackApplyMode::camera_solve:
      fail(ErrorCode::unsupported, "the engine does not apply '" + mode_name(spec.mode) + "' yet");
  }
  return PreparedJob{"trackApply", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
    if (control.cancelled()) return nullptr;
    return std::make_unique<TrackApplyResult>(job);
  }};
}

}  // namespace premation::jobs
