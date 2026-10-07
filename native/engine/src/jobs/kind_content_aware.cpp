// Job kind `contentAwareFill` — Content-Aware Fill (AE parity 3.7).
//
// The hole at each frame is the layer's masks as Béziers (content_aware_fill.hpp
// raster_hole_paths). Frames are filled in windows of kWindow: reference
// plates first, then synthesis / flow / membrane by mode, then lighting
// correction; each window starts from the previous window's last frame, so a
// range of any length works in bounded memory. The filled pictures are PNGs in
// `outputFolder` (next to the project, under "Content-Aware Fill", when empty)
// attached with setContentAwareFill. `createReference` fills one frame and
// writes it for the user to paint.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "content_aware_fill.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
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

/// Layer-centred mask paths → picture-pixel Bézier paths.
std::vector<caf::HolePath> paths_of(const doc::Json& mask, double layerW, double layerH, int w, int h, double grow) {
  std::vector<caf::HolePath> out;
  if (!mask.at("paths").is_array() || layerW <= 0 || layerH <= 0 || w <= 0 || h <= 0) return out;
  const double sx = static_cast<double>(w) / layerW;
  const double sy = static_cast<double>(h) / layerH;
  auto num = [](const doc::Json& p, const char* k, double fallback) {
    const doc::Json& v = p.at(k);
    return v.is_number() ? v.num() : fallback;
  };
  for (const doc::Json& path : mask.at("paths").arr()) {
    const doc::Json& mode = path.at("mode");
    const std::string m = mode.is_string() ? mode.str() : std::string("add");
    if (m == "none") continue;
    if (!path.at("points").is_array() || path.at("points").arr().size() < 3) continue;
    caf::HolePath hp;
    hp.subtract = m == "subtract";
    hp.inverted = path.at("inverted").is_bool() && path.at("inverted").b();
    hp.closed = true;  // a hole is an area: an open path closes
    hp.expansion = num(path, "expansion", 0) * std::sqrt(sx * sy) + grow;
    for (const doc::Json& pt : path.at("points").arr()) {
      if (!pt.at("x").is_number() || !pt.at("y").is_number()) continue;
      const double x = pt.at("x").num();
      const double y = pt.at("y").num();
      auto X = [&](double v) { return (v / layerW + 0.5) * static_cast<double>(w); };
      auto Y = [&](double v) { return (v / layerH + 0.5) * static_cast<double>(h); };
      hp.points.push_back({X(x), Y(y), X(num(pt, "inX", x)), Y(num(pt, "inY", y)), X(num(pt, "outX", x)), Y(num(pt, "outY", y))});
    }
    if (hp.points.size() >= 3) out.push_back(std::move(hp));
  }
  return out;
}

doc::Json mask_at(const doc::Json& staticMask, const std::vector<doc::Json>& anim, double t) {
  if (const auto keyed = doc::interpolate_mask(anim, t)) return *keyed;
  return staticMask;
}

/// Frames held at once. 1080p RGBA is ~8 MB a frame.
constexpr std::int64_t kWindow = 48;

class ContentAwareResult final : public JobResult {
 public:
  ContentAwareResult(std::string layer, std::vector<FillFrame> frames, caf::SequenceStats stats, bool reference)
      : layer_(std::move(layer)), frames_(std::move(frames)), stats_(stats), reference_(reference) {}

  [[nodiscard]] std::string summary_json() const override {
    doc::Json s = doc::Json::object();
    s.set("frames", doc::Json::number(static_cast<double>(frames_.size())));
    s.set("filledPixels", doc::Json::number(static_cast<double>(stats_.synthesized + stats_.propagated + stats_.blended + stats_.fromReference)));
    s.set("synthesized", doc::Json::number(stats_.synthesized));
    s.set("propagated", doc::Json::number(stats_.propagated));
    s.set("blended", doc::Json::number(stats_.blended));
    s.set("fromReference", doc::Json::number(stats_.fromReference));
    doc::Json files = doc::Json::array();
    if (reference_) {
      for (const FillFrame& f : frames_) files.arr_mut().push_back(doc::Json::string(f.file));
    }
    s.set("files", std::move(files));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return reference_ ? "Content-Aware Fill Reference" : "Content-Aware Fill"; }
  [[nodiscard]] bool has_edits() const override { return !reference_ && !frames_.empty(); }

