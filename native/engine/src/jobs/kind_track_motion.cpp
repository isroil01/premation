// Job kind `trackMotion` — the Track Motion panel's Track + Apply
// (src/layout/Inspector/trackMotion/trackMotionActions.ts onTrack / onApply,
// src/core/tracking/trackVideoLayer.ts, tracker.ts, applyTrack.ts).
//
// Track: the footage layer's frames are decoded at the analysis size
// (`analysisMaxEdge`, default 960 — the TS analysis tier), converted to luma
// (the decoder's Y bytes when it has them, lumaExtract.ts 'raw8'; else
// lumaFromRGBA), and the points walked through tracking.hpp over the DISTINCT
// source frames of the range; comp samples are read out per comp frame
// (`readOutCompSamples`: a comp frame whose source frame was never reached is
// dropped). Points, window sizes and samples are in layer (source display)
// pixels; windows convert to decoded pixels by the geometric mean, as
// trackVideoLayer.ts does, and are then ROUNDED to whole pixels (the TS relies
// on them being whole: a fractional half makes its Float32Array length throw).
//
//   feature   Rect centre = the point; half = round((max(w, h) − 1) / 2)
//             (21 → 10, the panel's 21×21), default 10.
//   search    only its size is read: half = round((max(w, h) − 1) / 2), the
//             ± offset range around the prediction (the overlay's ±search
//             box), default 24 (trackerStore).
//   attach    (0, 0) = the feature itself (the TS); otherwise the applied
//             point is the sample + (attach − feature centre), AE's attach point.
//
// Directions: `forward` walks origin → last frame (origin default: range
// start), `backward` origin → first (default: the last frame), `both` walks
// backward then forward from the origin (default: the playhead) and merges
// (autoTrack.ts runAutoTrack / mergeBidirectional).
//
// Apply (`applyTo` a PropRef on the TARGET layer; absent = analysis only, the
// track is in the summary):
//   position                  path `transform/position` or `transform`:
//                               planTrackToLayer (x/y keys, parent space);
//                               a camera target: planTrackToCamera (+ poiX/poiY).
//   positionRotation(Scale)   exactly two points; same paths: planTransformTrack
//                               (rotation, and scale for …Scale, as deltas on
//                               the target's own values); a camera target:
//                               planCameraSolveTrack (+ orientationZ).
//   perspectiveCorner         four points TL, TR, BR, BL (+ more: RANSAC planar
//                               fit, smoothed): path `effects/<id>` of a Corner
//                               Pin, or `effects` = the target's first Corner Pin,
//                               added when it has none (planCornerPinTrack).
//   stabilize = true          kind position: planStabilize on the TRACKED layer.
// The writes go out as track_apply.hpp describes (addEffect?, addKeyframes,
// deleteKeyframes) in the job's one history entry.
//
// Not ported (the TS has them, the schema cannot ask for them or they are
// other kinds): mask / planar kinds (maskTrack.ts), one-click auto-track
// (autoFeature.ts / autoTrack.ts planTrack), Create Null & Apply, mesh warp,
// 3D camera solves, nulls for planes.
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "media_input.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "tracking.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace tr = tracking;
namespace ta = trackapply;
namespace tf = trackframes;

