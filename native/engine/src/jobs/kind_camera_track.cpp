// Job kind `cameraTrack` — the automatic 3D Camera Tracker (AE parity 3.5).
//
//   solve         the footage's distinct frames over `range` are decoded at
//                 the analysis size (`analysisMaxEdge`, default 960), corners
//                 are tracked across them and the camera, the focal length
//                 (unless given) and the scene's points are solved
//                 (camera_track.hpp). Apply, as ONE entry: the "3D Tracker
//                 Camera" (made on the first run, tagged camera/trackerSolve)
//                 gets its Zoom and position / orientation keys; the solve is
//                 stored on the footage layer (setCameraSolve) for the
//                 viewer's track points and the two actions below.
//   groundPlane   the stored solve re-oriented: the plane through the chosen
//                 points becomes the ground (y up), their centre the world
//                 origin at the composition's centre; the camera re-keyed.
//   createLayers  a Text / Solid / Null / Shadow Catcher layer placed on the
//                 plane through the chosen points (3D, facing away from the
//                 camera so its front is seen), sized to them; one point: at
//                 that point, facing the camera.
//
// World (composition px) = O + k · G · (p − c) over the solve's own space
// (camera 0's frame: x right, y down, z forward, the composition's axes).
// First solve: G = I, c = 0, O = the comp centre at z = −zoom (where AE's
// default camera stands), k = zoom ÷ the median point depth — so the median
// depth lands on the composition plane and the footage lines up 1:1.
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "camera_track.hpp"
#include "fail.hpp"
#include "handlers_misc.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "transform.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace ct = camtrack;
namespace ta = trackapply;
namespace tf = trackframes;
using camsolve::M3;
using camsolve::V3;

