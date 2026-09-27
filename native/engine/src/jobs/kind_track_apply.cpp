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
//   cameraSolve     the 3D Camera Tracker (trackApplyEdits.ts solveCameraEdit):
//                   the SfM / planar-hybrid solve (camera_solve.hpp,
//                   planSfmCameraSolve; planPlanarCameraSolve when it cannot
//                   run) keyed as x / y / z + orientationX / Y / Z onto the
//                   composition's solve camera (tagged `camera/trackerSolve`),
//                   created on the first run ("3D Camera Tracker"). The lens is
//                   the camera's focalLength (the default lens otherwise). The
//                   TS searched every composition for the tagged camera; the
//                   engine searches the footage's own.
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
#include "camera_solve.hpp"
#include "jsmath.hpp"
#include "track_plans.hpp"
#include "tracking.hpp"
#include "transform.hpp"
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

namespace cs = camsolve;

/// What a camera solve reports (applyTrack.ts PlanarCameraSolveResult).
struct SolveReport {
  std::string cameraId;
  std::size_t keyframes = 0;
  double meanRmsPx = 0;
  std::size_t solvedFrames = 0;
  std::size_t totalFrames = 0;
};

struct CameraSolvePlan {
  ta::Plan plan;
  SolveReport report;
};

std::size_t min_len(const std::vector<ta::Track>& tracks) {
  std::size_t n = tracks.empty() ? 0 : tracks[0].size();
  for (const ta::Track& t : tracks) n = std::min(n, t.size());
  return n;
}

/// `canSolveCamera`: four tracks, at least one frame.
bool can_solve_camera(const std::vector<ta::Track>& tracks) { return tracks.size() >= 4 && min_len(tracks) > 0; }

/// `findSolveCamera`: the camera a previous solve made in `comp`, or ''.
std::string find_solve_camera(const doc::Document& d, const std::string& comp) {
  for (const auto& [id, n] : d.nodes()) {
    if (!n || n->kind() != "camera") continue;
    const std::optional<std::string> c = doc::comp_of_layer(d, id);
    if (!c || *c != comp) continue;
    for (const doc::Component& k : n->components) {
      const doc::Json& v = k.props.at("__planarSolveCamera");
      if (v.is_bool() && v.b()) return id;
    }
  }
  return {};
}

/// `cameraFocal`: the solve camera's focalLength, else the default lens of the composition.
double camera_focal(const doc::Document& d, const std::string& camId, double compW, double compH) {
  if (const doc::Node* n = d.node(camId)) {
    if (const doc::Component* t = n->comp("Transform")) {
      const doc::Json& f = t->props.at("focalLength");
      if (f.is_number() && f.num() > 0) return f.num();
    }
  }
  return motion::xf::default_camera(compW, compH).focal_length;
}

ta::Write write_of(std::string track, const std::vector<double>& times, const std::vector<double>& vals) {
  ta::Write w{std::move(track), {}};
  for (std::size_t i = 0; i < vals.size() && i < times.size(); ++i) w.keys.emplace_back(times[i], vals[i]);
  return w;
}

/// `planSfmCameraSolve`.
std::optional<CameraSolvePlan> plan_sfm_camera_solve(const std::vector<ta::Track>& tracks, double sourceW, double sourceH,
                                                     double focal, const std::string& camId) {
  if (!can_solve_camera(tracks)) return std::nullopt;
  const std::size_t nFrames = min_len(tracks);
  std::vector<std::vector<cs::V2>> frames;
  for (std::size_t fi = 0; fi < nFrames; ++fi) {
    std::vector<cs::V2> pts;
    for (const ta::Track& t : tracks) pts.push_back(cs::V2{t[fi].x, t[fi].y});
    frames.push_back(std::move(pts));
  }
  const std::vector<cs::SfmPose> path = cs::solve_sfm_camera_path(frames, focal, sourceW, sourceH);
  std::vector<double> times;
  std::vector<double> x, y, z, ox, oy, oz;
  double errSum = 0;
  for (std::size_t i = 0; i < path.size(); ++i) {
    times.push_back(tracks[0][i].compTime);
    x.push_back(path[i].x);
    y.push_back(path[i].y);
    z.push_back(path[i].z);
    ox.push_back(path[i].pitchDeg);
    oy.push_back(path[i].yawDeg);
    oz.push_back(path[i].rollDeg);
    errSum += path[i].error;
  }
  std::vector<ta::Write> writes{write_of("x", times, x), write_of("y", times, y), write_of("z", times, z),
                                write_of("orientationX", times, ox), write_of("orientationY", times, oy),
                                write_of("orientationZ", times, oz)};
  const std::size_t count = path.size() * writes.size();
  CameraSolvePlan out{ta::Plan{"Apply 3D Camera Tracker (SfM)", camId, std::move(writes), {}, {}, count}, {}};
  out.report = SolveReport{camId, count, errSum / static_cast<double>(std::max<std::size_t>(1, path.size())), path.size(), nFrames};
  return out;
}

