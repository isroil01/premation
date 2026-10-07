// Job kind `stabilize` — Track Motion's Smooth Stabilize (trackerStore mode
// `smooth`, src/core/tracking/smoothStabilize.ts smoothStabilizeVideoLayer,
// variant `similarity`), writing applyTrack.ts planSmoothStabilize's keys.
//
// Work: one pass over the range's comp frames. Each frame's luma (the
// decoder's Y bytes when it has them — lumaFromDecodedFrame scale 1 — else the
// canvas route, Rec.601 0–255 of RGBA) is box-downsampled to ≤480 px, the flow
// between adjacent DISTINCT source frames votes one similarity (stabilize.hpp);
// comp frames showing the same source frame contribute an identity pair. The
// corrections are `stabilizingCorrections(pairs, max(1, smoothnessSec · fps))`.
//
//   smoothness   0…100 %, as seconds of Gaussian sigma / 100: 50 % = 0.5 s,
//                the TS default.
//   method       which of the solve's keys are written: `position` (x, y),
//                `positionRotation` (+ rotation), `positionRotationScale`
//                (+ scaleX, scaleY; the TS, and the default). The solve itself
//                is always the TS's similarity.
//
// Apply: position / rotation / scale keys on the stabilized layer itself (the
// corrected frame centre measured through the layer's ORIGINAL transform,
// parent-space deltas, rotation and scale composed onto the layer's own
// values), through track_apply.hpp's addKeyframes / deleteKeyframes splice.
//
// Framing (AE parity 3.6, the Warp Stabilizer's Framing): `stabilizeOnly`
// (default) leaves the moving borders; `stabilizeCrop` zooms every frame by
// the one factor the worst frame needs; `cropAutoScale` zooms each frame by
// what it needs, eased; both capped at `maxScale` (%, default 150) and written
// on top of the scale keys (st::framing_scales).
//
// Variants (smoothStabilize.ts `variant`):
//   similarity       the above (default).
//   subspace         the Warp Stabilizer's mesh path: per adjacent pair a 4×4
//                    grid of local similarities (subspaceWarp.ts
//                    fitSubspaceWarp, the SAME flow the similarity pass
//                    measured — the TS walks twice and gets these numbers),
//                    inverted as the correction, written as Mesh Warp lattice
//                    keys on the layer (planSubspaceMeshSequence; a Mesh Warp
//                    is added when it has none). The first frame is identity.
//   rolling-shutter  subspace with each cell's x nudged by half the readout
//                    shear the pair's flow shows (estimateRollingShutterShear).
//   `method` is not read by the mesh variants (the TS wrote the mesh only).
#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "media_input.hpp"
#include "stabilize.hpp"
#include "track_apply.hpp"
#include "track_frames.hpp"
#include "track_plans.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace st = stabilize;
namespace ta = trackapply;
namespace tf = trackframes;

namespace {

constexpr std::uint32_t kAnalysisEdge = 960;

enum class Method : std::uint8_t { position, positionRotation, positionRotationScale };
enum class Variant : std::uint8_t { similarity, subspace, rollingShutter };

struct StabJob {
  FootageLayer fl;
  tf::CompFrames frames;
  double fps = 30;
  double smoothnessSec = 0.5;
  Method method = Method::positionRotationScale;
  Variant variant = Variant::similarity;
  std::uint32_t maxEdge = kAnalysisEdge;
  st::Framing framing = st::Framing::stabilizeOnly;
  double maxScale = 1.5;
};

/// The mesh variants' path: one cell grid per comp frame, in flow-sample px.
struct MeshPath {
  std::vector<ta::MeshFrame> frames;
  double fieldW = 0;
  double fieldH = 0;
};

class StabilizeResult final : public JobResult {
 public:
  StabilizeResult(StabJob job, std::vector<st::Sim> corrections, std::size_t fitted, std::size_t pairs, double sw, double sh,
                  MeshPath mesh)
      : job_(std::move(job)), corr_(std::move(corrections)), fitted_(fitted), pairs_(pairs), sw_(sw), sh_(sh),
        mesh_(std::move(mesh)) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"fittedPairs\":" + std::to_string(fitted_) + ",\"totalPairs\":" + std::to_string(pairs_) +
                    ",\"sourceWidth\":" + json_number(sw_) + ",\"sourceHeight\":" + json_number(sh_) +
                    ",\"variant\":" + json_string(variant_name()) +
                    (mesh() ? ",\"keyframes\":" + std::to_string(mesh_.frames.size() * 32) : std::string()) +
                    ",\"frame\":[\"t\",\"a\",\"b\",\"tx\",\"ty\"],\"corrections\":[";
    for (std::size_t i = 0; i < corr_.size(); ++i) {
      const st::Sim& c = corr_[i];
      if (i > 0) s += ',';
      const double t = static_cast<double>(job_.frames.first + static_cast<std::int64_t>(i)) / job_.fps;
      s += '[' + tf::fixed(t, 6) + ',' + tf::fixed(c.a, 8) + ',' + tf::fixed(c.b, 8) + ',' + tf::fixed(c.tx, 4) + ',' +
           tf::fixed(c.ty, 4) + ']';
    }
    return s + "]}";
  }