namespace {

constexpr std::uint32_t kAnalysisEdge = 960;

struct World {
  V3 O;
  double k = 1;
  M3 G{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
  V3 c;
};

V3 mulv(const M3& a, const V3& v) {
  return V3{a[0][0] * v.x + a[0][1] * v.y + a[0][2] * v.z, a[1][0] * v.x + a[1][1] * v.y + a[1][2] * v.z,
            a[2][0] * v.x + a[2][1] * v.y + a[2][2] * v.z};
}
M3 mul(const M3& a, const M3& b) {
  M3 o{};
  for (std::size_t r = 0; r < 3; ++r)
    for (std::size_t q = 0; q < 3; ++q) o[r][q] = a[r][0] * b[0][q] + a[r][1] * b[1][q] + a[r][2] * b[2][q];
  return o;
}
M3 transpose(const M3& a) {
  M3 o{};
  for (std::size_t r = 0; r < 3; ++r)
    for (std::size_t q = 0; q < 3; ++q) o[r][q] = a[q][r];
  return o;
}
M3 m3_of(const std::vector<double>& v) {
  M3 m{};
  for (std::size_t i = 0; i < 9 && i < v.size(); ++i) m[i / 3][i % 3] = v[i];
  return m;
}
std::vector<double> nums_of(const M3& m) {
  std::vector<double> v;
  for (const auto& row : m)
    for (const double x : row) v.push_back(x);
  return v;
}
V3 v3(const api::Vec3& v) { return V3{v.x, v.y, v.z}; }
api::Vec3 api3(const V3& v) { return api::Vec3{v.x, v.y, v.z}; }

V3 to_world(const World& w, const V3& p) {
  const V3 g = mulv(w.G, V3{p.x - w.c.x, p.y - w.c.y, p.z - w.c.z});
  return V3{w.O.x + w.k * g.x, w.O.y + w.k * g.y, w.O.z + w.k * g.z};
}

World world_of(const api::CameraSolveData& s) {
  World w;
  w.O = v3(s.world_origin);
  w.k = s.world_scale;
  w.G = m3_of(s.world_rotation);
  w.c = v3(s.world_centroid);
  return w;
}

/// Contain fit of the footage in the composition (the existing planar solve's convention).
double fit_scale(double compW, double compH, double sw, double sh) {
  return sw > 0 && sh > 0 ? std::min(compW / sw, compH / sh) : 1;
}

struct CameraKeys {
  std::vector<double> times;
  std::vector<double> x, y, z, ox, oy, oz;
};

CameraKeys camera_keys(const api::CameraSolveData& s, const World& w) {
  CameraKeys out;
  const M3 Gt = transpose(w.G);
  std::vector<double> yaws, pitches, rolls;
  for (const api::CameraSolveFrame& f : s.frames) {
    const V3 C = to_world(w, v3(f.center));
    // world → camera: R_s · Gᵀ (the world is the solve rotated by G).
    const ct::Ypr a = ct::r_to_ypr(mul(m3_of(f.rotation), Gt));
    out.times.push_back(seconds_of(f.time));
    out.x.push_back(C.x);
    out.y.push_back(C.y);
    out.z.push_back(C.z);
    yaws.push_back(a.yaw);
    pitches.push_back(a.pitch);
    rolls.push_back(a.roll);
  }
  camsolve::unwrap_degrees(yaws);
  camsolve::unwrap_degrees(pitches);
  camsolve::unwrap_degrees(rolls);
  out.oy = std::move(yaws);
  out.ox = std::move(pitches);
  out.oz = std::move(rolls);
  return out;
}

ta::Write write_of(std::string track, const std::vector<double>& times, const std::vector<double>& vals) {
  ta::Write w{std::move(track), {}};
  for (std::size_t i = 0; i < vals.size() && i < times.size(); ++i) w.keys.emplace_back(times[i], vals[i]);
  return w;
}

/// The comp's solve camera (tagged camera/trackerSolve), or ''.
std::string solve_camera_in(const doc::Document& d, const std::string& comp) {
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

/// Set a layer's members (stored units) as static values, one setProperty per API property.
void set_members(JobApply& a, const std::string& layer, const std::string& comp, const std::vector<std::pair<std::string, double>>& values) {
  const doc::Document& d = a.document();
  const doc::Catalog cat = doc::catalog_for(d, layer);
  std::map<std::string, std::pair<const doc::PropBinding*, std::map<std::string, double>>> byPath;
  for (const auto& [member, v] : values) {
    const doc::PropBinding* b = cat.by_member(member);
    if (b == nullptr || b->members.empty()) continue;
    auto& slot = byPath[b->path];
    slot.first = b;
    slot.second[member] = v;
  }
  const ta::DocView view(d, comp);
  std::vector<api::SetProperty> cmds;
  for (const auto& [path, entry] : byPath) {
    const doc::PropBinding& b = *entry.first;
    std::vector<double> nums;
    for (const std::string& m : b.members) {
      const auto it = entry.second.find(m);
      const double stored = it != entry.second.end() ? it->second : view.member_stored_at(layer, m, 0);
      nums.push_back(stored * doc::api_unit_factor(m));
    }
    api::SetProperty sp;
    sp.prop = api::PropRef{layer, b.path};
    sp.value = doc::vector_value(b.valueType, nums);
    cmds.push_back(std::move(sp));
  }
  for (api::SetProperty& c : cmds) (void)a.run(command(std::move(c)));
}

enum class Action : std::uint8_t { solve, ground, create };

struct Job {
  Action action = Action::solve;
  FootageLayer fl;
  tf::CompFrames frames;
  double fps = 30;
  double compW = 1920;
  double compH = 1080;
  std::uint32_t maxEdge = kAnalysisEdge;
  std::optional<double> focal;  ///< source px
  int maxFeatures = 220;
  /// ground / create: the stored solve and the chosen points.
  std::optional<api::CameraSolveData> stored;
  std::vector<std::uint32_t> points;
  api::TrackPointLayer create = api::TrackPointLayer::null;
};

class CameraTrackResult final : public JobResult {
 public:
  CameraTrackResult(Job job, api::CameraSolveData solve, double rms, int solved, int total)
      : job_(std::move(job)), solve_(std::move(solve)), rms_(rms), solved_(solved), total_(total) {}

  [[nodiscard]] std::string summary_json() const override {
    doc::Json s = doc::Json::object();
    s.set("action", doc::Json::string(job_.action == Action::solve ? "solve" : job_.action == Action::ground ? "groundPlane" : "createLayers"));
    s.set("focal", doc::Json::number(solve_.focal));
    s.set("points", doc::Json::number(static_cast<double>(solve_.points.size())));
    s.set("solvedFrames", doc::Json::number(solved_));
    s.set("totalFrames", doc::Json::number(total_));
    s.set("errorPx", doc::Json::number(rms_));
    s.set("camera", doc::Json::string(camera_));
    s.set("layer", doc::Json::string(made_));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override {
    switch (job_.action) {
      case Action::solve: return "3D Camera Tracker";
      case Action::ground: return "Set Ground Plane and Origin";
      case Action::create: return "Create from Track Points";
    }
    return "3D Camera Tracker";
  }
  [[nodiscard]] bool has_edits() const override { return !solve_.frames.empty(); }

  void apply(JobApply& a) const override {
    if (job_.action == Action::create) {
      create_layer(a);
      return;
    }
    const std::string& comp = job_.fl.comp;
    std::string cam = solve_.camera;
    if (cam.empty() || a.document().node(cam) == nullptr) cam = solve_camera_in(a.document(), comp);
    if (cam.empty()) {
      api::CreateLayer create;
      create.comp = comp;
      create.kind = api::LayerKind::camera;
      create.name = "3D Tracker Camera";
      create.init.push_back(api::PropertyInit{"camera/trackerSolve", doc::v_bool(true)});
      const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(create))));
      if (!made) fail(ErrorCode::internal, "createLayer returned no camera");
      cam = made->layer;
    }
    camera_ = cam;
    const double s = fit_scale(job_.compW, job_.compH, solve_.source_width, solve_.source_height);
    set_members(a, cam, comp, {{"focalLength", solve_.focal * s}});
    const World w = world_of(solve_);
    const CameraKeys k = camera_keys(solve_, w);
    std::vector<ta::Write> writes{write_of("x", k.times, k.x), write_of("y", k.times, k.y), write_of("z", k.times, k.z),
                                  write_of("orientationX", k.times, k.ox), write_of("orientationY", k.times, k.oy),
                                  write_of("orientationZ", k.times, k.oz)};
    const std::size_t count = k.times.size() * writes.size();
    ta::send_plan(a, ta::Plan{label(), cam, std::move(writes), {}, {}, count});
    api::SetCameraSolve store;
    store.layer = job_.fl.layer;
    store.solve = solve_;
    store.solve->camera = cam;
    (void)a.run(command(std::move(store)));
  }