namespace {

constexpr double kDefaultFeatureHalf = 10;
constexpr double kDefaultSearchHalf = 24;
constexpr std::uint32_t kAnalysisEdge = 960;
/// Luma planes a backward walk may hold at once (reverseFrameWalk.ts budgets the same way).
constexpr std::size_t kReverseBudgetBytes = std::size_t{256} << 20U;

enum class Mode : std::uint8_t { none, follow, transform, corner, stabilize };

struct PointSpec {
  double x = 0;
  double y = 0;
  double featureHalf = kDefaultFeatureHalf;  ///< display px
  double searchHalf = kDefaultSearchHalf;
  double attachDx = 0;
  double attachDy = 0;
};

/// Everything the work and the apply read, copied out of the document at prepare.
struct TrackJob {
  FootageLayer fl;
  api::TrackKind kind = api::TrackKind::position;
  api::TrackDirection direction = api::TrackDirection::forward;
  std::vector<PointSpec> points;
  tf::CompFrames frames;
  std::int64_t origin = 0;
  double fps = 30;
  double minConfidence = 0.55;
  int maxCoast = 8;
  std::uint32_t maxEdge = kAnalysisEdge;
  Mode mode = Mode::none;
  std::string target;
  std::string effectId;  ///< corner: the Corner Pin named by applyTo ('' = first / added)
  bool targetCamera = false;
};

struct CompSample {
  double compTime = 0;
  double x = 0;
  double y = 0;
  double confidence = 0;
  bool coasted = false;
};

double half_of(double size, double fallback) {
  return size > 0 ? motion::js::round((size - 1) / 2) : fallback;
}

/// Decoded luma for one walk: a straight stream ascending, bounded chunks
/// decoded forward and served backwards descending (reverseFrameWalk.ts).
class LumaWalk {
 public:
  struct Cancelled {};
  LumaWalk(FrameSource& src, JobControl& control, std::int64_t lo, bool descending)
      : src_(src), control_(control), lo_(lo), descending_(descending) {
    const std::size_t plane = std::max<std::size_t>(1, std::size_t{src.width()} * src.height() * sizeof(float));
    chunk_ = static_cast<std::int64_t>(std::max<std::size_t>(1, kReverseBudgetBytes / plane));
  }

  const tr::LumaPlane& at(std::int64_t idx) {
    if (const auto it = cache_.find(idx); it != cache_.end()) return it->second;
    cache_.clear();
    const std::int64_t from = descending_ ? std::max(lo_, idx - chunk_ + 1) : idx;
    for (std::int64_t i = from; i <= idx; ++i) {
      if (control_.cancelled()) throw Cancelled{};
      load(i);
    }
    return cache_.at(idx);
  }

 private:
  void load(std::int64_t i) {
    LumaImage li;
    std::string error;
    if (!src_.read_luma(i, li, error)) fail(ErrorCode::decode, "could not decode frame " + std::to_string(i) + ": " + error);
    tr::LumaPlane p;
    p.width = static_cast<int>(li.width);
    p.height = static_cast<int>(li.height);
    p.data = std::move(li.data);
    cache_.insert_or_assign(i, std::move(p));
  }

  FrameSource& src_;
  JobControl& control_;
  std::int64_t lo_;
  bool descending_;
  std::int64_t chunk_ = 1;
  std::map<std::int64_t, tr::LumaPlane> cache_;
};

// ── the plans (applyTrack.ts), against the document as it stands ────────

struct Ctx {
  const TrackJob& job;
  const ta::DocView& v;
  double sourceWidth;
  double sourceHeight;
  ta::P2 box;  ///< the footage's stored size, for a video box readGeometry does not report

