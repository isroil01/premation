// Job kind `faceTrack` — Face Tracking (AE parity 3.3; AE's Track Method:
// Face Tracking (Outline Only / Detailed Features)).
//
// The user draws a mask around the face (AE's workflow); at the origin frame
// its bounds are the first crop. A face landmark model (face_ort.hpp, 468
// points) then runs on every frame of the walk — forward, backward or both
// ways from the origin — each frame cropped where the previous frame's
// landmarks put the face (face_mesh.hpp), the landmarks smoothed with a One
// Euro filter. A face the model no longer sees ends that direction.
//
// The model runs in a CHILD engine process (child_job.hpp): a crash inside
// the runtime fails the job, never the engine. Its file: the spec's, else
// the one the user installed (PREMATION_FACE_USER_DIR, Electron main sets it
// to <userData>/models/face-landmarks), else the bundled one
// (PREMATION_FACE_DIR) — `face_landmark.onnx` in either.
//
// Apply, ONE entry:
//   outline    a "Face Outline" mask (Add) with a path key per frame;
//   detailed   that, plus "Left Eye", "Right Eye", "Left Brow", "Right Brow"
//              and "Mouth" masks (mode None: guides to use as you like) and
//              nulls "Face – Left Eye", "Right Eye", "Left Pupil",
//              "Right Pupil", "Nose Tip", "Mouth Left", "Mouth Right", "Chin"
//              keyed per frame (pupils from the iris points when the model
//              has them, else the eye centres).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "child_job.hpp"
#include "face_mesh.hpp"
#include "face_ort.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "track_plans.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using doc::Json;
namespace ta = trackapply;
namespace tf = trackframes;