 private:
  void create_layer(JobApply& a) const {
    const World w = world_of(solve_);
    std::vector<V3> pts;
    for (const std::uint32_t i : job_.points) {
      if (i < solve_.points.size()) pts.push_back(to_world(w, v3(solve_.points[i])));
    }
    if (pts.empty()) fail(ErrorCode::invalid_argument, "choose track points first");
    // The camera at the middle solved frame: which side of the plane is "front".
    V3 eye = w.O;
    if (!solve_.frames.empty()) eye = to_world(w, v3(solve_.frames[solve_.frames.size() / 2].center));
    V3 at = pts[0];
    V3 away{at.x - eye.x, at.y - eye.y, at.z - eye.z};
    double size = 200;
    if (const std::optional<ct::Plane> plane = ct::fit_plane(pts); plane && pts.size() >= 3) {
      at = plane->centroid;
      away = plane->normal;
      const V3 toCam{eye.x - at.x, eye.y - at.y, eye.z - at.z};
      if (away.x * toCam.x + away.y * toCam.y + away.z * toCam.z > 0) away = V3{-away.x, -away.y, -away.z};
      size = std::max(50.0, 2 * plane->spread);
    }
    const motion::xf::Orientation o = motion::xf::look_at_orientation(motion::xf::Vec3{at.x, at.y, at.z},
                                                                      motion::xf::Vec3{at.x + away.x, at.y + away.y, at.z + away.z});
    api::CreateLayer create;
    create.comp = job_.fl.comp;
    switch (job_.create) {
      case api::TrackPointLayer::text:
        create.kind = api::LayerKind::text;
        create.name = "Text";
        break;
      case api::TrackPointLayer::solid:
        create.kind = api::LayerKind::solid;
        create.name = "Track Solid";
        break;
      case api::TrackPointLayer::null:
        create.kind = api::LayerKind::null;
        create.name = "Track Null";
        break;
      case api::TrackPointLayer::shadow_catcher:
        create.kind = api::LayerKind::solid;
        create.name = "Shadow Catcher";
        break;
    }
    const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(create))));
    if (!made) fail(ErrorCode::internal, "createLayer returned no layer");
    made_ = made->layer;
    api::SetLayerSwitches sw;
    sw.layers = {made_};
    sw.patch.three_d = true;
    (void)a.run(command(std::move(sw)));
    std::vector<std::pair<std::string, double>> values{{"x", at.x}, {"y", at.y}, {"z", at.z},
                                                        {"orientationX", o.pitch}, {"orientationY", o.yaw}, {"orientationZ", 0}};
    if (job_.create == api::TrackPointLayer::solid || job_.create == api::TrackPointLayer::shadow_catcher) {
      // A solid is made at composition size: scale it to the points (a shadow catcher wider, it is a floor).
      const double k = (job_.create == api::TrackPointLayer::shadow_catcher ? 3 * size : size) / std::max(1.0, job_.compW);
      values.emplace_back("scaleX", k);
      values.emplace_back("scaleY", k);
    }
    set_members(a, made_, job_.fl.comp, values);
    if (job_.create == api::TrackPointLayer::shadow_catcher) {
      // AE's shadow catcher: Accepts Shadows "Only" — the layer shows only the shadows it receives.
      set_members(a, made_, job_.fl.comp, {{"acceptsShadows", 2}, {"castsShadows", 0}});
    }
  }

  Job job_;
  api::CameraSolveData solve_;
  double rms_;
  int solved_;
  int total_;
  mutable std::string camera_;
  mutable std::string made_;
};

