#include "child_export.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <memory>
#include <thread>
#include <utility>

#include "child_job.hpp"
#include "child_process.hpp"
#include "docio.hpp"
#include "fail.hpp"
#include "project_open.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

TempTree::TempTree(const std::string& prefix) {
  static std::atomic<std::uint64_t> seq{0};
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  path = fs::temp_directory_path() / prefix / (std::to_string(stamp) + "-" + std::to_string(++seq));
  std::error_code ec;
  fs::create_directories(path, ec);
  if (ec) fail(ErrorCode::io, "cannot create '" + path.string() + "': " + ec.message());
}

TempTree::~TempTree() {
  std::error_code ec;
  fs::remove_all(path, ec);
}

std::string snapshot_project_json(const doc::Document& d, const std::string& bundleRoot) {
  js::Json j = doc::capture_document(d);
  if (!bundleRoot.empty()) exporter::rewrite_blob_refs(j, fs::path(bundleRoot));
  return js::stringify(j);
}

std::optional<js::Json> run_child_export(const js::Json& job, const fs::path& workDir, JobControl& control, const std::string& label,
                                         double from, double to) {
  const std::string engineExe = child_executable();
  if (engineExe.empty()) {
    fail(ErrorCode::unsupported, "this engine does not know its own executable, so it cannot start a render child");
  }
  const fs::path jobFile = workDir / "job.json";
  {
    std::ofstream f(jobFile, std::ios::binary | std::ios::trunc);
    f << js::stringify(job);
    if (!f) fail(ErrorCode::io, "cannot write the render job");
  }
  std::string spawnError;
  std::unique_ptr<exporter::ChildProcess> child =
      exporter::ChildProcess::spawn(engineExe, {"--export", jobFile.string()}, (workDir / "engine.log").string(), spawnError, true);
  if (!child) fail(ErrorCode::internal, "could not start the render child: " + spawnError);

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
  std::optional<js::Json> preflight;
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
      std::optional<js::Json> ev = js::parse(line);
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
        } else {
          preflight = std::move(*ev);
        }
      } else if (kind == "progress") {
        const double k = ev->at("frame").is_number() ? ev->at("frame").num() : 0;
        const double total = ev->at("total").is_number() && ev->at("total").num() > 0 ? ev->at("total").num() : 1;
        control.progress(from + (to - from) * std::clamp(k / total, 0.0, 1.0), label);
      } else if (kind == "done") {
        finished = true;
      } else if (kind == "error") {
        failure = api::EngineError{};
        failure->code = ev->at("fallback").is_bool() && ev->at("fallback").b() ? ErrorCode::unsupported : ErrorCode::io;
        failure->message = ev->at("message").is_string() ? ev->at("message").str() : "the render child failed";
      }
    }
  }
  done = true;
  watcher.join();
  const int code = child->finish();
  if (killed.load() || control.cancelled()) return std::nullopt;
  if (failure) throw doc::EngineFail{std::move(*failure)};
  // An audio-only / preflight-only job ends at its preflight line with exit 0.
  const bool preflightOnly = (job.at("audioOnly").is_bool() && job.at("audioOnly").b()) ||
                             (job.at("preflightOnly").is_bool() && job.at("preflightOnly").b());
  if (code != 0 || !preflight || (!finished && !preflightOnly)) {
    fail(ErrorCode::internal, "the render child ended without finishing (exit " + std::to_string(code) + "; log: " +
                                  (workDir / "engine.log").string() + ")");
  }
  control.progress(to, label);
  return preflight;
}

std::optional<std::vector<RgbaImage>> render_layer_alone(const std::string& projectJson, const std::string& comp, const std::string& layer,
                                                        std::int64_t first, std::int64_t last, JobControl& control, const std::string& label,
                                                        double from, double to) {
  TempTree tree("premation-solo");
  const fs::path project = tree.path / "project.motion";
  {
    std::ofstream f(project, std::ios::binary | std::ios::trunc);
    f << projectJson;
    if (!f) fail(ErrorCode::io, "cannot write the render snapshot");
  }
  js::Json job = js::Json::object();
  job.set("projectPath", js::Json::string(project.string()));
  job.set("workDir", js::Json::string(tree.path.string()));
  job.set("comp", js::Json::string(comp));
  job.set("startFrame", js::Json::number(static_cast<double>(first)));
  job.set("endFrame", js::Json::number(static_cast<double>(last)));
  job.set("transparent", js::Json::boolean(true));
  job.set("audio", js::Json::boolean(false));
  job.set("depth", js::Json::number(8));
  job.set("sequence", js::Json::string("png"));
  job.set("isolateLayer", js::Json::string(layer));
  const double mid = from + (to - from) * 0.8;
  if (!run_child_export(job, tree.path, control, label, from, mid)) return std::nullopt;
  std::optional<std::vector<RgbaImage>> frames = read_png_frames(tree.path, control, label, mid, to);
  if (frames && frames->size() != static_cast<std::size_t>(last - first + 1)) {
    fail(ErrorCode::internal, "the solo render wrote " + std::to_string(frames->size()) + " frames, not " +
                                  std::to_string(last - first + 1));
  }
  return frames;
}

std::optional<std::vector<RgbaImage>> read_png_frames(const fs::path& workDir, JobControl& control, const std::string& label, double from,
                                                      double to) {
  std::vector<fs::path> pngs;
  const fs::path framesDir = workDir / "frames";
  std::error_code ec;
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
    control.progress(from + (to - from) * (static_cast<double>(i) + 1) / static_cast<double>(pngs.size()), label);
  }
  return frames;
}

}  // namespace premation::jobs