  [[nodiscard]] std::string label() const override { return mesh() ? "Apply Subspace Mesh Path" : "Smooth Stabilize"; }
  [[nodiscard]] bool has_edits() const override { return mesh() ? !mesh_.frames.empty() : !corr_.empty(); }

  /// applyTrack.ts planSmoothStabilize (keys filtered by `method`), or planSubspaceMeshSequence.
  void apply(JobApply& a) const override {
    const std::string& video = job_.fl.layer;
    if (mesh()) {
      const std::optional<ta::Plan> plan =
          ta::plan_subspace_mesh(video, mesh_.frames, 4, 4, mesh_.fieldW, mesh_.fieldH, sw_, sh_);
      if (plan) ta::send_plan(a, *plan);
      return;
    }
    const ta::DocView v(a.document(), job_.fl.comp);
    if (v.node(video) == nullptr || corr_.empty()) return;
    const std::optional<ta::Geometry> g = v.geometry(video);
    if (!g) return;
    const std::optional<std::string> parent = v.parent_of(video);
    const double cx = sw_ / 2;
    const double cy = sh_ / 2;
    const ta::P2 box{job_.fl.width > 0 ? static_cast<double>(job_.fl.width) : sw_,
                     job_.fl.height > 0 ? static_cast<double>(job_.fl.height) : sh_};
    const bool rot = job_.method != Method::position;
    const bool scale = job_.method == Method::positionRotationScale;
    // Framing: the zoom that hides the moving borders (AE parity 3.6),
    // measured on the correction as it is applied.
    std::vector<st::Sim> applied;
    applied.reserve(corr_.size());
    for (const st::Sim& c : corr_) applied.push_back(st::applied_correction(c, cx, cy, rot, scale));
    const std::vector<double> zoom =
        st::framing_scales(applied, sw_, sh_, job_.framing, job_.maxScale, std::max(1.0, job_.smoothnessSec * job_.fps));
    const bool framed = job_.framing != st::Framing::stabilizeOnly;
    ta::Buckets bk({"x", "y", "rotation", "scaleX", "scaleY"});
    std::size_t n = 0;
    double prevRotDelta = 0;
    for (std::size_t i = 0; i < corr_.size(); ++i) {
      const st::Sim& corr = corr_[i];
      const double compTime = static_cast<double>(job_.frames.first + static_cast<std::int64_t>(i)) / job_.fps;
      const st::XY w = st::apply_sim(corr, cx, cy);
      const std::optional<ta::P2> from = v.sample_to_comp(video, cx, cy, compTime, sw_, sh_, box);
      const std::optional<ta::P2> to = v.sample_to_comp(video, w.x, w.y, compTime, sw_, sh_, box);
      if (!from || !to) continue;
      double dx = to->x - from->x;
      double dy = to->y - from->y;
      if (parent) {
        const std::optional<doc::LayerSpace> ps = v.space(*parent, compTime);
        if (!ps) continue;
        const ta::P2 pa = ta::DocView::from_comp(*ps, *to);
        const ta::P2 pb = ta::DocView::from_comp(*ps, *from);
        dx = pa.x - pb.x;
        dy = pa.y - pb.y;
      }
      const double rotDelta = ta::unwrap_deg((st::sim_rotation(corr) * 180) / 3.141592653589793, prevRotDelta);
      prevRotDelta = rotDelta;
      const double k = st::sim_scale(corr);
      const double t = v.key_time(video, compTime);
      bk.add("x", compTime, v.sample(video, "x", t).value_or(g->local.x) + dx);
      bk.add("y", compTime, v.sample(video, "y", t).value_or(g->local.y) + dy);
      if (rot) bk.add("rotation", compTime, v.sample(video, "rotation", t).value_or(g->local.rotation) + rotDelta);
      if (scale || framed) {
        const double z = (scale ? k : 1.0) * zoom[i];
        bk.add("scaleX", compTime, v.sample(video, "scaleX", t).value_or(g->local.scale_x) * z);
        bk.add("scaleY", compTime, v.sample(video, "scaleY", t).value_or(g->local.scale_y) * z);
      }
      ++n;
    }
    if (n == 0) return;
    ta::send_plan(a, ta::Plan{"Smooth Stabilize", video, bk.writes(), {}, {}, n});
  }

 private:
  [[nodiscard]] bool mesh() const noexcept { return job_.variant != Variant::similarity; }
  [[nodiscard]] std::string variant_name() const {
    return job_.variant == Variant::subspace ? "subspace" : job_.variant == Variant::rollingShutter ? "rolling-shutter" : "similarity";
  }