  [[nodiscard]] std::optional<ta::P2> to_comp(double x, double y, double t) const {
    return v.sample_to_comp(job.fl.layer, x, y, t, sourceWidth, sourceHeight, box);
  }
  /// Comp point → `target`'s parent space (comp space when it has none), nullopt when unmeasurable.
  [[nodiscard]] std::optional<ta::P2> to_parent(const std::string& target, ta::P2 c, double t) const {
    const std::optional<std::string> parent = v.parent_of(target);
    if (!parent) return c;
    const std::optional<doc::LayerSpace> ps = v.space(*parent, t);
    if (!ps) return std::nullopt;
    return ta::DocView::from_comp(*ps, c);
  }
};

/// planTrackToLayer / planTrackToCamera.
std::optional<ta::Plan> plan_follow(const Ctx& c, const std::vector<CompSample>& samples, bool camera) {
  if (c.v.node(c.job.target) == nullptr || samples.empty()) return std::nullopt;
  if (camera && !c.v.is_camera(c.job.target)) return std::nullopt;
  ta::Buckets b(camera ? std::vector<std::string>{"x", "y", "poiX", "poiY"} : std::vector<std::string>{"x", "y"});
  std::size_t n = 0;
  for (const CompSample& s : samples) {
    const std::optional<ta::P2> cp = c.to_comp(s.x, s.y, s.compTime);
    if (!cp) continue;
    const std::optional<ta::P2> p = c.to_parent(c.job.target, *cp, s.compTime);
    if (!p) continue;
    b.add("x", s.compTime, p->x);
    b.add("y", s.compTime, p->y);
    if (camera) {
      b.add("poiX", s.compTime, p->x);
      b.add("poiY", s.compTime, p->y);
    }
    ++n;
  }
  if (n == 0) return std::nullopt;
  return ta::Plan{camera ? "Apply Camera Track" : "Apply Motion Track", c.job.target, b.writes(), {}, {}, n};
}

/// planStabilize: the tracked layer moved so the feature stays where it was at the first sample.
std::optional<ta::Plan> plan_stabilize(const Ctx& c, const std::vector<CompSample>& samples) {
  const std::string& video = c.job.fl.layer;
  if (c.v.node(video) == nullptr || samples.empty()) return std::nullopt;
  const std::optional<ta::Geometry> g = c.v.geometry(video);
  if (!g) return std::nullopt;
  const std::optional<std::string> parent = c.v.parent_of(video);
  const CompSample& first = samples.front();
  const std::optional<ta::P2> p0 = c.to_comp(first.x, first.y, first.compTime);
  if (!p0) return std::nullopt;
  ta::Buckets b({"x", "y"});
  std::size_t n = 0;
  for (const CompSample& s : samples) {
    const std::optional<ta::P2> p = c.to_comp(s.x, s.y, s.compTime);
    if (!p) continue;
    double dx = p0->x - p->x;
    double dy = p0->y - p->y;
    if (parent) {
      const std::optional<doc::LayerSpace> ps = c.v.space(*parent, s.compTime);
      if (!ps) continue;
      const ta::P2 a = ta::DocView::from_comp(*ps, *p0);
      const ta::P2 q = ta::DocView::from_comp(*ps, *p);
      dx = a.x - q.x;
      dy = a.y - q.y;
    }
    const double t = c.v.key_time(video, s.compTime);
    const double baseX = c.v.sample(video, "x", t).value_or(g->local.x);
    const double baseY = c.v.sample(video, "y", t).value_or(g->local.y);
    b.add("x", s.compTime, baseX + dx);
    b.add("y", s.compTime, baseY + dy);
    ++n;
  }
  if (n == 0) return std::nullopt;
  return ta::Plan{"Stabilize Motion", video, b.writes(), {}, {}, n};
}

double atan2_deg(double y, double x) { return (motion::js::atan2(y, x) * 180) / 3.141592653589793; }

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

/// planTransformTrack: position from the anchor, rotation / scale from the anchor→reference vector.
std::optional<ta::Plan> plan_transform(const Ctx& c, const std::vector<std::vector<CompSample>>& tracks, bool wantScale) {
  const std::string& target = c.job.target;
  if (c.v.node(target) == nullptr || tracks.size() != 2) return std::nullopt;
  const std::optional<ta::Geometry> g = c.v.geometry(target);
  if (!g) return std::nullopt;
  std::map<double, const CompSample*> refByTime;
  for (const CompSample& s : tracks[1]) refByTime.insert_or_assign(s.compTime, &s);
  ta::Buckets bk({"x", "y", "rotation", "scaleX", "scaleY"});
  std::size_t n = 0;
  std::optional<double> baseAngle;
  std::optional<double> baseLength;
  double prevAngleDelta = 0;
  for (const CompSample& a : tracks[0]) {
    const auto it = refByTime.find(a.compTime);
    if (it == refByTime.end()) continue;
    const CompSample& b = *it->second;
    const std::optional<ta::P2> ca = c.to_comp(a.x, a.y, a.compTime);
    const std::optional<ta::P2> pa = ca ? c.to_parent(target, *ca, a.compTime) : std::nullopt;
    const std::optional<ta::P2> cb = c.to_comp(b.x, b.y, a.compTime);
    const std::optional<ta::P2> pb = cb ? c.to_parent(target, *cb, a.compTime) : std::nullopt;
    if (!pa || !pb) continue;
    const double vx = pb->x - pa->x;
    const double vy = pb->y - pa->y;
    const double len = hypot2(vx, vy);
    if (len < 1e-6) continue;
    const double angle = atan2_deg(vy, vx);
    if (!baseAngle || !baseLength) {
      baseAngle = angle;
      baseLength = len;
    }
    const double angleDelta = ta::unwrap_deg(angle - *baseAngle, prevAngleDelta);
    prevAngleDelta = angleDelta;
    const double scaleRatio = len / *baseLength;
    const double t = c.v.key_time(target, a.compTime);
    bk.add("x", a.compTime, pa->x);
    bk.add("y", a.compTime, pa->y);
    ++n;
    const double baseRot = c.v.sample(target, "rotation", t).value_or(g->local.rotation);
    bk.add("rotation", a.compTime, baseRot + angleDelta);
    if (wantScale) {
      const double baseSx = c.v.sample(target, "scaleX", t).value_or(g->local.scale_x);
      const double baseSy = c.v.sample(target, "scaleY", t).value_or(g->local.scale_y);
      bk.add("scaleX", a.compTime, baseSx * scaleRatio);
      bk.add("scaleY", a.compTime, baseSy * scaleRatio);
    }
  }
  if (n == 0) return std::nullopt;
  return ta::Plan{"Apply Motion Track (rotation & scale)", target, bk.writes(), {}, {}, n};
}

/// planCameraSolveTrack: the camera follow + orientationZ from the anchor→reference angle (source px).
std::optional<ta::Plan> plan_camera_solve(const Ctx& c, const std::vector<std::vector<CompSample>>& tracks) {
  if (tracks.size() < 2 || !c.v.is_camera(c.job.target)) return std::nullopt;
  std::optional<ta::Plan> follow = plan_follow(c, tracks[0], true);
  if (!follow) return std::nullopt;
  std::map<double, const CompSample*> refByTime;
  for (const CompSample& s : tracks[1]) refByTime.insert_or_assign(s.compTime, &s);
  ta::Write ori{"orientationZ", {}};
  std::optional<double> baseAngle;
  double prevDelta = 0;
  for (const CompSample& a : tracks[0]) {
    const auto it = refByTime.find(a.compTime);
    if (it == refByTime.end()) continue;
    const double angle = atan2_deg(it->second->y - a.y, it->second->x - a.x);
    if (!baseAngle) baseAngle = angle;
    const double delta = ta::unwrap_deg(angle - *baseAngle, prevDelta);
    prevDelta = delta;
    ori.keys.emplace_back(a.compTime, delta);
  }
  follow->label = "Apply Camera Solve";
  follow->count += ori.keys.size();
  if (!ori.keys.empty()) follow->writes.push_back(std::move(ori));
  return follow;
}

/// planCornerPinTrack: the target's Corner Pin offsets riding the tracked corners.
std::optional<ta::Plan> plan_corner(const Ctx& c, const std::vector<std::vector<CompSample>>& tracks) {
  const std::string& target = c.job.target;
  if (c.v.node(target) == nullptr || tracks.size() < 4) return std::nullopt;
  const std::optional<ta::Geometry> g = c.v.geometry(target);
  if (!g || !g->width || !g->height) return std::nullopt;
  const double gw = *g->width;
  const double gh = *g->height;
  struct CornerKey {
    const char* x;
    const char* y;
    double rx;
    double ry;
  };
  const std::array<CornerKey, 4> keys{CornerKey{"topLeftX", "topLeftY", 0, 0}, CornerKey{"topRightX", "topRightY", gw, 0},
                                      CornerKey{"bottomRightX", "bottomRightY", gw, gh},
                                      CornerKey{"bottomLeftX", "bottomLeftY", 0, gh}};
  ta::Buckets bk({"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY", "bottomLeftX",
                  "bottomLeftY"});
  std::size_t nFrames = tracks[0].size();
  for (const auto& t : tracks) nFrames = std::min(nFrames, t.size());
  if (nFrames == 0) return std::nullopt;
  std::size_t planned = 0;
  auto writeCorner = [&](std::size_t corner, double sx, double sy, double compTime) {
    const CornerKey& k = keys[corner];
    const std::optional<ta::P2> cp = c.to_comp(sx, sy, compTime);
    if (!cp) return;
    const std::optional<doc::LayerSpace> space = c.v.space(target, compTime);
    if (!space) return;
    const ta::P2 l = ta::DocView::from_comp(*space, *cp);
    bk.add(k.x, compTime, l.x + gw / 2 - k.rx);
    bk.add(k.y, compTime, l.y + gh / 2 - k.ry);
    planned += 1;
  };
  if (tracks.size() == 4) {
    for (std::size_t corner = 0; corner < 4; ++corner) {
      for (const CompSample& s : tracks[corner]) writeCorner(corner, s.x, s.y, s.compTime);
    }
  } else {
    // RANSAC over every feature (coasted / weak samples weigh 0), then a temporal smooth of H.
    std::vector<tr::Pt> seeds;
    for (const auto& t : tracks) seeds.push_back(tr::Pt{t[0].x, t[0].y});
    std::vector<std::optional<tr::Mat3>> hs;
    for (std::size_t i = 0; i < nFrames; ++i) {
      std::vector<tr::Pt> dst;
      tr::RansacOptions ro;
      ro.inlierPx = 3;
      ro.seed = static_cast<std::uint32_t>(i + 1);
      for (const auto& t : tracks) {
        dst.push_back(tr::Pt{t[i].x, t[i].y});
        ro.weights.push_back(t[i].coasted || t[i].confidence < 0.2 ? 0.0 : t[i].confidence);
      }
      const std::optional<tr::RansacFit> fit = tr::fit_homography_ransac(seeds, dst, ro);
      hs.push_back(fit ? std::optional<tr::Mat3>(fit->H) : tr::fit_homography(seeds, dst));
    }
    const std::vector<std::optional<tr::Mat3>> smoothed = tr::smooth_homography_sequence(hs, 1);
    for (std::size_t i = 0; i < nFrames; ++i) {
      const double compTime = tracks[0][i].compTime;
      if (!smoothed[i]) {
        for (std::size_t corner = 0; corner < 4; ++corner) writeCorner(corner, tracks[corner][i].x, tracks[corner][i].y, compTime);
        continue;
      }
      for (std::size_t corner = 0; corner < 4; ++corner) {
        const std::optional<tr::Pt> p = tr::project_homography(*smoothed[i], seeds[corner]);
        if (!p) continue;
        writeCorner(corner, p->x, p->y, compTime);
      }
    }
  }
  if (planned == 0) return std::nullopt;
  return ta::Plan{"Apply Corner Pin Track", target, bk.writes(), "corner-pin", c.job.effectId, planned};
}

// ── the result ──────────────────────────────────────────────────────────

class TrackMotionResult final : public JobResult {
 public:
  TrackMotionResult(TrackJob job, std::vector<std::vector<CompSample>> tracks, std::string status, double sw, double sh)
      : job_(std::move(job)), tracks_(std::move(tracks)), status_(std::move(status)), sw_(sw), sh_(sh) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"kind\":" + json_string(api::to_string(job_.kind)) + ",\"direction\":" +
                    json_string(api::to_string(job_.direction)) + ",\"status\":" + json_string(status_) +
                    ",\"sourceWidth\":" + json_number(sw_) + ",\"sourceHeight\":" + json_number(sh_) +
                    ",\"sample\":[\"t\",\"x\",\"y\",\"confidence\",\"coasted\"],\"tracks\":[";
    for (std::size_t p = 0; p < tracks_.size(); ++p) {
      if (p > 0) s += ',';
      s += '[';
      for (std::size_t i = 0; i < tracks_[p].size(); ++i) {
        const CompSample& c = tracks_[p][i];
        if (i > 0) s += ',';
        s += '[' + tf::fixed(c.compTime, 6) + ',' + tf::fixed(c.x, 4) + ',' + tf::fixed(c.y, 4) + ',' +
             tf::fixed(c.confidence, 4) + ',' + (c.coasted ? '1' : '0') + ']';
      }
      s += ']';
    }
    return s + "]}";
  }

