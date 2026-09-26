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
// Not ported: the `subspace` and `rolling-shutter` variants (Mesh Warp keys
// from subspaceWarp.ts) — StabilizeJob has no field to ask for them.
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

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace st = stabilize;
namespace ta = trackapply;
namespace tf = trackframes;

namespace {

constexpr std::uint32_t kAnalysisEdge = 960;

enum class Method : std::uint8_t { position, positionRotation, positionRotationScale };

struct StabJob {
  FootageLayer fl;
  tf::CompFrames frames;
  double fps = 30;
  double smoothnessSec = 0.5;
  Method method = Method::positionRotationScale;
  std::uint32_t maxEdge = kAnalysisEdge;
};

class StabilizeResult final : public JobResult {
 public:
  StabilizeResult(StabJob job, std::vector<st::Sim> corrections, std::size_t fitted, std::size_t pairs, double sw, double sh)
      : job_(std::move(job)), corr_(std::move(corrections)), fitted_(fitted), pairs_(pairs), sw_(sw), sh_(sh) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"fittedPairs\":" + std::to_string(fitted_) + ",\"totalPairs\":" + std::to_string(pairs_) +
                    ",\"sourceWidth\":" + json_number(sw_) + ",\"sourceHeight\":" + json_number(sh_) +
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

  [[nodiscard]] std::string label() const override { return "Smooth Stabilize"; }
  [[nodiscard]] bool has_edits() const override { return !corr_.empty(); }

  /// applyTrack.ts planSmoothStabilize (keys filtered by `method`).
  void apply(JobApply& a) const override {
    const std::string& video = job_.fl.layer;
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
      if (scale) {
        bk.add("scaleX", compTime, v.sample(video, "scaleX", t).value_or(g->local.scale_x) * k);
        bk.add("scaleY", compTime, v.sample(video, "scaleY", t).value_or(g->local.scale_y) * k);
      }
      ++n;
    }
    if (n == 0) return;
    ta::send_plan(a, ta::Plan{"Smooth Stabilize", video, bk.writes(), {}, {}, n});
  }

 private:
  StabJob job_;
  std::vector<st::Sim> corr_;
  std::size_t fitted_;
  std::size_t pairs_;
  double sw_;
  double sh_;
};

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
  for (std::int64_t i = 1; i < frames; ++i) {
    if (control.cancelled()) return nullptr;
    const std::int64_t idx = srcIndexAt(job.frames.first + i);
    if (idx == prevIdx) {
      pairs.emplace_back(st::Sim{});
      ++fitted;
    } else {
      st::FloatLuma cur = lumaAt(idx);
      const std::optional<st::Sim> fit = st::pair_motion(prev, cur, scaleX, scaleY);
      pairs.push_back(fit);
      if (fit) ++fitted;
      prev = std::move(cur);
      prevIdx = idx;
    }
    control.progress(static_cast<double>(i) / static_cast<double>(frames - 1),
                     "Tracking frame " + std::to_string(i) + " of " + std::to_string(frames - 1));
  }
  if (control.cancelled()) return nullptr;
  const double sigmaFrames = std::max(1.0, job.smoothnessSec * job.fps);
  std::vector<st::Sim> corrections = st::stabilizing_corrections(pairs, sigmaFrames);
  return std::make_unique<StabilizeResult>(job, std::move(corrections), fitted, pairs.size(), sw, sh);
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
  if (!std::isfinite(spec.smoothness) || spec.smoothness < 0) fail(ErrorCode::out_of_range, "smoothness must be 0…100 %");
  job.smoothnessSec = std::min(spec.smoothness, 100.0) / 100;
  job.fps = job.fl.compFps > 0 ? job.fl.compFps : 30;
  job.frames = tf::comp_frames_of(spec.range, job.fps);
  if (job.frames.last <= job.frames.first) fail(ErrorCode::out_of_range, "the range covers one frame or less — nothing to stabilize");
  if (spec.analysis_max_edge) job.maxEdge = *spec.analysis_max_edge;
  return PreparedJob{"stabilize", [job = std::move(job)](JobControl& control) { return run_stabilize(job, control); }};
}

}  // namespace premation::jobs
