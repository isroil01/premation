// Job kind `trackMotion` — the Track Motion panel's Track + Apply
// (src/layout/Inspector/trackMotion/trackMotionActions.ts onTrack / onApply,
// src/core/tracking/trackVideoLayer.ts, tracker.ts, applyTrack.ts,
// maskTrack.ts, planarFit.ts densifyQuad).
//
// Track: the footage layer's frames are decoded at the analysis size
// (`analysisMaxEdge`, default 960 — the TS analysis tier) and walked by
// track_walk.hpp (the distinct source frames of the range, samples read out
// per comp frame). Point specs:
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
// Kinds:
//   position … perspectiveCorner   the points as given.
//   planar    the corner mode's "Dense grid": the quad TL, TR, BR, BL (+ any
//             points after it, kept) gains a planarGrid² lattice inside it
//             (densifyQuad, default 5); applied as a corner pin, whose fit over
//             more than four points is the RANSAC plane.
//   mask      trackLayerMask: every vertex of the layer's masks (or of the one
//             `applyTo` names, `masks/<id>`) as they stand at the origin
//             (the mask animation interpolated there, else the static mask) is
//             a point — past 64 vertices an arc-length sample is tracked and the
//             rest ride their neighbours (mask_sampling.hpp); the windows are
//             `points[0]`'s (default 10 / 24). The result is ONE path key per
//             tracked comp frame on every tracked mask ("Track Mask"): vertices
//             displaced by their tracked delta, handles rigid with their vertex,
//             a lost vertex frozen where it was last seen; keys inside the
//             tracked span replaced, the rest kept. (The TS wrote the layer's
//             mask animation outside the history; here it is one undoable entry.)
//
// Apply (`applyTo` a PropRef on the TARGET layer; absent = analysis only, the
// track is in the summary — the panel's Apply then sends a trackApply job):
//   position                  path `transform/position` or `transform`:
//                               planTrackToLayer (x/y keys, parent space);
//                               a camera target: planTrackToCamera (+ poiX/poiY).
//   positionRotation(Scale)   exactly two points; same paths: planTransformTrack
//                               (rotation, and scale for …Scale, as deltas on
//                               the target's own values); a camera target:
//                               planCameraSolveTrack (+ orientationZ).
//   perspectiveCorner/planar  four points TL, TR, BR, BL (+ more: RANSAC planar
//                               fit, smoothed): path `effects/<id>` of a Corner
//                               Pin, or `effects` = the target's first Corner Pin,
//                               added when it has none (planCornerPinTrack).
//   stabilize = true          kind position: planStabilize on the TRACKED layer.
// The writes go out as track_apply.hpp describes (addEffect?, addKeyframes,
// deleteKeyframes) in the job's one history entry.
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "fxstate.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "mask_sampling.hpp"
#include "media_input.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "track_plans.hpp"
#include "track_walk.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace ta = trackapply;
namespace tf = trackframes;
namespace tw = trackwalk;
namespace ms = masksample;

