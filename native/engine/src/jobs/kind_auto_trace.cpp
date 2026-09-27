// Job kind `autoTrace` — Layer ▸ Auto-trace (src/core/effects/autoTrace.ts,
// the `layer.autoTrace` command in src/providers/Providers.tsx).
//
// The TS rendered the layer alone on a transparent comp and traced that;
// the engine job traces the footage layer's own frames (layer pixels, the
// same space its masks live in), read through open_frames at full size. The
// rest is autoTrace.ts: the chosen channel thresholded, traced
// (trace_bitmap.hpp), outer rings first as `add` masks named "Auto-trace N",
// then holes as `subtract` masks "Auto-trace hole N"; with `everyFrame` over a
// range of more than one frame, every mask path gets a keyframe on every
// frame of the range — the TS `replaceMaskRings` + `keyframeMask` walk.
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "media_input.hpp"
#include "trace_bitmap.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

struct TracedFrame {
  api::Time time = 0;  ///< comp time of the frame
  std::vector<trace::MaskRing> rings;
};

api::BezierPath bezier_of(const trace::MaskRing& r) {
  api::BezierPath p;
  p.closed = true;
  p.vertices.reserve(r.points.size() * 2);
  for (const trace::TracePoint& pt : r.points) {
    p.vertices.push_back(pt.x);
    p.vertices.push_back(pt.y);
  }
  // Corners: the in/out handles sit on the vertex (autoTrace.ts inX = x …).
  p.in_tangents.assign(p.vertices.size(), 0.0);
  p.out_tangents.assign(p.vertices.size(), 0.0);
  return p;
}

/// "masks/<id>" from an addMask result.
std::string mask_group_of(const api::CommandResult& r) {
  const std::optional<api::GroupList> g = result_payload<api::GroupList>(r);
  if (!g || g->groups.empty()) fail(ErrorCode::internal, "addMask returned no mask");
  return g->groups.front();
}

class AutoTraceResult final : public JobResult {
 public:
  AutoTraceResult(std::string layer, std::vector<TracedFrame> frames, bool keyed)
      : layer_(std::move(layer)), frames_(std::move(frames)), keyed_(keyed) {}

  [[nodiscard]] std::string summary_json() const override {
    const Counts c = counts();
    return "{\"pathsAdded\":" + std::to_string(c.paths) + ",\"keyframes\":" + std::to_string(c.keyframes) +
           ",\"frames\":" + std::to_string(frames_.size()) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Auto-trace"; }
  [[nodiscard]] bool has_edits() const override { return counts().paths > 0; }

  void apply(JobApply& a) const override {
    std::vector<std::string> groups;   // "masks/<id>", in stack order
    std::vector<api::BezierPath> now;  // each traced path's current shape
    auto add_mask = [&](const trace::MaskRing& ring, std::string name) {
      api::AddMask m;
      m.layer = layer_;
      m.path = bezier_of(ring);
      m.mode = ring.hole ? api::MaskMode::subtract : api::MaskMode::add;
      m.name = std::move(name);
      groups.push_back(mask_group_of(a.run(command(std::move(m)))));
      now.push_back(bezier_of(ring));
    };
    if (frames_.empty()) return;
    // The first traced frame: one mask per ring, numbered per kind.
    int outer = 0;
    int holes = 0;
    for (const trace::MaskRing& ring : frames_.front().rings) {
      add_mask(ring, ring.hole ? "Auto-trace hole " + std::to_string(++holes) : "Auto-trace " + std::to_string(++outer));
    }
    if (!keyed_) return;
    api::AddKeyframes keys;
    for (std::size_t f = 0; f < frames_.size(); ++f) {
      const TracedFrame& fr = frames_[f];
      if (f != 0) {
        // replaceMaskRings: ring i overwrites traced path i; a frame with more
        // rings adds paths. A path without a ring this frame keeps its last shape.
        // (The TS also re-set the path's add/subtract mode per frame; a mask's
        // mode is not animatable, so it keeps the mode it was created with.)
        for (std::size_t i = 0; i < fr.rings.size(); ++i) {
          if (i < groups.size()) {
            now[i] = bezier_of(fr.rings[i]);
          } else {
            add_mask(fr.rings[i], fr.rings[i].hole ? "Auto-trace hole" : "Auto-trace");
          }
        }
      }
      // keyframeMask: the whole mask keyed at this frame.
      for (std::size_t i = 0; i < groups.size(); ++i) {
        api::KeyframeInsert k;
        k.prop = api::PropRef{layer_, groups[i] + "/path"};
        k.time = fr.time;
        k.value = doc::v_path(now[i]);
        keys.keys.push_back(std::move(k));
      }
    }
    if (!keys.keys.empty()) (void)a.run(command(std::move(keys)));
  }

 private:
  struct Counts {
    std::size_t paths = 0;
    std::size_t keyframes = 0;
  };
  [[nodiscard]] Counts counts() const {
    Counts c;
    if (frames_.empty()) return c;
    c.paths = frames_.front().rings.size();
    if (!keyed_) return c;
    for (std::size_t f = 0; f < frames_.size(); ++f) {
      if (f != 0) c.paths = std::max(c.paths, frames_[f].rings.size());
      c.keyframes += c.paths;
    }
    return c;
  }

  std::string layer_;
  std::vector<TracedFrame> frames_;
  bool keyed_;
};

/// The source frame playing at source second `s` (the frame containing s + 1 µs,
/// objectMask.ts `frameIndexAt(round(mediaSec·1e6) + 1)`); −1 when outside the stream.
std::int64_t frame_at(double s, double fps, std::int64_t count) {
  if (!std::isfinite(s) || count <= 0) return -1;
  if (count == 1) return 0;  // a still: the one picture at every time
  if (!(fps > 0)) return -1;
  const double f = std::floor((s + 1e-6) * fps);
  if (f < 0 || f >= static_cast<double>(count)) return -1;
  return static_cast<std::int64_t>(f);
}

}  // namespace

