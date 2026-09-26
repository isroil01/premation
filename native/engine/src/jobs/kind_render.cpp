// render / prerender: the F1 export path as an engine job. Each render queue
// item (or pre-rendered composition) is rendered by a CHILD engine,
//
//   premation-engine --export JOB.json      (export/export_job.hpp)
//
// with this engine as its supervisor: the document is snapshotted on the core
// thread (footage `motion-blob:` refs resolved to the bundle's files), the
// child's preflight answers the frame size / rate / audio, the encoder command
// line is export's own (encode_args.hpp — ffmpegEncodeArgs.ts ported), and the
// finished file is moved to its output path. A composition the scene builder
// cannot render yet fails the job with the preflight's reasons (the page's
// Chromium fallback lives in the export supervisor, not here). A crash of the
// child fails the job; the engine keeps running. prerender imports what it
// rendered (one undoable entry).
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "child_job.hpp"
#include "child_process.hpp"
#include "docio.hpp"
#include "encode_args.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "json.hpp"
#include "model.hpp"
#include "project_open.hpp"
#include "readmodel.hpp"
#include "scene.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

namespace {

/// One composition to render to one file.
struct RenderUnit {
  std::string comp;
  std::string compName;
  std::string format;      ///< mp4 | mov | webm | gif | png | jpg | exr (sequences zipped)
  std::string proresProfile = "4444";
  std::string quality = "high";
  std::string output;
  std::optional<std::int64_t> startFrame;
  std::optional<std::int64_t> endFrame;
  std::optional<double> fps;
  std::optional<double> width;
  std::optional<double> height;
  bool alpha = false;
  bool audio = true;
  int depth = 8;
};

bool is_sequence(const std::string& f) { return f == "png" || f == "jpg" || f == "exr"; }

/// RenderSettings.format ids (getCapabilities: 'mp4-h264', 'mov-prores', 'webm-vp9', 'png-seq', 'gif', and the page's names).
bool map_format(const std::string& id, RenderUnit& u) {
  if (id == "mp4" || id == "mp4-h264") u.format = "mp4";
  else if (id == "webm" || id == "webm-vp9") u.format = "webm";
  else if (id == "gif") u.format = "gif";
  else if (id == "png-seq" || id == "png-sequence") u.format = "png";
  else if (id == "jpg-seq" || id == "jpg-sequence") u.format = "jpg";
  else if (id == "exr-seq" || id == "exr-sequence") u.format = "exr";
  else if (id == "mov" || id.starts_with("mov-prores")) {
    u.format = "mov";
    const std::string p = id.size() > 10 ? id.substr(10) : "";
    if (p == "proxy" || p == "lt" || p == "422" || p == "hq" || p == "4444") u.proresProfile = p;
  } else {
    return false;
  }
  return true;
}

std::string quality_of(double q) {
  if (q >= 67 || q <= 0) return "high";
  return q >= 34 ? "medium" : "draft";
}

std::string extension_of(const RenderUnit& u) { return is_sequence(u.format) ? "zip" : u.format; }

/// Render one unit through a child engine. Returns the delivered path, or nullopt when cancelled.
std::optional<std::string> render_unit(const RenderUnit& u, const std::string& projectJson, const fs::path& workDir,
                                       JobControl& control, double from, double span) {
  std::error_code ec;
  fs::create_directories(workDir, ec);
  if (ec) fail(ErrorCode::io, "cannot create '" + workDir.string() + "': " + ec.message());
  const fs::path project = workDir / "project.motion";
  {
    std::ofstream f(project, std::ios::binary | std::ios::trunc);
    f << projectJson;
    if (!f) fail(ErrorCode::io, "cannot write the render snapshot");
  }
  js::Json job = js::Json::object();
  job.set("projectPath", js::Json::string(project.string()));
  job.set("workDir", js::Json::string(workDir.string()));
  job.set("comp", js::Json::string(u.comp));
  if (u.startFrame) job.set("startFrame", js::Json::number(static_cast<double>(*u.startFrame)));
  if (u.endFrame) job.set("endFrame", js::Json::number(static_cast<double>(*u.endFrame)));
  if (u.fps) job.set("fps", js::Json::number(*u.fps));
  if (u.width) job.set("width", js::Json::number(*u.width));
  if (u.height) job.set("height", js::Json::number(*u.height));
  job.set("transparent", js::Json::boolean(u.alpha));
  job.set("audio", js::Json::boolean(u.audio && u.format != "gif" && !is_sequence(u.format)));
  job.set("depth", js::Json::number(u.depth));
  if (is_sequence(u.format)) job.set("sequence", js::Json::string(u.format + "-zip"));
  const fs::path jobFile = workDir / "job.json";
  {
    std::ofstream f(jobFile, std::ios::binary | std::ios::trunc);
    f << js::stringify(job);
    if (!f) fail(ErrorCode::io, "cannot write the render job");
  }
  const std::string engineExe = child_executable();
  if (engineExe.empty()) fail(ErrorCode::unsupported, "this engine does not know its own executable, so it cannot start a render");
  std::string error;
  std::unique_ptr<exporter::ChildProcess> child =
      exporter::ChildProcess::spawn(engineExe, {"--export", jobFile.string()}, (workDir / "engine.log").string(), error, true);
  if (!child) fail(ErrorCode::internal, "could not start the render process: " + error);
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
  const fs::path encoded = is_sequence(u.format) ? workDir / ("frames." + u.format + ".zip") : workDir / ("out." + u.format);
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
          continue;
        }
        if (is_sequence(u.format)) continue;  // no encoder: the child writes the archive itself
        const double w = ev->at("width").is_number() ? ev->at("width").num() : 1920;
        const double h = ev->at("height").is_number() ? ev->at("height").num() : 1080;
        const double fps = ev->at("fps").is_number() ? ev->at("fps").num() : 30;
        const bool alpha = ev->at("alpha").is_bool() && ev->at("alpha").b();
        const int depth = ev->at("depth").is_number() && ev->at("depth").num() == 16 ? 16 : 8;
        encode::Options o;
        o.format = u.format;
        o.videoInput = encode::raw_video_input(w, h, fps, depth == 16);
        o.frame = encode::Options::Frame{w, h, fps};
        o.quality = u.quality;
        o.proresProfile = u.proresProfile;
        if (ev->at("audio").is_string()) o.audio = ev->at("audio").str();
        o.alpha = alpha;
        o.tagSrgb = true;
        o.out = encoded.string();
        js::Json args = js::Json::array();
        for (const std::string& a : encode::build_encode_args(o)) args.arr_mut().push_back(js::Json::string(a));
        js::Json enc = js::Json::object();
        enc.set("bin", js::Json::string(ffmpeg_executable()));
        enc.set("args", std::move(args));
        js::Json msg = js::Json::object();
        msg.set("encode", std::move(enc));
        const std::string text = js::stringify(msg) + "\n";
        (void)child->write(std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(text.data()), text.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      } else if (kind == "progress") {
        const double k = ev->at("frame").is_number() ? ev->at("frame").num() : 0;
        const double total = ev->at("total").is_number() && ev->at("total").num() > 0 ? ev->at("total").num() : 1;
        control.progress(from + span * std::clamp(k / total, 0.0, 1.0), "Rendering " + u.compName);
      } else if (kind == "done") {
        finished = true;
      } else if (kind == "error") {
        failure = api::EngineError{};
        failure->code = ErrorCode::io;
        failure->message = ev->at("message").is_string() ? ev->at("message").str() : "the render failed";
      }
    }
  }
  done = true;
  watcher.join();
  const int code = child->finish();
  if (killed.load() || control.cancelled()) return std::nullopt;
  if (failure) throw doc::EngineFail{std::move(*failure)};
  if (!finished || code != 0) {
    fail(ErrorCode::internal, "the render process ended without finishing (exit " + std::to_string(code) + "; log: " +
                                  (workDir / "engine.log").string() + ")");
  }
  // Deliver: rename, or copy across volumes (engineExport.ts deliver).
  const fs::path target(u.output);
  fs::create_directories(target.parent_path(), ec);
  ec.clear();
  fs::rename(encoded, target, ec);
  if (ec) {
    ec.clear();
    fs::copy_file(encoded, target, fs::copy_options::overwrite_existing, ec);
    if (ec) fail(ErrorCode::io, "cannot move the render to '" + target.string() + "': " + ec.message());
  }
  fs::remove_all(workDir, ec);
  return target.string();
}