  [[nodiscard]] std::string label() const override {
    switch (job_.mode) {
      case Mode::stabilize: return "Stabilize Motion";
      case Mode::follow: return job_.targetCamera ? "Apply Camera Track" : "Apply Motion Track";
      case Mode::transform: return job_.targetCamera ? "Apply Camera Solve" : "Apply Motion Track (rotation & scale)";
      case Mode::corner: return "Apply Corner Pin Track";
      case Mode::none: break;
    }
    return "Track Motion";
  }

  [[nodiscard]] bool has_edits() const override {
    return job_.mode != Mode::none && std::any_of(tracks_.begin(), tracks_.end(), [](const auto& t) { return !t.empty(); });
  }

  void apply(JobApply& a) const override {
    if (!has_edits()) return;
    const ta::DocView v(a.document(), job_.fl.comp);
    // The attach point rides the feature at a fixed offset (AE); (0, 0) = the feature itself.
    std::vector<std::vector<CompSample>> tracks = tracks_;
    for (std::size_t p = 0; p < tracks.size() && p < job_.points.size(); ++p) {
      for (CompSample& s : tracks[p]) {
        s.x += job_.points[p].attachDx;
        s.y += job_.points[p].attachDy;
      }
    }
    const ta::P2 box{job_.fl.width > 0 ? static_cast<double>(job_.fl.width) : sw_,
                     job_.fl.height > 0 ? static_cast<double>(job_.fl.height) : sh_};
    const Ctx c{job_, v, sw_, sh_, box};
    std::optional<ta::Plan> plan;
    switch (job_.mode) {
      case Mode::stabilize: plan = plan_stabilize(c, tracks[0]); break;
      case Mode::follow: plan = plan_follow(c, tracks[0], job_.targetCamera); break;
      case Mode::transform:
        plan = job_.targetCamera ? plan_camera_solve(c, tracks)
                                 : plan_transform(c, tracks, job_.kind == api::TrackKind::position_rotation_scale);
        break;
      case Mode::corner: plan = plan_corner(c, tracks); break;
      case Mode::none: break;
    }
    if (plan) ta::send_plan(a, *plan);
  }

