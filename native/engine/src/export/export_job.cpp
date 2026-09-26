#include "export_job.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

#include "child_process.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "engine_frames.hpp"
#include "fonts.hpp"
#include "exr_write.hpp"
#include "ffmetadata.hpp"
#include "frame_convert.hpp"
#include "jpeg_write.hpp"
#include "log.hpp"
#include "png_write.hpp"
#include "zip_write.hpp"
#include "model.hpp"
#include "native_scene.hpp"
#include "project_open.hpp"
#include "scene_finish.hpp"
#include "scene_renderer.hpp"
#include "scene_textures.hpp"
#include "text_measure.hpp"
#include "wav_write.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_config.hpp"
#include "media_system.hpp"
#include "media_textures.hpp"
#endif

namespace premation::exporter {
namespace fs = std::filesystem;
namespace sc = premation::scene;
namespace rs = premation::raster;
using js::Json;
using Clock = std::chrono::steady_clock;

namespace {

double ms_since(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

fs::path u8path(const std::string& s) { return fs::path(std::u8string(s.begin(), s.end())); }

// ── the control channel ─────────────────────────────────────────────────────

class Control {
 public:
  void emit(const Json& line) {
    const std::string s = js::stringify(line) + "\n";
    const std::lock_guard lock(m_);
    std::fwrite(s.data(), 1, s.size(), stdout);
    std::fflush(stdout);
  }

  /// Read stdin lines on a thread of its own: `encode`, `cancel`, EOF.
  void start_reader() {
    reader_ = std::thread([this] {
      std::string line;
      while (std::getline(std::cin, line)) {
        auto j = js::parse(line);
        if (!j || !j->is_object()) continue;
        if (j->at("cancel").b()) {
          cancel();
          continue;
        }
        const Json& enc = j->at("encode");
        if (enc.is_object() && enc.at("bin").is_string()) {
          std::vector<std::string> args;
          for (const Json& a : enc.at("args").arr()) {
            if (a.is_string()) args.push_back(a.str());
          }
          const std::lock_guard lock(m_);
          encodeBin_ = enc.at("bin").str();
          encodeArgs_ = std::move(args);
          cv_.notify_all();
        }
      }
      // EOF: the supervisor is gone (or closed our input) — nothing to deliver to.
      if (!done_.load()) cancel();
    });
    reader_.detach();  // blocked in getline; the process exit ends it
  }

  void cancel() {
    cancelled_.store(true);
    const std::lock_guard lock(m_);
    cv_.notify_all();
  }
  [[nodiscard]] bool cancelled() const noexcept { return cancelled_.load(); }
  void mark_done() noexcept { done_.store(true); }

  /// Wait for the encoder command (or a cancel). False = cancelled.
  bool wait_encode(std::string& bin, std::vector<std::string>& args) {
    std::unique_lock lock(m_);
    cv_.wait(lock, [&] { return cancelled_.load() || encodeBin_.has_value(); });
    if (cancelled_.load()) return false;
    bin = *encodeBin_;
    args = encodeArgs_;
    return true;
  }

 private:
  std::mutex m_;
  std::condition_variable cv_;
  std::thread reader_;
  std::atomic<bool> cancelled_{false};
  std::atomic<bool> done_{false};
  std::optional<std::string> encodeBin_;
  std::vector<std::string> encodeArgs_;
};

Json str_array(const std::vector<std::string>& v) {
  Json a = Json::array();
  for (const auto& s : v) a.arr_mut().push_back(Json::string(s));
  return a;
}

Json error_line(bool fallback, const std::string& message) {
  Json j = Json::object();
  j.set("ev", Json::string("error"));
  j.set("fallback", Json::boolean(fallback));
  j.set("message", Json::string(message));
  return j;
}

// ── fonts + one document per build worker ───────────────────────────────────

struct Fonts {
  std::unique_ptr<rs::FontSet> set;
  rs::CanvasOptions canvas;
  Fonts(const std::string& manifest, bool chromium, const std::vector<std::string>& families) {
    set = std::make_unique<rs::FontSet>(chromium ? rs::FontOptions::chromium_windows() : rs::FontOptions{});
    if (!manifest.empty()) {
      std::string err;
      if (!set->load_manifest(manifest, err)) {
        PREMATION_LOG(warn, "fonts_manifest").kv("error", err);
      }
    }
    std::set<std::string, std::less<>> seen;
    for (const char* g : {"Inter", "system-ui", "sans-serif", "serif", "monospace"}) {
      if (seen.emplace(g).second) (void)set->add_system_family(g);
    }
    for (const std::string& f : families) {
      if (seen.emplace(f).second) (void)set->add_system_family(f);
    }
    canvas.fonts = set.get();
    canvas.lcdGeometry = chromium;
  }
};

struct DocCopy {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  std::unique_ptr<doc::DocExprEnv> env;
  std::unique_ptr<Fonts> fonts;
  std::unique_ptr<sc::TextMeasurer> measurer;

  bool open(const OpenedProject& p, const std::string& comp, const JobSpec& job, const std::vector<std::string>& families,
            std::string& err) {
    try {
      (void)doc::restore_document(d, view, p.document, p.sessionAssets);
    } catch (const std::exception& e) {
      err = std::string("the project could not be opened: ") + e.what();
      return false;
    }
    // `thisComp` in expressions is the composition being rendered.
    view.tabComp = comp;
    env = std::make_unique<doc::DocExprEnv>(d, view, cache);
    fonts = std::make_unique<Fonts>(job.fontsManifest, job.chromiumProfile, families);
    measurer = sc::make_canvas_measurer(fonts->canvas);
    return true;
  }
  [[nodiscard]] sc::BuildContext ctx() { return sc::BuildContext{d, view, *env, cache, measurer.get(), {}}; }
};

// ── what the job renders (headlessRender.ts + offlineRenderer.ts) ───────────

struct Plan {
  std::string compId;
  std::string compName;
  double compW = 1920, compH = 1080;
  double fps = 30;
  double width = 1920, height = 1080;
  std::int64_t start = 0, end = 0;  // inclusive (resolveRange)
  bool alpha = false;
  /// Output bits per channel: 8 (rgba, the raw pipe) or 16 (rgba64le from a half-float surface).
  int depth = 8;
  sc::ViewSpec view;
  sc::CompOverrides overrides;
  [[nodiscard]] std::int64_t frames() const noexcept { return end - start + 1; }
};

/// resolveComposition: id, exact name, case-insensitive name; none = the first non-pristine comp.
std::string resolve_comp(const doc::Document& d, const std::string& sel) {
  const auto lower = [](std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  };
  if (!sel.empty()) {
    if (d.comp(sel) != nullptr) return sel;
    for (const auto& id : d.comps().keys()) {
      const Json* r = d.comp(id);
      if (r != nullptr && r->at("name").is_string() && r->at("name").str() == sel) return id;
    }
    const std::string l = lower(sel);
    for (const auto& id : d.comps().keys()) {
      const Json* r = d.comp(id);
      if (r != nullptr && r->at("name").is_string() && lower(r->at("name").str()) == l) return id;
    }
    return {};
  }
  for (const auto& id : d.comps().keys()) {
    const Json* r = d.comp(id);
    if (r != nullptr && !r->at("pristine").b()) return id;
  }
  return d.comps().empty() ? std::string() : d.comps().keys().front();
}

bool make_plan(const doc::Document& d, const JobSpec& job, Plan& p, std::string& err) {
  p.compId = resolve_comp(d, job.comp);
  const Json* rec = p.compId.empty() ? nullptr : d.comp(p.compId);
  if (rec == nullptr) {
    err = job.comp.empty() ? "the project has no composition" : "no composition named '" + job.comp + "'";
    return false;
  }
  p.compName = rec->at("name").is_string() ? rec->at("name").str() : p.compId;
  p.compW = rec->at("width").is_number() ? rec->at("width").num() : 1920;
  p.compH = rec->at("height").is_number() ? rec->at("height").num() : 1080;
  p.fps = job.fps.value_or(rec->at("fps").is_number() ? rec->at("fps").num() : 30);
  if (!(p.fps > 0)) {
    err = "invalid frame rate";
    return false;
  }
  // outputSize: one dimension given keeps the comp's aspect.
  if (job.width || job.height) {
    const double aspect = p.compW / p.compH;
    p.width = job.width.value_or(std::round(*job.height * aspect));
    p.height = job.height.value_or(std::round(*job.width / aspect));
  } else {
    p.width = p.compW;
    p.height = p.compH;
  }
  p.width = std::max(1.0, std::trunc(p.width));
  p.height = std::max(1.0, std::trunc(p.height));
  // resolveRange over frameCount(durationSec, fps).
  const double dur = rec->at("durationSeconds").is_number() ? rec->at("durationSeconds").num() : 10;
  const auto total = std::max<std::int64_t>(1, std::llround(dur * p.fps));
  p.start = std::max<std::int64_t>(0, job.startFrame.value_or(0));
  p.end = std::min<std::int64_t>(total - 1, job.endFrame.value_or(total - 1));
  p.end = std::max(p.start, p.end);
  p.alpha = job.transparent.value_or(rec->at("transparent").b());
  p.overrides.forExport = true;
  p.overrides.transparent = p.alpha;
  p.view = sc::export_view(p.width, p.height, p.compW, p.compH);
  // RGBA surface: the read-back rows are the raw pipe's channel order already.
  // 16-bit output draws the same display-encoded frame into a half-float surface.
  p.depth = job.depth;
  p.view.surfaceFormat = p.depth == 16 ? api::RenderTextureFormat::rgba16float : api::RenderTextureFormat::rgba8unorm;
  return true;
}

// ── build ───────────────────────────────────────────────────────────────────

struct Built {
  sc::NativeFrame nf;
  std::vector<std::string> reasons;  // why this frame cannot be rendered by the engine
};

std::unique_ptr<Built> build_frame(DocCopy& dc, const Plan& p, std::int64_t frame) {
  auto b = std::make_unique<Built>();
  const double t = static_cast<double>(frame) / p.fps;  // frameTimeAt: index / fps, exactly
  try {
    sc::BuildContext ctx = dc.ctx();
    b->nf = sc::build_native_frame(ctx, p.compId, t, p.view, true, {}, frame, p.overrides);
    plugins::finish_native_frame(ctx, p.compId, t, p.view, true, b->nf, nullptr);
  } catch (const std::exception& e) {
    b->reasons.push_back(std::string("frame build failed: ") + e.what());
    return b;
  }
  for (const sc::LayerError& e : b->nf.errors) {
    std::string r = e.stage == "snapshot" ? "snapshot error: " : "";
    r += e.message;
    if (!e.layerId.empty()) r += " (" + e.layerId + ")";
    b->reasons.push_back(std::move(r));
  }
  // Native plugins run in the viewport's host; the export job starts none.
  const std::function<bool(const std::vector<api::Renderable>&)> hasNative = [&](const std::vector<api::Renderable>& rs) {
    for (const auto& r : rs) {
      for (const auto& e : r.effects) {
        if (e.type == "native-plugin") return true;
      }
      if (hasNative(r.precomp_children)) return true;
    }
    return false;
  };
  if (hasNative(b->nf.file.scene.renderables)) b->reasons.emplace_back("native plugin effects (no plugin host in export)");
  return b;
}

// ── the pipeline ────────────────────────────────────────────────────────────

struct Stats {
  double openMs = 0, preflightMs = 0, audioMs = 0, gpuInitMs = 0, gpuWaitMs = 0, renderMs = 0, totalMs = 0;
  double buildMsSum = 0, prepareMsSum = 0, submitMsSum = 0, readbackMsSum = 0, writeMsSum = 0;
  double renderWaitBuildMs = 0, renderWaitWriterMs = 0;
  std::uint64_t rasterMisses = 0;
  unsigned buildThreads = 0;
  unsigned inFlight = 0;
};

/// A frame buffer on its way to the encoder.
struct OutFrame {
  std::int64_t index = 0;
  std::vector<std::uint8_t> rgba;
};

class Pipeline {
 public:
  Pipeline(const Plan& plan, std::vector<std::unique_ptr<DocCopy>>& docs, Control& ctl, Stats& stats)
      : plan_(plan), docs_(docs), ctl_(ctl), stats_(stats) {}

  /// Preflight: every frame of the range built once (in parallel), stopping at the
  /// first frames that are outside the port.
  bool preflight(std::vector<std::pair<std::int64_t, std::string>>& unported) {
    std::atomic<std::int64_t> next{plan_.start};
    std::atomic<bool> stop{false};
    std::mutex m;
    std::vector<std::jthread> pool;
    for (auto& dc : docs_) {
      pool.emplace_back([&, d = dc.get()] {
        for (std::int64_t i = next.fetch_add(1); i <= plan_.end && !stop.load() && !ctl_.cancelled(); i = next.fetch_add(1)) {
          const auto b = build_frame(*d, plan_, i);
          if (b->reasons.empty()) continue;
          const std::lock_guard lock(m);
          for (const auto& r : b->reasons) {
            if (unported.size() < 24) unported.emplace_back(i, r);
          }
          stop.store(true);
        }
      });
    }
    pool.clear();
    std::ranges::sort(unported);
    return unported.empty();
  }

  /// Render every frame into `sink` (called in frame order on the writer thread).
  /// Returns an exit code; `failure` says why when it is not kExitOk.
  int run(rg::SceneRenderer& renderer, sc::SceneTextures& textures, unsigned inFlight,
          const std::function<bool(const OutFrame&)>& sink, std::string& failure) {
    const std::size_t window = docs_.size() * 2 + inFlight + 2;
    const std::size_t frameBytes = static_cast<std::size_t>(plan_.width) * static_cast<std::size_t>(plan_.height) * (plan_.depth == 16 ? 8U : 4U);

    // Build workers: claim the next index while it is within `window` of the render cursor.
    std::vector<std::jthread> workers;
    for (auto& dc : docs_) {
      workers.emplace_back([this, window, d = dc.get()] {
        for (;;) {
          std::int64_t i = 0;
          {
            std::unique_lock lock(m_);
            cv_.wait(lock, [&] { return abort_ || claim_ > plan_.end || claim_ - cursor_ < static_cast<std::int64_t>(window); });
            if (abort_ || claim_ > plan_.end) return;
            i = claim_++;
          }
          const auto t0 = Clock::now();
          auto b = build_frame(*d, plan_, i);
          const double ms = ms_since(t0);
          const std::lock_guard lock(m_);
          stats_.buildMsSum += ms;
          ready_.emplace(i, std::move(b));
          cv_.notify_all();
        }
      });
    }

    // Writer: in order, straight to the encoder.
    std::deque<OutFrame> toWrite;
    std::vector<std::vector<std::uint8_t>> freeBuffers;
    for (std::size_t k = 0; k < inFlight + 2; ++k) freeBuffers.emplace_back(frameBytes);
    std::mutex wm;
    std::condition_variable wcv;
    bool writerDone = false;
    bool writerFailed = false;
    std::jthread writer([&] {
      for (;;) {
        OutFrame f;
        {
          std::unique_lock lock(wm);
          wcv.wait(lock, [&] { return !toWrite.empty() || writerDone; });
          if (toWrite.empty()) return;
          f = std::move(toWrite.front());
          toWrite.pop_front();
        }
        const auto t0 = Clock::now();
        const bool ok = sink(f);
        const double ms = ms_since(t0);
        {
          const std::lock_guard lock(wm);
          stats_.writeMsSum += ms;
          freeBuffers.push_back(std::move(f.rgba));
          if (!ok) writerFailed = true;
        }
        wcv.notify_all();
        if (!ok) return;
      }
    });

    int code = kExitOk;
    std::deque<std::pair<std::int64_t, rg::PendingReadback>> inflight;
    std::vector<rg::PendingReadback> spare;
    const auto finishOldest = [&]() -> bool {
      auto [index, pending] = std::move(inflight.front());
      inflight.pop_front();
      std::vector<std::uint8_t> buf;
      {
        const auto w0 = Clock::now();
        std::unique_lock lock(wm);
        wcv.wait(lock, [&] { return !freeBuffers.empty() || writerFailed; });
        stats_.renderWaitWriterMs += ms_since(w0);
        if (writerFailed) return false;
        buf = std::move(freeBuffers.back());
        freeBuffers.pop_back();
      }
      buf.resize(frameBytes);
      std::string err;
      const auto r0 = Clock::now();
      const bool ok = renderer.take_readback(
          pending,
          [&](std::span<const std::uint8_t> rows) {
            if (pending.half) {
              half_surface_to_rgba64(rows, pending.width, pending.height, pending.bytesPerRow, buf);
            } else {
              surface_to_straight_rgba(rows, pending.width, pending.height, pending.bytesPerRow, pending.bgra, buf);
            }
          },
          err);
      stats_.readbackMsSum += ms_since(r0);
      spare.push_back(std::move(pending));
      if (!ok) {
        failure = "GPU readback failed at frame " + std::to_string(index) + ": " + err;
        code = kExitFallback;
        return false;
      }
      {
        const std::lock_guard lock(wm);
        toWrite.push_back(OutFrame{index, std::move(buf)});
      }
      wcv.notify_all();
      return true;
    };

    for (std::int64_t i = plan_.start; i <= plan_.end && code == kExitOk; ++i) {
      if (ctl_.cancelled()) {
        code = kExitCancelled;
        break;
      }
      std::unique_ptr<Built> b;
      {
        const auto w0 = Clock::now();
        std::unique_lock lock(m_);
        cv_.wait(lock, [&] { return ready_.contains(i); });
        stats_.renderWaitBuildMs += ms_since(w0);
        b = std::move(ready_.at(i));
        ready_.erase(i);
        cursor_ = i + 1;
      }
      cv_.notify_all();
      if (!b->reasons.empty()) {
        failure = "frame " + std::to_string(i) + ": " + b->reasons.front();
        code = kExitFallback;
        break;
      }
      const auto p0 = Clock::now();
      textures.set_color_managed(b->nf.file.view.color_management.has_value());
      sc::PrepareStats ps;
      textures.prepare(b->nf.textures, b->nf.file.textures, ps);
      stats_.prepareMsSum += ms_since(p0);
      stats_.rasterMisses += ps.rasterMisses;
      if (!ps.unsupported.empty()) {
        failure = "frame " + std::to_string(i) + ": raster: " + ps.unsupported.front().second;
        code = kExitFallback;
        break;
      }
      rg::PendingReadback pending;
      if (!spare.empty()) {
        pending = std::move(spare.back());
        spare.pop_back();
      }
      rg::FrameStats fs;
      std::string err;
      const auto s0 = Clock::now();
      if (!renderer.render_submit(b->nf.file, pending, fs, err)) {
        failure = "frame " + std::to_string(i) + ": " + err;
        code = kExitFallback;
        break;
      }
      stats_.submitMsSum += ms_since(s0);
      // offlineRenderer.ts refuses a frame whose compositing could not be honoured.
      if (!fs.diagnostics.empty() || !fs.gpuError.empty()) {
        failure = "frame " + std::to_string(i) + ": " +
                  (fs.gpuError.empty() ? fs.diagnostics.front().detail : "GPU error: " + fs.gpuError);
        code = kExitFallback;
        break;
      }
      inflight.emplace_back(i, std::move(pending));
      if (inflight.size() >= inFlight && !finishOldest()) break;
    }
    while (code == kExitOk && !inflight.empty()) {
      if (!finishOldest()) break;
    }
    {
      const std::lock_guard lock(m_);
      abort_ = true;
    }
    cv_.notify_all();
    workers.clear();
    {
      const std::lock_guard lock(wm);
      writerDone = true;
    }
    wcv.notify_all();
    writer.join();
    if (code == kExitOk && writerFailed) {
      code = ctl_.cancelled() ? kExitCancelled : kExitFailed;
      if (failure.empty()) failure = "the encoder stopped accepting frames";
    }
    return code;
  }

 private:
  const Plan& plan_;
  std::vector<std::unique_ptr<DocCopy>>& docs_;
  Control& ctl_;
  Stats& stats_;
  std::mutex m_;
  std::condition_variable cv_;
  std::map<std::int64_t, std::unique_ptr<Built>> ready_;
  std::int64_t claim_ = 0;
  std::int64_t cursor_ = 0;
  bool abort_ = false;

 public:
  void reset_cursor() {
    claim_ = plan_.start;
    cursor_ = plan_.start;
  }
};

std::string tail_of(const fs::path& p, std::size_t n) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return {};
  std::ostringstream ss;
  ss << in.rdbuf();
  std::string s = ss.str();
  if (s.size() > n) s = s.substr(s.size() - n);
  return s;
}

}  // namespace

bool parse_job(const Json& j, JobSpec& out, std::string& error) {
  if (!j.is_object()) {
    error = "the job is not a JSON object";
    return false;
  }
  const auto str = [&](const char* k, std::string& dst, bool required) {
    const Json& v = j.at(k);
    if (v.is_string() && !v.str().empty()) {
      dst = v.str();
      return true;
    }
    if (required || !v.is_undefined()) {
      error = std::string("job: \"") + k + "\" must be a non-empty string";
      return false;
    }
    return true;
  };
  if (!str("projectPath", out.projectPath, true) || !str("workDir", out.workDir, true)) return false;
  if (!j.at("comp").is_undefined() && !str("comp", out.comp, false)) return false;
  if (!j.at("fontsManifest").is_undefined() && !str("fontsManifest", out.fontsManifest, false)) return false;
  for (const auto& [k, dst] : {std::pair<const char*, std::optional<std::int64_t>*>{"startFrame", &out.startFrame}, {"endFrame", &out.endFrame}}) {
    const Json& v = j.at(k);
    if (v.is_undefined() || v.is_null()) continue;
    if (!v.is_finite_number()) {
      error = std::string("job: \"") + k + "\" must be a number";
      return false;
    }
    *dst = static_cast<std::int64_t>(std::floor(v.num()));
  }
  for (const auto& [k, dst] : {std::pair<const char*, std::optional<double>*>{"fps", &out.fps}, {"width", &out.width}, {"height", &out.height}}) {
    const Json& v = j.at(k);
    if (v.is_undefined() || v.is_null()) continue;
    if (!v.is_finite_number() || !(v.num() > 0)) {
      error = std::string("job: \"") + k + "\" must be a positive number";
      return false;
    }
    *dst = v.num();
  }
  if (j.at("transparent").is_bool()) out.transparent = j.at("transparent").b();
  if (j.at("chromiumProfile").is_bool()) out.chromiumProfile = j.at("chromiumProfile").b();
  if (j.at("audio").is_bool()) out.audio = j.at("audio").b();
  if (!j.at("depth").is_undefined()) {
    if (!j.at("depth").is_number() || (j.at("depth").num() != 8 && j.at("depth").num() != 16)) {
      error = "job: \"depth\" must be 8 or 16";
      return false;
    }
    out.depth = static_cast<int>(j.at("depth").num());
  }
  if (j.at("preflightOnly").is_bool()) out.preflightOnly = j.at("preflightOnly").b();
  if (j.at("buildThreads").is_finite_number()) out.buildThreads = static_cast<unsigned>(std::clamp(j.at("buildThreads").num(), 0.0, 64.0));
  if (j.at("inFlight").is_finite_number()) out.inFlight = static_cast<unsigned>(std::clamp(j.at("inFlight").num(), 1.0, 8.0));
  const Json& enc = j.at("encode");
  if (enc.is_object()) {
    if (!enc.at("bin").is_string()) {
      error = "job: \"encode.bin\" must be a string";
      return false;
    }
    out.encodeBin = enc.at("bin").str();
    for (const Json& a : enc.at("args").arr()) {
      if (a.is_string()) out.encodeArgs.push_back(a.str());
    }
  }
  if (!j.at("sequence").is_undefined()) {
    if (!j.at("sequence").is_string()) {
      error = "job: \"sequence\" must be png, jpg, exr, or their -zip forms";
      return false;
    }
    const std::string& s = j.at("sequence").str();
    if (s != "png" && s != "jpg" && s != "exr" && s != "png-zip" && s != "jpg-zip" && s != "exr-zip") {
      error = "job: \"sequence\" must be png, jpg, exr, or their -zip forms";
      return false;
    }
    out.sequence = s;
  }
  if (j.at("chapters").is_array()) {
    for (const Json& c : j.at("chapters").arr()) {
      if (!c.at("startMs").is_finite_number() || !c.at("endMs").is_finite_number() || !c.at("title").is_string()) {
        error = "job: each chapter needs startMs, endMs, and title";
        return false;
      }
      out.chapters.push_back({{c.at("startMs").num(), c.at("endMs").num()}, c.at("title").str()});
    }
  }
  return true;
}

int run_export(const std::string& jobPath) {
  const auto tStart = Clock::now();
  ignore_broken_pipes();
  Control ctl;
  JobSpec job;
  {
    std::ifstream in(u8path(jobPath), std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    const auto j = js::parse(ss.str());
    std::string err;
    if (!in || !j || !parse_job(*j, job, err)) {
      ctl.emit(error_line(false, err.empty() ? "the export job file could not be read" : err));
      return kExitUsage;
    }
  }
  if (job.buildThreads == 0) {
    // Benches / the "8 cores" measurement: a thread count without touching the job file.
    if (const char* t = std::getenv("PREMATION_EXPORT_THREADS")) job.buildThreads = static_cast<unsigned>(std::strtoul(t, nullptr, 10));  // NOLINT(concurrency-mt-unsafe): read before any thread starts
  }
  if (job.fontsManifest.empty()) {
    if (const char* m = std::getenv("PREMATION_FONTS_MANIFEST")) job.fontsManifest = m;  // NOLINT(concurrency-mt-unsafe): read before any thread starts
  }
  if (!job.encodeBin && job.sequence.empty()) ctl.start_reader();

  // The GPU starts first, while the project opens and the preflight runs
  // (Dawn + the shader compiler: ~1 s). The renderer is used on this thread
  // only after the join — never concurrently.
  std::unique_ptr<rg::SceneRenderer> renderer;
  std::string gpuErr;
  double gpuInitMs = 0;
  std::jthread gpuInit;
  if (!job.preflightOnly) {
    rg::RendererOptions ro;
    ro.highPerformance = true;
    if (const char* v = std::getenv("PREMATION_EXPORT_GPU_VENDOR")) ro.vendorId = static_cast<std::uint32_t>(std::strtoul(v, nullptr, 0));  // NOLINT(concurrency-mt-unsafe): read before the thread starts
    gpuInit = std::jthread([&renderer, &gpuErr, &gpuInitMs, ro] {
      const auto t0 = Clock::now();
      renderer = rg::SceneRenderer::create(ro, gpuErr);
      gpuInitMs = ms_since(t0);
    });
  }

  // ── open + plan ──
  OpenedProject proj;
  std::string err;
  if (!open_project(u8path(job.projectPath), proj, err)) {
    ctl.emit(error_line(true, err));
    return kExitFallback;
  }
  auto first = std::make_unique<DocCopy>();
  {
    // The plan and the font families come from the first copy.
    try {
      (void)doc::restore_document(first->d, first->view, proj.document, proj.sessionAssets);
    } catch (const std::exception& e) {
      ctl.emit(error_line(true, std::string("the project could not be opened: ") + e.what()));
      return kExitFallback;
    }
  }
  Plan plan;
  if (!make_plan(first->d, job, plan, err)) {
    ctl.emit(error_line(false, err));
    return kExitFailed;
  }
  const std::vector<std::string> families = sc::document_font_families(first->d);
  const unsigned hw = std::max(1U, std::thread::hardware_concurrency());
  const unsigned threads = job.buildThreads != 0 ? job.buildThreads : std::clamp(hw / 2, 2U, 6U);
  const unsigned nThreads = static_cast<unsigned>(std::min<std::int64_t>(threads, plan.frames()));
  std::vector<std::unique_ptr<DocCopy>> docs;
  {
    first = std::make_unique<DocCopy>();
    if (!first->open(proj, plan.compId, job, families, err)) {
      ctl.emit(error_line(true, err));
      return kExitFallback;
    }
    docs.push_back(std::move(first));
    // The other copies load in parallel (a large document is a noticeable parse).
    std::vector<std::unique_ptr<DocCopy>> more(std::max(1U, nThreads) - 1);
    std::vector<std::string> errs(more.size());
    {
      std::vector<std::jthread> loaders;
      for (std::size_t k = 0; k < more.size(); ++k) {
        loaders.emplace_back([&, k] {
          more[k] = std::make_unique<DocCopy>();
          if (!more[k]->open(proj, plan.compId, job, families, errs[k])) more[k].reset();
        });
      }
    }
    for (auto& m : more) {
      if (m) docs.push_back(std::move(m));
    }
  }

  Stats stats;
  stats.openMs = ms_since(tStart);
  stats.buildThreads = static_cast<unsigned>(docs.size());
  stats.inFlight = job.inFlight;
  Pipeline pipeline(plan, docs, ctl, stats);

  // ── preflight ──
  {
    const auto t0 = Clock::now();
    std::vector<std::pair<std::int64_t, std::string>> unported;
    const bool ok = pipeline.preflight(unported);
    stats.preflightMs = ms_since(t0);
    if (ctl.cancelled()) return kExitCancelled;
    if (!ok) {
      Json j = Json::object();
      j.set("ev", Json::string("preflight"));
      j.set("ok", Json::boolean(false));
      j.set("reason", Json::string("frame " + std::to_string(unported.front().first) + ": " + unported.front().second));
      Json list = Json::array();
      for (const auto& [f, r] : unported) {
        Json u = Json::object();
        u.set("frame", Json::number(static_cast<double>(f)));
        u.set("reason", Json::string(r));
        list.arr_mut().push_back(std::move(u));
      }
      j.set("unported", std::move(list));
      j.set("ms", Json::number(stats.preflightMs));
      ctl.emit(j);
      return kExitFallback;
    }
  }

  // ── audio (exportAudioBytes: the picture's exact range, 48 kHz 16-bit WAV) ──
  std::vector<std::string> warnings;
  std::optional<std::string> audioPath;
  if (job.audio) {
    const auto t0 = Clock::now();
    sc::CompAudioMix mix;
    DocCopy& dc = *docs.front();
    const double startSec = static_cast<double>(plan.start) / plan.fps;
    const double endSec = static_cast<double>(plan.end + 1) / plan.fps;
    std::string aerr;
    if (!sc::mix_comp_audio(dc.d, dc.view, *dc.env, dc.cache, plan.compId, startSec, endSec, mix, aerr)) {
      // A comp with no audio engine behind it: the Chromium path mixes it.
      ctl.emit(error_line(true, "audio: " + aerr));
      return kExitFallback;
    }
    if (!mix.notes.empty()) {
      // Voices the E2 builder reports outside its port (audio effects, retimed
      // precomp audio): the Chromium path's mix is the reference.
      ctl.emit(error_line(true, "audio: " + mix.notes.front()));
      return kExitFallback;
    }
    if (mix.audible) {
      const fs::path wav = u8path(job.workDir) / "audio.wav";
      if (!write_wav16(wav, mix.channels, mix.sampleRate)) {
        ctl.emit(error_line(false, "could not write the audio mix to " + wav.string()));
        return kExitFailed;
      }
      const std::u8string s = wav.u8string();
      audioPath = std::string(s.begin(), s.end());
    }
    stats.audioMs = ms_since(t0);
  }

  {
    Json j = Json::object();
    j.set("ev", Json::string("preflight"));
    j.set("ok", Json::boolean(true));
    j.set("frames", Json::number(static_cast<double>(plan.frames())));
    j.set("startFrame", Json::number(static_cast<double>(plan.start)));
    j.set("width", Json::number(plan.width));
    j.set("height", Json::number(plan.height));
    j.set("fps", Json::number(plan.fps));
    j.set("comp", Json::string(plan.compId));
    j.set("compName", Json::string(plan.compName));
    j.set("alpha", Json::boolean(plan.alpha));
    j.set("depth", Json::number(plan.depth));
    j.set("audio", audioPath ? Json::string(*audioPath) : Json::null());
    j.set("warnings", str_array(warnings));
    j.set("ms", Json::number(stats.preflightMs));
    ctl.emit(j);
  }
  if (job.preflightOnly) {
    ctl.mark_done();
    return kExitOk;
  }

  // ── the encoder, or an image sequence ──
  if (!job.chapters.empty()) {
    std::vector<Chapter> chapters;
    chapters.reserve(job.chapters.size());
    for (const auto& c : job.chapters) chapters.push_back({c.first.first, c.first.second, c.second});
    std::ofstream meta(u8path(job.workDir) / "chapters.ffmeta", std::ios::binary);
    meta << format_ffmetadata(chapters);
  }
  const bool sequence = !job.sequence.empty();
  const bool asZip = job.sequence.size() > 4 && job.sequence.ends_with("-zip");
  const bool asExr = job.sequence == "exr" || job.sequence == "exr-zip";
  const bool asJpg = job.sequence == "jpg" || job.sequence == "jpg-zip";
  std::string bin = job.encodeBin.value_or("");
  std::vector<std::string> args = job.encodeArgs;
  if (!sequence && !job.encodeBin && !ctl.wait_encode(bin, args)) return kExitCancelled;

  // ── GPU ──
  const auto tGpu = Clock::now();
  if (gpuInit.joinable()) gpuInit.join();
  if (!renderer) {
    ctl.emit(error_line(true, "the GPU could not be started: " + gpuErr));
    return kExitFallback;
  }
  const Fonts renderFonts(job.fontsManifest, job.chromiumProfile, families);
  sc::SceneTextures::Options to;
  to.canvas = renderFonts.canvas;
  to.mediaBase = proj.mediaBase;
  sc::SceneTextures textures(to);
  textures.set_device(&renderer->device());
  textures.set_playing(false);
#if defined(PREMATION_HAVE_MEDIA)
  std::string decodeNote;
  media::MediaSystem mediaSystem(media::media_config_for(renderer->device().device(), decodeNote));
  media::MediaTextures mediaTex(mediaSystem, renderer->device().device(), media::MediaTextures::Mode::exact);
  mediaTex.set_exact_timeout(std::chrono::milliseconds(15000));
  textures.set_media(&mediaSystem, &mediaTex);
#endif
  renderer->set_external_textures(&textures);
  stats.gpuInitMs = gpuInitMs;
  stats.gpuWaitMs = ms_since(tGpu);

  const fs::path ffLog = u8path(job.workDir) / "ffmpeg.log";
  const fs::path framesDir = u8path(job.workDir) / "frames";
  std::unique_ptr<ChildProcess> child;
  ZipWriter zip;
  bool zipOpen = false;
  if (sequence) {
    std::error_code ec;
    if (asZip) {
      const char* zipName = asExr ? "frames.exr.zip" : asJpg ? "frames.jpg.zip" : "frames.png.zip";
      zipOpen = zip.open(u8path(job.workDir) / zipName);
      if (!zipOpen) {
        ctl.emit(error_line(false, "the sequence archive could not be created"));
        return kExitFailed;
      }
    } else if (!fs::create_directories(framesDir, ec) && !fs::is_directory(framesDir)) {
      ctl.emit(error_line(false, "the sequence directory could not be created"));
      return kExitFailed;
    }
  } else {
    child = ChildProcess::spawn(bin, args, ffLog.string(), err);
    if (!child) {
      ctl.emit(error_line(false, err));
      return kExitFailed;
    }
  }

  // ── render ──
  const auto tRender = Clock::now();
  std::int64_t written = 0;
  auto lastEmit = Clock::now() - std::chrono::seconds(1);
  const std::int64_t total = plan.frames();
  const auto wpx = static_cast<std::uint32_t>(plan.width);
  const auto hpx = static_cast<std::uint32_t>(plan.height);
  const auto sink = [&](const OutFrame& f) {
    if (ctl.cancelled()) return false;
    if (sequence) {
      std::string name = std::to_string(f.index);
      if (name.size() < 5) name.insert(0, 5 - name.size(), '0');
      name = "frame_" + name + (asExr ? ".exr" : asJpg ? ".jpg" : ".png");
      std::vector<std::uint8_t> bytes;
      if (asExr) {
        const auto row = wpx * (plan.depth == 16 ? 8U : 4U);
        std::vector<std::uint8_t> half(std::size_t{wpx} * hpx * 8);
        target_to_half_rgba(f.rgba, wpx, hpx, row, plan.depth == 16 ? LinearFormat::float16 : LinearFormat::unorm8, half);
        bytes = encode_exr_half(half, wpx, hpx);
      } else if (asJpg) {
        if (!encode_jpeg_rgba8(f.rgba, wpx, hpx, 0.92F, bytes)) return false;
      } else if (!encode_png_rgba8(f.rgba, wpx, hpx, bytes)) {
        return false;
      }
      if (asZip) {
        if (!zip.add(name, bytes)) return false;
      } else {
        std::ofstream out(framesDir / name, std::ios::binary);
        out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        if (!out) return false;
      }
    } else if (!child->write(f.rgba)) {
      return false;
    }
    ++written;
    const auto now = Clock::now();
    if (written == total || now - lastEmit >= std::chrono::milliseconds(100)) {
      lastEmit = now;
      Json j = Json::object();
      j.set("ev", Json::string("progress"));
      j.set("frame", Json::number(static_cast<double>(written)));
      j.set("total", Json::number(static_cast<double>(total)));
      ctl.emit(j);
    }
    return true;
  };
  pipeline.reset_cursor();
  std::string failure;
  const int code = pipeline.run(*renderer, textures, job.inFlight, sink, failure);
  stats.renderMs = ms_since(tRender);
  if (code != kExitOk) {
    if (child) child->kill();
    if (code == kExitCancelled || ctl.cancelled()) return kExitCancelled;
    if (code == kExitFailed) {
      const std::string tail = tail_of(ffLog, 600);
      failure += tail.empty() ? "" : ": " + tail;
    }
    ctl.emit(error_line(code == kExitFallback, failure));
    return code;
  }
  if (sequence) {
    if (asZip && !zip.finish()) {
      ctl.emit(error_line(false, "the sequence archive could not be finished"));
      return kExitFailed;
    }
  } else {
    const int ffCode = child->finish();
    if (ffCode != 0) {
      ctl.emit(error_line(false, "The encode failed: ffmpeg exited " + std::to_string(ffCode) + ": " + tail_of(ffLog, 600)));
      return kExitFailed;
    }
  }
  stats.totalMs = ms_since(tStart);
  ctl.mark_done();
  {
    const double n = static_cast<double>(std::max<std::int64_t>(1, total));
    Json s = Json::object();
    s.set("totalMs", Json::number(stats.totalMs));
    s.set("openMs", Json::number(stats.openMs));
    s.set("gpuInitMs", Json::number(stats.gpuInitMs));
    s.set("gpuWaitMs", Json::number(stats.gpuWaitMs));
    s.set("preflightMs", Json::number(stats.preflightMs));
    s.set("audioMs", Json::number(stats.audioMs));
    s.set("renderMs", Json::number(stats.renderMs));
    s.set("fps", Json::number(static_cast<double>(total) / std::max(1e-9, stats.renderMs / 1000)));
    s.set("buildMsPerFrame", Json::number(stats.buildMsSum / n));
    s.set("prepareMsPerFrame", Json::number(stats.prepareMsSum / n));
    s.set("submitMsPerFrame", Json::number(stats.submitMsSum / n));
    s.set("readbackMsPerFrame", Json::number(stats.readbackMsSum / n));
    s.set("writeMsPerFrame", Json::number(stats.writeMsSum / n));
    s.set("renderWaitBuildMs", Json::number(stats.renderWaitBuildMs));
    s.set("renderWaitWriterMs", Json::number(stats.renderWaitWriterMs));
    s.set("rasterMisses", Json::number(static_cast<double>(stats.rasterMisses)));
    s.set("buildThreads", Json::number(stats.buildThreads));
    s.set("inFlight", Json::number(stats.inFlight));
    s.set("adapter", Json::string(renderer->adapter()));
    Json j = Json::object();
    j.set("ev", Json::string("done"));
    j.set("frames", Json::number(static_cast<double>(total)));
    j.set("stats", std::move(s));
    ctl.emit(j);
  }
  return kExitOk;
}

}  // namespace premation::exporter