class RenderResult final : public JobResult {
 public:
  std::vector<std::string> outputs;
  bool import = false;
  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"outputs\":[";
    for (std::size_t i = 0; i < outputs.size(); ++i) s += (i > 0 ? "," : "") + json_string(outputs[i]);
    return s + "]}";
  }
  [[nodiscard]] std::string label() const override { return "Pre-render"; }
  [[nodiscard]] bool has_edits() const override {
    return import && std::any_of(outputs.begin(), outputs.end(), [](const std::string& o) { return !o.ends_with(".zip"); });
  }
  void apply(JobApply& a) const override {
    api::ImportFiles imp;
    for (const std::string& o : outputs) {
      if (o.ends_with(".zip")) continue;  // a zipped image sequence is a delivery, not footage
      api::ImportFile f;
      f.path = o;
      imp.files.push_back(std::move(f));
    }
    (void)a.run(command(std::move(imp)));
  }
};

/// The document as the child opens it: footage in the bundle resolved to files.
std::string snapshot(const JobDocContext& ctx) {
  js::Json doc = doc::capture_document(ctx.doc);
  if (!ctx.bundleRoot.empty()) exporter::rewrite_blob_refs(doc, fs::path(ctx.bundleRoot));
  return js::stringify(doc);
}

fs::path work_root() {
  static std::atomic<std::uint64_t> seq{0};
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return fs::temp_directory_path() / "premation-render" / (std::to_string(stamp) + "-" + std::to_string(++seq));
}