std::unique_ptr<JobResult> run_solve(const Job& job, JobControl& control) {
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(job.fl.file, job.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = job.fl.layer});
  const double w = src->width();
  const double h = src->height();
  if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = job.fl.layer});
  const double sw = src->source_width() > 0 ? src->source_width() : w;
  const double sh = src->source_height() > 0 ? src->source_height() : h;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  // The distinct source frames of the range, in order, and the first comp frame showing each.
  std::vector<std::int64_t> srcIdx;
  std::vector<std::int64_t> compOf;
  for (std::int64_t f = job.frames.first; f <= job.frames.last; ++f) {
    const std::int64_t i = tf::source_index(job.fl, f, job.fps, src->fps(), count);
    if (srcIdx.empty() || srcIdx.back() != i) {
      srcIdx.push_back(i);
      compOf.push_back(f);
    }
  }
  if (srcIdx.size() < 3) fail(ErrorCode::out_of_range, "the range shows fewer than three different frames — nothing to solve", {.layer = job.fl.layer});
  tracking::LumaPlane current;
  std::int64_t loaded = -1;
  const tracking::FrameAt frameAt = [&](std::int64_t i) -> const tracking::LumaPlane& {
    if (i != loaded) {
      LumaImage li;
      if (!src->read_luma(srcIdx[static_cast<std::size_t>(i)], li, error)) {
        fail(ErrorCode::decode, "could not decode frame " + std::to_string(srcIdx[static_cast<std::size_t>(i)]) + ": " + error, {.layer = job.fl.layer});
      }
      current.width = static_cast<int>(li.width);
      current.height = static_cast<int>(li.height);
      current.data = std::move(li.data);
      loaded = i;
    }
    return current;
  };
  const auto n = static_cast<std::int64_t>(srcIdx.size());
  ct::FeatureOptions fo;
  fo.maxFeatures = job.maxFeatures;
  const tracking::OnProgress onProgress = [&](std::int64_t done, std::int64_t total) {
    control.progress(0.6 * static_cast<double>(done + 1) / static_cast<double>(std::max<std::int64_t>(1, total)),
                     "Tracking features, frame " + std::to_string(done + 1) + " of " + std::to_string(total));
    return !control.cancelled();
  };
  const std::optional<ct::FeatureTracks> tracks = ct::track_features(frameAt, 0, n - 1, fo, onProgress);
  if (!tracks) return nullptr;
  control.progress(0.65, "Solving camera");
  ct::SolveOptions so;
  if (job.focal) so.focal = *job.focal * (w / sw);  // source px → analysis px
  const std::optional<ct::Solve> solved = ct::solve(*tracks, so);
  if (control.cancelled()) return nullptr;
  if (!solved || solved->solvedFrames < 3) {
    fail(ErrorCode::invalid_argument,
         "The camera could not be solved: the shot needs camera movement with parallax (a pan or zoom alone cannot be solved in 3D) and enough detail to track.",
         {.layer = job.fl.layer});
  }

  api::CameraSolveData data;
  data.focal = solved->focal * (sw / w);
  data.source_width = sw;
  data.source_height = sh;
  for (std::size_t i = 0; i < solved->poses.size(); ++i) {
    if (!solved->poses[i]) continue;
    api::CameraSolveFrame f;
    f.time = flicks_of(static_cast<double>(compOf[i]) / job.fps);
    f.rotation = nums_of(solved->poses[i]->R);
    f.center = api3(solved->poses[i]->C);
    data.frames.push_back(std::move(f));
  }
  std::vector<double> depths;
  for (std::size_t p = 0; p < solved->points.size(); ++p) {
    if (!solved->points[p]) continue;
    data.points.push_back(api3(*solved->points[p]));
    data.point_errors.push_back(solved->pointError[p] * (sw / w));
    depths.push_back(solved->points[p]->z);
  }
  std::nth_element(depths.begin(), depths.begin() + static_cast<std::ptrdiff_t>(depths.size() / 2), depths.end());
  const double medianDepth = depths.empty() ? 1 : std::max(1e-6, depths[depths.size() / 2]);
  const double zoom = data.focal * fit_scale(job.compW, job.compH, sw, sh);
  data.world_origin = api::Vec3{job.compW / 2, job.compH / 2, -zoom};
  data.world_scale = zoom / medianDepth;
  data.world_rotation = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  data.world_centroid = api::Vec3{0, 0, 0};
  control.progress(1, "Solved " + std::to_string(solved->solvedFrames) + " frames");
  return std::make_unique<CameraTrackResult>(job, std::move(data), solved->rmsPx * (sw / w), solved->solvedFrames, static_cast<int>(n));
}

