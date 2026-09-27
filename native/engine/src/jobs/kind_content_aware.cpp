// Job kind `contentAwareFill` — Content-Aware Fill
// (src/core/effects/contentAwareFillVideo.ts runContentAwareFill).
//
// Each frame of the range whose mask covers any pixel is a hole. PatchMatch
// fills the first, and block flow carries the fill both ways. The filled
// pictures are PNGs in `outputFolder` (next to the project, under
// "Content-Aware Fill", when the folder is empty) and attached with
// setContentAwareFill.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "content_aware.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "media_input.hpp"
#include "png_write.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

struct FillFrame {
  api::Time time = 0;
  std::string file;
};

std::int64_t frame_at(double s, double fps, std::int64_t count) {
  if (!std::isfinite(s) || count <= 0) return -1;
  if (count == 1) return 0;
  if (!(fps > 0)) return -1;
  const double f = std::floor((s + 1e-6) * fps);
  if (f < 0 || f >= static_cast<double>(count)) return -1;
  return static_cast<std::int64_t>(f);
}

/// Layer-centred mask points → picture-pixel polygons (maskToHole).
std::vector<caf::Poly> polys_of(const doc::Json& mask, double layerW, double layerH, int w, int h) {
  std::vector<caf::Poly> out;
  if (!mask.at("paths").is_array() || layerW <= 0 || layerH <= 0 || w <= 0 || h <= 0) return out;
  for (const doc::Json& path : mask.at("paths").arr()) {
    const doc::Json& mode = path.at("mode");
    if (mode.is_string() && mode.str() == "none") continue;
    if (!path.at("points").is_array() || path.at("points").arr().size() < 3) continue;
    caf::Poly poly;
    for (const doc::Json& pt : path.at("points").arr()) {
      if (!pt.at("x").is_number() || !pt.at("y").is_number()) continue;
      poly.points.emplace_back((pt.at("x").num() / layerW + 0.5) * static_cast<double>(w),
                               (pt.at("y").num() / layerH + 0.5) * static_cast<double>(h));
    }
    if (poly.points.size() >= 3) out.push_back(std::move(poly));
  }
  return out;
}

doc::Json mask_at(const doc::Json& staticMask, const std::vector<doc::Json>& anim, double t) {
  if (const auto keyed = doc::interpolate_mask(anim, t)) return *keyed;
  return staticMask;
}

class ContentAwareResult final : public JobResult {
 public:
  ContentAwareResult(std::string layer, std::vector<FillFrame> frames, int filled)
      : layer_(std::move(layer)), frames_(std::move(frames)), filled_(filled) {}