namespace {

constexpr const char* kModelFile = "face_landmark.onnx";

double num_or(const Json& j, const char* k, double d) { return j.at(k).is_number() ? j.at(k).num() : d; }

/// One analysed frame: composition seconds and the landmarks in layer px (top-left origin).
struct FaceFrame {
  double compTime = 0;
  std::vector<face::P2> lm;
  /// The iris centres when the model has them.
  std::optional<face::P2> rightIris;
  std::optional<face::P2> leftIris;
};

// ── the child ────────────────────────────────────────────────────────────

/// Input: {file, model, layerWidth, layerHeight, outline:[x,y…] layer px, walks:[[[compTime, sourceSeconds]…]…], fps}.
std::string face_track_child(const std::string& inputJson, JobControl& control) {
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string() || !in->at("model").is_string()) fail(ErrorCode::invalid_argument, "faceTrack: bad input");
  std::string error;
  std::unique_ptr<FrameSource> src = open_frames(in->at("file").str(), 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read the footage: " + error);
  control.progress(0.02, "Loading the face model");
  std::unique_ptr<face::LandmarkModel> model = face::load(in->at("model").str(), error);
  if (!model) fail(face::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "Face model: " + error);

  const double layerW = num_or(*in, "layerWidth", 0) > 0 ? num_or(*in, "layerWidth", 0) : src->source_width();
  const double layerH = num_or(*in, "layerHeight", 0) > 0 ? num_or(*in, "layerHeight", 0) : src->source_height();
  std::vector<face::P2> outline;
  if (in->at("outline").is_array()) {
    const Json::Array& a = in->at("outline").arr();
    for (std::size_t i = 0; i + 1 < a.size(); i += 2) outline.push_back(face::P2{a[i].num(), a[i + 1].num()});
  }
  const double srcFps = src->fps() > 0 ? src->fps() : 30.0;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  std::size_t total = 0;
  if (in->at("walks").is_array()) {
    for (const Json& w : in->at("walks").arr()) total += w.is_array() ? w.arr().size() : 0;
  }
  std::size_t done = 0;
  Json frames = Json::array();
  bool lost = false;
  for (const Json& walk : in->at("walks").arr()) {
    if (!walk.is_array()) continue;
    face::OneEuro smooth(1.2, 0.02);
    std::optional<face::Roi> roi;
    double prevT = 0;
    bool first = true;
    RgbaImage img;
    for (const Json& step : walk.arr()) {
      if (control.cancelled()) return "{}";
      const double compTime = step.arr()[0].num();
      const double srcSec = step.arr()[1].num();
      const std::int64_t frame = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor((std::max(0.0, srcSec) + 1e-6) * srcFps)), 0, count - 1);
      if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
      const double kx = img.width / layerW;
      const double ky = img.height / layerH;
      if (!roi) {
        std::vector<face::P2> o;
        for (const face::P2& p : outline) o.push_back(face::P2{p.x * kx, p.y * ky});
        roi = face::roi_from_outline(o);
      }
      const std::vector<float> input = face::crop(img.rgba, static_cast<int>(img.width), static_cast<int>(img.height), *roi, model->planar());
      face::MeshOut out;
      if (!model->run(input, out, error)) fail(ErrorCode::internal, "Face model: " + error);
      if (out.score < 0.5) {
        lost = true;
        break;
      }
      std::vector<face::P2> lm;
      const std::size_t n = out.landmarks.size() / 3;
      lm.reserve(n);
      for (std::size_t i = 0; i < n; ++i) lm.push_back(face::crop_to_frame(*roi, face::P2{out.landmarks[i * 3], out.landmarks[i * 3 + 1]}));
      roi = face::roi_from_landmarks(lm);
      const std::vector<face::P2> sm = smooth.filter(lm, first ? 0.0 : std::abs(compTime - prevT));
      first = false;
      prevT = compTime;
      Json fr = Json::object();
      fr.set("t", Json::number(compTime));
      Json pts = Json::array();
      for (const face::P2& p : sm) {
        pts.arr_mut().push_back(Json::number(p.x / kx));
        pts.arr_mut().push_back(Json::number(p.y / ky));
      }
      fr.set("lm", std::move(pts));
      frames.arr_mut().push_back(std::move(fr));
      ++done;
      control.progress(0.05 + 0.9 * static_cast<double>(done) / static_cast<double>(std::max<std::size_t>(1, total)),
                       "Tracking the face, frame " + std::to_string(done) + " of " + std::to_string(total));
    }
  }
  Json o = Json::object();
  o.set("frames", std::move(frames));
  o.set("status", Json::string(lost ? "lost" : "completed"));
  o.set("provider", Json::string(model->provider()));
  return js::stringify(o);
}

// ── apply ────────────────────────────────────────────────────────────────

std::string mask_group_of(const api::CommandResult& r) {
  const std::optional<api::GroupList> g = result_payload<api::GroupList>(r);
  if (!g || g->groups.empty()) fail(ErrorCode::internal, "addMask returned no mask");
  return g->groups.front();
}

template <std::size_t N>
api::BezierPath loop_path(const FaceFrame& f, const std::array<int, N>& loop, double w, double h) {
  api::BezierPath p;
  p.closed = true;
  for (const int i : loop) {
    if (static_cast<std::size_t>(i) >= f.lm.size()) continue;
    p.vertices.push_back(f.lm[static_cast<std::size_t>(i)].x - w / 2);
    p.vertices.push_back(f.lm[static_cast<std::size_t>(i)].y - h / 2);
  }
  p.in_tangents.assign(p.vertices.size(), 0.0);
  p.out_tangents.assign(p.vertices.size(), 0.0);
  return p;
}

struct FaceJob {
  FootageLayer fl;
  api::FaceTrackMode mode = api::FaceTrackMode::outline;
  double layerW = 0;
  double layerH = 0;
  std::string inputJson;
};