/// `planPlanarCameraSolve`: the tracked plane as the comp plane (z = 0), footage contain-fitted.
std::optional<CameraSolvePlan> plan_planar_camera_solve(const std::vector<ta::Track>& tracks, double sourceW, double sourceH,
                                                        double compW, double compH, double focal, const std::string& camId) {
  if (!can_solve_camera(tracks)) return std::nullopt;
  const std::size_t nFrames = min_len(tracks);
  const double s = std::min(compW / sourceW, compH / sourceH);
  const double ox = (compW - sourceW * s) / 2;
  const double oy = (compH - sourceH * s) / 2;
  const auto toComp = [&](const ta::CompSample& p) { return tracking::Pt{ox + p.x * s, oy + p.y * s}; };
  const double cx = compW / 2;
  const double cy = compH / 2;
  std::vector<tracking::Pt> seeds;
  for (const ta::Track& t : tracks) seeds.push_back(toComp(t[0]));
  std::vector<double> times;
  std::vector<cs::PlanarPose> poses;
  double rmsSum = 0;
  for (std::size_t fi = 0; fi < nFrames; ++fi) {
    std::vector<tracking::Pt> image;
    tracking::RansacOptions ro;
    ro.inlierPx = 3 * s + 1;
    ro.seed = static_cast<std::uint32_t>(fi + 1);
    for (const ta::Track& t : tracks) {
      image.push_back(toComp(t[fi]));
      ro.weights.push_back(t[fi].coasted || t[fi].confidence < 0.2 ? 0.0 : t[fi].confidence);
    }
    // Robust pre-pass: the homography's inliers pick the correspondences the pose is solved from.
    const std::optional<tracking::RansacFit> fit = tracking::fit_homography_ransac(seeds, image, ro);
    std::vector<cs::V2> plane;
    std::vector<cs::V2> img;
    std::size_t usable = 0;
    for (std::size_t i = 0; i < seeds.size(); ++i) {
      if (fit ? fit->inliers[i] : ro.weights[i] > 0) ++usable;
    }
    for (std::size_t i = 0; i < seeds.size(); ++i) {
      const bool keep = usable < 4 || (fit ? fit->inliers[i] : ro.weights[i] > 0);
      if (!keep) continue;
      plane.push_back(cs::V2{seeds[i].x, seeds[i].y});
      img.push_back(cs::V2{image[i].x, image[i].y});
    }
    const std::optional<cs::PlanarPose> pose = cs::solve_planar_pose(plane, img, focal, cx, cy);
    if (!pose) continue;
    times.push_back(tracks[0][fi].compTime);
    poses.push_back(*pose);
    rmsSum += pose->rmsPx;
  }
  if (poses.empty()) return std::nullopt;
  std::vector<double> yaws, pitches, rolls, x, y, z;
  for (const cs::PlanarPose& p : poses) {
    yaws.push_back(p.yawDeg);
    pitches.push_back(p.pitchDeg);
    rolls.push_back(p.rollDeg);
    x.push_back(p.position.x);
    y.push_back(p.position.y);
    z.push_back(p.position.z);
  }
  cs::unwrap_degrees(yaws);
  cs::unwrap_degrees(pitches);
  cs::unwrap_degrees(rolls);
  std::vector<ta::Write> writes{write_of("x", times, x), write_of("y", times, y), write_of("z", times, z),
                                write_of("orientationX", times, pitches), write_of("orientationY", times, yaws),
                                write_of("orientationZ", times, rolls)};
  const std::size_t count = poses.size() * writes.size();
  CameraSolvePlan out{ta::Plan{"Apply Planar Camera Solve", camId, std::move(writes), {}, {}, count}, {}};
  out.report = SolveReport{camId, count, rmsSum / static_cast<double>(poses.size()), poses.size(), nFrames};
  return out;
}