std::unique_ptr<JobResult> run_ground(const Job& job) {
  api::CameraSolveData s = *job.stored;
  const World w0 = world_of(s);
  std::vector<V3> pts;
  for (const std::uint32_t i : job.points) {
    if (i < s.points.size()) pts.push_back(v3(s.points[i]));
  }
  const std::optional<ct::Plane> plane = ct::fit_plane(pts);
  if (!plane) fail(ErrorCode::invalid_argument, "choose three or more track points that are not on one line", {.layer = job.fl.layer});
  // The normal toward the first camera (the solve space's origin), then up = −y.
  V3 n = plane->normal;
  if (s.frames.empty() || n.x * (v3(s.frames.front().center).x - plane->centroid.x) + n.y * (v3(s.frames.front().center).y - plane->centroid.y) +
                                  n.z * (v3(s.frames.front().center).z - plane->centroid.z) < 0) {
    n = V3{-n.x, -n.y, -n.z};
  }
  const M3 G = ct::rotation_between(n, V3{0, -1, 0});
  s.world_rotation = nums_of(G);
  s.world_centroid = api3(plane->centroid);
  s.world_origin = api::Vec3{job.compW / 2, job.compH / 2, 0};
  s.world_scale = w0.k;
  return std::make_unique<CameraTrackResult>(job, std::move(s), 0, static_cast<int>(job.stored->frames.size()),
                                             static_cast<int>(job.stored->frames.size()));
}

}  // namespace

PreparedJob prepare_camera_track(const api::CameraTrackJob& spec, const JobDocContext& ctx) {
  Job job;
  job.fl = footage_layer(ctx, spec.layer, Need::picture);
  job.fps = job.fl.compFps > 0 ? job.fl.compFps : 30;
  job.compW = job.fl.compWidth;
  job.compH = job.fl.compHeight;
  switch (spec.action.value_or(api::CameraTrackAction::solve)) {
    case api::CameraTrackAction::solve: job.action = Action::solve; break;
    case api::CameraTrackAction::ground_plane: job.action = Action::ground; break;
    case api::CameraTrackAction::create_layers: job.action = Action::create; break;
  }
  if (spec.analysis_max_edge) job.maxEdge = *spec.analysis_max_edge;
  if (spec.max_features) job.maxFeatures = static_cast<int>(std::clamp<std::uint32_t>(*spec.max_features, 24, 2000));
  if (spec.focal_length) {
    if (!(*spec.focal_length > 0) || !std::isfinite(*spec.focal_length)) fail(ErrorCode::invalid_argument, "focalLength must be > 0 (source px)");
    job.focal = *spec.focal_length;
  }
  job.points = spec.points;
  job.create = spec.create.value_or(api::TrackPointLayer::null);
  if (job.action == Action::solve) {
    job.frames = tf::comp_frames_of(spec.range, job.fps);
    if (job.frames.last - job.frames.first < 2) fail(ErrorCode::out_of_range, "the range is too short to solve a camera");
    return PreparedJob{"cameraTrack", [job = std::move(job)](JobControl& control) { return run_solve(job, control); }};
  }
  job.stored = doc::camera_solve_of(ctx.doc, doc::EditorView{job.fl.comp, 0}, spec.layer);
  if (!job.stored || job.stored->frames.empty()) fail(ErrorCode::invalid_argument, "track the camera first (no solve on this layer)", {.layer = spec.layer});
  for (const std::uint32_t i : job.points) {
    if (i >= job.stored->points.size()) fail(ErrorCode::out_of_range, "track point " + std::to_string(i) + " is not in the solve", {.layer = spec.layer});
  }
  if (job.points.empty()) fail(ErrorCode::invalid_argument, "choose track points first", {.layer = spec.layer});
  if (job.action == Action::ground) {
    return PreparedJob{"cameraTrack", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
      if (control.cancelled()) return nullptr;
      return run_ground(job);
    }};
  }
  return PreparedJob{"cameraTrack", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
    if (control.cancelled()) return nullptr;
    api::CameraSolveData s = *job.stored;
    const int n = static_cast<int>(s.frames.size());
    return std::make_unique<CameraTrackResult>(job, std::move(s), 0, n, n);
  }};
}

}  // namespace premation::jobs