class FaceTrackResult final : public JobResult {
 public:
  FaceTrackResult(FaceJob job, std::vector<FaceFrame> frames, std::string status, std::string provider)
      : job_(std::move(job)), frames_(std::move(frames)), status_(std::move(status)), provider_(std::move(provider)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("frames", Json::number(static_cast<double>(frames_.size())));
    s.set("status", Json::string(status_));
    s.set("provider", Json::string(provider_));
    Json masks = Json::array();
    for (const std::string& m : masks_) masks.arr_mut().push_back(Json::string(m));
    s.set("masks", std::move(masks));
    Json nulls = Json::array();
    for (const std::string& n : nulls_) nulls.arr_mut().push_back(Json::string(n));
    s.set("nulls", std::move(nulls));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Face Tracking"; }
  [[nodiscard]] bool has_edits() const override { return frames_.size() >= 1; }

  void apply(JobApply& a) const override {
    if (frames_.empty()) return;
    masks_.clear();
    nulls_.clear();
    const double w = job_.layerW;
    const double h = job_.layerH;
    auto add_mask = [&](const char* name, api::MaskMode mode, auto pathAt) {
      api::AddMask m;
      m.layer = job_.fl.layer;
      m.path = pathAt(frames_.front());
      m.mode = mode;
      m.name = name;
      const std::string group = mask_group_of(a.run(command(std::move(m))));
      api::AddKeyframes keys;
      for (const FaceFrame& f : frames_) {
        api::KeyframeInsert k;
        k.prop = api::PropRef{job_.fl.layer, group + "/path"};
        k.time = flicks_of(f.compTime);
        k.value = doc::v_path(pathAt(f));
        keys.keys.push_back(std::move(k));
      }
      (void)a.run(command(std::move(keys)));
      masks_.push_back(group);
    };
    add_mask("Face Outline", api::MaskMode::add, [&](const FaceFrame& f) { return loop_path(f, face::kFaceOval, w, h); });
    if (job_.mode != api::FaceTrackMode::detailed) return;
    add_mask("Left Eye", api::MaskMode::none, [&](const FaceFrame& f) { return loop_path(f, face::kLeftEye, w, h); });
    add_mask("Right Eye", api::MaskMode::none, [&](const FaceFrame& f) { return loop_path(f, face::kRightEye, w, h); });
    add_mask("Left Brow", api::MaskMode::none, [&](const FaceFrame& f) { return loop_path(f, face::kLeftBrow, w, h); });
    add_mask("Right Brow", api::MaskMode::none, [&](const FaceFrame& f) { return loop_path(f, face::kRightBrow, w, h); });
    add_mask("Mouth", api::MaskMode::none, [&](const FaceFrame& f) { return loop_path(f, face::kLipsOuter, w, h); });

    // Feature nulls: each a track in layer px, keyed in composition space.
    struct Feature {
      const char* name;
      std::function<face::P2(const FaceFrame&)> at;
    };
    const auto pt = [](int i) { return [i](const FaceFrame& f) { return f.lm[static_cast<std::size_t>(i)]; }; };
    const std::vector<Feature> features{
        {"Face – Left Eye", [](const FaceFrame& f) { return face::centre_of(f.lm, face::kLeftEye); }},
        {"Face – Right Eye", [](const FaceFrame& f) { return face::centre_of(f.lm, face::kRightEye); }},
        {"Face – Left Pupil", [](const FaceFrame& f) { return f.leftIris.value_or(face::centre_of(f.lm, face::kLeftEye)); }},
        {"Face – Right Pupil", [](const FaceFrame& f) { return f.rightIris.value_or(face::centre_of(f.lm, face::kRightEye)); }},
        {"Face – Nose Tip", pt(face::kNoseTip)},
        {"Face – Mouth Left", pt(face::kMouthLeft)},
        {"Face – Mouth Right", pt(face::kMouthRight)},
        {"Face – Chin", pt(face::kChin)},
    };
    const ta::P2 box{w, h};
    for (const Feature& feat : features) {
      ta::Track track;
      for (const FaceFrame& f : frames_) {
        const face::P2 p = feat.at(f);
        track.push_back(ta::CompSample{f.compTime, p.x, p.y, 1, false});
      }
      api::CreateLayer create;
      create.comp = job_.fl.comp;
      create.kind = api::LayerKind::null;
      create.name = feat.name;
      const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(create))));
      if (!made) fail(ErrorCode::internal, "createLayer returned no layer");
      nulls_.push_back(made->layer);
      const ta::DocView v(a.document(), job_.fl.comp);
      const ta::Planner planner(v, ta::Source{job_.fl.layer, w, h, box});
      if (const std::optional<ta::Plan> plan = planner.follow(made->layer, track, false)) ta::send_plan(a, *plan);
    }
  }

 private:
  FaceJob job_;
  std::vector<FaceFrame> frames_;
  std::string status_;
  std::string provider_;
  mutable std::vector<std::string> masks_;
  mutable std::vector<std::string> nulls_;
};

