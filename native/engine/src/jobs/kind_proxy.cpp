// proxy: a low-resolution editing proxy for a footage item, transcoded by
// ffmpeg with the page's rule and arguments (src/core/assets/proxy.ts
// proxyResolution / proxyCodec / proxyEncodeArgs — halve until the long edge
// is ≤ 1920, even dimensions, H.264 yuv420p or VP9 yuva420p for alpha, GOP 12,
// no timing flags so frame N of the proxy is frame N of the source), written
// temp + rename, then attached with setProxy (one undoable entry).
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "child_process.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "json.hpp"
#include "model.hpp"
#include "scene.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

namespace {

constexpr double kTargetLongEdge = 1920;   // PROXY_TARGET_LONG_EDGE
constexpr double kMinSourceLongEdge = 1280;  // PROXY_MIN_SOURCE_LONG_EDGE

struct Size {
  int width = 0;
  int height = 0;
};

/// proxy.ts halveTo.
std::optional<Size> halve_to(double width, double height, double targetLongEdge, double minSourceLongEdge) {
  if (!std::isfinite(width) || !std::isfinite(height) || width <= 0 || height <= 0) return std::nullopt;
  if (std::max(width, height) <= minSourceLongEdge) return std::nullopt;
  double w = width;
  double h = height;
  do {
    w /= 2;
    h /= 2;
  } while (std::max(w, h) > targetLongEdge);
  const auto even = [](double n) { return static_cast<int>(std::max(2.0, motion::js::round(n / 2) * 2)); };
  return Size{even(w), even(h)};
}

/// proxy.ts proxyEncodeArgs (+ `-progress pipe:1 -nostats`, which changes nothing in the output).
std::vector<std::string> encode_args(const std::string& input, const std::string& output, Size size, bool hasAlpha) {
  std::vector<std::string> a{"-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", input,
                             "-vf", "scale=" + std::to_string(size.width) + ":" + std::to_string(size.height), "-an"};
  if (hasAlpha) {
    for (const char* x : {"-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "34", "-b:v", "0", "-g", "12", "-deadline", "realtime",
                          "-cpu-used", "5"}) {
      a.emplace_back(x);
    }
  } else {
    for (const char* x : {"-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-g", "12"}) a.emplace_back(x);
  }
  // The muxer from the name the file will have, not the temp name's extension.
  a.emplace_back("-f");
  a.emplace_back(hasAlpha ? "webm" : "mp4");
  a.push_back(output);
  return a;
}

class ProxyResult final : public JobResult {
 public:
  std::string item;
  std::string file;
  Size size;
  [[nodiscard]] std::string summary_json() const override {
    return "{\"path\":" + json_string(file) + ",\"width\":" + std::to_string(size.width) + ",\"height\":" + std::to_string(size.height) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Create Proxy"; }
  void apply(JobApply& a) const override {
    api::SetProxy p;
    p.item = item;
    p.path = file;
    p.enabled = true;
    (void)a.run(command(std::move(p)));
  }
};

}  // namespace

PreparedJob prepare_proxy(const api::ProxyJob& spec, const JobDocContext& ctx) {
  const js::Json* rec = doc::find_asset(ctx.doc, spec.item);
  if (rec == nullptr) fail(ErrorCode::not_found, "no footage item '" + spec.item + "'", {.item = spec.item});
  if (!(rec->at("type").is_string() && rec->at("type").str() == "video")) {
    fail(ErrorCode::invalid_argument, "only video footage gets a proxy", {.item = spec.item});
  }
  std::string file;
  if (rec->at("path").is_string()) file = resolve_footage_path(rec->at("path").str(), ctx.bundleRoot);
  if (file.empty() && rec->at("src").is_string()) file = resolve_footage_path(rec->at("src").str(), ctx.bundleRoot);
  if (file.empty()) fail(ErrorCode::unsupported, "the item's footage is session-only; the engine cannot read it", {.item = spec.item});
  const js::Json& md = rec->at("metadata");
  const double w = md.is_object() && md.at("width").is_number() ? md.at("width").num() : 0;
  const double h = md.is_object() && md.at("height").is_number() ? md.at("height").num() : 0;
  const bool hasAlpha = md.is_object() && md.at("hasAlpha").is_bool() && md.at("hasAlpha").b();
  const double durationSec = md.is_object() && md.at("duration").is_number() ? md.at("duration").num() : 0;
  const std::optional<Size> size = spec.max_edge ? halve_to(w, h, std::max<double>(2, *spec.max_edge), *spec.max_edge)
                                                 : halve_to(w, h, kTargetLongEdge, kMinSourceLongEdge);
  if (!size) fail(ErrorCode::invalid_argument, "this footage is small enough to edit without a proxy", {.item = spec.item});
  fs::path folder = spec.output_folder;
  if (folder.empty()) {
    folder = !ctx.projectPath.empty() ? fs::path(ctx.projectPath).parent_path() / "Proxies"
                                      : fs::temp_directory_path() / "premation-proxies";
  }
  const std::string ext = hasAlpha ? "webm" : "mp4";
  const fs::path target = folder / (spec.item + "_proxy." + ext);
  const std::string exe = ffmpeg_executable();
  const std::string item = spec.item;
  const Size sz = *size;
  return PreparedJob{"proxy", [item, file, target, sz, hasAlpha, durationSec, exe](JobControl& control) -> std::unique_ptr<JobResult> {
    std::error_code ec;
    fs::create_directories(target.parent_path(), ec);
    if (ec) fail(ErrorCode::io, "cannot create '" + target.parent_path().string() + "': " + ec.message());
    const fs::path temp = target.string() + ".partial";
    std::string error;
    std::unique_ptr<exporter::ChildProcess> ff =
        exporter::ChildProcess::spawn(exe, encode_args(file, temp.string(), sz, hasAlpha), target.string() + ".log", error, true);
    if (!ff) fail(ErrorCode::io, "could not start ffmpeg: " + error);
    std::atomic<bool> done{false};
    std::atomic<bool> killed{false};
    std::thread watcher([&] {
      while (!done.load()) {
        if (control.cancelled()) {
          killed = true;
          ff->kill();
          return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    });
    // `-progress pipe:1`: key=value lines; out_time_us is how far the encode is.
    std::string buffer;
    std::array<std::uint8_t, 4096> chunk{};
    for (;;) {
      const long n = ff->read_stdout(chunk);
      if (n <= 0) break;
      buffer.append(reinterpret_cast<const char*>(chunk.data()), static_cast<std::size_t>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      for (std::size_t nl = buffer.find('\n'); nl != std::string::npos; nl = buffer.find('\n')) {
        const std::string line = buffer.substr(0, nl);
        buffer.erase(0, nl + 1);
        if (line.rfind("out_time_us=", 0) == 0 && durationSec > 0) {
          const double us = std::strtod(line.c_str() + 12, nullptr);
          control.progress(std::clamp(us / 1e6 / durationSec, 0.0, 0.99), "Transcoding the proxy");
        }
      }
    }
    done = true;
    watcher.join();
    const int code = ff->finish();
    if (killed.load() || control.cancelled()) {
      fs::remove(temp, ec);
      return nullptr;
    }
    if (code != 0) {
      fs::remove(temp, ec);
      fail(ErrorCode::io, "ffmpeg could not make the proxy (exit " + std::to_string(code) + "; log: " + target.string() + ".log)");
    }
    fs::rename(temp, target, ec);
    if (ec) fail(ErrorCode::io, "cannot move the proxy into place: " + ec.message());
    fs::remove(target.string() + ".log", ec);
    auto out = std::make_unique<ProxyResult>();
    out->item = item;
    out->file = target.string();
    out->size = sz;
    control.progress(1, "Done");
    return out;
  }};
}

}  // namespace premation::jobs
