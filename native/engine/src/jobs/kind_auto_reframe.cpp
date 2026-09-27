// Job kind `autoReframe` — src/core/reframe/autoReframe.ts.
//
// The source composition is rendered by a child engine at 160 px wide and
// 12 fps (the same offline renderer export uses), then saliency and shot
// detection decide a pan. Apply builds a NEW composition holding the source
// as a precomp, scaled to cover, with that pan keyed on separated position.
// The source is not edited.
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "child_job.hpp"
#include "child_process.hpp"
#include "docio.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "project_open.hpp"
#include "readmodel.hpp"
#include "reframe_analyse.hpp"
#include "reframe_path.hpp"
#include "time_conv.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

namespace {

constexpr double kAnalysisWidth = 160;
constexpr double kAnalysisRate = 12;

bool blank(std::string_view s) {
  return std::all_of(s.begin(), s.end(), [](unsigned char ch) { return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'; });
}

struct PanKey {
  bool axisY = false;
  api::Time time = 0;
  double value = 0;
  api::Easing easing = api::Easing::linear;
};

struct Request {
  std::string sourceId;
  std::string sourceName;
  double sourceW = 0;
  double sourceH = 0;
  double fps = 30;
  double duration = 0;
  double startFrame = 0;
  api::Color background{};
  bool transparent = false;
  std::uint32_t targetW = 0;
  std::uint32_t targetH = 0;
  std::string name;
  double deadZone = 0.12;
  double lagSeconds = 0.5;
  std::string projectJson;
};

struct TempTree {
  fs::path path;
  TempTree() = default;
  ~TempTree() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
  TempTree(const TempTree&) = delete;
  TempTree& operator=(const TempTree&) = delete;
  TempTree(TempTree&&) = delete;
  TempTree& operator=(TempTree&&) = delete;
};

fs::path work_root() {
  static std::atomic<std::uint64_t> seq{0};
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return fs::temp_directory_path() / "premation-reframe" / (std::to_string(stamp) + "-" + std::to_string(++seq));
}

/// Render the composition to a PNG sequence and read it back. nullopt when cancelled.
std::optional<std::vector<RgbaImage>> render_analysis(const Request& req, JobControl& control) {
  const std::string engineExe = child_executable();
  if (engineExe.empty()) {
    fail(ErrorCode::unsupported, "this engine does not know its own executable, so it cannot render a composition to reframe");
  }
  const double analysisW = std::max(16.0, kAnalysisWidth);
  const double analysisH = std::max(16.0, motion::js::round(analysisW * req.sourceH / req.sourceW));
  TempTree tree;
  tree.path = work_root();
  std::error_code ec;
  fs::create_directories(tree.path, ec);
  if (ec) fail(ErrorCode::io, "cannot create '" + tree.path.string() + "': " + ec.message());
  const fs::path project = tree.path / "project.motion";
  {
    std::ofstream f(project, std::ios::binary | std::ios::trunc);
    f << req.projectJson;
    if (!f) fail(ErrorCode::io, "cannot write the reframe snapshot");
  }
  js::Json job = js::Json::object();
  job.set("projectPath", js::Json::string(project.string()));
  job.set("workDir", js::Json::string(tree.path.string()));
  job.set("comp", js::Json::string(req.sourceId));
  job.set("fps", js::Json::number(kAnalysisRate));
  job.set("width", js::Json::number(analysisW));
  job.set("height", js::Json::number(analysisH));
  job.set("transparent", js::Json::boolean(req.transparent));
  job.set("audio", js::Json::boolean(false));
  job.set("depth", js::Json::number(8));
  job.set("sequence", js::Json::string("png"));
  const fs::path jobFile = tree.path / "job.json";
  {
    std::ofstream f(jobFile, std::ios::binary | std::ios::trunc);
    f << js::stringify(job);
    if (!f) fail(ErrorCode::io, "cannot write the reframe render job");
  }
  std::string spawnError;
  std::unique_ptr<exporter::ChildProcess> child =
      exporter::ChildProcess::spawn(engineExe, {"--export", jobFile.string()}, (tree.path / "engine.log").string(), spawnError, true);
  if (!child) fail(ErrorCode::internal, "could not start the reframe render: " + spawnError);

  std::atomic<bool> done{false};
  std::atomic<bool> killed{false};
  std::thread watcher([&] {
    while (!done.load()) {
      if (control.cancelled()) {
        killed = true;
        child->kill();
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  });

  std::optional<api::EngineError> failure;
  bool finished = false;
  std::string buffer;
  std::array<std::uint8_t, 8192> chunk{};
  for (;;) {
    const long n = child->read_stdout(chunk);
    if (n <= 0) break;
    buffer.append(reinterpret_cast<const char*>(chunk.data()), static_cast<std::size_t>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    for (std::size_t nl = buffer.find('\n'); nl != std::string::npos; nl = buffer.find('\n')) {
      const std::string line = buffer.substr(0, nl);
      buffer.erase(0, nl + 1);
      const std::optional<js::Json> ev = js::parse(line);
      if (!ev || !ev->is_object() || !ev->at("ev").is_string()) continue;
      const std::string kind = ev->at("ev").str();
      if (kind == "preflight") {
        if (!ev->at("ok").is_bool() || !ev->at("ok").b()) {
          std::string why = ev->at("reason").is_string() ? ev->at("reason").str() : "the composition cannot be rendered by the engine";
          if (ev->at("unported").is_array() && !ev->at("unported").arr().empty()) {
            const js::Json& first = ev->at("unported").arr().front();
            if (first.at("reason").is_string()) why += " (" + first.at("reason").str() + ")";
          }
          failure = api::EngineError{};
          failure->code = ErrorCode::unsupported;
          failure->message = why;
        }
      } else if (kind == "progress") {
        const double k = ev->at("frame").is_number() ? ev->at("frame").num() : 0;
        const double total = ev->at("total").is_number() && ev->at("total").num() > 0 ? ev->at("total").num() : 1;
        control.progress(0.85 * std::clamp(k / total, 0.0, 1.0), "Rendering " + req.sourceName);
      } else if (kind == "done") {
        finished = true;
      } else if (kind == "error") {
        failure = api::EngineError{};
        failure->code = ev->at("fallback").is_bool() && ev->at("fallback").b() ? ErrorCode::unsupported : ErrorCode::io;
        failure->message = ev->at("message").is_string() ? ev->at("message").str() : "the reframe render failed";
      }
    }
  }
  done = true;
  watcher.join();
  const int code = child->finish();
  if (killed.load() || control.cancelled()) return std::nullopt;
  if (failure) throw doc::EngineFail{std::move(*failure)};
  if (!finished || code != 0) {
    fail(ErrorCode::internal, "the reframe render ended without finishing (exit " + std::to_string(code) + "; log: " +
                                  (tree.path / "engine.log").string() + ")");
  }

  std::vector<fs::path> pngs;
  const fs::path framesDir = tree.path / "frames";
  for (fs::directory_iterator it(framesDir, ec), end; !ec && it != end; it.increment(ec)) {
    if (!it->is_regular_file()) continue;
    const std::string filename = it->path().filename().string();
    if (filename.starts_with("frame_") && filename.ends_with(".png")) pngs.push_back(it->path());
  }
  std::sort(pngs.begin(), pngs.end());
  std::vector<RgbaImage> frames;
  frames.reserve(pngs.size());
  for (std::size_t i = 0; i < pngs.size(); ++i) {
    if (control.cancelled()) return std::nullopt;
    std::string decodeError;
    const std::unique_ptr<FrameSource> src = open_frames(pngs[i].string(), 0, decodeError);
    if (!src) fail(ErrorCode::io, "cannot read '" + pngs[i].string() + "': " + decodeError);
    RgbaImage image;
    if (!src->read(0, image, decodeError)) fail(ErrorCode::io, "cannot read '" + pngs[i].string() + "': " + decodeError);
    frames.push_back(std::move(image));
    control.progress(0.85 + 0.15 * (static_cast<double>(i) + 1) / static_cast<double>(pngs.size()), "Analysing " + req.sourceName);
  }
  return frames;
}

class AutoReframeResult final : public JobResult {
 public:
  AutoReframeResult(Request req, std::vector<PanKey> keys, int samples, int cuts)
      : req_(std::move(req)), keys_(std::move(keys)), samples_(samples), cuts_(cuts) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"samples\":" + std::to_string(samples_) + ",\"cuts\":" + std::to_string(cuts_) +
                    ",\"keyframes\":" + std::to_string(keys_.size());
    if (!compId_.empty()) s += ",\"comp\":" + json_string(compId_) + ",\"layer\":" + json_string(layerId_);
    s += "}";
    return s;
  }
  [[nodiscard]] std::string label() const override { return "Auto-reframe"; }

  void apply(JobApply& a) const override {
    api::CreateComposition made;
    made.settings.name = req_.name;
    made.settings.width = req_.targetW;
    made.settings.height = req_.targetH;
    if (std::isfinite(req_.fps) && req_.fps == std::trunc(req_.fps) && req_.fps >= 1 && req_.fps <= 999) {
      made.settings.frame_rate = api::Rational{static_cast<std::uint32_t>(req_.fps), 1};
    } else {
      const double n = motion::js::round(req_.fps * 1000);
      made.settings.frame_rate = api::Rational{static_cast<std::uint32_t>(std::clamp(n, 1.0, 4294967295.0)), 1000};
    }
    made.settings.duration = doc::seconds_to_flicks(req_.duration);
    made.settings.background = req_.background;
    made.settings.transparent = req_.transparent;
    if (req_.startFrame != 0 && req_.fps > 0) made.settings.start_timecode = doc::seconds_to_flicks(req_.startFrame / req_.fps);
    const std::optional<api::ItemRef> comp = result_payload<api::ItemRef>(a.run(command(std::move(made))));
    if (!comp) fail(ErrorCode::internal, "createComposition returned no composition");
    compId_ = comp->item;

    const reframe::Geometry geometry{req_.sourceW, req_.sourceH, static_cast<double>(req_.targetW), static_cast<double>(req_.targetH)};
    const double scale = reframe::cover_scale(geometry) * 100;
    api::CreateLayer layer;
    layer.comp = compId_;
    layer.kind = api::LayerKind::precomp;
    layer.source = req_.sourceId;
    layer.init.push_back(api::PropertyInit{"transform/scale", doc::v_vec2(scale, scale)});
    const std::optional<api::LayerRef> node = result_payload<api::LayerRef>(a.run(command(std::move(layer))));
    if (!node) fail(ErrorCode::internal, "createLayer returned no layer");
    layerId_ = node->layer;

    if (keys_.empty()) return;
    api::SetDimensionsSeparated sep;
    sep.layer = layerId_;
    sep.path = "transform/position";
    sep.separated = true;
    (void)a.run(command(std::move(sep)));
    api::AddKeyframes add;
    for (const PanKey& k : keys_) {
      api::KeyframeInsert ins;
      ins.prop = api::PropRef{layerId_, k.axisY ? "transform/position/y" : "transform/position/x"};
      ins.time = k.time;
      ins.value = doc::v_scalar(k.value);
      ins.easing = k.easing;
      add.keys.push_back(std::move(ins));
    }
    (void)a.run(command(std::move(add)));
  }

 private:
  Request req_;
  std::vector<PanKey> keys_;
  int samples_ = 0;
  int cuts_ = 0;
  mutable std::string compId_;
  mutable std::string layerId_;
};

std::vector<PanKey> pan_keys(const reframe::XYPath& path, const std::vector<int>& cuts, double sampleRate, double centreX, double centreY) {
  std::vector<PanKey> keys;
  const auto axis = [&](bool y, const std::vector<double>& values, double centre) {
    for (const reframe::PathKeyframe& k : reframe::path_to_keyframes(values, cuts, sampleRate)) {
      PanKey key;
      key.axisY = y;
      key.time = doc::seconds_to_flicks(k.t);
      key.value = centre + k.value;
      key.easing = k.easing == reframe::PathEase::step ? api::Easing::step : api::Easing::linear;
      keys.push_back(key);
    }
  };
  axis(false, path.x, centreX);
  axis(true, path.y, centreY);
  return keys;
}

}  // namespace

PreparedJob prepare_auto_reframe(const api::AutoReframeJob& spec, const JobDocContext& ctx) {
  const doc::Json* rec = ctx.doc.comp(spec.comp);
  if (rec == nullptr) fail(ErrorCode::not_found, "There is no composition to reframe.", {.item = spec.comp});
  if (spec.width < 4 || spec.height < 4 || spec.width > 30000 || spec.height > 30000) {
    fail(ErrorCode::out_of_range, "That target size is too small to render.");
  }
  if (spec.name && blank(*spec.name)) fail(ErrorCode::invalid_argument, "a composition name cannot be empty");

  Request req;
  req.sourceId = spec.comp;
  req.sourceName = rec->at("name").is_string() ? rec->at("name").str() : spec.comp;
  req.sourceW = rec->at("width").is_number() ? rec->at("width").num() : 0;
  req.sourceH = rec->at("height").is_number() ? rec->at("height").num() : 0;
  if (!(req.sourceW > 0) || !(req.sourceH > 0)) fail(ErrorCode::invalid_argument, "There is no composition to reframe.", {.item = spec.comp});
  req.fps = rec->at("fps").is_number() && rec->at("fps").num() > 0 ? rec->at("fps").num() : 30;
  req.duration = rec->at("durationSeconds").is_number() ? rec->at("durationSeconds").num() : 0;
  if (!(req.duration > 0)) fail(ErrorCode::invalid_argument, "There is no composition to reframe.", {.item = spec.comp});
  req.startFrame = rec->at("startFrame").is_number() ? rec->at("startFrame").num() : 0;
  req.background = doc::hex_to_color(rec->at("background"));
  req.transparent = rec->at("transparent").is_bool() && rec->at("transparent").b();
  req.targetW = spec.width;
  req.targetH = spec.height;
  req.name = spec.name ? *spec.name : req.sourceName + " " + std::to_string(spec.width) + "\xC3\x97" + std::to_string(spec.height);
  if (spec.dead_zone) req.deadZone = *spec.dead_zone;
  if (spec.lag_seconds) req.lagSeconds = *spec.lag_seconds;

  js::Json doc = doc::capture_document(ctx.doc);
  if (!ctx.bundleRoot.empty()) exporter::rewrite_blob_refs(doc, fs::path(ctx.bundleRoot));
  req.projectJson = js::stringify(doc);

  return PreparedJob{"autoReframe", [req = std::move(req)](JobControl& control) mutable -> std::unique_ptr<JobResult> {
    const std::optional<std::vector<RgbaImage>> frames = render_analysis(req, control);
    if (!frames) return nullptr;
    if (frames->empty()) fail(ErrorCode::internal, "Nothing could be analysed — the composition rendered no frames.");
    const reframe::Analysis analysis = reframe::analyse_frames(*frames);
    if (analysis.points.empty()) fail(ErrorCode::internal, "Nothing could be analysed — the composition rendered no frames.");
    reframe::PathOptions opts;
    opts.sampleRate = kAnalysisRate;
    opts.deadZone = req.deadZone;
    opts.lagSeconds = req.lagSeconds;
    const reframe::Geometry geometry{req.sourceW, req.sourceH, static_cast<double>(req.targetW), static_cast<double>(req.targetH)};
    const reframe::XYPath path = reframe::build_reframe_path(analysis.points, analysis.cuts, geometry, opts);
    std::vector<PanKey> keys =
        pan_keys(path, analysis.cuts, kAnalysisRate, static_cast<double>(req.targetW) / 2, static_cast<double>(req.targetH) / 2);
    const int samples = static_cast<int>(analysis.points.size());
    const int cuts = static_cast<int>(analysis.cuts.size());
    req.projectJson.clear();
    control.progress(1, "Done");
    return std::make_unique<AutoReframeResult>(std::move(req), std::move(keys), samples, cuts);
  }};
}

}  // namespace premation::jobs
