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
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

#include "core/joining_thread.hpp"
#include "child_process.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "effects_port.hpp"
#include "engine_frames.hpp"
#include "fonts.hpp"
#include "exr_write.hpp"
#include "tiff_dpx_write.hpp"
#include "ffmetadata.hpp"
#include "frame_convert.hpp"
#include "hdr_convert.hpp"
#include "jpeg_write.hpp"
#include "log.hpp"
#include "png_write.hpp"
#include "zip_write.hpp"
#include "contrib.hpp"
#include "model.hpp"
#include "host.hpp"
#include "native_scene.hpp"
#include "passes.hpp"
#include "render_glue.hpp"
#include "project_open.hpp"
#include "scene.hpp"
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
          std::vector<std::string> args = string_list(enc.at("args"));
          std::vector<std::vector<std::string>> extra;
          for (const Json& e : enc.at("extra").arr()) {
            if (e.is_object()) extra.push_back(string_list(e.at("args")));
          }
          const std::lock_guard lock(m_);
          encodeBin_ = enc.at("bin").str();
          encodeArgs_ = std::move(args);
          encodeExtra_ = std::move(extra);
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
  bool wait_encode(std::string& bin, std::vector<std::string>& args, std::vector<std::vector<std::string>>& extra) {
    std::unique_lock lock(m_);
    cv_.wait(lock, [&] { return cancelled_.load() || encodeBin_.has_value(); });
    if (cancelled_.load()) return false;
    bin = *encodeBin_;
    args = encodeArgs_;
    extra = encodeExtra_;
    return true;
  }

  static std::vector<std::string> string_list(const Json& a) {
    std::vector<std::string> out;
    for (const Json& s : a.arr()) {
      if (s.is_string()) out.push_back(s.str());
    }
    return out;
  }

 private:
  std::mutex m_;
  std::condition_variable cv_;
  std::thread reader_;
  std::atomic<bool> cancelled_{false};
  std::atomic<bool> done_{false};
  std::optional<std::string> encodeBin_;
  std::vector<std::string> encodeArgs_;
  std::vector<std::vector<std::string>> encodeExtra_;
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
      // '\x01' marks a per-character fallback family (sc::document_font_families),
      // '\x02' the language the OS picked it for (T3).
      const bool fallback = !f.empty() && f.front() == '\x01';
      const std::string body = fallback ? f.substr(1) : f;
      const std::size_t at = fallback ? body.find('\x02') : std::string::npos;
      const std::string fam = at == std::string::npos ? body : body.substr(0, at);
      if (seen.emplace(fam).second) (void)set->add_system_family(fam);
      if (fallback) set->mark_fallback(fam, at == std::string::npos ? std::string_view{} : std::string_view(body).substr(at + 1));
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
  std::string isolateLayer;
  std::vector<std::string> isolateAlso;

  bool open(const OpenedProject& p, const std::string& comp, const JobSpec& job, const std::vector<std::string>& families,
            std::string& err) {
    isolateLayer = job.isolateLayer;
    isolateAlso = job.isolateLayers;
    try {
      (void)doc::restore_document(d, view, p.document, p.sessionAssets);
    } catch (const std::exception& e) {
      err = std::string("the project could not be opened: ") + e.what();
      return false;
    }
    // An HDR delivery encodes PQ / HLG itself (hdr_convert.hpp): the viewer's
    // PQ / HLG preview or ACES SDR tone map would be applied twice or clip at white.
    if (!job.hdr.empty()) d.color_mut().displayTransform = "srgb";
    // `thisComp` in expressions is the composition being rendered.
    view.tabComp = comp;
    env = std::make_unique<doc::DocExprEnv>(d, view, cache);
    fonts = std::make_unique<Fonts>(job.fontsManifest, job.chromiumProfile, families);
    measurer = sc::make_canvas_measurer(fonts->canvas);
    mediaBase = p.mediaBase;
    waveform = sc::offline_waveform(d, view, *env, cache);
    return true;
  }
  std::filesystem::path mediaBase;  // relative media (image-layer rigs) resolve here, as the texture feed's
  sc::WaveformProvider waveform;    // the Audio Waveform generator's source, decoded and waited for
  [[nodiscard]] sc::BuildContext ctx() {
    sc::BuildContext c{d, view, *env, cache, measurer.get(), {}};
    c.mediaBase = mediaBase;
    c.waveform = waveform;
    c.isolateLayer = isolateLayer;
    c.isolateAlso = isolateAlso;
    return c;
  }
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
  /// An HDR delivery's encode (JobSpec::hdr); nullopt = SDR.
  std::optional<HdrEncode> hdr;
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
    const double s = job.scale.value_or(1);
    p.width = std::round(p.compW * s);
    p.height = std::round(p.compH * s);
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
  if (!job.hdr.empty()) {
    // HDR is an opaque 16-bit delivery (hdr_convert.hpp).
    p.hdr = HdrEncode{job.hdr == "hlg" ? HdrTransfer::hlg : HdrTransfer::pq, job.hdrPeakNits, job.hdrWhiteNits};
    p.alpha = false;
  }
  p.overrides.forExport = true;
  p.overrides.transparent = p.alpha;
  p.view = sc::export_view(p.width, p.height, p.compW, p.compH);
  p.view.gpuEffects = sc::engine_gpu_effects();  // E4: exports render on the device too
  p.view.svgDisplayScale = true;                 // 3D perf E4: SVGs at the exported size (exact, synchronous)
  // RGBA surface: the read-back rows are the raw pipe's channel order already.
  // 16-bit output draws the same display-encoded frame into a half-float surface.
  p.depth = p.hdr ? 16 : job.depth;
  p.view.surfaceFormat = p.depth == 16 ? api::RenderTextureFormat::rgba16float : api::RenderTextureFormat::rgba8unorm;
  return true;
}