namespace {

constexpr double kDefaultFeatureHalf = 10;
constexpr double kDefaultSearchHalf = 24;
constexpr std::uint32_t kAnalysisEdge = 960;

enum class Mode : std::uint8_t { none, follow, transform, corner, stabilize };

struct PointSpec {
  tw::WalkPoint p;
  double attachDx = 0;
  double attachDy = 0;
};

/// Everything the work and the apply read, copied out of the document at prepare.
struct TrackJob {
  tw::WalkSpec walk;
  api::TrackKind kind = api::TrackKind::position;
  std::vector<PointSpec> points;
  std::uint32_t maxEdge = kAnalysisEdge;
  Mode mode = Mode::none;
  std::string target;
  std::string effectId;  ///< corner: the Corner Pin named by applyTo ('' = first / added)
  bool targetCamera = false;
};

double half_of(double size, double fallback) {
  return size > 0 ? motion::js::round((size - 1) / 2) : fallback;
}

/// planarFit.ts `densifyQuad(points, grid)`: the lattice takes the first point's windows (one size for all, trackerStore).
std::vector<tw::WalkPoint> densify_quad(const std::vector<tw::WalkPoint>& points, int grid) {
  if (points.size() < 4) return points;
  const tw::WalkPoint tl = points[0];
  const tw::WalkPoint tr = points[1];
  const tw::WalkPoint br = points[2];
  const tw::WalkPoint bl = points[3];
  std::vector<tw::WalkPoint> out = points;
  for (int r = 0; r < grid; ++r) {
    const double v = (r + 0.5) / grid;
    for (int c = 0; c < grid; ++c) {
      const double u = (c + 0.5) / grid;
      const double topX = tl.x + (tr.x - tl.x) * u;
      const double topY = tl.y + (tr.y - tl.y) * u;
      const double botX = bl.x + (br.x - bl.x) * u;
      const double botY = bl.y + (br.y - bl.y) * u;
      tw::WalkPoint p = tl;
      p.x = topX + (botX - topX) * v;
      p.y = topY + (botY - topY) * v;
      out.push_back(p);
    }
  }
  return out;
}

// ── the result ──────────────────────────────────────────────────────────

class TrackMotionResult final : public JobResult {
 public:
  TrackMotionResult(TrackJob job, tw::WalkResult r) : job_(std::move(job)), r_(std::move(r)) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"kind\":" + json_string(api::to_string(job_.kind)) + ",\"direction\":" +
                    json_string(api::to_string(job_.walk.direction)) + ",\"status\":" + json_string(r_.status) +
                    ",\"sourceWidth\":" + json_number(r_.sourceWidth) + ",\"sourceHeight\":" + json_number(r_.sourceHeight) +
                    ",\"sample\":[\"t\",\"x\",\"y\",\"confidence\",\"coasted\"],\"tracks\":[";
    for (std::size_t p = 0; p < r_.tracks.size(); ++p) {
      if (p > 0) s += ',';
      s += '[';
      for (std::size_t i = 0; i < r_.tracks[p].size(); ++i) {
        const ta::CompSample& c = r_.tracks[p][i];
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
    return job_.mode != Mode::none && std::any_of(r_.tracks.begin(), r_.tracks.end(), [](const auto& t) { return !t.empty(); });
  }

  void apply(JobApply& a) const override {
    if (!has_edits()) return;
    const ta::DocView v(a.document(), job_.walk.fl.comp);
    // The attach point rides the feature at a fixed offset (AE); (0, 0) = the feature itself.
    std::vector<ta::Track> tracks = r_.tracks;
    for (std::size_t p = 0; p < tracks.size() && p < job_.points.size(); ++p) {
      for (ta::CompSample& s : tracks[p]) {
        s.x += job_.points[p].attachDx;
        s.y += job_.points[p].attachDy;
      }
    }
    const FootageLayer& fl = job_.walk.fl;
    const ta::P2 box{fl.width > 0 ? static_cast<double>(fl.width) : r_.sourceWidth,
                     fl.height > 0 ? static_cast<double>(fl.height) : r_.sourceHeight};
    const ta::Planner planner(v, ta::Source{fl.layer, r_.sourceWidth, r_.sourceHeight, box});
    std::optional<ta::Plan> plan;
    switch (job_.mode) {
      case Mode::stabilize: plan = planner.stabilize(tracks[0]); break;
      case Mode::follow: plan = planner.follow(job_.target, tracks[0], job_.targetCamera); break;
      case Mode::transform:
        plan = job_.targetCamera ? planner.camera_track(job_.target, tracks)
                                 : planner.transform(job_.target, tracks, job_.kind == api::TrackKind::position_rotation_scale);
        break;
      case Mode::corner: plan = planner.corner(job_.target, tracks, job_.effectId); break;
      case Mode::none: break;
    }
    if (plan) ta::send_plan(a, *plan);
  }

 private:
  TrackJob job_;
  tw::WalkResult r_;
};

// ── mask tracking (maskTrack.ts) ────────────────────────────────────────

/// One mask path as it stood at the origin (layer-local, centred).
struct MaskShape {
  std::string group;  ///< masks/<id>
  api::BezierPath path;
};

struct MaskJob {
  tw::WalkSpec walk;
  std::vector<MaskShape> masks;
  /// The layer's drawn box (readGeometry) the vertices scale into.
  double boxW = 0;
  double boxH = 0;
  std::uint32_t maxEdge = kAnalysisEdge;
};

class MaskTrackResult final : public JobResult {
 public:
  MaskTrackResult(std::string layer, std::vector<ta::PathKeys> keys, std::size_t frames, std::size_t vertices,
                  std::size_t sampled, std::string status)
      : layer_(std::move(layer)), keys_(std::move(keys)), frames_(frames), vertices_(vertices), sampled_(sampled),
        status_(std::move(status)) {}

