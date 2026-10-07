// Job kind `rotoBrush` — Roto Brush propagation (src/core/tracking/rotoBrush.ts runRotoBrush).
//
// The starting matte is the tool's SAM outline (`startMask` at range.start),
// else GrabCut from every foreground prompt. It is carried frame to frame by
// block flow; every prompt rides the same flow and re-seeds the matte by
// colour (background prompts keep their region out). The result is ONE
// "Roto Brush" mask with a path key on every frame of the range, replacing
// the layer's previous "Roto Brush" masks in the same history entry. The
// matte arithmetic is roto_matte.cpp; this file is the footage read and the
// apply.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "fxstate.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "media_input.hpp"
#include "roto_matte.hpp"
#include "stabilize.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

struct RotoFrame {
  api::Time time = 0;
  api::BezierPath path;
};

/// The source frame playing at source second `s` (objectMask.ts frameIndexAt).
std::int64_t frame_at(double s, double fps, std::int64_t count) {
  if (!std::isfinite(s) || count <= 0) return -1;
  if (count == 1) return 0;
  if (!(fps > 0)) return -1;
  const double f = std::floor((s + 1e-6) * fps);
  if (f < 0 || f >= static_cast<double>(count)) return -1;
  return static_cast<std::int64_t>(f);
}

/// matteToPath centres, in the layer's centred pixel space (rotoBrush.ts pathFromMatte).
api::BezierPath path_from_matte(const roto::Matte& mask, int w, int h, double layerW, double layerH) {
  const std::vector<roto::Pt> pts = roto::matte_to_path(mask, w, h);
  api::BezierPath p;
  p.closed = true;
  auto push = [&](double x, double y) {
    p.vertices.push_back(x);
    p.vertices.push_back(y);
  };
  if (pts.size() >= 3 && w > 0 && h > 0) {
    for (const roto::Pt& pt : pts) {
      push((pt.x / static_cast<double>(w) - 0.5) * layerW, (pt.y / static_cast<double>(h) - 0.5) * layerH);
    }
  } else {
    push(-layerW / 4, -layerH / 4);
    push(layerW / 4, -layerH / 4);
    push(layerW / 4, layerH / 4);
    push(-layerW / 4, layerH / 4);
  }
  // Corners: handles sit on the vertex (the engine stores offsets, so 0).
  p.in_tangents.assign(p.vertices.size(), 0.0);
  p.out_tangents.assign(p.vertices.size(), 0.0);
  return p;
}

std::string mask_group_of(const api::CommandResult& r) {
  const std::optional<api::GroupList> g = result_payload<api::GroupList>(r);
  if (!g || g->groups.empty()) fail(ErrorCode::internal, "addMask returned no mask");
  return g->groups.front();
}

class RotoBrushResult final : public JobResult {
 public:
  RotoBrushResult(std::string layer, std::vector<RotoFrame> frames, double feather, std::vector<std::string> replace)
      : layer_(std::move(layer)), frames_(std::move(frames)), feather_(feather), replace_(std::move(replace)) {}

  [[nodiscard]] std::string summary_json() const override {
    return "{\"frames\":" + std::to_string(frames_.size()) + ",\"keyframes\":" + std::to_string(frames_.size()) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Roto Brush"; }
  [[nodiscard]] bool has_edits() const override { return !frames_.empty(); }

  void apply(JobApply& a) const override {
    if (frames_.empty()) return;
    // The tool's previous outline (the SAM matte this run started from, an
    // earlier propagation) goes in the same entry: one "Roto Brush" mask.
    if (!replace_.empty()) {
      api::RemovePropertyGroups drop;
      for (const std::string& id : replace_) drop.groups.push_back(api::PropRef{layer_, "masks/" + id});
      (void)a.run(command(std::move(drop)));
    }
    api::AddMask m;
    m.layer = layer_;
    m.path = frames_.front().path;
    m.mode = api::MaskMode::add;
    m.name = "Roto Brush";
    const std::string group = mask_group_of(a.run(command(std::move(m))));
    api::SetProperties feather;
    api::PropertyWrite fw;
    fw.prop = api::PropRef{layer_, group + "/feather"};
    fw.value = doc::v_scalar(feather_);
    feather.writes.push_back(std::move(fw));
    (void)a.run(command(std::move(feather)));
    api::AddKeyframes keys;
    for (const RotoFrame& fr : frames_) {
      api::KeyframeInsert k;
      k.prop = api::PropRef{layer_, group + "/path"};
      k.time = fr.time;
      k.value = doc::v_path(fr.path);
      keys.keys.push_back(std::move(k));
    }
    (void)a.run(command(std::move(keys)));
  }

 private:
  std::string layer_;
  std::vector<RotoFrame> frames_;
  double feather_;
  std::vector<std::string> replace_;
};

/// The mask `id`'s outline at `t` (layer-centred px), from the layer's masks
/// (keyed: interpolated). Empty when the layer has no such mask.
std::vector<roto::Pt> mask_outline_at(const doc::Node& node, const std::string& id, double t) {
  const std::vector<doc::Json> anim = doc::read_node_mask_anim(node);
  const std::optional<doc::Json> keyed = doc::interpolate_mask(anim, t);
  const doc::Json mask = keyed ? *keyed : doc::get_node_mask(node);
  std::vector<roto::Pt> out;
  const doc::Json* path = doc::mask_path_by_id(mask, id);
  if (path == nullptr || !path->at("points").is_array()) return out;
  for (const doc::Json& pt : path->at("points").arr()) {
    if (pt.at("x").is_number() && pt.at("y").is_number()) out.push_back(roto::Pt{pt.at("x").num(), pt.at("y").num()});
  }
  return out;
}

}  // namespace

