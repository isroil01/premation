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
#include <span>
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
#include "subjects.hpp"
#include "timeline.hpp"
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

/// A subject's stored matte frames (ContentAwareFillJob `subject`): composition seconds and the
/// cut-out picture whose alpha is the hole. `tracked`: frames about every frame (a Follow) — such
/// a subject leaves no hole outside its span; one held on a frame or two holes every frame.
struct SubjectHole {
  std::vector<std::pair<double, std::string>> frames;
  bool tracked = false;

  /// The stored frame for composition second `t` (nullptr: no hole at `t`).
  [[nodiscard]] const std::string* at(double t, double fps) const {
    const std::pair<double, std::string>* best = nullptr;
    for (const auto& f : frames)
      if (best == nullptr || std::abs(f.first - t) < std::abs(best->first - t)) best = &f;
    if (best == nullptr) return nullptr;
    if (tracked && std::abs(best->first - t) > 1.0 / std::max(1.0, fps)) return nullptr;
    return &best->second;
  }
};

/// The hole of one stored subject frame: its alpha (resampled nearest to the picture's size) over
/// a low threshold — the soft edge is part of what must be filled — grown by `grow` px.
int subject_hole(std::span<std::uint8_t> hole, int w, int h, const std::string& src, int grow, const std::string& layer) {
  std::string err;
  std::unique_ptr<FrameSource> m = open_frames(src, 0, err);
  if (!m) fail(ErrorCode::decode, "cannot read the subject's matte '" + src + "': " + err, {.layer = layer});
  RgbaImage img;
  if (!m->read(0, img, err)) fail(ErrorCode::decode, "the subject's matte '" + src + "': " + err, {.layer = layer});
  const int mw = static_cast<int>(img.width);
  const int mh = static_cast<int>(img.height);
  if (mw <= 0 || mh <= 0) return 0;
  int count = 0;
  for (int y = 0; y < h; ++y) {
    const int sy = std::min(mh - 1, static_cast<int>((static_cast<long long>(y) * mh) / h));
    for (int x = 0; x < w; ++x) {
      const int sx = std::min(mw - 1, static_cast<int>((static_cast<long long>(x) * mw) / w));
      const bool in = img.rgba[(static_cast<std::size_t>(sy) * static_cast<std::size_t>(mw) + static_cast<std::size_t>(sx)) * 4 + 3] > 8;
      hole[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)] = in ? 255 : 0;
      count += in ? 1 : 0;
    }
  }
  if (count > 0 && grow > 0) caf::dilate_hole(hole, w, h, grow);
  return count;
}

/// A clean plate for a subject fill: the background behind the subject from the frames where
/// it is uncovered. Each pixel is the median (by luma) of up to kPlateSamples frames spread over
/// the range in which the pixel is outside the (grown) hole; `known` marks pixels some frame
/// showed. Built only for a camera that holds still — the picture outside the holes must agree
/// across the samples (mean |Δluma| under kStillCamera levels) — else empty.
struct CleanPlate {
  std::vector<std::uint8_t> rgba;
  std::vector<std::uint8_t> known;
  [[nodiscard]] bool empty() const { return rgba.empty(); }
};
constexpr int kPlateSamples = 24;
/// A plate pixel needs this many frames showing it, whose luma interquartile spread is at most kPlateMaxSpread levels.
constexpr std::size_t kPlateMinShown = 3;
constexpr double kPlateMaxSpread = 18.0;
constexpr double kStillCamera = 10.0;

CleanPlate build_clean_plate(const std::vector<std::vector<std::uint8_t>>& rgba, const std::vector<std::vector<std::uint8_t>>& holes, int w, int h) {
  CleanPlate plate;
  const std::size_t n = rgba.size();
  if (n < 2) return plate;
  const auto px = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  const auto luma = [&](std::size_t s, std::size_t p) {
    return 0.299 * rgba[s][p * 4] + 0.587 * rgba[s][p * 4 + 1] + 0.114 * rgba[s][p * 4 + 2];
  };
  // The camera: consecutive samples compared where neither has a hole (every 7th pixel).
  double diff = 0;
  std::size_t cnt = 0;
  for (std::size_t s = 1; s < n; ++s)
    for (std::size_t p = 0; p < px; p += 7)
      if (holes[s][p] == 0 && holes[s - 1][p] == 0) {
        diff += std::abs(luma(s, p) - luma(s - 1, p));
        ++cnt;
      }
  if (cnt == 0 || diff / static_cast<double>(cnt) > kStillCamera) return plate;
  plate.rgba.assign(px * 4, 0);
  plate.known.assign(px, 0);
  std::vector<std::pair<double, std::size_t>> vals;
  vals.reserve(n);
  for (std::size_t p = 0; p < px; ++p) {
    vals.clear();
    for (std::size_t s = 0; s < n; ++s)
      if (holes[s][p] == 0) vals.emplace_back(luma(s, p), s);
    // Trusted only when several frames show the pixel and they agree: a pixel uncovered once or
    // twice is often the subject itself where its matte missed a part (a ghost of it in the plate).
    if (vals.size() < kPlateMinShown) continue;
    std::ranges::sort(vals, {}, &std::pair<double, std::size_t>::first);
    const double spread = vals[vals.size() * 3 / 4].first - vals[vals.size() / 4].first;
    if (spread > kPlateMaxSpread) continue;
    const std::size_t s = vals[vals.size() / 2].second;
    for (std::size_t c = 0; c < 3; ++c) plate.rgba[p * 4 + c] = rgba[s][p * 4 + c];
    plate.rgba[p * 4 + 3] = 255;
    plate.known[p] = 1;
  }
  return plate;
}