  [[nodiscard]] std::string summary_json() const override {
    return "{\"kind\":\"mask\",\"keyframes\":" + std::to_string(frames_) + ",\"vertices\":" + std::to_string(vertices_) +
           ",\"sampled\":" + std::to_string(sampled_) + ",\"masks\":" + std::to_string(keys_.size()) +
           ",\"status\":" + json_string(status_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Track Mask"; }
  [[nodiscard]] bool has_edits() const override { return frames_ > 0; }
  void apply(JobApply& a) const override { ta::send_path_splice(a, layer_, keys_); }

 private:
  std::string layer_;
  std::vector<ta::PathKeys> keys_;
  std::size_t frames_;
  std::size_t vertices_;
  std::size_t sampled_;
  std::string status_;
};

std::unique_ptr<JobResult> run_mask_track(const MaskJob& job, JobControl& control) {
  const FootageLayer& fl = job.walk.fl;
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(fl.file, job.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = fl.layer});
  const double sw = src->source_width() > 0 ? src->source_width() : src->width();
  const double sh = src->source_height() > 0 ? src->source_height() : src->height();
  if (!(sw > 0) || !(sh > 0)) fail(ErrorCode::decode, "the footage has no picture", {.layer = fl.layer});
  const double gw = job.boxW > 0 ? job.boxW : sw;
  const double gh = job.boxH > 0 ? job.boxH : sh;

  // Flatten every path's vertices, in path order: layer-local (centred) →
  // source display px — the inverse of trackSampleToComp's local step.
  struct VertexRef {
    std::size_t path;
    std::size_t point;
  };
  std::vector<VertexRef> refs;
  std::vector<ms::Pt> vertices;
  std::vector<ms::SamplablePath> samplable;
  for (std::size_t p = 0; p < job.masks.size(); ++p) {
    const api::BezierPath& path = job.masks[p].path;
    ms::SamplablePath sp;
    sp.closed = path.closed;
    for (std::size_t i = 0; i + 1 < path.vertices.size(); i += 2) {
      refs.push_back(VertexRef{p, i / 2});
      const ms::Pt d{(path.vertices[i] / gw + 0.5) * sw, (path.vertices[i + 1] / gh + 0.5) * sh};
      sp.points.push_back(d);
      vertices.push_back(d);
    }
    samplable.push_back(std::move(sp));
  }
  if (vertices.empty()) fail(ErrorCode::invalid_argument, "The mask has no points.", {.layer = fl.layer});

  // The tracking party: every vertex within the cap, an arc-length sample past it.
  const ms::VertexSampling sampling = ms::sample_mask_vertices(samplable, ms::kMaxTrackedVertices);
  tw::WalkSpec spec = job.walk;
  const tw::WalkPoint windows = spec.points.empty() ? tw::WalkPoint{} : spec.points.front();
  spec.points.clear();
  std::vector<ms::Pt> rest;
  for (const int v : sampling.tracked) {
    const ms::Pt& d = vertices[static_cast<std::size_t>(v)];
    rest.push_back(d);
    tw::WalkPoint wp = windows;
    wp.x = d.x;
    wp.y = d.y;
    spec.points.push_back(wp);
  }
  const std::optional<tw::WalkResult> r = tw::walk(*src, spec, control);
  if (!r) return nullptr;

  // Sample times: the union of comp times any vertex reached, in order. A
  // vertex missing at a time freezes at its last known place.
  std::set<double> timeSet;
  for (const ta::Track& t : r->tracks) {
    for (const ta::CompSample& s : t) timeSet.insert(s.compTime);
  }
  const std::vector<double> times(timeSet.begin(), timeSet.end());
  if (times.size() < 2) fail(ErrorCode::invalid_argument, "Tracking produced too little motion to keyframe.", {.layer = fl.layer});
  std::vector<std::map<double, const ta::CompSample*>> byTime(r->tracks.size());
  for (std::size_t k = 0; k < r->tracks.size(); ++k) {
    for (const ta::CompSample& s : r->tracks[k]) byTime[k].insert_or_assign(s.compTime, &s);
  }

  std::vector<ta::PathKeys> keys;
  for (const MaskShape& m : job.masks) keys.push_back(ta::PathKeys{m.group, {}});
  std::vector<ms::Pt> lastKnown = rest;
  const bool interpolated = sampling.tracked.size() < refs.size();
  for (const double compTime : times) {
    // Where every tracked slot is at this time (frozen if it was lost).
    std::vector<ms::Pt> slotAt(rest.size());
    for (std::size_t k = 0; k < rest.size(); ++k) {
      if (k < byTime.size()) {
        const auto it = byTime[k].find(compTime);
        if (it != byTime[k].end()) lastKnown[k] = ms::Pt{it->second->x, it->second->y};
      }
      slotAt[k] = lastKnown[k];
    }
    // Untracked vertices ride their neighbours' deltas (display px).
    std::vector<ms::Pt> blended;
    if (interpolated) {
      std::vector<ms::Pt> deltas;
      for (std::size_t k = 0; k < slotAt.size(); ++k) deltas.push_back(ms::Pt{slotAt[k].x - rest[k].x, slotAt[k].y - rest[k].y});
      blended = ms::blend_vertex_deltas(sampling, deltas);
    }
    // The base shape, each vertex displaced by its tracked delta (the handles
    // are relative in a BezierPath: they travel rigidly with their vertex).
    std::vector<api::BezierPath> paths;
    for (const MaskShape& m : job.masks) paths.push_back(m.path);
    for (std::size_t v = 0; v < refs.size(); ++v) {
      const int slot = sampling.slotOf[v];
      const ms::Pt at = slot >= 0 ? slotAt[static_cast<std::size_t>(slot)]
                                  : ms::Pt{vertices[v].x + blended[v].x, vertices[v].y + blended[v].y};
      api::BezierPath& path = paths[refs[v].path];
      path.vertices[refs[v].point * 2] = (at.x / sw - 0.5) * gw;
      path.vertices[refs[v].point * 2 + 1] = (at.y / sh - 0.5) * gh;
    }
    for (std::size_t p = 0; p < paths.size(); ++p) keys[p].keys.push_back(ta::PathKey{compTime, std::move(paths[p])});
  }
  control.progress(1.0, "Tracked " + std::to_string(refs.size()) + " mask vertices");
  return std::make_unique<MaskTrackResult>(fl.layer, std::move(keys), times.size(), refs.size(), sampling.tracked.size(),
                                           r->status == "partial" ? "lost" : r->status);
}

/// The masks a mask track follows, as they stand at `originSec` (comp seconds).
std::vector<MaskShape> masks_at(const JobDocContext& ctx, const FootageLayer& fl, double originSec, const std::string& only) {
  const doc::Node* n = ctx.doc.node(fl.layer);
  const ta::DocView v(ctx.doc, fl.comp);
  // The shape VISIBLE at the start time: an animated mask continues from what
  // the user sees, not from the static rest shape underneath.
  std::optional<doc::Json> base = doc::interpolate_mask(doc::read_node_mask_anim(*n), v.key_time(fl.layer, originSec));
  if (!base || !base->at("paths").is_array() || base->at("paths").arr().empty()) base = doc::read_node_mask(*n);
  if (!base || !base->at("paths").is_array() || base->at("paths").arr().empty()) {
    fail(ErrorCode::invalid_argument, "Layer has no mask to track.", {.layer = fl.layer});
  }
  std::vector<MaskShape> out;
  for (const doc::Json& p : base->at("paths").arr()) {
    const std::string id = p.at("id").is_string() ? p.at("id").str() : std::string("undefined");
    if (!only.empty() && id != only) continue;
    MaskShape m{"masks/" + id, doc::mask_to_bezier(p)};
    if (m.path.vertices.empty()) continue;
    out.push_back(std::move(m));
  }
  if (out.empty()) {
    fail(ErrorCode::invalid_argument, only.empty() ? "The mask has no points." : "Layer has no mask '" + only + "' to track.",
         {.layer = fl.layer});
  }
  return out;
}

std::unique_ptr<JobResult> run_track(const TrackJob& job, JobControl& control) {
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(job.walk.fl.file, job.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = job.walk.fl.layer});
  std::optional<tw::WalkResult> r = tw::walk(*src, job.walk, control);
  if (!r) return nullptr;
  control.progress(1.0, "Tracked " + std::to_string(r->tracks.size()) + (r->tracks.size() == 1 ? " point" : " points"));
  return std::make_unique<TrackMotionResult>(job, std::move(*r));
}

}  // namespace

PreparedJob prepare_track_motion(const api::TrackMotionJob& spec, const JobDocContext& ctx) {
  TrackJob job;
  tw::WalkSpec& walk = job.walk;
  walk.fl = footage_layer(ctx, spec.layer, Need::picture);
  job.kind = spec.kind;
  walk.direction = spec.direction;
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
    case api::TrackKind::planar:
      if (n < 4) fail(ErrorCode::invalid_argument, "a corner pin track needs four points (top left, top right, bottom right, bottom left)");
      break;
    case api::TrackKind::mask:
      break;
  }
  if (spec.stabilize && spec.kind != api::TrackKind::position) {
    fail(ErrorCode::invalid_argument, "stabilize tracks one point (kind position)");
  }
  walk.fps = walk.fl.compFps > 0 ? walk.fl.compFps : 30;
  walk.frames = tf::comp_frames_of(spec.range, walk.fps);
  if (walk.frames.last <= walk.frames.first) fail(ErrorCode::out_of_range, "the range covers one frame or less — nothing to track");
  const auto clampFrame = [&walk](std::int64_t f) { return std::clamp(f, walk.frames.first, walk.frames.last); };
  if (spec.origin) {
    walk.origin = clampFrame(static_cast<std::int64_t>(motion::js::round(seconds_of(*spec.origin) * walk.fps)));
  } else if (spec.direction == api::TrackDirection::forward) {
    walk.origin = walk.frames.first;
  } else if (spec.direction == api::TrackDirection::backward) {
    walk.origin = walk.frames.last;
  } else {
    walk.origin = clampFrame(static_cast<std::int64_t>(motion::js::round(seconds_of(ctx.time) * walk.fps)));
  }
  if (spec.direction == api::TrackDirection::forward && walk.origin >= walk.frames.last) {
    fail(ErrorCode::out_of_range, "nothing after the origin to track");
  }
  if (spec.direction == api::TrackDirection::backward && walk.origin <= walk.frames.first) {
    fail(ErrorCode::out_of_range, "nothing before the origin to track");
  }
  if (spec.min_confidence) walk.minConfidence = *spec.min_confidence;
  if (spec.max_coast_frames) walk.maxCoast = static_cast<int>(std::min<std::uint32_t>(*spec.max_coast_frames, 100000));
  if (spec.analysis_max_edge) job.maxEdge = *spec.analysis_max_edge;