PreparedJob prepare_roto_brush(const api::RotoBrushJob& spec, const JobDocContext& ctx) {
  const FootageLayer fl = footage_layer(ctx, spec.layer, Need::picture);
  auto nonneg = [&](const std::optional<double>& v, double fallback, const char* what) {
    if (!v) return fallback;
    if (!std::isfinite(*v) || *v < 0) fail(ErrorCode::out_of_range, std::string(what) + " must be ≥ 0", {.layer = spec.layer});
    return *v;
  };
  const double tolerance = nonneg(spec.tolerance, 36, "tolerance");
  const double feather = nonneg(spec.feather, 2, "feather");
  if (!std::isfinite(spec.seed.x) || !std::isfinite(spec.seed.y)) {
    fail(ErrorCode::invalid_argument, "the seed click must be a finite point", {.layer = spec.layer});
  }
  if (spec.range.duration < 0) fail(ErrorCode::invalid_argument, "range.duration must be ≥ 0", {.layer = spec.layer});

  const double fps = fl.compFps > 0 ? fl.compFps : 30.0;
  const auto first = static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start) * fps));
  const auto last =
      std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
  if (first < 0) fail(ErrorCode::out_of_range, "the range starts before the composition", {.layer = spec.layer});
  if (last - first > 100'000) fail(ErrorCode::out_of_range, "range is too long to rotoscope", {.layer = spec.layer});

  auto finite_pts = [&](const std::vector<api::Vec2>& in, const char* what) {
    std::vector<roto::Pt> out;
    for (const api::Vec2& p : in) {
      if (!std::isfinite(p.x) || !std::isfinite(p.y)) fail(ErrorCode::invalid_argument, std::string(what) + " must be finite points", {.layer = spec.layer});
      out.push_back(roto::Pt{p.x, p.y});
    }
    return out;
  };
  std::vector<roto::Pt> fgPrompts = finite_pts(spec.prompts, "prompts");
  if (fgPrompts.empty()) fgPrompts.push_back(roto::Pt{spec.seed.x, spec.seed.y});
  const std::vector<roto::Pt> bgPrompts = finite_pts(spec.background_prompts, "backgroundPrompts");

  const doc::Node* node = ctx.doc.node(spec.layer);
  if (node == nullptr) fail(ErrorCode::not_found, "no layer '" + spec.layer + "'", {.layer = spec.layer});
  std::vector<roto::Pt> startOutline;
  if (spec.start_mask && !spec.start_mask->empty()) {
    startOutline = mask_outline_at(*node, *spec.start_mask, seconds_of(spec.range.start));
    if (startOutline.size() < 3) fail(ErrorCode::not_found, "no mask '" + *spec.start_mask + "' to start from", {.layer = spec.layer});
  }
  // Every "Roto Brush" mask the layer has now, plus the ones the page names.
  std::vector<std::string> replace = spec.replace_masks;
  {
    const doc::Json mask = doc::get_node_mask(*node);
    if (mask.at("paths").is_array()) {
      for (const doc::Json& p : mask.at("paths").arr()) {
        if (p.at("id").is_string() && p.at("name").is_string() && p.at("name").str() == "Roto Brush") replace.push_back(p.at("id").str());
      }
    }
    std::sort(replace.begin(), replace.end());
    replace.erase(std::unique(replace.begin(), replace.end()), replace.end());
  }

  PreparedJob job;
  job.kind = "rotoBrush";
  job.work = [fl, tolerance, feather, fps, first, last, fgPrompts, bgPrompts, startOutline,
              replace](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    std::unique_ptr<FrameSource> src = open_frames(fl.file, 0, error);
    if (!src) fail(ErrorCode::decode, "cannot read '" + fl.file + "': " + error, {.layer = fl.layer});
    const int w = static_cast<int>(src->width());
    const int h = static_cast<int>(src->height());
    if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = fl.layer});
    const double layerW = fl.width > 0 ? static_cast<double>(fl.width) : static_cast<double>(src->source_width());
    const double layerH = fl.height > 0 ? static_cast<double>(fl.height) : static_cast<double>(src->source_height());
    const double scaleX = layerW > 0 ? layerW / static_cast<double>(w) : 1.0;
    const double scaleY = layerH > 0 ? layerH / static_cast<double>(h) : 1.0;

    auto read_at = [&](std::int64_t compFrame, RgbaImage& img) -> bool {
      const double t = static_cast<double>(compFrame) / fps;
      if (t < fl.in_seconds() || t >= fl.out_seconds()) return false;
      const std::int64_t sf = frame_at(fl.source_seconds(t), src->fps(), src->frame_count());
      if (sf < 0) return false;
      if (!src->read(sf, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(sf) + ": " + error, {.layer = fl.layer});
      return true;
    };
    // Prompts are layer px (top-left origin); the matte is picture px.
    auto seeds_of = [&](const std::vector<roto::Pt>& pts) {
      std::vector<roto::Seed> out;
      out.reserve(pts.size());
      for (const roto::Pt& p : pts) out.push_back(roto::Seed{p.x / scaleX, p.y / scaleY, tolerance});
      return out;
    };
    std::vector<roto::Seed> fgSeeds = seeds_of(fgPrompts);
    std::vector<roto::Seed> bgSeeds = seeds_of(bgPrompts);

    RgbaImage img;
    if (!read_at(first, img)) {
      fail(ErrorCode::invalid_argument, "the layer has no picture at the start of the range", {.layer = fl.layer});
    }
    roto::Matte mask;
    if (startOutline.size() >= 3) {
      // The SAM outline the tool wrote: layer-centred px → picture px.
      std::vector<roto::Pt> poly;
      poly.reserve(startOutline.size());
      for (const roto::Pt& p : startOutline) {
        poly.push_back(roto::Pt{(p.x / layerW + 0.5) * static_cast<double>(w), (p.y / layerH + 0.5) * static_cast<double>(h)});
      }
      mask = roto::fill_polygon(poly, w, h);
    } else {
      roto::GrabCutOptions cut;
      cut.unknownRadius = 8;
      cut.iterations = 5;
      cut.featherPx = feather;
      mask = roto::grab_cut_matte(img.rgba, w, h, fgSeeds, cut);
      if (!bgSeeds.empty()) {
        const roto::Matte back = roto::flood_matte(img.rgba, w, h, bgSeeds);
        for (std::size_t p = 0; p < mask.size() && p < back.size(); ++p) {
          if (back[p] != 0) mask[p] = 0;
        }
      }
      mask = roto::refine_frame_matte(img.rgba, mask, w, h, feather, fgSeeds);
    }
    stabilize::FloatLuma prevLuma = stabilize::luma_255_of(img.rgba, w, h);

    const std::int64_t total = last - first + 1;
    std::vector<RotoFrame> frames;
    frames.reserve(static_cast<std::size_t>(total));
    scene::pixmo::FlowOptions flowOpts;
    flowOpts.step = 8;
    for (std::int64_t f = first; f <= last; ++f) {
      if (control.cancelled()) return nullptr;
      const roto::Matte soft = roto::blur_mask(mask, w, h, feather);
      RotoFrame fr;
      fr.time = flicks_of(static_cast<double>(f) / fps);
      fr.path = path_from_matte(soft, w, h, layerW, layerH);
      frames.push_back(std::move(fr));
      if (f == last) break;
      RgbaImage next;
      if (!read_at(f + 1, next)) break;
      const stabilize::FloatLuma nextLuma = stabilize::luma_255_of(next.rgba, w, h);
      const scene::pixmo::FlowField flow = stabilize::compute_flow_f32(prevLuma, nextLuma, flowOpts);
      mask = roto::warp_matte(mask, w, h, flow, 1, 1);
      roto::advect_seeds(fgSeeds, flow, w, h);
      roto::advect_seeds(bgSeeds, flow, w, h);
      const roto::Reseed reseed = roto::reseed_matte(next.rgba, mask, w, h, fgSeeds, bgSeeds, tolerance);
      for (std::size_t p = 0; p < mask.size() && p < reseed.add.size(); ++p) {
        if (reseed.add[p] != 0) mask[p] = 255;
      }
      if (!reseed.seeds.empty()) mask = roto::refine_frame_matte(next.rgba, mask, w, h, feather, reseed.seeds);
      prevLuma = nextLuma;
      img = std::move(next);
      const std::int64_t done = f - first + 1;
      control.progress(static_cast<double>(done) / static_cast<double>(total),
                       "Roto frame " + std::to_string(done) + " of " + std::to_string(total));
    }
    return std::make_unique<RotoBrushResult>(fl.layer, std::move(frames), feather, replace);
  };
  return job;
}

}  // namespace premation::jobs