  void apply(JobApply& a) const override {
    if (reference_ || frames_.empty()) return;
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
  caf::SequenceStats stats_;
  bool reference_;
};

std::string padded(std::int64_t n) {
  std::string s = std::to_string(n);
  if (s.size() < 5) s.insert(0, 5 - s.size(), '0');
  return s;
}

void write_png(const std::vector<std::uint8_t>& rgba, int w, int h, const std::filesystem::path& path, const std::string& layer) {
  std::vector<std::uint8_t> png;
  if (!exporter::encode_png_rgba8(rgba, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h), png)) {
    fail(ErrorCode::io, "could not encode '" + path.string() + "'", {.layer = layer});
  }
  // Temp file + rename: a cancelled or failed write never leaves half a frame.
  std::filesystem::path tmp = path;
  tmp += ".tmp";
  {
    std::ofstream file(tmp, std::ios::binary | std::ios::trunc);
    if (!file) fail(ErrorCode::io, "cannot write '" + tmp.string() + "'", {.layer = layer});
    file.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    if (!file) fail(ErrorCode::io, "cannot write '" + tmp.string() + "'", {.layer = layer});
  }
  std::error_code ec;
  std::filesystem::rename(tmp, path, ec);
  if (ec) fail(ErrorCode::io, "cannot write '" + path.string() + "': " + ec.message(), {.layer = layer});
}

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
  const bool reference = spec.create_reference.value_or(false);
  const auto last = reference ? first
                              : std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
  if (first < 0) fail(ErrorCode::out_of_range, "the range starts before the composition", {.layer = spec.layer});

  caf::SequenceOptions opts;
  switch (spec.mode.value_or(api::ContentAwareFillMode::object)) {
    case api::ContentAwareFillMode::object: opts.mode = caf::FillMode::object; break;
    case api::ContentAwareFillMode::surface: opts.mode = caf::FillMode::surface; break;
    case api::ContentAwareFillMode::edge_blend: opts.mode = caf::FillMode::edgeBlend; break;
  }
  switch (spec.lighting.value_or(api::ContentAwareLighting::off)) {
    case api::ContentAwareLighting::off: opts.lighting = caf::Lighting::off; break;
    case api::ContentAwareLighting::subtle: opts.lighting = caf::Lighting::subtle; break;
    case api::ContentAwareLighting::moderate: opts.lighting = caf::Lighting::moderate; break;
    case api::ContentAwareLighting::strong: opts.lighting = caf::Lighting::strong; break;
  }
  if (reference && opts.mode == caf::FillMode::surface) opts.mode = caf::FillMode::object;  // one frame has nothing to carry
  const double grow = spec.expansion.value_or(0);
  if (!std::isfinite(grow)) fail(ErrorCode::invalid_argument, "expansion must be finite", {.layer = spec.layer});

  // Reference plates by composition frame.
  std::vector<std::pair<std::int64_t, std::string>> refs;
  for (const api::ContentAwareFillFrame& r : spec.references) {
    if (r.src.empty()) continue;
    refs.emplace_back(static_cast<std::int64_t>(std::llround(seconds_of(r.time) * fps)), r.src);
  }

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
  job.work = [fl, fps, first, last, staticMask, anim, folderText, opts, grow, refs, reference](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    std::unique_ptr<FrameSource> src = open_frames(fl.file, 0, error);
    if (!src) fail(ErrorCode::decode, "cannot read '" + fl.file + "': " + error, {.layer = fl.layer});
    const int w = static_cast<int>(src->width());
    const int h = static_cast<int>(src->height());
    if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = fl.layer});
    const double layerW = fl.width > 0 ? static_cast<double>(fl.width) : static_cast<double>(w);
    const double layerH = fl.height > 0 ? static_cast<double>(fl.height) : static_cast<double>(h);
    const auto px = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);

    std::error_code ec;
    std::filesystem::create_directories(folderText, ec);
    if (ec) fail(ErrorCode::io, "cannot create '" + folderText + "': " + ec.message(), {.layer = fl.layer});

    auto reference_for = [&](std::int64_t f) -> std::vector<std::uint8_t> {
      for (const auto& [rf, path] : refs) {
        if (rf != f) continue;
        std::string err;
        std::unique_ptr<FrameSource> plate = open_frames(path, 0, err);
        if (!plate) fail(ErrorCode::decode, "cannot read reference '" + path + "': " + err, {.layer = fl.layer});
        if (plate->width() != src->width() || plate->height() != src->height()) {
          fail(ErrorCode::invalid_argument,
               "reference '" + path + "' is " + std::to_string(plate->width()) + "×" + std::to_string(plate->height()) +
                   ", the footage is " + std::to_string(w) + "×" + std::to_string(h),
               {.layer = fl.layer});
        }
        RgbaImage img;
        if (!plate->read(0, img, err)) fail(ErrorCode::decode, "reference '" + path + "': " + err, {.layer = fl.layer});
        return std::move(img.rgba);
      }
      return {};
    };

    std::vector<FillFrame> out;
    caf::SequenceStats total;
    std::optional<caf::SequenceFrame> carry;  // the previous window's last frame, filled
    std::int64_t carryFrame = -2;
    const std::int64_t count = last - first + 1;
    RgbaImage img;
    for (std::int64_t w0 = first; w0 <= last; w0 += kWindow) {
      const std::int64_t w1 = std::min(last, w0 + kWindow - 1);
      std::vector<caf::SequenceFrame> frames;
      std::vector<std::int64_t> index;  // comp frame per entry, -1 for the carried anchor
      std::vector<api::Time> times;
      std::vector<std::int64_t> compFrame;
      if (carry && carryFrame == w0 - 1) {
        frames.push_back(std::move(*carry));
        frames.back().anchor = true;
        index.push_back(-1);
        times.push_back(0);
        compFrame.push_back(carryFrame);
      }
      carry.reset();
      for (std::int64_t f = w0; f <= w1; ++f) {
        if (control.cancelled()) return nullptr;
        const double t = static_cast<double>(f) / fps;
        if (t < fl.in_seconds() || t >= fl.out_seconds()) continue;
        const std::int64_t sf = frame_at(fl.source_seconds(t), src->fps(), src->frame_count());
        if (sf < 0) continue;
        if (!src->read(sf, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(sf) + ": " + error, {.layer = fl.layer});
        caf::SequenceFrame fr;
        fr.hole.assign(px, 0);
        const std::vector<caf::HolePath> paths = paths_of(mask_at(staticMask, anim, t), layerW, layerH, w, h, grow);
        const int holes = caf::raster_hole_paths(fr.hole, w, h, paths);
        fr.rgba = std::move(img.rgba);
        img = RgbaImage{};
        // A frame with no hole is a clean source for its neighbours.
        fr.anchor = holes == 0;
        if (holes > 0) fr.reference = reference_for(f);
        frames.push_back(std::move(fr));
        index.push_back(holes > 0 ? f : -1);
        times.push_back(flicks_of(t));
        compFrame.push_back(f);
        control.progress(0.9 * static_cast<double>(f - first + 1) / static_cast<double>(count),
                         "Filling frame " + std::to_string(f - first + 1) + " of " + std::to_string(count));
      }
      if (frames.empty()) continue;
      const caf::SequenceStats st = caf::fill_sequence(frames, w, h, opts);
      total.synthesized += st.synthesized;
      total.propagated += st.propagated;
      total.blended += st.blended;
      total.fromReference += st.fromReference;
      for (std::size_t i = 0; i < frames.size(); ++i) {
        if (index[i] < 0) continue;
        if (control.cancelled()) return nullptr;
        const std::string name = (reference ? "reference_" : "fill_") + padded(index[i]) + ".png";
        const std::filesystem::path path = std::filesystem::path(folderText) / name;
        write_png(frames[i].rgba, w, h, path, fl.layer);
        out.push_back(FillFrame{times[i], path.string()});
      }
      // The window's last frame anchors the next one.
      carry = std::move(frames.back());
      carryFrame = compFrame.back();
    }
    control.progress(1, "Content-Aware Fill");
    return std::make_unique<ContentAwareResult>(fl.layer, std::move(out), total, reference);
  };
  return job;
}

}  // namespace premation::jobs