  StabJob job_;
  std::vector<st::Sim> corr_;
  std::size_t fitted_;
  std::size_t pairs_;
  double sw_;
  double sh_;
  MeshPath mesh_;
};

/// One pair's mesh cells (smoothStabilize.ts's second walk): the local grid,
/// the rolling-shutter nudge, inverted as the correction.
std::vector<ta::SubspaceCell> mesh_cells(const scene::pixmo::FlowField& flow, double scaleX, double scaleY, double fieldH0,
                                         bool rollingShutter) {
  std::vector<st::Cell> cells = st::fit_subspace_warp(flow, 4, 4, scaleX, scaleY);
  if (rollingShutter) {
    const double k = st::estimate_rolling_shutter_shear(flow, scaleX, scaleY);
    const double cy = fieldH0 / 2;
    for (st::Cell& c : cells) {
      const st::XY r = st::apply_rolling_shutter_repair(c.cx, c.cy, cy, -k);
      c.sim.tx = c.sim.tx + (r.x - c.cx) * 0.5;
    }
  }
  std::vector<ta::SubspaceCell> out;
  out.reserve(cells.size());
  // Invert local motion ≈ the stabilizing correction (the similarity path's idea).
  for (const st::Cell& c : cells) out.push_back(ta::SubspaceCell{c.cx, c.cy, st::Sim{c.sim.a, -c.sim.b, -c.sim.tx, -c.sim.ty}});
  return out;
}

/// Reads the stabilizer's luma: Y bytes when the decoder has them, else the canvas route over RGBA.
class StabLuma {
 public:
  explicit StabLuma(FrameSource& src) : src_(src) {}
  st::FloatLuma read(std::int64_t i) {
    std::string error;
    if (useRgba_) return from_rgba(i);
    LumaImage li;
    if (!src_.read_luma(i, li, error)) fail(ErrorCode::decode, "could not decode frame " + std::to_string(i) + ": " + error);
    if (!li.bytes) {
      // Not planar YUV: the TS's canvas route (0–255 from RGBA) — for this and every later frame.
      useRgba_ = true;
      return from_rgba(i);
    }
    return st::FloatLuma{static_cast<int>(li.width), static_cast<int>(li.height), std::move(li.data)};
  }

 private:
  st::FloatLuma from_rgba(std::int64_t i) {
    std::string error;
    RgbaImage img;
    if (!src_.read(i, img, error)) fail(ErrorCode::decode, "could not decode frame " + std::to_string(i) + ": " + error);
    return st::luma_255_of(img.rgba, static_cast<int>(img.width), static_cast<int>(img.height));
  }

  FrameSource& src_;
  bool useRgba_ = false;
};

