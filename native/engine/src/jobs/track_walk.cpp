#include "track_walk.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

#include "fail.hpp"
#include "jsmath.hpp"
#include "tracking.hpp"

namespace premation::jobs::trackwalk {

using api::ErrorCode;
using doc::fail;
namespace tr = tracking;
namespace tf = trackframes;

namespace {

/// Luma planes a backward walk may hold at once (reverseFrameWalk.ts budgets the same way).
constexpr std::size_t kReverseBudgetBytes = std::size_t{256} << 20U;

struct Cancelled {};

/// Decoded luma for one walk: a straight stream ascending, bounded chunks
/// decoded forward and served backwards descending (reverseFrameWalk.ts).
class LumaWalk {
 public:
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

}  // namespace

std::optional<WalkResult> walk(FrameSource& src, const WalkSpec& spec, JobControl& control) {
  const double w = src.width();
  const double h = src.height();
  if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = spec.fl.layer});
  WalkResult out;
  out.sourceWidth = src.source_width() > 0 ? src.source_width() : w;
  out.sourceHeight = src.source_height() > 0 ? src.source_height() : h;
  // Display grid (layer px) ↔ decoded grid; lengths by the geometric mean.
  const double toCodedX = w / out.sourceWidth;
  const double toCodedY = h / out.sourceHeight;
  const double toCodedLength = std::sqrt(toCodedX * toCodedY);
  const std::int64_t count = std::max<std::int64_t>(1, src.frame_count());
  const double srcFps = src.fps();
  auto srcIndexAt = [&](std::int64_t compFrame) { return tf::source_index(spec.fl, compFrame, spec.fps, srcFps, count); };

  std::vector<tr::PointSeed> seeds;
  for (const WalkPoint& p : spec.points) {
    tr::PointSeed s;
    s.x = p.x * toCodedX;
    s.y = p.y * toCodedY;
    s.featureHalf = std::max(1, static_cast<int>(motion::js::round(p.featureHalf * toCodedLength)));
    s.searchHalf = std::max(1, static_cast<int>(motion::js::round(p.searchHalf * toCodedLength)));
    seeds.push_back(s);
  }
  tr::TrackOptions opts;
  opts.minConfidence = spec.minConfidence;
  opts.maxCoastFrames = spec.maxCoast;

  // Comp frames the result covers, and the source walks.
  std::int64_t compLo = spec.frames.first;
  std::int64_t compHi = spec.frames.last;
  struct Walk {
    std::int64_t from;
    std::int64_t to;
  };
  std::vector<Walk> walks;  // run in order; `both` = backward, then forward
  const char* still = "the clip does not advance over this range — nothing to track";
  if (spec.direction == api::TrackDirection::forward) {
    compLo = spec.origin;
    walks.push_back(Walk{srcIndexAt(spec.origin), srcIndexAt(compHi)});
    if (walks[0].from == walks[0].to) fail(ErrorCode::invalid_argument, still);
  } else if (spec.direction == api::TrackDirection::backward) {
    compHi = spec.origin;
    walks.push_back(Walk{srcIndexAt(spec.origin), srcIndexAt(compLo)});
    if (walks[0].from == walks[0].to) fail(ErrorCode::invalid_argument, still);
  } else {
    const std::int64_t a = srcIndexAt(compLo);
    const std::int64_t b = srcIndexAt(compHi);
    const std::int64_t lo = std::min(a, b);
    const std::int64_t hi = std::max(a, b);
    if (lo == hi) fail(ErrorCode::invalid_argument, still);
    const std::int64_t anchor = std::clamp(srcIndexAt(spec.origin), lo, hi);
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
      LumaWalk frames(src, control, std::min(wk.from, wk.to), descending);
      const tr::FrameAt frameAt = [&frames](std::int64_t i) -> const tr::LumaPlane& { return frames.at(i); };
      const tr::OnProgress onProgress = [&](std::int64_t, std::int64_t) {
        ++done;
        control.progress(total > 0 ? static_cast<double>(done) / static_cast<double>(total) : 1.0,
                         "Tracking frame " + std::to_string(done) + " of " + std::to_string(total));
        return !control.cancelled();
      };
      results.push_back(tr::track_points(frameAt, wk.from, wk.to, seeds, opts, onProgress));
      if (results.back().status == tr::TrackStatus::cancelled) return std::nullopt;
    }
  } catch (const Cancelled&) {
    return std::nullopt;
  }
  if (control.cancelled()) return std::nullopt;

  // Per point: the source samples (merged when both ways), then read out per comp frame.
  for (const tr::MultiTrackResult& r : results) {
    if (r.status != tr::TrackStatus::completed) out.status = spec.direction == api::TrackDirection::both ? "partial" : "lost";
  }
  for (std::size_t p = 0; p < seeds.size(); ++p) {
    std::vector<tr::TrackSample> samples;
    if (results.size() == 2) {
      samples = tr::merge_bidirectional(results[0].tracks[p], results[1].tracks[p]);
    } else if (results.size() == 1) {
      samples = results[0].tracks[p];
    }
    std::map<std::int64_t, const tr::TrackSample*> byFrame;
    for (const tr::TrackSample& s : samples) byFrame.insert_or_assign(s.frame, &s);
    trackapply::Track comp;
    for (std::int64_t f = compLo; f <= compHi; ++f) {
      const auto it = byFrame.find(srcIndexAt(f));
      if (it == byFrame.end()) continue;
      const tr::TrackSample& s = *it->second;
      comp.push_back(trackapply::CompSample{static_cast<double>(f) / spec.fps, s.x / toCodedX, s.y / toCodedY, s.confidence, s.coasted});
    }
    out.tracks.push_back(std::move(comp));
  }
  return out;
}

}  // namespace premation::jobs::trackwalk