PreparedJob prepare_auto_trace(const api::AutoTraceJob& spec, const JobDocContext& ctx) {
  const FootageLayer fl = footage_layer(ctx, spec.layer, Need::picture);
  trace::Channel channel = trace::Channel::alpha;
  if (!trace::parse_channel(spec.channel, channel)) {
    fail(ErrorCode::invalid_argument, "channel '" + spec.channel + "' is not alpha, luminance, red, green or blue",
         {.layer = spec.layer});
  }
  if (!std::isfinite(spec.threshold) || spec.threshold < 0 || spec.threshold > 1) {
    fail(ErrorCode::out_of_range, "threshold must be 0…1", {.layer = spec.layer});
  }
  auto nonneg = [&](const std::optional<double>& v, double fallback, const char* what) {
    if (!v) return fallback;
    if (!std::isfinite(*v) || *v < 0) fail(ErrorCode::out_of_range, std::string(what) + " must be ≥ 0", {.layer = spec.layer});
    return *v;
  };
  trace::AutoTraceParams params;
  params.threshold = spec.threshold * 255.0;
  params.tolerance = nonneg(spec.tolerance, 1.5, "tolerance");
  params.minArea = nonneg(spec.min_area, 16, "minArea");
  const double blur = nonneg(spec.blur, 0, "blur");
  if (spec.range.duration < 0) fail(ErrorCode::invalid_argument, "range.duration must be ≥ 0", {.layer = spec.layer});

  // autoTrace.ts: comp frames first…last at the comp's rate; a range is
  // inclusive of its last frame (Providers.tsx: work-area start + duration − 1).
  const double fps = fl.compFps > 0 ? fl.compFps : 30.0;
  const auto first = static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start) * fps));
  std::int64_t last = first;
  if (spec.every_frame) {
    last = std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
  }
  if (last - first > 100'000) fail(ErrorCode::out_of_range, "range is too long to trace", {.layer = spec.layer});

  PreparedJob job;
  job.kind = "autoTrace";
  job.work = [fl, channel, params, blur, fps, first, last, invert = spec.invert,
              keyed = spec.every_frame && last > first](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    std::unique_ptr<FrameSource> src = open_frames(fl.file, 0, error);
    if (!src) fail(ErrorCode::decode, "cannot read '" + fl.file + "': " + error, {.layer = fl.layer});
    const double layerW = fl.width > 0 ? fl.width : src->source_width();
    const double layerH = fl.height > 0 ? fl.height : src->source_height();
    const std::int64_t total = last - first + 1;
    std::vector<TracedFrame> frames;
    frames.reserve(static_cast<std::size_t>(total));
    RgbaImage img;
    for (std::int64_t f = first; f <= last; ++f) {
      if (control.cancelled()) return nullptr;
      TracedFrame fr;
      const double t = static_cast<double>(f) / fps;
      fr.time = flicks_of(t);
      // A frame where the layer draws nothing traces to nothing (the TS
      // rendered it alone: an inactive layer is an empty frame).
      const bool active = t >= fl.in_seconds() && t < fl.out_seconds();
      const std::int64_t sf = active ? frame_at(fl.source_seconds(t), src->fps(), src->frame_count()) : -1;
      if (sf >= 0) {
        if (!src->read(sf, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(sf) + ": " + error, {.layer = fl.layer});
        std::vector<std::uint8_t> plane = trace::channel_plane(img, channel, invert);
        if (blur > 0) plane = trace::box_blur(plane, img.width, img.height, blur);
        fr.rings = trace::auto_trace_rings(plane, img.width, img.height, layerW, layerH, params);
      }
      frames.push_back(std::move(fr));
      const std::int64_t done = f - first + 1;
      control.progress(static_cast<double>(done) / static_cast<double>(total),
                       "Tracing frame " + std::to_string(done) + " of " + std::to_string(total));
    }
    return std::make_unique<AutoTraceResult>(fl.layer, std::move(frames), keyed);
  };
  return job;
}

}  // namespace premation::jobs