PreparedJob render_units(std::string kind, std::vector<RenderUnit> units, std::string projectJson, bool import) {
  return PreparedJob{std::move(kind), [units = std::move(units), projectJson = std::move(projectJson), import](JobControl& control) -> std::unique_ptr<JobResult> {
    auto out = std::make_unique<RenderResult>();
    out->import = import;
    const fs::path root = work_root();
    const double span = 1.0 / static_cast<double>(units.size());
    for (std::size_t i = 0; i < units.size(); ++i) {
      const std::optional<std::string> file =
          render_unit(units[i], projectJson, root / std::to_string(i), control, static_cast<double>(i) * span, span);
      if (!file) return nullptr;
      out->outputs.push_back(*file);
    }
    std::error_code ec;
    fs::remove_all(root, ec);
    control.progress(1, "Done");
    return out;
  }};
}

}  // namespace

PreparedJob prepare_render(const api::RenderJob& spec, const JobDocContext& ctx) {
  const doc::RenderQueue& rq = ctx.doc.render_queue();
  std::vector<const api::RenderItemInfo*> items;
  if (spec.items.empty()) {
    for (const api::RenderItemInfo& r : rq) {
      if (r.queued) items.push_back(&r);
    }
  } else {
    for (const std::string& id : spec.items) {
      const auto it = std::find_if(rq.begin(), rq.end(), [&id](const api::RenderItemInfo& r) { return r.id == id; });
      if (it == rq.end()) fail(ErrorCode::not_found, "no render queue item '" + id + "'");
      items.push_back(&*it);
    }
  }
  if (items.empty()) fail(ErrorCode::invalid_argument, "nothing is queued to render");
  std::vector<RenderUnit> units;
  for (const api::RenderItemInfo* r : items) {
    RenderUnit u;
    u.comp = r->comp;
    if (!doc::is_comp_item(ctx.doc, u.comp)) fail(ErrorCode::not_found, "render item '" + r->id + "' names no composition");
    const api::CompSettings cs = doc::comp_settings(ctx.doc, u.comp);
    u.compName = cs.name;
    if (!map_format(r->settings.format, u)) {
      fail(ErrorCode::unsupported, "render item '" + r->id + "': the engine cannot write '" + r->settings.format + "'");
    }
    if (r->settings.output_path.empty()) fail(ErrorCode::invalid_argument, "render item '" + r->id + "' has no output path");
    u.output = r->settings.output_path;
    u.quality = quality_of(r->settings.quality);
    const double fps = r->settings.frame_rate && r->settings.frame_rate->den > 0
                           ? static_cast<double>(r->settings.frame_rate->num) / r->settings.frame_rate->den
                           : static_cast<double>(cs.frame_rate.num) / std::max(1U, cs.frame_rate.den);
    if (r->settings.frame_rate) u.fps = fps;
    if (r->settings.range.duration > 0) {
      u.startFrame = static_cast<std::int64_t>(motion::js::round(seconds_of(r->settings.range.start) * fps));
      u.endFrame = static_cast<std::int64_t>(motion::js::round(seconds_of(r->settings.range.start + r->settings.range.duration) * fps)) - 1;
    }
    if (r->settings.width) u.width = *r->settings.width;
    if (r->settings.height) u.height = *r->settings.height;
    u.alpha = r->settings.include_alpha;
    u.audio = r->settings.include_audio;
    // 16 bits per channel: mov only (the export supervisor's rule).
    u.depth = u.format == "mov" && r->settings.bit_depth != api::BitDepth::u8 ? 16 : 8;
    units.push_back(std::move(u));
  }
  return render_units("render", std::move(units), snapshot(ctx), false);
}

PreparedJob prepare_prerender(const api::PrerenderJob& spec, const JobDocContext& ctx) {
  if (spec.comps.empty()) fail(ErrorCode::invalid_argument, "no compositions to pre-render");
  fs::path folder = spec.output_folder;
  if (folder.empty()) {
    folder = !ctx.projectPath.empty() ? fs::path(ctx.projectPath).parent_path() / "Pre-renders"
                                      : fs::temp_directory_path() / "premation-prerenders";
  }
  std::vector<RenderUnit> units;
  for (const std::string& comp : spec.comps) {
    if (!doc::is_comp_item(ctx.doc, comp)) fail(ErrorCode::not_found, "no composition '" + comp + "'", {.item = comp});
    RenderUnit u;
    u.comp = comp;
    const api::CompSettings cs = doc::comp_settings(ctx.doc, comp);
    u.compName = cs.name;
    if (!map_format(spec.format.empty() ? "mov" : spec.format, u)) {
      fail(ErrorCode::unsupported, "the engine cannot pre-render to '" + spec.format + "'");
    }
    u.alpha = cs.transparent;
    std::string stem = cs.name;
    for (char& c : stem) {
      if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') c = '-';
    }
    if (stem.empty()) stem = comp;
    u.output = (folder / (stem + "." + extension_of(u))).string();
    units.push_back(std::move(u));
  }
  return render_units("prerender", std::move(units), snapshot(ctx), true);
}

}  // namespace premation::jobs