 private:
  TrackJob job_;
  std::vector<std::vector<CompSample>> tracks_;
  std::string status_;
  double sw_;
  double sh_;
};

// ── the work ────────────────────────────────────────────────────────────

std::unique_ptr<JobResult> run_track(const TrackJob& job, JobControl& control) {
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(job.fl.file, job.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = job.fl.layer});
  const double w = src->width();
  const double h = src->height();
  const double sw = src->source_width() > 0 ? src->source_width() : w;
  const double sh = src->source_height() > 0 ? src->source_height() : h;
  if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = job.fl.layer});
  // Display grid (layer px) ↔ decoded grid; lengths by the geometric mean.
  const double toCodedX = w / sw;
  const double toCodedY = h / sh;
  const double toCodedLength = std::sqrt(toCodedX * toCodedY);
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const double srcFps = src->fps();
  auto srcIndexAt = [&](std::int64_t compFrame) { return tf::source_index(job.fl, compFrame, job.fps, srcFps, count); };

  std::vector<tr::PointSeed> seeds;
  for (const PointSpec& p : job.points) {
    tr::PointSeed s;
    s.x = p.x * toCodedX;
    s.y = p.y * toCodedY;
    s.featureHalf = std::max(1, static_cast<int>(motion::js::round(p.featureHalf * toCodedLength)));
    s.searchHalf = std::max(1, static_cast<int>(motion::js::round(p.searchHalf * toCodedLength)));
    seeds.push_back(s);
  }
  tr::TrackOptions opts;
  opts.minConfidence = job.minConfidence;
  opts.maxCoastFrames = job.maxCoast;

  // Comp frames the result covers, and the source walks.
  std::int64_t compLo = job.frames.first;
  std::int64_t compHi = job.frames.last;
  struct Walk {
    std::int64_t from;
    std::int64_t to;
  };
  std::vector<Walk> walks;  // run in order; `both` = backward, then forward
  if (job.direction == api::TrackDirection::forward) {
    compLo = job.origin;
    walks.push_back(Walk{srcIndexAt(job.origin), srcIndexAt(compHi)});
    if (walks[0].from == walks[0].to) fail(ErrorCode::invalid_argument, "the clip does not advance over this range — nothing to track");
  } else if (job.direction == api::TrackDirection::backward) {
    compHi = job.origin;
    walks.push_back(Walk{srcIndexAt(job.origin), srcIndexAt(compLo)});
    if (walks[0].from == walks[0].to) fail(ErrorCode::invalid_argument, "the clip does not advance over this range — nothing to track");
  } else {
    const std::int64_t a = srcIndexAt(compLo);
    const std::int64_t b = srcIndexAt(compHi);
    const std::int64_t lo = std::min(a, b);
    const std::int64_t hi = std::max(a, b);
    if (lo == hi) fail(ErrorCode::invalid_argument, "the clip does not advance over this range — nothing to track");
    const std::int64_t anchor = std::clamp(srcIndexAt(job.origin), lo, hi);
    if (lo < anchor) walks.push_back(Walk{anchor, lo});
    if (anchor < hi) walks.push_back(Walk{anchor, hi});
  }
  std::int64_t total = 0;
  for (const Walk& wk : walks) total += wk.to >= wk.from ? wk.to - wk.from : wk.from - wk.to;
  std::int64_t done = 0;

  std::vector<tr::MultiTrackResult> results;
  try {
    for (const Walk& wk : walks) {
      const bool descending = wk.to < wk.from;
      LumaWalk frames(*src, control, std::min(wk.from, wk.to), descending);
      const tr::FrameAt frameAt = [&frames](std::int64_t i) -> const tr::LumaPlane& { return frames.at(i); };
      const tr::OnProgress onProgress = [&](std::int64_t, std::int64_t) {
        ++done;
        control.progress(total > 0 ? static_cast<double>(done) / static_cast<double>(total) : 1.0,
                         "Tracking frame " + std::to_string(done) + " of " + std::to_string(total));
        return !control.cancelled();
      };
      results.push_back(tr::track_points(frameAt, wk.from, wk.to, seeds, opts, onProgress));
      if (results.back().status == tr::TrackStatus::cancelled) return nullptr;
    }
  } catch (const LumaWalk::Cancelled&) {
    return nullptr;
  }
  if (control.cancelled()) return nullptr;

  // Per point: the source samples (merged when both ways), then read out per comp frame.
  std::string status = "completed";
  for (const tr::MultiTrackResult& r : results) {
    if (r.status != tr::TrackStatus::completed) status = job.direction == api::TrackDirection::both ? "partial" : "lost";
  }
  std::vector<std::vector<CompSample>> out;
  for (std::size_t p = 0; p < seeds.size(); ++p) {
    std::vector<tr::TrackSample> samples;
    if (results.size() == 2) {
      samples = tr::merge_bidirectional(results[0].tracks[p], results[1].tracks[p]);
    } else if (results.size() == 1) {
      samples = results[0].tracks[p];
    }
    std::map<std::int64_t, const tr::TrackSample*> byFrame;
    for (const tr::TrackSample& s : samples) byFrame.insert_or_assign(s.frame, &s);
    std::vector<CompSample> comp;
    for (std::int64_t f = compLo; f <= compHi; ++f) {
      const auto it = byFrame.find(srcIndexAt(f));
      if (it == byFrame.end()) continue;
      const tr::TrackSample& s = *it->second;
      comp.push_back(CompSample{static_cast<double>(f) / job.fps, s.x / toCodedX, s.y / toCodedY, s.confidence, s.coasted});
    }
    out.push_back(std::move(comp));
  }
  control.progress(1.0, "Tracked " + std::to_string(out.size()) + (out.size() == 1 ? " point" : " points"));
  return std::make_unique<TrackMotionResult>(job, std::move(out), std::move(status), sw, sh);
}

}  // namespace