// ── build ───────────────────────────────────────────────────────────────────

struct Built {
  sc::NativeFrame nf;
  std::vector<std::string> reasons;   // why this frame cannot be rendered by the engine
  std::vector<std::string> warnings;  // what this frame draws without (stage `warning`): told, not refused
};

std::unique_ptr<Built> build_frame(DocCopy& dc, const Plan& p, std::int64_t frame) {
  auto b = std::make_unique<Built>();
  const double t = static_cast<double>(frame) / p.fps;  // frameTimeAt: index / fps, exactly
  try {
    sc::BuildContext ctx = dc.ctx();
    b->nf = sc::build_native_frame(ctx, p.compId, t, p.view, true, {}, frame, p.overrides);
    // The export's own host (run_export): the camera / lights / transforms an
    // effect reads and its checkouts at other times, as the viewport finishes them.
    plugins::finish_native_frame(ctx, p.compId, t, p.view, true, b->nf, plugins::PluginHost::active());
  } catch (const std::exception& e) {
    b->reasons.push_back(std::string("frame build failed: ") + e.what());
    return b;
  }
  for (const sc::LayerError& e : b->nf.errors) {
    // Advisories, not failures: the frame still draws — a family that is not
    // installed falls back to another face (T4's `font`), effects take the
    // CPU path (P11's `cpu-effects`). The viewport reports them; an export or
    // an auto-reframe must not refuse the frame over them.
    if (e.stage == "font" || e.stage == "cpu-effects") continue;
    // A Premation Cloud plugin without a valid token passes its layer through,
    // in an export as in the viewer (PLUGIN_STORE.md §4b) — not a refusal.
    if (sc::is_plugin_locked_error(e.stage, e.message)) continue;
    // Stage `warning` (scene_types.hpp): the layer draws without something it
    // could not resolve. The export completes and lists it on its preflight line.
    // Stage `expression` (2026-10-21): an expression that failed fell back to
    // its pre-expression value, as After Effects renders it — listed, not refused.
    if (e.stage == "warning" || e.stage == "expression") {
      std::string w = e.stage == "expression" ? "expression (" + e.path + "): " + e.message : e.message;
      if (!e.layerName.empty()) w += " (" + e.layerName + ")";
      else if (!e.layerId.empty()) w += " (" + e.layerId + ")";
      b->warnings.push_back(std::move(w));
      continue;
    }
    std::string r = e.stage == "snapshot" ? "snapshot error: " : "";
    r += e.message;
    if (!e.layerId.empty()) r += " (" + e.layerId + ")";
    b->reasons.push_back(std::move(r));
  }
  // Native plugins: the export's own host renders them (run_export). Without
  // one (no plugin folder given) a frame that needs a plugin is not exported
  // with the effect silently missing.
  if (plugins::PluginHost::active() != nullptr) return b;
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
  /// An HDR job's delivered light levels (render thread only).
  HdrLightLevels hdrLevels;
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
  /// first frames that are outside the port. `warnings` collects, once each and
  /// with the first frame that raised it, what the frames draw without.
  bool preflight(std::vector<std::pair<std::int64_t, std::string>>& unported, std::vector<std::string>& warnings) {
    std::atomic<std::int64_t> next{plan_.start};
    std::atomic<bool> stop{false};
    std::mutex m;
    std::map<std::string, std::int64_t> warned;  // message → first frame
    std::vector<JoiningThread> pool;
    for (auto& dc : docs_) {
      pool.emplace_back([&, d = dc.get()] {
        for (std::int64_t i = next.fetch_add(1); i <= plan_.end && !stop.load() && !ctl_.cancelled(); i = next.fetch_add(1)) {
          const auto b = build_frame(*d, plan_, i);
          if (!b->warnings.empty()) {
            const std::lock_guard lock(m);
            for (const auto& w : b->warnings) {
              const auto it = warned.find(w);
              if (it == warned.end()) {
                if (warned.size() < 24) warned.emplace(w, i);
              } else if (i < it->second) {
                it->second = i;
              }
            }
          }
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
    std::vector<std::pair<std::int64_t, std::string>> ordered;
    for (const auto& [w, f] : warned) ordered.emplace_back(f, w);
    std::ranges::sort(ordered);
    for (const auto& [f, w] : ordered) warnings.push_back("frame " + std::to_string(f) + ": " + w);
    return unported.empty();
  }

  /// Render every frame into `sink` (called in frame order on the writer thread).
  /// Returns an exit code; `failure` says why when it is not kExitOk.
  int run(rg::SceneRenderer& renderer, sc::SceneTextures& textures, unsigned inFlight,
          const std::function<bool(const OutFrame&)>& sink, std::string& failure) {
    {
      const std::lock_guard lock(m_);
      drawing_ = true;
    }
    const std::size_t window = docs_.size() * 2 + inFlight + 2;
    const std::size_t frameBytes = static_cast<std::size_t>(plan_.width) * static_cast<std::size_t>(plan_.height) * (plan_.depth == 16 ? 8U : 4U);
    // An HDR job's tables, built once (hdr_convert.hpp).
    const std::unique_ptr<HdrEncoder> hdr = plan_.hdr ? std::make_unique<HdrEncoder>(*plan_.hdr) : nullptr;

    // Build workers: claim the next index while it is within `window` of the render cursor.
    std::vector<JoiningThread> workers;
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
    JoiningThread writer([&] {
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
            if (pending.half && hdr) {
              hdr->convert(rows, pending.width, pending.height, pending.bytesPerRow, buf, stats_.hdrLevels);
            } else if (pending.half) {
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
        for (;;) {
          // A build waiting on a layer it samples (sampleImage) is drawn here, between frames.
          cv_.wait(lock, [&] { return ready_.contains(i) || !pixelRequests_.empty(); });
          if (pixelRequests_.empty()) break;
          const std::shared_ptr<PixelRequest> req = std::move(pixelRequests_.front());
          pixelRequests_.pop_front();
          lock.unlock();
          serve_pixels(renderer, textures, *req);
          lock.lock();
        }
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
      // Builds still waiting on a layer draw are answered: nothing draws from here on.
      drawing_ = false;
      for (const std::shared_ptr<PixelRequest>& r : pixelRequests_) {
        r->done.set_value({nullptr, "the export stopped before the layer was drawn"});
      }
      pixelRequests_.clear();
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

  /// sampleImage in an export (DocCopy's ExprCache::pixelProbe): the build
  /// worker builds the layer alone, the render loop (run) draws and reads it.
  /// In preflight nothing draws: the layer reads as transparent there.
  std::shared_ptr<const doc::LayerPixels> layer_pixels(DocCopy& dc, std::string_view node, double t, bool postEffect,
                                                       std::string& error) {
    {
      const std::lock_guard lock(m_);
      if (!drawing_) {
        auto none = std::make_shared<doc::LayerPixels>();
        none->width = 1;
        none->height = 1;
        none->rgba.assign(4, 0.0F);
        return none;
      }
    }
    const std::optional<std::string> comp = doc::comp_of_layer(dc.d, node);
    if (!comp) {
      error = "sampleImage: the layer is in no composition.";
      return nullptr;
    }
    auto req = std::make_shared<PixelRequest>();
    try {
      sc::BuildContext ctx = dc.ctx();
      sc::layer_pixels_context(ctx, node, postEffect);
      req->frame = sc::build_layer_pixels_frame(ctx, *comp, node, t, plan_.view);
      plugins::finish_native_frame(ctx, *comp, t, req->frame.view, false, req->frame.nf, plugins::PluginHost::active());
    } catch (const std::exception& e) {
      error = std::string("sampleImage: the layer could not be built: ") + e.what();
      return nullptr;
    }
    std::future<std::pair<std::shared_ptr<const doc::LayerPixels>, std::string>> answer = req->done.get_future();
    {
      const std::lock_guard lock(m_);
      if (!drawing_) {
        error = "sampleImage: the export stopped before the layer was drawn";
        return nullptr;
      }
      pixelRequests_.push_back(req);
    }
    cv_.notify_all();
    auto [px, why] = answer.get();
    if (!px) error = "sampleImage: " + why;
    return px;
  }

 private:
  struct PixelRequest {
    sc::LayerPixelsFrame frame;
    std::promise<std::pair<std::shared_ptr<const doc::LayerPixels>, std::string>> done;
  };

  /// Render loop: draw a sampled layer and read it back (premultiplied, as the graph holds it).
  static void serve_pixels(rg::SceneRenderer& renderer, sc::SceneTextures& textures, PixelRequest& req) {
    sc::LayerPixelsFrame& lf = req.frame;
    textures.set_color_managed(lf.nf.file.view.color_management.has_value());
    sc::PrepareStats ps;
    textures.prepare(lf.nf.textures, lf.nf.file.textures, ps);
    rg::FrameStats fs;
    std::string err;
    rg::TargetPixels scene;
    if (!renderer.render(lf.nf.file, nullptr, fs, err) || !renderer.read_target(rg::kSceneColor, scene, err)) {
      req.done.set_value({nullptr, err.empty() ? std::string("the layer could not be drawn") : err});
      return;
    }
    auto px = std::make_shared<doc::LayerPixels>();
    px->width = scene.width;
    px->height = scene.height;
    px->scale = lf.scale * (lf.width > 0 ? static_cast<double>(scene.width) / lf.width : 1.0);
    px->boxWidth = lf.boxWidth;
    px->boxHeight = lf.boxHeight;
    px->rgba = std::move(scene.rgba);
    req.done.set_value({std::move(px), {}});
  }

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
  /// m_: run() is drawing (sampleImage requests are served); false in preflight and once it stops.
  bool drawing_ = false;
  std::deque<std::shared_ptr<PixelRequest>> pixelRequests_;

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
  if (!j.at("pluginRevoked").is_undefined() && !str("pluginRevoked", out.pluginRevoked, false)) return false;
  if (!j.at("pluginEntitlement").is_undefined() && !str("pluginEntitlement", out.pluginEntitlement, false)) return false;
  for (const auto& [k, dst] : {std::pair<const char*, std::vector<std::string>*>{"plugins", &out.pluginPaths}, {"pluginDisabled", &out.pluginDisabled}}) {
    const Json& v = j.at(k);
    if (v.is_undefined()) continue;
    if (!v.is_array()) {
      error = std::string("job: \"") + k + "\" must be an array of strings";
      return false;
    }
    for (const Json& e : v.arr()) {
      if (e.is_string() && !e.str().empty()) dst->push_back(e.str());
    }
  }
  for (const auto& [k, dst] : {std::pair<const char*, std::optional<std::int64_t>*>{"startFrame", &out.startFrame}, {"endFrame", &out.endFrame}}) {
    const Json& v = j.at(k);
    if (v.is_undefined() || v.is_null()) continue;
    if (!v.is_finite_number()) {
      error = std::string("job: \"") + k + "\" must be a number";
      return false;
    }
    *dst = static_cast<std::int64_t>(std::floor(v.num()));
  }
  for (const auto& [k, dst] : {std::pair<const char*, std::optional<double>*>{"fps", &out.fps}, {"width", &out.width}, {"height", &out.height}, {"scale", &out.scale}}) {
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
  if (j.at("audioOnly").is_bool()) out.audioOnly = j.at("audioOnly").b();
  if (j.at("isolateLayer").is_string()) out.isolateLayer = j.at("isolateLayer").str();
  for (const Json& id : j.at("isolateLayers").arr()) {
    if (id.is_string() && !id.str().empty()) out.isolateLayers.push_back(id.str());
  }
  if (out.audioOnly) out.audio = true;
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
    for (const Json& e : enc.at("extra").arr()) {
      std::vector<std::string> args;
      for (const Json& a : e.at("args").arr()) {
        if (a.is_string()) args.push_back(a.str());
      }
      if (!args.empty()) out.encodeExtra.push_back(std::move(args));
    }
  }
  if (!j.at("sequence").is_undefined()) {
    if (!j.at("sequence").is_string()) {
      error = "job: \"sequence\" must be png, jpg, exr, or their -zip forms";
      return false;
    }
    const std::string& s = j.at("sequence").str();
    // P7c: `plugin:<plugin>/<module>` — a plugin output module (pluginPath, pluginOptions).
    const bool plugin = s.starts_with("plugin:") && s.find('/') != std::string::npos;
    if (plugin) {
      out.pluginPath = j.at("pluginPath").is_string() ? j.at("pluginPath").str() : std::string();
      if (j.at("pluginOptions").is_string()) out.pluginOptions = j.at("pluginOptions").str();
      if (out.pluginPath.empty()) {
        error = "job: a plugin output module needs \"pluginPath\"";
        return false;
      }
    }
    const std::string_view base = s.ends_with("-zip") ? std::string_view(s).substr(0, s.size() - 4) : std::string_view(s);
    if (!plugin && base != "png" && base != "jpg" && base != "exr" && base != "tiff" && base != "dpx") {
      error = "job: \"sequence\" must be png, jpg, exr, tiff, dpx, or their -zip forms";
      return false;
    }
    out.sequence = s;
  }
  if (!j.at("hdr").is_undefined() && !j.at("hdr").is_null()) {
    if (!j.at("hdr").is_string() || (j.at("hdr").str() != "pq" && j.at("hdr").str() != "hlg")) {
      error = "job: \"hdr\" must be pq or hlg";
      return false;
    }
    out.hdr = j.at("hdr").str();
    if (!out.sequence.empty()) {
      error = "job: an HDR job writes to an encoder, not an image sequence";
      return false;
    }
  }
  for (const auto& [k, dst] : {std::pair<const char*, double*>{"hdrPeakNits", &out.hdrPeakNits}, {"hdrWhiteNits", &out.hdrWhiteNits}}) {
    const Json& v = j.at(k);
    if (v.is_undefined() || v.is_null()) continue;
    if (!v.is_finite_number() || !(v.num() > 0) || v.num() > 10000) {
      error = std::string("job: \"") + k + "\" must be a light level in nits (0 … 10000]";
      return false;
    }
    *dst = v.num();
  }
  if (out.hdrWhiteNits > out.hdrPeakNits) {
    error = "job: \"hdrWhiteNits\" is above \"hdrPeakNits\"";
    return false;
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
  if (!job.encodeBin && job.sequence.empty() && !job.audioOnly) ctl.start_reader();

  // The GPU starts first, while the project opens and the preflight runs
  // (Dawn + the shader compiler: ~1 s). The renderer is used on this thread
  // only after the join — never concurrently.
  std::unique_ptr<rg::SceneRenderer> renderer;
  std::string gpuErr;
  double gpuInitMs = 0;
  JoiningThread gpuInit;
  if (!job.preflightOnly && !job.audioOnly) {
    rg::RendererOptions ro;
    ro.highPerformance = true;
    if (const char* v = std::getenv("PREMATION_EXPORT_GPU_VENDOR")) ro.vendorId = static_cast<std::uint32_t>(std::strtoul(v, nullptr, 0));  // NOLINT(concurrency-mt-unsafe): read before the thread starts
    gpuInit = JoiningThread([&renderer, &gpuErr, &gpuInitMs, ro] {
      const auto t0 = Clock::now();
      renderer = rg::SceneRenderer::create(ro, gpuErr);
      if (renderer) renderer->set_effect_fields(sc::engine_gpu_effects());  // E4, with the view's gpuEffects
      if (renderer) renderer->set_effect_layer_buffers(true);                // E1: as the viewport renders 3D chains
      // Rasters are planned against this device's 2D texture limit (device_limits.hpp).
      if (renderer) sc::set_texture_dimension_limit(renderer->device().max_texture_dimension());
      gpuInitMs = ms_since(t0);
    });
  }

  // ── native plugins (AE parity 2.10) ──
  // Before the project opens, so the document resolves plugin effect types;
  // the same folders, disabled set and revocations as the editor's engine.
  std::unique_ptr<plugins::PluginHost> pluginHost;
  {
    std::vector<std::filesystem::path> paths(job.pluginPaths.begin(), job.pluginPaths.end());
    if (const char* env = std::getenv("PREMATION_PLUGIN_PATH")) {  // NOLINT(concurrency-mt-unsafe): read before any thread starts
      std::string_view rest = env;
      while (!rest.empty()) {
        const std::size_t cut = rest.find(';');
        if (cut != 0) paths.emplace_back(std::string(rest.substr(0, cut)));
        if (cut == std::string_view::npos) break;
        rest.remove_prefix(cut + 1);
      }
    }
    if (!paths.empty()) {
      plugins::HostOptions ho;
      ho.searchPaths = std::move(paths);
      ho.disabled = job.pluginDisabled;
      if (!job.pluginRevoked.empty()) ho.revoked = plugins::read_revoked_file(job.pluginRevoked);
      ho.entitlement = job.pluginEntitlement;
      pluginHost = std::make_unique<plugins::PluginHost>(std::move(ho));
      const auto recs = pluginHost->scan();
      PREMATION_LOG(info, "export_plugins").kv("count", static_cast<std::uint64_t>(recs.size()));
    }
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
      std::vector<JoiningThread> loaders;
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
  for (const std::unique_ptr<DocCopy>& dc : docs) {
    dc->cache.pixelProbe = [&pipeline, d = dc.get()](const doc::DocExprEnv& /*env*/, std::string_view node, double t,
                                                     bool postEffect, std::string& error) {
      return pipeline.layer_pixels(*d, node, t, postEffect, error);
    };
  }

  // ── preflight (an audio-only job renders no picture: nothing to check) ──
  // What the frames draw without (stage `warning`), told on the preflight line.
  std::vector<std::string> warnings;
  if (!job.audioOnly) {
    const auto t0 = Clock::now();
    std::vector<std::pair<std::int64_t, std::string>> unported;
    const bool ok = pipeline.preflight(unported, warnings);
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
  std::optional<std::string> audioPath;
  std::vector<std::vector<float>> pluginAudio;  // P7c: the mix, for a plugin output module's WRITE_AUDIO
  int pluginAudioRate = 0;
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
    // Voices the audio builder mixes without something (an audio effect it
    // has no port for): told on the preflight line with the picture's
    // warnings, never a refusal — there is no other mixer to fall back to
    // (docs/TS_ENGINE_REMOVAL.md), and the user saw the whole export fail
    // over one layer's note.
    for (const std::string& note : mix.notes) warnings.push_back("audio: " + note);
    if (mix.audible && job.sequence.starts_with("plugin:")) {
      pluginAudio = mix.channels;
      pluginAudioRate = mix.sampleRate;
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
    // Echoed so the supervisor never tags SDR frames as HDR (an engine without it omits the key).
    j.set("hdr", plan.hdr ? Json::string(job.hdr) : Json::null());
    j.set("audio", audioPath ? Json::string(*audioPath) : Json::null());
    j.set("warnings", str_array(warnings));
    j.set("ms", Json::number(stats.preflightMs));
    ctl.emit(j);
  }
  if (job.preflightOnly || job.audioOnly) {
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
  const bool asTiff = job.sequence == "tiff" || job.sequence == "tiff-zip";
  const bool asDpx = job.sequence == "dpx" || job.sequence == "dpx-zip";
  const char* seqExt = asExr ? ".exr" : asJpg ? ".jpg" : asTiff ? ".tif" : asDpx ? ".dpx" : ".png";
  const bool viaPlugin = job.sequence.starts_with("plugin:");  // P7c
  std::string bin = job.encodeBin.value_or("");
  std::vector<std::string> args = job.encodeArgs;
  std::vector<std::vector<std::string>> extraArgs = job.encodeExtra;
  if (!sequence && !job.encodeBin && !ctl.wait_encode(bin, args, extraArgs)) return kExitCancelled;

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
  textures.set_exact(true);  // E4: SVGs at their exact display step, synchronously — the export is deterministic
#if defined(PREMATION_HAVE_MEDIA)
  std::string decodeNote;
  media::MediaSystem mediaSystem(media::media_config_for(renderer->device().device(), decodeNote));
  media::MediaTextures mediaTex(mediaSystem, renderer->device().device(), media::MediaTextures::Mode::exact);
  mediaTex.set_exact_timeout(std::chrono::milliseconds(15000));
  textures.set_media(&mediaSystem, &mediaTex);
#endif
  renderer->set_external_textures(&textures);
  // `native-plugin` chain entries run through the export's plugin host (CPU or
  // the plugin's GPU path on this device), as in the viewport (engine_frames.cpp).
  std::unique_ptr<plugins::RenderGlue> pluginGlue;
  if (pluginHost) {
    pluginGlue = std::make_unique<plugins::RenderGlue>();
    renderer->set_native_effects(pluginGlue.get());
  }
  stats.gpuInitMs = gpuInitMs;
  stats.gpuWaitMs = ms_since(tGpu);

  const fs::path ffLog = u8path(job.workDir) / "ffmpeg.log";
  const fs::path framesDir = u8path(job.workDir) / "frames";
  // Every encoder the frames go to: [0] is the job's own output, the rest are
  // its extra output modules (one render, N files). Each has its own log.
  std::vector<std::unique_ptr<ChildProcess>> children;
  const auto ffLogOf = [&](std::size_t i) {
    return i == 0 ? ffLog : u8path(job.workDir) / ("ffmpeg." + std::to_string(i) + ".log");
  };
  const auto killAll = [&] {
    for (auto& c : children) {
      if (c) c->kill();
    }
  };
  // The encoder that refused a frame (its log says why), for the error line.
  std::size_t failedOutput = 0;
  const auto failedTail = [&] {
    const std::string tail = tail_of(ffLogOf(failedOutput), 600);
    if (tail.empty()) return tail;
    return (failedOutput == 0 ? std::string() : "output " + std::to_string(failedOutput + 1) + ": ") + tail;
  };
  ZipWriter zip;
  bool zipOpen = false;
  // P7c: a plugin output module (BEGIN here; END below, or cancelled when the job stops).
  std::unique_ptr<plugins::OutputJob> pluginOut;
  std::vector<float> pluginFrame;
  if (viaPlugin) {
    plugins::OutputParams op;
    op.path = job.pluginPath;
    op.width = static_cast<std::int32_t>(plan.width);
    op.height = static_cast<std::int32_t>(plan.height);
    op.fps = plan.fps;
    op.frameCount = plan.frames();
    op.audioRate = pluginAudio.empty() ? 0U : static_cast<std::uint32_t>(pluginAudioRate);
    op.audioChannels = static_cast<std::uint32_t>(pluginAudio.size());
    std::string perr;
    if (plugins::PluginHost* ph = plugins::PluginHost::active(); ph != nullptr) {
      op.optionsJson = ph->contrib().output_options(job.sequence, job.pluginOptions);
      pluginOut = ph->contrib().output_job(job.sequence, perr);
    } else {
      perr = "no plugin host (the job lists no plugin folders)";
    }
    if (!pluginOut || !pluginOut->begin(op, perr)) {
      ctl.emit(error_line(false, "output module: " + perr));
      return kExitFailed;
    }
  } else if (sequence) {
    std::error_code ec;
    if (asZip) {
      const std::string zipName = std::string("frames") + seqExt + ".zip";
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
    std::vector<const std::vector<std::string>*> all{&args};
    for (const auto& e : extraArgs) all.push_back(&e);
    for (std::size_t i = 0; i < all.size(); ++i) {
      auto c = ChildProcess::spawn(bin, *all[i], ffLogOf(i).string(), err);
      if (!c) {
        killAll();
        ctl.emit(error_line(false, i == 0 ? err : "output " + std::to_string(i + 1) + ": " + err));
        return kExitFailed;
      }
      children.push_back(std::move(c));
    }
  }

  // ── render ──
  const auto tRender = Clock::now();
  std::int64_t written = 0;
  auto lastEmit = Clock::now() - std::chrono::seconds(1);
  const std::int64_t total = plan.frames();
  const auto wpx = static_cast<std::uint32_t>(plan.width);
  const auto hpx = static_cast<std::uint32_t>(plan.height);
  std::string sinkFailure;  // P7c: why the output module refused a frame
  const auto sink = [&](const OutFrame& f) {
    if (ctl.cancelled()) return false;
    if (pluginOut) {
      plugins::export_frame_to_float(f.rgba, plan.depth, pluginFrame);
      std::string perr;
      const std::int64_t t = static_cast<std::int64_t>(std::llround(static_cast<double>(f.index) / plan.fps * 705600000.0));
      if (!pluginOut->write_frame(f.index - plan.start, t, pluginFrame.data(), perr)) {
        sinkFailure = "output module: " + perr;
        return false;
      }
    } else if (sequence) {
      std::string name = std::to_string(f.index);
      if (name.size() < 5) name.insert(0, 5 - name.size(), '0');
      name = "frame_" + name + seqExt;
      std::vector<std::uint8_t> bytes;
      if (asExr) {
        const auto row = wpx * (plan.depth == 16 ? 8U : 4U);
        std::vector<std::uint8_t> half(std::size_t{wpx} * hpx * 8);
        // f.rgba is the writer's frame: straight RGBA8, or at depth 16 straight RGBA64
        // integers (half_surface_to_rgba64) — not the half-float surface itself.
        target_to_half_rgba(f.rgba, wpx, hpx, row, plan.depth == 16 ? LinearFormat::unorm16 : LinearFormat::unorm8, half);
        bytes = encode_exr_half(half, wpx, hpx);
      } else if (asTiff) {
        bytes = encode_tiff_rgba(f.rgba, wpx, hpx, plan.depth);
      } else if (asDpx) {
        bytes = encode_dpx10_rgb(f.rgba, wpx, hpx, plan.depth);
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
    } else {
      // The same bytes to every encoder, in order; any one refusing fails the job
      // (its log says why) rather than delivering a partial set of files.
      for (std::size_t i = 0; i < children.size(); ++i) {
        if (!children[i]->write(f.rgba)) {
          failedOutput = i;
          return false;
        }
      }
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
  if (code != kExitOk && !sinkFailure.empty()) failure = sinkFailure;
  if (code != kExitOk) {
    killAll();
    if (code == kExitCancelled || ctl.cancelled()) return kExitCancelled;
    if (code == kExitFailed) {
      const std::string tail = failedTail();
      failure += tail.empty() ? "" : ": " + tail;
    }
    ctl.emit(error_line(code == kExitFallback, failure));
    return code;
  }
  if (pluginOut) {
    std::string perr;
    std::vector<float> interleaved;
    plugins::interleave_audio(pluginAudio, interleaved);
    const auto frames = pluginAudio.empty() ? 0U : static_cast<std::uint32_t>(pluginAudio.front().size());
    if ((frames > 0 && !pluginOut->write_audio(interleaved.data(), frames, perr)) || !pluginOut->finish(false, perr)) {
      ctl.emit(error_line(false, "output module: " + perr));
      return kExitFailed;
    }
  } else if (sequence) {
    if (asZip && !zip.finish()) {
      ctl.emit(error_line(false, "the sequence archive could not be finished"));
      return kExitFailed;
    }
  } else {
    // Close every encoder before judging any: each finishes its own file.
    std::vector<int> codes;
    codes.reserve(children.size());
    for (auto& c : children) codes.push_back(c->finish());
    for (std::size_t i = 0; i < codes.size(); ++i) {
      if (codes[i] == 0) continue;
      const std::string which = i == 0 ? std::string() : " (output " + std::to_string(i + 1) + ")";
      ctl.emit(error_line(false, "The encode failed" + which + ": ffmpeg exited " + std::to_string(codes[i]) + ": " + tail_of(ffLogOf(i), 600)));
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
    if (plan.hdr) {
      // What was delivered (CTA-861.3, whole nits). The encoder's SEI was
      // written before the first frame, so it carries the supervisor's values.
      Json h = Json::object();
      h.set("transfer", Json::string(job.hdr));
      h.set("maxCll", Json::number(std::round(stats.hdrLevels.maxCll)));
      h.set("maxFall", Json::number(std::round(stats.hdrLevels.maxFall)));
      s.set("hdr", std::move(h));
    }
    Json j = Json::object();
    j.set("ev", Json::string("done"));
    j.set("frames", Json::number(static_cast<double>(total)));
    j.set("stats", std::move(s));
    ctl.emit(j);
  }
  return kExitOk;
}

}  // namespace premation::exporter