  [[nodiscard]] std::string summary_json() const override {
    return "{\"frames\":" + std::to_string(frames_.size()) + ",\"filledPixels\":" + std::to_string(filled_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Content-Aware Fill"; }
  [[nodiscard]] bool has_edits() const override { return !frames_.empty(); }

  void apply(JobApply& a) const override {
    if (frames_.empty()) return;
    api::SetContentAwareFill cmd;
    cmd.layer = layer_;
    for (const FillFrame& fr : frames_) {
      api::ContentAwareFillFrame f;
      f.time = fr.time;
      f.src = fr.file;
      cmd.frames.push_back(std::move(f));
    }
    (void)a.run(command(std::move(cmd)));
  }

 private:
  std::string layer_;
  std::vector<FillFrame> frames_;
  int filled_;
};

}  // namespace

PreparedJob prepare_content_aware_fill(const api::ContentAwareFillJob& spec, const JobDocContext& ctx) {
  const FootageLayer fl = footage_layer(ctx, spec.layer, Need::picture);
  if (spec.range.duration < 0) fail(ErrorCode::invalid_argument, "range.duration must be ≥ 0", {.layer = spec.layer});
  const doc::Node* node = ctx.doc.node(spec.layer);
  if (node == nullptr) fail(ErrorCode::not_found, "no layer '" + spec.layer + "'", {.layer = spec.layer});
  const doc::Json staticMask = doc::get_node_mask(*node);
  const std::vector<doc::Json> anim = doc::read_node_mask_anim(*node);

  const double fps = fl.compFps > 0 ? fl.compFps : 30.0;
  const auto first = static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start) * fps));
  const auto last =
      std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
  if (first < 0) fail(ErrorCode::out_of_range, "the range starts before the composition", {.layer = spec.layer});
  if (last - first > 300) fail(ErrorCode::out_of_range, "range is too long to fill", {.layer = spec.layer});

  std::filesystem::path folder(spec.output_folder);
  if (folder.empty()) {
    // Beside the project; an untitled one: the temp folder (never the
    // engine's working directory).
    const std::filesystem::path project(ctx.projectPath);
    folder = project.empty() ? std::filesystem::temp_directory_path() / "premation-content-aware-fill" / spec.layer
                             : project.parent_path() / "Content-Aware Fill";
  }
  const std::string folderText = folder.string();

  PreparedJob job;
  job.kind = "contentAwareFill";
  job.work = [fl, fps, first, last, staticMask, anim, folderText](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    std::unique_ptr<FrameSource> src = open_frames(fl.file, 0, error);
    if (!src) fail(ErrorCode::decode, "cannot read '" + fl.file + "': " + error, {.layer = fl.layer});
    const int w = static_cast<int>(src->width());
    const int h = static_cast<int>(src->height());
    if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = fl.layer});
    const double layerW = fl.width > 0 ? static_cast<double>(fl.width) : static_cast<double>(w);
    const double layerH = fl.height > 0 ? static_cast<double>(fl.height) : static_cast<double>(h);

    std::vector<std::vector<std::uint8_t>> pictures;
    std::vector<std::vector<std::uint8_t>> holes;
    std::vector<api::Time> times;
    const std::int64_t total = last - first + 1;
    RgbaImage img;
    for (std::int64_t f = first; f <= last; ++f) {
      if (control.cancelled()) return nullptr;
      const double t = static_cast<double>(f) / fps;
      if (t < fl.in_seconds() || t >= fl.out_seconds()) continue;
      const std::int64_t sf = frame_at(fl.source_seconds(t), src->fps(), src->frame_count());
      if (sf < 0) continue;
      if (!src->read(sf, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(sf) + ": " + error, {.layer = fl.layer});
      const doc::Json mask = mask_at(staticMask, anim, t);
      const std::vector<caf::Poly> polys = polys_of(mask, layerW, layerH, w, h);
      std::vector<std::uint8_t> hole(static_cast<std::size_t>(w * h), 0);
      caf::raster_hole(hole, w, h, polys);
      const bool any = std::any_of(hole.begin(), hole.end(), [](std::uint8_t v) { return v != 0; });
      if (!any) continue;
      pictures.push_back(std::move(img.rgba));
      img = RgbaImage{};
      holes.push_back(std::move(hole));
      times.push_back(flicks_of(t));
      control.progress(0.7 * static_cast<double>(f - first + 1) / static_cast<double>(total),
                       "Reading frame " + std::to_string(f - first + 1) + " of " + std::to_string(total));
    }

    caf::InpaintOptions opts;
    opts.patchHalf = 4;
    opts.iterations = 4;
    const int filled = pictures.empty() ? 0 : caf::propagate_fill_bidirectional(pictures, w, h, holes, opts);
    control.progress(0.85, "Writing filled frames");

    std::error_code ec;
    std::filesystem::create_directories(folderText, ec);
    if (ec) fail(ErrorCode::io, "cannot create '" + folderText + "': " + ec.message(), {.layer = fl.layer});

    std::vector<FillFrame> out;
    out.reserve(pictures.size());
    for (std::size_t i = 0; i < pictures.size(); ++i) {
      if (control.cancelled()) return nullptr;
      std::vector<std::uint8_t> png;
      if (!exporter::encode_png_rgba8(pictures[i], static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h), png)) {
        fail(ErrorCode::io, "could not encode fill frame " + std::to_string(i), {.layer = fl.layer});
      }
      std::string name = "fill_";
      const std::string n = std::to_string(i);
      if (n.size() < 5) name.append(5 - n.size(), '0');
      name += n;
      name += ".png";
      const std::filesystem::path path = std::filesystem::path(folderText) / name;
      std::ofstream file(path, std::ios::binary | std::ios::trunc);
      if (!file) fail(ErrorCode::io, "cannot write '" + path.string() + "'", {.layer = fl.layer});
      file.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
      if (!file) fail(ErrorCode::io, "cannot write '" + path.string() + "'", {.layer = fl.layer});
      out.push_back(FillFrame{times[i], path.string()});
    }
    control.progress(1, "Content-Aware Fill");
    return std::make_unique<ContentAwareResult>(fl.layer, std::move(out), filled);
  };
  return job;
}

}  // namespace premation::jobs