PreparedJob prepare_track_motion(const api::TrackMotionJob& spec, const JobDocContext& ctx) {
  TrackJob job;
  job.fl = footage_layer(ctx, spec.layer, Need::picture);
  job.kind = spec.kind;
  job.direction = spec.direction;
  const std::size_t n = spec.points.size();
  switch (spec.kind) {
    case api::TrackKind::position:
      if (n < 1) fail(ErrorCode::invalid_argument, "a position track needs a point");
      break;
    case api::TrackKind::position_rotation:
    case api::TrackKind::position_rotation_scale:
      if (n != 2) fail(ErrorCode::invalid_argument, "a rotation / scale track needs exactly two points (anchor, reference)");
      break;
    case api::TrackKind::perspective_corner:
      if (n < 4) fail(ErrorCode::invalid_argument, "a corner pin track needs four points (top left, top right, bottom right, bottom left)");
      break;
    case api::TrackKind::mask:
    case api::TrackKind::planar:
      fail(ErrorCode::unsupported, "the engine tracks position, rotation / scale and corner pin; mask and planar tracks are not ported");
  }
  if (spec.stabilize && spec.kind != api::TrackKind::position) {
    fail(ErrorCode::invalid_argument, "stabilize tracks one point (kind position)");
  }
  job.fps = job.fl.compFps > 0 ? job.fl.compFps : 30;
  job.frames = tf::comp_frames_of(spec.range, job.fps);
  if (job.frames.last <= job.frames.first) fail(ErrorCode::out_of_range, "the range covers one frame or less — nothing to track");
  const auto clampFrame = [&job](std::int64_t f) { return std::clamp(f, job.frames.first, job.frames.last); };
  if (spec.origin) {
    job.origin = clampFrame(static_cast<std::int64_t>(motion::js::round(seconds_of(*spec.origin) * job.fps)));
  } else if (spec.direction == api::TrackDirection::forward) {
    job.origin = job.frames.first;
  } else if (spec.direction == api::TrackDirection::backward) {
    job.origin = job.frames.last;
  } else {
    job.origin = clampFrame(static_cast<std::int64_t>(motion::js::round(seconds_of(ctx.time) * job.fps)));
  }
  if (spec.direction == api::TrackDirection::forward && job.origin >= job.frames.last) {
    fail(ErrorCode::out_of_range, "nothing after the origin to track");
  }
  if (spec.direction == api::TrackDirection::backward && job.origin <= job.frames.first) {
    fail(ErrorCode::out_of_range, "nothing before the origin to track");
  }
  if (spec.min_confidence) job.minConfidence = *spec.min_confidence;
  if (spec.max_coast_frames) job.maxCoast = static_cast<int>(std::min<std::uint32_t>(*spec.max_coast_frames, 100000));
  if (spec.analysis_max_edge) job.maxEdge = *spec.analysis_max_edge;

  for (const api::TrackPointSpec& p : spec.points) {
    PointSpec s;
    s.x = p.feature.x;
    s.y = p.feature.y;
    s.featureHalf = half_of(std::max(p.feature.width, p.feature.height), kDefaultFeatureHalf);
    s.searchHalf = half_of(std::max(p.search.width, p.search.height), kDefaultSearchHalf);
    if (p.attach.x != 0 || p.attach.y != 0) {
      s.attachDx = p.attach.x - p.feature.x;
      s.attachDy = p.attach.y - p.feature.y;
    }
    job.points.push_back(s);
  }

  // Where the result goes.
  if (spec.stabilize) {
    job.mode = Mode::stabilize;
    job.target = job.fl.layer;
  } else if (spec.apply_to) {
    const api::PropRef& to = *spec.apply_to;
    const std::optional<std::string> comp = ctx.doc.node(to.layer) != nullptr ? doc::comp_of_layer(ctx.doc, to.layer) : std::nullopt;
    if (!comp || *comp == to.layer) fail(ErrorCode::not_found, "no layer '" + to.layer + "' to apply the track to", {.layer = to.layer});
    job.target = to.layer;
    job.targetCamera = ctx.doc.node(to.layer)->kind() == "camera";
    if (spec.kind == api::TrackKind::perspective_corner) {
      job.mode = Mode::corner;
      if (to.path.starts_with("effects/")) {
        const std::string rest = to.path.substr(8);
        job.effectId = rest.substr(0, rest.find('/'));
        const ta::DocView v(ctx.doc, *comp);
        if (v.effect_type(to.layer, job.effectId) != "corner-pin") {
          fail(ErrorCode::invalid_argument, "'" + to.path + "' is not a Corner Pin effect", {.layer = to.layer, .path = to.path});
        }
      } else if (!to.path.empty() && to.path != "effects") {
        fail(ErrorCode::invalid_argument, "a corner pin track applies to a Corner Pin effect ('effects/<id>' or 'effects')",
             {.layer = to.layer, .path = to.path});
      }
    } else {
      if (!to.path.empty() && to.path != "transform" && to.path != "transform/position") {
        fail(ErrorCode::invalid_argument, "a position / rotation / scale track applies to 'transform' or 'transform/position'",
             {.layer = to.layer, .path = to.path});
      }
      job.mode = spec.kind == api::TrackKind::position ? Mode::follow : Mode::transform;
    }
  }
  return PreparedJob{"trackMotion", [job = std::move(job)](JobControl& control) { return run_track(job, control); }};
}

}  // namespace premation::jobs