  for (const api::TrackPointSpec& p : spec.points) {
    PointSpec s;
    s.p.x = p.feature.x;
    s.p.y = p.feature.y;
    s.p.featureHalf = half_of(std::max(p.feature.width, p.feature.height), kDefaultFeatureHalf);
    s.p.searchHalf = half_of(std::max(p.search.width, p.search.height), kDefaultSearchHalf);
    if (p.attach.x != 0 || p.attach.y != 0) {
      s.attachDx = p.attach.x - p.feature.x;
      s.attachDy = p.attach.y - p.feature.y;
    }
    job.points.push_back(s);
    walk.points.push_back(s.p);
  }

  if (spec.kind == api::TrackKind::mask) {
    MaskJob mj;
    mj.walk = walk;
    mj.maxEdge = job.maxEdge;
    std::string only;
    if (spec.apply_to) {
      if (spec.apply_to->layer != spec.layer) fail(ErrorCode::invalid_argument, "a mask track writes the tracked layer's own masks");
      const std::string& path = spec.apply_to->path;
      if (path.starts_with("masks/")) {
        const std::size_t slash = path.find('/', 6);
        only = path.substr(6, slash == std::string::npos ? std::string::npos : slash - 6);
      } else if (!path.empty() && path != "masks") {
        fail(ErrorCode::invalid_argument, "a mask track applies to 'masks' or 'masks/<id>'", {.layer = spec.layer, .path = path});
      }
    }
    mj.masks = masks_at(ctx, walk.fl, static_cast<double>(walk.origin) / walk.fps, only);
    if (const std::optional<ta::Geometry> g = ta::DocView(ctx.doc, walk.fl.comp).geometry(spec.layer)) {
      mj.boxW = g->width.value_or(walk.fl.width);
      mj.boxH = g->height.value_or(walk.fl.height);
    }
    return PreparedJob{"trackMotion", [mj = std::move(mj)](JobControl& control) { return run_mask_track(mj, control); }};
  }
  if (spec.kind == api::TrackKind::planar) {
    const std::uint32_t grid = std::clamp<std::uint32_t>(spec.planar_grid.value_or(5), 1, 16);
    walk.points = densify_quad(walk.points, static_cast<int>(grid));
  }

  // Where the result goes.
  if (spec.stabilize) {
    job.mode = Mode::stabilize;
    job.target = walk.fl.layer;
  } else if (spec.apply_to) {
    const api::PropRef& to = *spec.apply_to;
    const std::optional<std::string> comp = ctx.doc.node(to.layer) != nullptr ? doc::comp_of_layer(ctx.doc, to.layer) : std::nullopt;
    if (!comp || *comp == to.layer) fail(ErrorCode::not_found, "no layer '" + to.layer + "' to apply the track to", {.layer = to.layer});
    job.target = to.layer;
    job.targetCamera = ctx.doc.node(to.layer)->kind() == "camera";
    if (spec.kind == api::TrackKind::perspective_corner || spec.kind == api::TrackKind::planar) {
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