/// The plate laid into a frame's hole where the plate knows the background (those pixels leave
/// the hole), shifted per channel by the mean difference between the frame and the plate on a
/// ring just outside the hole — exposure drifts over a shot. What no frame showed stays a hole
/// for the fill. Returns the pixels laid.
int lay_clean_plate(caf::SequenceFrame& fr, const CleanPlate& plate, int w, int h) {
  const auto px = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  std::vector<std::uint8_t> ring(fr.hole);
  caf::dilate_hole(ring, w, h, std::max(4, std::max(w, h) / 100));
  std::array<double, 3> off{};
  std::size_t cnt = 0;
  for (std::size_t p = 0; p < px; ++p) {
    if (ring[p] == 0 || fr.hole[p] != 0 || plate.known[p] == 0) continue;
    for (std::size_t c = 0; c < 3; ++c) off[c] += static_cast<double>(fr.rgba[p * 4 + c]) - plate.rgba[p * 4 + c];
    ++cnt;
  }
  if (cnt > 0)
    for (double& o : off) o /= static_cast<double>(cnt);
  int laid = 0;
  for (std::size_t p = 0; p < px; ++p) {
    if (fr.hole[p] == 0 || plate.known[p] == 0) continue;
    for (std::size_t c = 0; c < 3; ++c) fr.rgba[p * 4 + c] = static_cast<std::uint8_t>(std::clamp(plate.rgba[p * 4 + c] + off[c], 0.0, 255.0));
    fr.rgba[p * 4 + 3] = 255;
    fr.hole[p] = 0;
    ++laid;
  }
  return laid;
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

  // The hole from a subject's matte (the area a Separated subject left behind), not the masks.
  std::optional<SubjectHole> subjectHole;
  if (spec.subject && !spec.subject->empty()) {
    SubjectHole sh;
    const doc::Json& am = node->fx().at("alphaMatte");
    const doc::EditorView view{fl.comp, 0};
    if (am.is_object() && am.at("frames").is_array())
      for (const doc::Json& f : am.at("frames").arr())
        if (f.at("t").is_number() && f.at("src").is_string() && doc::frame_subject(f) == *spec.subject)
          sh.frames.emplace_back(doc::keyframe_to_comp_time(ctx.doc, view, spec.layer, f.at("t").num()), f.at("src").str());
    if (sh.frames.empty()) fail(ErrorCode::not_found, "the layer has no subject '" + *spec.subject + "'", {.layer = spec.layer});
    std::ranges::sort(sh.frames, {}, &std::pair<double, std::string>::first);
    const double span = sh.frames.back().first - sh.frames.front().first;
    sh.tracked = sh.frames.size() >= 3 && span / static_cast<double>(sh.frames.size() - 1) <= 1.5 / fps;
    subjectHole = std::move(sh);
  }

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
  job.work = [fl, fps, first, last, staticMask, anim, folderText, opts, grow, refs, reference,
              subjectHole](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    std::unique_ptr<FrameSource> src = open_frames(fl.file, 0, error);
    if (!src) fail(ErrorCode::decode, "cannot read '" + fl.file + "': " + error, {.layer = fl.layer});
    const int w = static_cast<int>(src->width());
    const int h = static_cast<int>(src->height());
    if (w <= 0 || h <= 0) fail(ErrorCode::decode, "the footage has no picture", {.layer = fl.layer});
    const double layerW = fl.width > 0 ? static_cast<double>(fl.width) : static_cast<double>(w);
    const double layerH = fl.height > 0 ? static_cast<double>(fl.height) : static_cast<double>(h);
    const auto px = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
    // A still is the same picture on every frame: ONE frame filled (the renderer shows the stored
    // fill nearest the time, so it holds). Filling all 300 frames of a 10 s comp took many minutes.
    const bool still = src->frame_count() <= 1;
    const std::int64_t end = still ? first : last;
    // Stop reaches inside the fill: one window of full-size frames runs for minutes.
    caf::SequenceOptions fill = opts;
    fill.cancelled = [&control] { return control.cancelled(); };

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

    // A subject fill over a still camera: the background the subject uncovers somewhere in the
    // range, as a clean plate (the fill alone carries one frame's guess through the shot).
    CleanPlate plate;
    if (subjectHole && !still) {  // a still uncovers nothing over time
      std::vector<std::vector<std::uint8_t>> sampleRgba;
      std::vector<std::vector<std::uint8_t>> sampleHole;
      // Sampled over the subject's whole tracked span (and the range): the more of the shot, the
      // more background some frame uncovers.
      const std::int64_t p0 = std::min(first, static_cast<std::int64_t>(std::llround(subjectHole->frames.front().first * fps)));
      const std::int64_t p1 = std::max(end, static_cast<std::int64_t>(std::llround(subjectHole->frames.back().first * fps)));
      const std::int64_t span = p1 - p0 + 1;
      const std::int64_t step = std::max<std::int64_t>(1, span / kPlateSamples);
      const int g = static_cast<int>(std::lround(grow > 0 ? grow * w / layerW : std::max(w, h) * 0.01));
      for (std::int64_t f = p0; f <= p1; f += step) {
        if (control.cancelled()) return nullptr;
        const double t = static_cast<double>(f) / fps;
        if (t < fl.in_seconds() || t >= fl.out_seconds()) continue;
        const std::int64_t sf = frame_at(fl.source_seconds(t), src->fps(), src->frame_count());
        if (sf < 0) continue;
        RgbaImage s;
        if (!src->read(sf, s, error)) fail(ErrorCode::decode, "frame " + std::to_string(sf) + ": " + error, {.layer = fl.layer});
        std::vector<std::uint8_t> hole(px, 0);
        if (const std::string* matte = subjectHole->at(t, fps); matte != nullptr) (void)subject_hole(hole, w, h, *matte, g, fl.layer);
        sampleRgba.push_back(std::move(s.rgba));
        sampleHole.push_back(std::move(hole));
        control.progress(0.1 * static_cast<double>(f - p0 + 1) / static_cast<double>(span), "Finding the background behind the subject");
      }
      plate = build_clean_plate(sampleRgba, sampleHole, w, h);
    }
    std::optional<caf::SequenceFrame> carry;  // the previous window's last frame, filled
    std::int64_t carryFrame = -2;
    const std::int64_t count = end - first + 1;
    RgbaImage img;
    for (std::int64_t w0 = first; w0 <= end; w0 += kWindow) {
      const std::int64_t w1 = std::min(end, w0 + kWindow - 1);
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
        int holes = 0;
        if (subjectHole) {
          // 1% of the long side by default: the matte's soft edge, a halo, motion blur.
          const int g = static_cast<int>(std::lround(grow > 0 ? grow * w / layerW : std::max(w, h) * 0.01));
          if (const std::string* matte = subjectHole->at(t, fps); matte != nullptr) holes = subject_hole(fr.hole, w, h, *matte, g, fl.layer);
        } else {
          const std::vector<caf::HolePath> paths = paths_of(mask_at(staticMask, anim, t), layerW, layerH, w, h, grow);
          holes = caf::raster_hole_paths(fr.hole, w, h, paths);
        }
        fr.rgba = std::move(img.rgba);
        img = RgbaImage{};
        // What the clean plate covers leaves the hole now; the rest is the fill's. The frame is
        // still written (it had a hole) even when the plate covered all of it.
        bool remaining = holes > 0;
        if (holes > 0 && !plate.empty()) {
          total.fromReference += lay_clean_plate(fr, plate, w, h);
          remaining = std::ranges::any_of(fr.hole, [](std::uint8_t v) { return v != 0; });
        }
        // A frame with nothing left to fill is a clean source for its neighbours.
        fr.anchor = !remaining;
        if (remaining) fr.reference = reference_for(f);
        frames.push_back(std::move(fr));
        index.push_back(holes > 0 ? f : -1);
        times.push_back(flicks_of(t));
        compFrame.push_back(f);
        // Reading is quick; the bar moves with the fill below (fill.progress), not with the reads.
        control.progress((subjectHole ? 0.1 : 0.0) + (subjectHole ? 0.8 : 0.9) * static_cast<double>(w0 - first) / static_cast<double>(count),
                         "Reading frame " + std::to_string(f - first + 1) + " of " + std::to_string(count));
      }
      if (frames.empty()) continue;
      const double base = (subjectHole ? 0.1 : 0.0) + (subjectHole ? 0.8 : 0.9) * static_cast<double>(w0 - first) / static_cast<double>(count);
      const double share = (subjectHole ? 0.8 : 0.9) * static_cast<double>(w1 - w0 + 1) / static_cast<double>(count);
      fill.progress = [&control, base, share, w0, w1, first, count](double k) {
        const auto done = std::min<std::int64_t>(w1 - first + 1, w0 - first + static_cast<std::int64_t>(std::llround(k * static_cast<double>(w1 - w0 + 1))));
        control.progress(base + share * k, "Filling frame " + std::to_string(std::max<std::int64_t>(1, done)) + " of " + std::to_string(count));
      };
      const caf::SequenceStats st = caf::fill_sequence(frames, w, h, fill);
      if (control.cancelled()) return nullptr;
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