std::string model_file(const std::string& given) {
  if (!given.empty()) return given;
  for (const char* var : {"PREMATION_FACE_USER_DIR", "PREMATION_FACE_DIR"}) {
    const char* dir = std::getenv(var);
    if (dir == nullptr || *dir == '\0') continue;
    const std::filesystem::path p = std::filesystem::path(dir) / kModelFile;
    std::error_code ec;
    if (std::filesystem::exists(p, ec)) return p.string();
  }
  return {};
}

}  // namespace

void register_face_track_child() { register_child_work("faceTrack", face_track_child); }

PreparedJob prepare_face_track(const api::FaceTrackJob& spec, const JobDocContext& ctx) {
  FaceJob job;
  job.fl = footage_layer(ctx, spec.layer, Need::picture);
  job.mode = spec.mode;
  const std::string model = model_file(spec.landmark_model);
  if (model.empty()) {
    fail(ErrorCode::unsupported, "Face Tracking needs the face landmark model — install it in Settings ▸ Face Tracking (it downloads once).",
         {.layer = spec.layer});
  }
  const double fps = job.fl.compFps > 0 ? job.fl.compFps : 30;
  const tf::CompFrames frames = tf::comp_frames_of(spec.range, fps);
  if (frames.last < frames.first) fail(ErrorCode::out_of_range, "the range is empty");
  const auto clampF = [&](std::int64_t f) { return std::clamp(f, frames.first, frames.last); };
  std::int64_t origin = 0;
  if (spec.origin) origin = clampF(static_cast<std::int64_t>(std::llround(seconds_of(*spec.origin) * fps)));
  else if (spec.direction == api::TrackDirection::backward) origin = frames.last;
  else if (spec.direction == api::TrackDirection::forward) origin = frames.first;
  else origin = clampF(static_cast<std::int64_t>(std::llround(seconds_of(ctx.time) * fps)));

  // The face mask at the origin (AE: a mask drawn around the face).
  const doc::Node* node = ctx.doc.node(spec.layer);
  const ta::DocView v(ctx.doc, job.fl.comp);
  std::optional<Json> mask = doc::interpolate_mask(doc::read_node_mask_anim(*node), v.key_time(spec.layer, static_cast<double>(origin) / fps));
  if (!mask || !mask->at("paths").is_array()) mask = doc::read_node_mask(*node);
  const Json* path = nullptr;
  if (mask && mask->at("paths").is_array()) {
    for (const Json& p : mask->at("paths").arr()) {
      const std::string id = p.at("id").is_string() ? p.at("id").str() : std::string();
      if (!spec.mask || *spec.mask == id) {
        path = &p;
        break;
      }
    }
  }
  if (path == nullptr) {
    fail(ErrorCode::invalid_argument, spec.mask ? "Layer has no mask '" + *spec.mask + "'" : std::string("Draw a mask around the face first."),
         {.layer = spec.layer});
  }
  const api::BezierPath bp = doc::mask_to_bezier(*path);
  if (bp.vertices.size() < 6) fail(ErrorCode::invalid_argument, "The face mask needs at least three points.", {.layer = spec.layer});
  job.layerW = job.fl.width > 0 ? job.fl.width : 1920;
  job.layerH = job.fl.height > 0 ? job.fl.height : 1080;
  if (const std::optional<ta::Geometry> g = v.geometry(spec.layer)) {
    job.layerW = g->width.value_or(job.layerW);
    job.layerH = g->height.value_or(job.layerH);
  }

  Json in = Json::object();
  in.set("file", Json::string(job.fl.file));
  in.set("model", Json::string(model));
  in.set("layerWidth", Json::number(job.layerW));
  in.set("layerHeight", Json::number(job.layerH));
  Json outline = Json::array();
  for (std::size_t i = 0; i + 1 < bp.vertices.size(); i += 2) {
    outline.arr_mut().push_back(Json::number(bp.vertices[i] + job.layerW / 2));
    outline.arr_mut().push_back(Json::number(bp.vertices[i + 1] + job.layerH / 2));
  }
  in.set("outline", std::move(outline));
  auto walk = [&](std::int64_t from, std::int64_t to) {
    Json steps = Json::array();
    const std::int64_t step = to >= from ? 1 : -1;
    for (std::int64_t f = from; step > 0 ? f <= to : f >= to; f += step) {
      const double t = static_cast<double>(f) / fps;
      if (t < job.fl.in_seconds() || t >= job.fl.out_seconds()) continue;
      Json s = Json::array();
      s.arr_mut().push_back(Json::number(t));
      s.arr_mut().push_back(Json::number(job.fl.source_seconds(t)));
      steps.arr_mut().push_back(std::move(s));
    }
    return steps;
  };
  Json walks = Json::array();
  if (spec.direction != api::TrackDirection::backward) walks.arr_mut().push_back(walk(origin, frames.last));
  if (spec.direction != api::TrackDirection::forward) walks.arr_mut().push_back(walk(origin, frames.first));
  in.set("walks", std::move(walks));
  job.inputJson = js::stringify(in);

  return PreparedJob{"faceTrack", [job = std::move(job)](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::optional<std::string> out = run_child("faceTrack", job.inputJson, control);
    if (!out) return nullptr;
    const std::optional<Json> res = js::parse(*out);
    if (!res || !res->at("frames").is_array()) fail(ErrorCode::internal, "faceTrack: the child answered no frames");
    std::map<double, FaceFrame> byTime;  // both walks share the origin: one frame per time
    for (const Json& fr : res->at("frames").arr()) {
      FaceFrame f;
      f.compTime = fr.at("t").num();
      const Json::Array& a = fr.at("lm").arr();
      for (std::size_t i = 0; i + 1 < a.size(); i += 2) f.lm.push_back(face::P2{a[i].num(), a[i + 1].num()});
      if (f.lm.size() < face::kLandmarks) continue;
      if (f.lm.size() > static_cast<std::size_t>(face::kLeftIris)) {
        f.rightIris = f.lm[static_cast<std::size_t>(face::kRightIris)];
        f.leftIris = f.lm[static_cast<std::size_t>(face::kLeftIris)];
      }
      byTime.insert_or_assign(f.compTime, std::move(f));
    }
    if (byTime.empty()) fail(ErrorCode::not_found, "No face was found inside the mask.", {.layer = job.fl.layer});
    std::vector<FaceFrame> frames;
    for (auto& [t, f] : byTime) frames.push_back(std::move(f));
    const std::string status = res->at("status").is_string() ? res->at("status").str() : "completed";
    const std::string provider = res->at("provider").is_string() ? res->at("provider").str() : "cpu";
    return std::make_unique<FaceTrackResult>(job, std::move(frames), status, provider);
  }};
}

}  // namespace premation::jobs