class TrackApplyResult final : public JobResult {
 public:
  explicit TrackApplyResult(ApplyJob job) : job_(std::move(job)) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"mode\":" + json_string(mode_name(job_.mode)) + ",\"keyframes\":" + std::to_string(keyframes_) +
                    ",\"nullIds\":[";
    for (std::size_t i = 0; i < nullIds_.size(); ++i) s += (i > 0 ? "," : "") + json_string(nullIds_[i]);
    s += "]";
    if (solve_) {
      s += ",\"cameraId\":" + json_string(solve_->cameraId) + ",\"meanRmsPx\":" + json_number(solve_->meanRmsPx) +
           ",\"solvedFrames\":" + std::to_string(solve_->solvedFrames) + ",\"totalFrames\":" + std::to_string(solve_->totalFrames);
    }
    return s + "}";
  }

  [[nodiscard]] std::string label() const override {
    switch (job_.mode) {
      case TrackApplyMode::follow: return "Apply Motion Track";
      case TrackApplyMode::transform: return "Apply Motion Track (rotation & scale)";
      case TrackApplyMode::corner: return "Apply Corner Pin Track";
      case TrackApplyMode::stabilize: return "Stabilize Motion";
      case TrackApplyMode::mesh_warp: return "Apply Mesh Warp Track";
      case TrackApplyMode::camera_solve: return "Apply 3D Camera Tracker";
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
    solve_.reset();
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
      case TrackApplyMode::camera_solve: solve_camera(a); break;
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

  /// solveCameraEdit: the solve camera (made on the first run), then the solve keyed onto it.
  void solve_camera(JobApply& a) const {
    std::string camId = find_solve_camera(a.document(), job_.comp);
    if (camId.empty()) {
      api::CreateLayer create;
      create.comp = job_.comp;
      create.kind = api::LayerKind::camera;
      create.name = "3D Camera Tracker";
      create.init.push_back(api::PropertyInit{"camera/trackerSolve", doc::v_bool(true)});
      const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(create))));
      if (!made) fail(ErrorCode::internal, "createLayer returned no camera");
      camId = made->layer;
    }
    const ta::DocView v(a.document(), job_.comp);
    const double focal = camera_focal(a.document(), camId, v.comp_width(), v.comp_height());
    std::optional<CameraSolvePlan> solved = plan_sfm_camera_solve(job_.tracks, job_.sourceWidth, job_.sourceHeight, focal, camId);
    if (!solved) {
      solved = plan_planar_camera_solve(job_.tracks, job_.sourceWidth, job_.sourceHeight, v.comp_width(), v.comp_height(), focal, camId);
    }
    if (!solved) fail(ErrorCode::invalid_argument, "Camera solve failed — the plane is degenerate over this range.");
    ta::send_plan(a, solved->plan);
    keyframes_ = solved->report.keyframes;
    solve_ = solved->report;
  }

  ApplyJob job_;
  mutable std::optional<SolveReport> solve_;
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
      if (!can_solve_camera(job.tracks)) fail(ErrorCode::invalid_argument, "a camera solve needs four corner tracks with samples");
      break;
  }
  return PreparedJob{"trackApply", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
    if (control.cancelled()) return nullptr;
    return std::make_unique<TrackApplyResult>(job);
  }};
}

}  // namespace premation::jobs