std::unique_ptr<JobResult> run_stabilize(const StabJob& job, JobControl& control) {
  std::string error;
  const std::unique_ptr<FrameSource> src = open_frames(job.fl.file, job.maxEdge, error);
  if (!src) fail(ErrorCode::decode, "could not read the footage: " + error, {.layer = job.fl.layer});
  const int w = static_cast<int>(src->width());
  const int h = static_cast<int>(src->height());
  if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = job.fl.layer});
  const double sw = src->source_width() > 0 ? src->source_width() : w;
  const double sh = src->source_height() > 0 ? src->source_height() : h;
  const int factor = st::flow_factor(w, h);
  // Flow-grid px → source display px.
  const double scaleX = (factor * sw) / w;
  const double scaleY = (factor * sh) / h;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const double srcFps = src->fps();
  auto srcIndexAt = [&](std::int64_t f) { return tf::source_index(job.fl, f, job.fps, srcFps, count); };

  StabLuma luma(*src);
  auto lumaAt = [&](std::int64_t idx) { return st::downsample_luma(luma.read(idx), factor); };

  const std::int64_t frames = job.frames.last - job.frames.first + 1;
  std::vector<std::optional<st::Sim>> pairs;
  std::size_t fitted = 0;
  std::int64_t prevIdx = srcIndexAt(job.frames.first);
  st::FloatLuma prev = lumaAt(prevIdx);
  const bool meshed = job.variant != Variant::similarity;
  const bool rs = job.variant == Variant::rollingShutter;
  MeshPath mesh;
  // A repeated source frame: the flow of a frame against itself (the TS second
  // walk computes it for every such pair), cached per frame.
  std::optional<std::vector<ta::SubspaceCell>> stillCells;
  if (meshed) {
    mesh.fieldW = prev.w * scaleX;
    mesh.fieldH = prev.h * scaleY;
    std::vector<ta::SubspaceCell> first;
    for (const st::Cell& c : st::fit_subspace_warp(st::compute_flow_f32(prev, prev), 4, 4, scaleX, scaleY)) {
      first.push_back(ta::SubspaceCell{c.cx, c.cy, st::Sim{}});
    }
    mesh.frames.push_back(ta::MeshFrame{std::move(first), static_cast<double>(job.frames.first) / job.fps});
  }
  for (std::int64_t i = 1; i < frames; ++i) {
    if (control.cancelled()) return nullptr;
    const std::int64_t idx = srcIndexAt(job.frames.first + i);
    const double compTime = static_cast<double>(job.frames.first + i) / job.fps;
    if (idx == prevIdx) {
      pairs.emplace_back(st::Sim{});
      ++fitted;
      if (meshed) {
        if (!stillCells) stillCells = mesh_cells(st::compute_flow_f32(prev, prev), scaleX, scaleY, mesh.fieldH, rs);
        mesh.frames.push_back(ta::MeshFrame{*stillCells, compTime});
      }
    } else {
      st::FloatLuma cur = lumaAt(idx);
      const scene::pixmo::FlowField flow = st::compute_flow_f32(prev, cur);
      const std::optional<st::Sim> fit = st::fit_similarity(st::flow_sample_points(flow, scaleX, scaleY));
      pairs.push_back(fit);
      if (fit) ++fitted;
      if (meshed) mesh.frames.push_back(ta::MeshFrame{mesh_cells(flow, scaleX, scaleY, mesh.fieldH, rs), compTime});
      stillCells.reset();
      prev = std::move(cur);
      prevIdx = idx;
    }
    control.progress(static_cast<double>(i) / static_cast<double>(frames - 1),
                     "Tracking frame " + std::to_string(i) + " of " + std::to_string(frames - 1));
  }
  if (control.cancelled()) return nullptr;
  const double sigmaFrames = std::max(1.0, job.smoothnessSec * job.fps);
  std::vector<st::Sim> corrections = st::stabilizing_corrections(pairs, sigmaFrames);
  return std::make_unique<StabilizeResult>(job, std::move(corrections), fitted, pairs.size(), sw, sh, std::move(mesh));
}

}  // namespace

PreparedJob prepare_stabilize(const api::StabilizeJob& spec, const JobDocContext& ctx) {
  StabJob job;
  job.fl = footage_layer(ctx, spec.layer, Need::picture);
  if (spec.method.empty() || spec.method == "positionRotationScale") {
    job.method = Method::positionRotationScale;
  } else if (spec.method == "positionRotation") {
    job.method = Method::positionRotation;
  } else if (spec.method == "position") {
    job.method = Method::position;
  } else {
    fail(ErrorCode::invalid_argument, "method must be 'position', 'positionRotation' or 'positionRotationScale'");
  }
  const std::string variant = spec.variant.value_or("similarity");
  if (variant.empty() || variant == "similarity") {
    job.variant = Variant::similarity;
  } else if (variant == "subspace") {
    job.variant = Variant::subspace;
  } else if (variant == "rolling-shutter" || variant == "rollingShutter") {
    job.variant = Variant::rollingShutter;
  } else {
    fail(ErrorCode::invalid_argument, "variant must be 'similarity', 'subspace' or 'rolling-shutter'");
  }
  if (!std::isfinite(spec.smoothness) || spec.smoothness < 0) fail(ErrorCode::out_of_range, "smoothness must be 0…100 %");
  job.smoothnessSec = std::min(spec.smoothness, 100.0) / 100;
  job.fps = job.fl.compFps > 0 ? job.fl.compFps : 30;
  job.frames = tf::comp_frames_of(spec.range, job.fps);
  if (job.frames.last <= job.frames.first) fail(ErrorCode::out_of_range, "the range covers one frame or less — nothing to stabilize");
  if (spec.analysis_max_edge) job.maxEdge = *spec.analysis_max_edge;
  switch (spec.framing.value_or(api::StabilizeFraming::stabilize_only)) {
    case api::StabilizeFraming::stabilize_only: job.framing = st::Framing::stabilizeOnly; break;
    case api::StabilizeFraming::stabilize_crop: job.framing = st::Framing::stabilizeCrop; break;
    case api::StabilizeFraming::crop_auto_scale: job.framing = st::Framing::cropAutoScale; break;
  }
  if (spec.max_scale) {
    if (!std::isfinite(*spec.max_scale) || *spec.max_scale < 100) fail(ErrorCode::out_of_range, "maxScale must be ≥ 100 %");
    job.maxScale = *spec.max_scale / 100;
  }
  if (job.framing != st::Framing::stabilizeOnly && job.variant != Variant::similarity) {
    fail(ErrorCode::invalid_argument, "framing applies to the similarity variant (the mesh variants keep the frame)");
  }
  return PreparedJob{"stabilize", [job = std::move(job)](JobControl& control) { return run_stabilize(job, control); }};
}

}  // namespace premation::jobs
