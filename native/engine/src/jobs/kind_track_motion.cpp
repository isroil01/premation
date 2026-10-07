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
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "fxstate.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "mask_fit.hpp"
#include "mask_sampling.hpp"
#include "media_input.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "track_plans.hpp"
#include "planar_track.hpp"
#include "track_feature.hpp"
#include "track_walk.hpp"
#include "tracking.hpp"

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

enum class Mode : std::uint8_t { none, follow, transform, corner, stabilize, effectPoint };

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
  std::string effectId;  ///< corner: the Corner Pin named by applyTo ('' = first / added); effectPoint: the effect
  std::string effectType;  ///< effectPoint
  std::string param;       ///< effectPoint: the point param's base name (`center` → centerX / centerY)
  bool targetCamera = false;
  /// AE parity 3.6: pick the feature (and a companion) at the origin frame.
  bool autoFeature = false;
  /// The hint's search radius (source display px); 0 = the default.
  double autoRadius = 0;
  /// Kind planarRegion (AE parity 3.4).
  bool planarRegion = false;
  std::array<ta::P2, 4> region{};
  std::array<ta::P2, 4> surface{};
  /// Exclusion outlines per comp frame, layer px from the layer's centre.
  std::map<std::int64_t, std::vector<std::vector<ta::P2>>> exclude;
  /// The layer's drawn box the mask coordinates scale from.
  double boxW = 0;
  double boxH = 0;
};

/// A mask path (BezierPath, tangents relative) as a closed polyline, 8 samples a segment.
std::vector<ta::P2> flatten(const api::BezierPath& b) {
  std::vector<ta::P2> out;
  const std::size_t n = b.vertices.size() / 2;
  if (n < 2) return out;
  auto v = [&](std::size_t i) { return ta::P2{b.vertices[2 * i], b.vertices[2 * i + 1]}; };
  auto tin = [&](std::size_t i) { return i * 2 + 1 < b.in_tangents.size() ? ta::P2{b.in_tangents[2 * i], b.in_tangents[2 * i + 1]} : ta::P2{0, 0}; };
  auto tout = [&](std::size_t i) { return i * 2 + 1 < b.out_tangents.size() ? ta::P2{b.out_tangents[2 * i], b.out_tangents[2 * i + 1]} : ta::P2{0, 0}; };
  for (std::size_t i = 0; i < n; ++i) {
    const std::size_t j = (i + 1) % n;
    const ta::P2 a = v(i);
    const ta::P2 d = v(j);
    const ta::P2 bb{a.x + tout(i).x, a.y + tout(i).y};
    const ta::P2 c{d.x + tin(j).x, d.y + tin(j).y};
    for (int k = 0; k < 8; ++k) {
      const double t = k / 8.0;
      const double u = 1 - t;
      out.push_back(ta::P2{u * u * u * a.x + 3 * u * u * t * bb.x + 3 * u * t * t * c.x + t * t * t * d.x,
                           u * u * u * a.y + 3 * u * u * t * bb.y + 3 * u * t * t * c.y + t * t * t * d.y});
    }
  }
  return out;
}

/// What autoFeature measured, in source display px.
struct AutoPlan {
  double x = 0;
  double y = 0;
  double featureHalf = 0;
  double searchHalf = 0;
  std::optional<double> motionPerFrame;
  double strength = 0;
  double distinctness = 0;
  std::optional<std::pair<double, double>> companion;
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
  TrackMotionResult(TrackJob job, tw::WalkResult r, std::optional<AutoPlan> plan = std::nullopt)
      : job_(std::move(job)), r_(std::move(r)), plan_(std::move(plan)) {}

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
    s += ']';
    if (plan_) {
      s += ",\"plan\":{\"x\":" + tf::fixed(plan_->x, 3) + ",\"y\":" + tf::fixed(plan_->y, 3) +
           ",\"featureHalf\":" + tf::fixed(plan_->featureHalf, 2) + ",\"searchHalf\":" + tf::fixed(plan_->searchHalf, 2) +
           ",\"motionPerFrame\":" + (plan_->motionPerFrame ? tf::fixed(*plan_->motionPerFrame, 3) : std::string("null")) +
           ",\"strength\":" + json_number(plan_->strength) + ",\"distinctness\":" + tf::fixed(plan_->distinctness, 4) +
           ",\"companion\":" +
           (plan_->companion ? "{\"x\":" + tf::fixed(plan_->companion->first, 3) + ",\"y\":" + tf::fixed(plan_->companion->second, 3) + "}"
                             : std::string("null")) +
           "}";
    }
    return s + "}";
  }

  [[nodiscard]] std::string label() const override {
    switch (job_.mode) {
      case Mode::stabilize: return job_.kind == api::TrackKind::position ? "Stabilize Motion" : "Stabilize Motion (rotation & scale)";
      case Mode::effectPoint: return "Apply Motion Track to Effect Point";
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
      case Mode::stabilize:
        plan = job_.kind == api::TrackKind::position
                   ? planner.stabilize(tracks[0])
                   : planner.stabilize_transform(tracks, job_.kind == api::TrackKind::position_rotation_scale);
        break;
      case Mode::effectPoint: plan = planner.effect_point(job_.target, job_.effectId, job_.effectType, job_.param, tracks[0]); break;
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
  std::optional<AutoPlan> plan_;
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
  /// AE parity 5.4: per-vertex, or the whole mask by one fitted transform per frame.
  maskfit::Method method = maskfit::Method::vertices;
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
    std::vector<api::BezierPath> paths;
    for (const MaskShape& m : job.masks) paths.push_back(m.path);
    if (job.method != maskfit::Method::vertices) {
      // AE parity 5.4: the whole mask by one transform fitted to every tracked
      // point (display px), applied to the shape in display px and back.
      std::vector<tracking::Pt> src;
      std::vector<tracking::Pt> dst;
      for (std::size_t k = 0; k < rest.size(); ++k) {
        src.push_back(tracking::Pt{rest[k].x, rest[k].y});
        dst.push_back(tracking::Pt{slotAt[k].x, slotAt[k].y});
      }
      const auto toDisplay = [&](api::BezierPath& path, bool forward) {
        const double kx = forward ? sw / gw : gw / sw;
        const double ky = forward ? sh / gh : gh / sh;
        for (std::size_t i = 0; i + 1 < path.vertices.size(); i += 2) {
          path.vertices[i] = forward ? (path.vertices[i] / gw + 0.5) * sw : (path.vertices[i] / sw - 0.5) * gw;
          path.vertices[i + 1] = forward ? (path.vertices[i + 1] / gh + 0.5) * sh : (path.vertices[i + 1] / sh - 0.5) * gh;
        }
        for (std::vector<double>* tan : {&path.in_tangents, &path.out_tangents}) {
          for (std::size_t i = 0; i + 1 < tan->size(); i += 2) {
            (*tan)[i] *= kx;
            (*tan)[i + 1] *= ky;
          }
        }
      };
      std::optional<maskfit::Affine> aff;
      std::optional<tracking::Mat3> hom;
      if (job.method == maskfit::Method::perspective) {
        if (src.size() >= 4) hom = tracking::fit_homography(src, dst);
        if (!hom) aff = maskfit::fit_affine(src, dst, src.size() >= 3 ? maskfit::Method::affine : maskfit::Method::position);
      } else {
        aff = maskfit::fit_affine(src, dst, job.method);
        if (!aff) aff = maskfit::fit_affine(src, dst, maskfit::Method::position);
      }
      for (api::BezierPath& path : paths) {
        toDisplay(path, true);
        if (hom) maskfit::transform_path(path, *hom);
        else if (aff) maskfit::transform_path(path, *aff);
        toDisplay(path, false);
      }
      for (std::size_t p = 0; p < paths.size(); ++p) keys[p].keys.push_back(ta::PathKey{compTime, std::move(paths[p])});
      continue;
    }
    // The base shape, each vertex displaced by its tracked delta (the handles
    // are relative in a BezierPath: they travel rigidly with their vertex).
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

/// autoFeature (autoTrack.ts planTrack): the feature, its windows and a
/// companion, measured on the origin frame and the two after it (before it
/// for a backward walk), in analysis px, answered in source display px.
AutoPlan plan_auto_feature(FrameSource& src, const TrackJob& job) {
  const tw::WalkSpec& w = job.walk;
  const double sw = src.source_width() > 0 ? src.source_width() : src.width();
  const double scale = sw > 0 ? static_cast<double>(src.width()) / sw : 1.0;  // display px → analysis px
  const std::int64_t count = std::max<std::int64_t>(1, src.frame_count());
  std::string error;
  auto plane_at = [&](std::int64_t compFrame) {
    RgbaImage img;
    const std::int64_t idx = tf::source_index(w.fl, compFrame, w.fps, src.fps(), count);
    if (!src.read(idx, img, error)) fail(ErrorCode::decode, "could not decode frame " + std::to_string(idx) + ": " + error, {.layer = w.fl.layer});
    return tracking::luma_from_rgba(img.rgba, static_cast<int>(img.width), static_cast<int>(img.height));
  };
  const tracking::LumaPlane anchor = plane_at(w.origin);
  const std::int64_t step = w.direction == api::TrackDirection::backward ? -1 : 1;
  std::vector<tracking::LumaPlane> probes;
  for (std::int64_t k = 1; k <= 2; ++k) {
    const std::int64_t f = w.origin + step * k;
    if (f < w.frames.first || f > w.frames.last) break;
    probes.push_back(plane_at(f));
  }
  feature::PickOptions opts;
  if (!w.points.empty()) opts.hint = tracking::Pt{w.points.front().x * scale, w.points.front().y * scale};
  if (job.autoRadius > 0) opts.radius = job.autoRadius * scale;
  const std::optional<feature::Plan> plan = feature::plan_track(anchor, probes, opts);
  if (!plan) {
    fail(ErrorCode::invalid_argument, "Nothing trackable here — the area is flat or only an edge. Click a corner or a detail.",
         {.layer = w.fl.layer});
  }
  AutoPlan out;
  out.x = plan->x / scale;
  out.y = plan->y / scale;
  out.featureHalf = plan->featureHalf / scale;
  out.searchHalf = plan->searchHalf / scale;
  if (plan->motionPerFrame) out.motionPerFrame = *plan->motionPerFrame / scale;
  out.strength = plan->feature.strength;
  out.distinctness = plan->feature.distinctness;
  if (plan->companion) out.companion = std::pair{plan->companion->x / scale, plan->companion->y / scale};
  return out;
}

std::unique_ptr<JobResult> run_track(const TrackJob& job0, JobControl& control) {
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(job0.walk.fl.file, job0.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = job0.walk.fl.layer});
  TrackJob job = job0;
  std::optional<AutoPlan> plan;
  if (job.autoFeature) {
    control.progress(0, "Choosing a feature");
    plan = plan_auto_feature(*src, job);
    tw::WalkPoint p;
    p.x = plan->x;
    p.y = plan->y;
    p.featureHalf = std::round(plan->featureHalf);
    p.searchHalf = std::round(plan->searchHalf);
    job.walk.points.assign(1, p);
    job.points.assign(1, PointSpec{p, 0, 0});
    if (plan->companion) {
      tw::WalkPoint q = p;
      q.x = plan->companion->first;
      q.y = plan->companion->second;
      job.walk.points.push_back(q);
      job.points.push_back(PointSpec{q, 0, 0});
    }
    // A rotation / scale apply needs the companion.
    if ((job.mode == Mode::transform || (job.mode == Mode::stabilize && job.kind != api::TrackKind::position)) &&
        job.walk.points.size() < 2) {
      fail(ErrorCode::invalid_argument, "No second feature near the first — rotation and scale need two. Track position only, or place two points.",
           {.layer = job.walk.fl.layer});
    }
  }
  std::optional<tw::WalkResult> r;
  if (job.planarRegion) {
    const double sw = src->source_width() > 0 ? src->source_width() : src->width();
    const double sh = src->source_height() > 0 ? src->source_height() : src->height();
    const double gw = job.boxW > 0 ? job.boxW : sw;
    const double gh = job.boxH > 0 ? job.boxH : sh;
    tw::PlanarWalk pw;
    for (std::size_t c = 0; c < 4; ++c) {
      pw.region[c] = tracking::Pt{job.region[c].x, job.region[c].y};
      pw.surface[c] = tracking::Pt{job.surface[c].x, job.surface[c].y};
    }
    pw.featureHalf = job.walk.points.empty() ? 7 : std::min(job.walk.points.front().featureHalf, 12.0);
    pw.searchHalf = job.walk.points.empty() ? 20 : job.walk.points.front().searchHalf;
    pw.excludeAt = [&job, sw, sh, gw, gh](std::int64_t compFrame) {
      planar::Polys out;
      const auto it = job.exclude.find(compFrame);
      if (it == job.exclude.end()) return out;
      for (const std::vector<ta::P2>& poly : it->second) {
        planar::Poly p;
        for (const ta::P2& q : poly) p.push_back(tracking::Pt{(q.x / gw + 0.5) * sw, (q.y / gh + 0.5) * sh});
        out.push_back(std::move(p));
      }
      return out;
    };
    r = tw::walk_planar(*src, job.walk, pw, control);
  } else {
    r = tw::walk(*src, job.walk, control);
  }
  if (!r) return nullptr;
  control.progress(1.0, job.planarRegion ? std::string("Tracked the plane")
                                         : "Tracked " + std::to_string(r->tracks.size()) + (r->tracks.size() == 1 ? " point" : " points"));
  return std::make_unique<TrackMotionResult>(job, std::move(*r), std::move(plan));
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
      if (n < 1 && !spec.auto_feature.value_or(false)) fail(ErrorCode::invalid_argument, "a position track needs a point");
      break;
    case api::TrackKind::position_rotation:
    case api::TrackKind::position_rotation_scale:
      if (n != 2 && !spec.auto_feature.value_or(false)) fail(ErrorCode::invalid_argument, "a rotation / scale track needs exactly two points (anchor, reference)");
      break;
    case api::TrackKind::perspective_corner:
    case api::TrackKind::planar:
    case api::TrackKind::planar_region:
      if (n < 4) fail(ErrorCode::invalid_argument, "a corner pin track needs four points (top left, top right, bottom right, bottom left)");
      break;
    case api::TrackKind::mask:
      break;
  }
  if (spec.stabilize && spec.kind != api::TrackKind::position && spec.kind != api::TrackKind::position_rotation &&
      spec.kind != api::TrackKind::position_rotation_scale) {
    fail(ErrorCode::invalid_argument, "stabilize tracks one point (position) or two (rotation / scale)");
  }
  job.autoFeature = spec.auto_feature.value_or(false);
  if (job.autoFeature && (spec.kind == api::TrackKind::mask || spec.kind == api::TrackKind::perspective_corner ||
                          spec.kind == api::TrackKind::planar || spec.kind == api::TrackKind::planar_region)) {
    fail(ErrorCode::invalid_argument, "autoFeature picks one feature and a companion: kinds position, positionRotation, positionRotationScale");
  }
  if (job.autoFeature && !spec.points.empty()) {
    const api::Rect& f = spec.points.front().feature;
    if (f.width > 1 || f.height > 1) job.autoRadius = std::max(f.width, f.height) / 2;
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
    mj.method = maskfit::method_of(spec.mask_method.value_or(api::MaskTrackMethod::vertices));
    if (const std::optional<ta::Geometry> g = ta::DocView(ctx.doc, walk.fl.comp).geometry(spec.layer)) {
      mj.boxW = g->width.value_or(walk.fl.width);
      mj.boxH = g->height.value_or(walk.fl.height);
    }
    return PreparedJob{"trackMotion", [mj = std::move(mj)](JobControl& control) { return run_mask_track(mj, control); }};
  }
  if (spec.kind == api::TrackKind::planar_region) {
    job.planarRegion = true;
    for (std::size_t c = 0; c < 4; ++c) {
      job.region[c] = ta::P2{spec.points[c].feature.x, spec.points[c].feature.y};
      job.surface[c] = n >= 8 ? ta::P2{spec.points[4 + c].feature.x, spec.points[4 + c].feature.y} : job.region[c];
    }
    // The apply follows the four surface corners (no attach offsets).
    job.points.assign(4, PointSpec{});
    // Exclusion masks, as they stand at each comp frame of the range.
    if (!spec.exclude_masks.empty()) {
      const doc::Node* node = ctx.doc.node(spec.layer);
      const ta::DocView v(ctx.doc, walk.fl.comp);
      const std::vector<doc::Json> anim = doc::read_node_mask_anim(*node);
      const std::optional<doc::Json> rest = doc::read_node_mask(*node);
      for (std::int64_t f = walk.frames.first; f <= walk.frames.last; ++f) {
        std::optional<doc::Json> m = doc::interpolate_mask(anim, v.key_time(spec.layer, static_cast<double>(f) / walk.fps));
        if (!m || !m->at("paths").is_array()) m = rest;
        if (!m || !m->at("paths").is_array()) continue;
        std::vector<std::vector<ta::P2>> polys;
        for (const doc::Json& path : m->at("paths").arr()) {
          const std::string id = path.at("id").is_string() ? path.at("id").str() : std::string();
          if (std::find(spec.exclude_masks.begin(), spec.exclude_masks.end(), id) == spec.exclude_masks.end()) continue;
          std::vector<ta::P2> poly = flatten(doc::mask_to_bezier(path));
          if (poly.size() >= 3) polys.push_back(std::move(poly));
        }
        if (!polys.empty()) job.exclude.emplace(f, std::move(polys));
      }
      if (job.exclude.empty()) fail(ErrorCode::not_found, "none of the exclusion masks is on the layer", {.layer = spec.layer});
    }
    if (const std::optional<ta::Geometry> g = ta::DocView(ctx.doc, walk.fl.comp).geometry(spec.layer)) {
      job.boxW = g->width.value_or(walk.fl.width);
      job.boxH = g->height.value_or(walk.fl.height);
    }
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
    if (spec.kind == api::TrackKind::perspective_corner || spec.kind == api::TrackKind::planar ||
        spec.kind == api::TrackKind::planar_region) {
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
    } else if (to.path.starts_with("effects/") && std::count(to.path.begin(), to.path.end(), '/') == 2) {
      // An effect point (AE parity 3.6): effects/<id>/<param>.
      if (spec.kind != api::TrackKind::position) {
        fail(ErrorCode::invalid_argument, "an effect point takes a position track", {.layer = to.layer, .path = to.path});
      }
      const std::string rest = to.path.substr(8);
      job.effectId = rest.substr(0, rest.find('/'));
      job.param = rest.substr(rest.find('/') + 1);
      const ta::DocView v(ctx.doc, *comp);
      job.effectType = v.effect_type(to.layer, job.effectId);
      if (job.effectType.empty()) fail(ErrorCode::not_found, "no effect '" + job.effectId + "' on the layer", {.layer = to.layer, .path = to.path});
      const doc::Catalog cat = doc::catalog_for(ctx.doc, to.layer);
      const std::string base = "effect." + job.effectId + "." + job.param;
      if (cat.by_member(base + "X") == nullptr || cat.by_member(base + "Y") == nullptr) {
        fail(ErrorCode::invalid_argument, "'" + job.param + "' is not a point of " + job.effectType + " (it needs " + job.param + "X and " +
                                              job.param + "Y)",
             {.layer = to.layer, .path = to.path});
      }
      job.mode = Mode::effectPoint;
    } else {
      if (!to.path.empty() && to.path != "transform" && to.path != "transform/position") {
        fail(ErrorCode::invalid_argument, "a position / rotation / scale track applies to 'transform', 'transform/position' or an effect point 'effects/<id>/<param>'",
             {.layer = to.layer, .path = to.path});
      }
      job.mode = spec.kind == api::TrackKind::position ? Mode::follow : Mode::transform;
    }
  }
  return PreparedJob{"trackMotion", [job = std::move(job)](JobControl& control) { return run_track(job, control); }};
}

}  // namespace premation::jobs
