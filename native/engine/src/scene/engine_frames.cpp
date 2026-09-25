#include "engine_frames.hpp"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <span>
#include <exception>
#include <limits>
#include <map>
#include <thread>
#include <set>
#include <string_view>
#include <utility>

#include "anim.hpp"
#include "built_frame.hpp"
#include "fonts.hpp"
#include "log.hpp"
#include "model.hpp"
#include "native_scene.hpp"
#include "host.hpp"
#include "render_glue.hpp"
#include "scene_finish.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "scene_renderer.hpp"
#include "scene_textures.hpp"
#include "text_measure.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_system.hpp"
#include "media_config.hpp"
#include "media_textures.hpp"
#endif

#if defined(PREMATION_HAVE_AUDIO)
#include "audio_system.hpp"
#include "transport_clock.hpp"
#include "voice_build.hpp"
#endif

namespace premation::scene {
namespace {

using Json = js::Json;

// ── fonts ─────────────────────────────────────────────────────────────────

/// One thread's FontSet (FontSet is filled before shaping, then read-only —
/// the core thread measures with one, the render thread rasterises with another).
struct Fonts {
  std::unique_ptr<raster::FontSet> set;
  raster::CanvasOptions canvas;
  std::set<std::string, std::less<>> families;

  explicit Fonts(const EngineFramesOptions& o) {
    set = std::make_unique<raster::FontSet>(o.chromiumProfile ? raster::FontOptions::chromium_windows()
                                                               : raster::FontOptions{});
    if (!o.fontsManifest.empty()) {
      std::string err;
      if (!set->load_manifest(o.fontsManifest, err)) {
        PREMATION_LOG(warn, "fonts_manifest").kv("error", err);
      }
    }
    for (const char* g : {"Inter", "system-ui", "sans-serif", "serif", "monospace"}) add(g);
    canvas.fonts = set.get();
    canvas.lcdGeometry = o.chromiumProfile;
  }
  /// Register a family once (a no-op for families already seen).
  bool add(std::string_view family) {
    if (family.empty() || families.contains(family)) return false;
    families.emplace(family);
    (void)set->add_system_family(std::string(family));
    return true;
  }
};

/// "Inter, 'Segoe UI', sans-serif" → each family.
void split_families(std::string_view css, std::vector<std::string>& out) {
  while (!css.empty()) {
    const std::size_t comma = css.find(',');
    std::string_view one = css.substr(0, comma);
    while (!one.empty() && (one.front() == ' ' || one.front() == '"' || one.front() == '\'')) one.remove_prefix(1);
    while (!one.empty() && (one.back() == ' ' || one.back() == '"' || one.back() == '\'')) one.remove_suffix(1);
    if (!one.empty()) out.emplace_back(one);
    if (comma == std::string_view::npos) break;
    css.remove_prefix(comma + 1);
  }
}

/// Every font family the document's text names (component props + rich-text runs).
std::vector<std::string> document_families(const doc::Document& d) {
  std::vector<std::string> out;
  for (const auto& [id, node] : d.nodes()) {
    if (!node) continue;
    for (const doc::Component& c : node->components) {
      const Json& f = c.props.at("fontFamily");
      if (f.is_string()) split_families(f.str(), out);
      const Json& runs = c.props.at("richText").at("runs");
      if (!runs.is_array()) continue;
      for (const Json& r : runs.arr()) {
        const Json& rf = r.at("fontFamily");
        if (rf.is_string()) split_families(rf.str(), out);
      }
    }
  }
  std::ranges::sort(out);
  out.erase(std::ranges::unique(out).begin(), out.end());
  return out;
}

// ── the core-thread builder ───────────────────────────────────────────────

class EngineFrameBuilder final : public FrameBuilder {
 public:
  explicit EngineFrameBuilder(const EngineFramesOptions& o) : fonts_(o), measurer_(make_canvas_measurer(fonts_.canvas)) {}

  std::shared_ptr<BuiltFrame> build(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                    doc::ExprCache& cache, std::string_view comp, api::Time time,
                                    const ViewportConfig& viewport, bool playing,
                                    std::vector<api::LayerError>& errors) override {
    const auto t0 = std::chrono::steady_clock::now();
    auto out = std::make_shared<BuiltFrame>();
    try {
      // Fonts the text names, registered before measuring (and forwarded to the render thread).
      out->fontFamilies = document_families(d);
      bool added = false;
      for (const std::string& f : out->fontFamilies) added = fonts_.add(f) || added;
      if (added) measurer_ = make_canvas_measurer(fonts_.canvas);

      BuildContext ctx{d, view, expr, cache, measurer_.get()};
      const SnapshotComp sc = snapshot_comp_of(d, comp);
      // The comp contain-fitted into the slot, centred, over black — C2's
      // compositor placement (render/compositor.cpp), which the page's
      // overlays are drawn against (docs/VIEWPORT_ROUTE.md).
      ViewSpec vs = export_view(std::max<double>(1, viewport.width), std::max<double>(1, viewport.height),
                                std::max(1.0, sc.width), std::max(1.0, sc.height));
      if (viewport.zoom > 0) {
        // D5: the page's own camera (viewToCamera), so the engine's frame lines up
        // with the overlays the page draws over it: CSS px, DPR, zoom, centre.
        const double dpr = viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1.0;
        vs.cssWidth = std::max(1.0, static_cast<double>(viewport.width) / dpr);
        vs.cssHeight = std::max(1.0, static_cast<double>(viewport.height) / dpr);
        vs.dpr = dpr;
        vs.zoom = viewport.zoom;
        vs.centerX = viewport.panX;
        vs.centerY = viewport.panY;
      }
      vs.clear = api::Color{0, 0, 0, 1};
      vs.surfaceFormat = api::RenderTextureFormat::rgba8unorm;
      const double seconds = doc::flicks_to_seconds(time);
      NativeFrame nf = build_native_frame(ctx, comp, seconds, vs, true);
      // G1: native plugin entries completed from the document (sequence data,
      // times), their checkouts at other times added, disabled instances reported.
      plugins::PluginHost* host = plugins::PluginHost::active();
      plugins::finish_native_frame(ctx, comp, seconds, vs, true, nf, host);
      if (host != nullptr) {
        host->next_frame();
        // Instances no frame has used for a while give their state back
        // (SEQUENCE_SETDOWN); the document's flat copy rebuilds them on use.
        if ((++builtFrames_ & 255U) == 0) host->collect_instances(kIdleInstanceFrames);
      }
      out->file = std::move(nf.file);
      out->textures = std::move(nf.textures);
      errors.reserve(nf.errors.size());
      for (LayerError& e : nf.errors) {
        api::LayerError le;
        le.layer = std::move(e.layerId);
        le.stage = std::move(e.stage);
        le.message = std::move(e.message);
        errors.push_back(std::move(le));
      }
    } catch (const std::exception& e) {
      // The builder itself failed (not one layer — those are isolated inside):
      // the Session falls back to C2's quad scene for this frame.
      PREMATION_LOG(error, "scene_build_failed").kv("error", std::string(e.what()));
      errors.push_back(api::LayerError{"", "snapshot", std::string("frame build failed: ") + e.what(), std::nullopt});
      return nullptr;
    }
    out->playing = playing;
    out->buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return out;
  }

 private:
  static constexpr std::uint64_t kIdleInstanceFrames = 600;
  Fonts fonts_;
  std::unique_ptr<TextMeasurer> measurer_;
  std::uint64_t builtFrames_ = 0;
};

// ── the render-thread drawer ──────────────────────────────────────────────

class ViewportDrawer final : public render::BuiltFrameDrawer {
 public:
  static std::unique_ptr<ViewportDrawer> create(const EngineFramesOptions& o, const Gpu& gpu, std::string& error) {
    auto d = std::unique_ptr<ViewportDrawer>(new ViewportDrawer(o));  // NOLINT(cppcoreguidelines-owning-memory): private ctor
    d->renderer_ = rg::SceneRenderer::create_on(gpu.instance, gpu.adapter, gpu.device, gpu.float32, error);
    if (!d->renderer_) return nullptr;
    SceneTextures::Options to;
    to.canvas = d->fonts_.canvas;
    d->textures_ = std::make_unique<SceneTextures>(to);
    d->textures_->set_device(&d->renderer_->device());
#if defined(PREMATION_HAVE_MEDIA)
    // E1: hardware decode on the render GPU (d3d11va for 8-bit, NVDEC for
    // deeper streams on NVIDIA), software as the floor — media_config.hpp.
    std::string decodeNote;
    d->media_ = std::make_unique<media::MediaSystem>(media::media_config_for(gpu.device, decodeNote));
    PREMATION_LOG(info, "media_decode").kv("policy", decodeNote);
    d->mediaTex_ = std::make_unique<media::MediaTextures>(*d->media_, gpu.device, media::MediaTextures::Mode::preview);
    d->textures_->set_media(d->media_.get(), d->mediaTex_.get());
#endif
    d->renderer_->set_external_textures(d->textures_.get());
    // G1: `native-plugin` chain entries run through the engine's plugin host.
    d->plugins_ = std::make_unique<plugins::RenderGlue>();
    d->renderer_->set_native_effects(d->plugins_.get());
    return d;
  }

  bool draw(const BuiltFrame& frame, const wgpu::TextureView& target, std::uint32_t width, std::uint32_t height,
            std::string& error) override {
    // New families: the FontSet grows between frames (never while rasterising),
    // and cached rasters drawn without the face are dropped.
    bool added = false;
    for (const std::string& f : frame.fontFamilies) added = fonts_.add(f) || added;
    if (added) textures_->clear();
#if defined(PREMATION_HAVE_MEDIA)
    // Paused: the exact frame (short wait); playing: never block, nearest frame.
    mediaTex_->set_mode(frame.playing ? media::MediaTextures::Mode::preview : media::MediaTextures::Mode::exact);
    mediaTex_->set_exact_timeout(std::chrono::milliseconds(250));
#endif
    textures_->set_playing(frame.playing);
    textures_->set_color_managed(frame.file.view.color_management.has_value());
    api::RenderFrameFile file = frame.file;  // refs are filled per draw (hashes depend on the cache)
    PrepareStats ps;
    textures_->prepare(frame.textures, file.textures, ps);
    for (const auto& [key, what] : ps.unsupported) {
      std::string reportKey = key;
      reportKey += '|';
      reportKey += what;
      if (reported_.insert(std::move(reportKey)).second) {
        PREMATION_LOG(warn, "scene_texture_unsupported").kv("key", key).kv("what", what);
      }
    }
    // Rounded: a fractional DPR (2.18 on the owner's laptop) makes css × dpr
    // miss the slot size by an ulp even when the frame was built for this slot.
    if (std::lround(file.view.css_width * file.view.device_pixel_ratio) != static_cast<long>(width) ||
        std::lround(file.view.css_height * file.view.device_pixel_ratio) != static_cast<long>(height)) {
      // A frame built for the previous slot size (resize in flight): draw it
      // into this size (the camera is re-fitted by the next frame).
      file.view.css_width = width;
      file.view.css_height = height;
      file.view.device_pixel_ratio = 1;
    }
    // D4: a frame is final unless footage on it was drawn from the nearest
    // decoded frame (playing, MediaTextures preview mode).
    exact_ = !frame.playing || ps.mediaRefs == 0;
    rg::FrameStats st;
    return renderer_->render_into(file, target, wgpu::TextureFormat::RGBA8Unorm, st, error);
  }

  /// D4: everything that decides the frame's pixels — the encoded
  /// RenderFrameFile (FrameScene, view, colour, blobs), the texture feed each
  /// key resolves through (raster drawables, footage paths and source times),
  /// the font families and the slot size. The draw is a pure function of these
  /// (CLAUDE.md determinism), so equal keys draw equal pixels.
  [[nodiscard]] std::optional<std::uint64_t> content_key(const BuiltFrame& frame, std::uint32_t width,
                                                         std::uint32_t height) const override {
    // One writer reused across frames: encoding allocates only when a frame
    // outgrows the last one. The raster specs' JSON text is a per-frame
    // string per texture request (small, bounded by the layer count).
    keyWriter_.clear();
    api::encode(keyWriter_, frame.file);
    ContentHash h;
    h.bytes(keyWriter_.bytes());
    h.u64(width);
    h.u64(height);
    for (const TextureRequest& t : frame.textures) {
      h.str(t.key);
      h.u64(static_cast<std::uint64_t>(t.kind));
      if (!t.spec.is_undefined()) h.str(js::stringify(t.spec));
      h.f64(t.resolutionScale);
      h.f64(t.padding);
      h.str(t.src);
      h.f64(t.sourceTime);
      h.u64((t.video ? 1U : 0U) | (t.premultiplied ? 2U : 0U));
      h.f64(t.compFps);
      // Builder-computed textures (TexKind::pixels: the colour-LUT strips).
      h.u64((std::uint64_t{t.pxWidth} << 32U) | t.pxHeight);
      h.bytes(t.pixels);
    }
    for (const std::string& f : frame.fontFamilies) h.str(f);
    return h.value();
  }

  [[nodiscard]] bool last_frame_exact() const override { return exact_; }

 private:
  /// A fast 64-bit content hash (8 bytes per step, multiply-xorshift mix): the
  /// file can carry megabytes of mesh and environment blobs, so byte-wise
  /// FNV would cost milliseconds per frame. Not cryptographic; a collision
  /// shows a wrong cached frame, at ~2^-64 per pair.
  class ContentHash {
   public:
    void bytes(std::span<const std::uint8_t> b) {
      std::size_t i = 0;
      for (; i + 8 <= b.size(); i += 8) {
        std::uint64_t w = 0;
        std::memcpy(&w, b.data() + i, 8);
        mix(w);
      }
      std::uint64_t tail = 0;
      if (i < b.size()) std::memcpy(&tail, b.data() + i, b.size() - i);
      mix(tail ^ (static_cast<std::uint64_t>(b.size()) << 56U));
    }
    void str(std::string_view s) { bytes({reinterpret_cast<const std::uint8_t*>(s.data()), s.size()}); }  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): chars → bytes
    void u64(std::uint64_t v) { mix(v); }
    void f64(double v) { mix(std::bit_cast<std::uint64_t>(v)); }
    [[nodiscard]] std::uint64_t value() const {
      std::uint64_t x = h_;
      x ^= x >> 33U;
      x *= 0xff51afd7ed558ccdULL;
      x ^= x >> 33U;
      return x;
    }

   private:
    void mix(std::uint64_t w) {
      h_ ^= w * 0x9e3779b97f4a7c15ULL;
      h_ = std::rotl(h_, 27) * 0xc2b2ae3d27d4eb4fULL + 0x165667b19e3779f9ULL;
    }
    std::uint64_t h_ = 0x243f6a8885a308d3ULL;
  };

  explicit ViewportDrawer(const EngineFramesOptions& o) : fonts_(o) {}
  mutable wire::Writer keyWriter_;
  bool exact_ = false;
  Fonts fonts_;
  std::unique_ptr<rg::SceneRenderer> renderer_;
  std::unique_ptr<SceneTextures> textures_;
  std::unique_ptr<plugins::RenderGlue> plugins_;
#if defined(PREMATION_HAVE_MEDIA)
  std::unique_ptr<media::MediaSystem> media_;
  std::unique_ptr<media::MediaTextures> mediaTex_;
#endif
  std::set<std::string> reported_;
};

// ── audio ─────────────────────────────────────────────────────────────────

#if defined(PREMATION_HAVE_AUDIO)

constexpr double kMinLevelDb = -60;
constexpr double kRampHz = 50;  // audioParams.ts RAMP_HZ

double percent_to_db(double pct) {
  if (!std::isfinite(pct) || pct <= 0) return kMinLevelDb;
  return std::max(kMinLevelDb, 20 * std::log10(pct / 100));
}

/// audioScene.ts `staticLevelDb`.
double static_level_db(const Json& props, std::string_view dbKey, std::string_view pctKey) {
  if (props.at(dbKey).is_number()) return props.at(dbKey).num();
  if (props.at(pctKey).is_number()) return percent_to_db(props.at(pctKey).num());
  return 0;
}

class EngineAudio final : public MediaClock {
 public:
  explicit EngineAudio(bool useDevice) : system_(options(useDevice)), clock_(system_) {}

  bool start(std::string& error) { return system_.start_device(error); }

  void play(double fromSec, double rate, Loop loop, double rangeStartSec, double rangeEndSec) override {
    const audio::LoopMode lm = loop == Loop::once       ? audio::LoopMode::once
                               : loop == Loop::pingPong ? audio::LoopMode::pingPong
                                                        : audio::LoopMode::loop;
    clock_.play(fromSec, rate, lm, rangeStartSec, rangeEndSec);
  }
  void pause() override { clock_.pause(); }
  void seek(double sec, bool scrub) override { clock_.seek(sec, scrub); }
  [[nodiscard]] std::optional<double> media_elapsed(std::chrono::steady_clock::time_point now) const override {
    const auto e = clock_.media_elapsed(now);
    if (!e) return std::nullopt;
    return std::abs(*e);
  }

  void set_document(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                    doc::ExprCache& cache, std::string_view comp) override {
    audio::Program p;
    p.format = system_.format();
    p.revision = ++revision_;
    notes_.clear();
    if (!comp.empty() && d.comp(comp) != nullptr) {
      Ctx c{d, view, expr, cache};
      std::vector<std::string> stack{std::string(comp)};
      p.voices = comp_voices(c, comp, stack);
    }
    for (const std::string& n : notes_) PREMATION_LOG(info, "audio_unported").kv("what", n);
    PREMATION_LOG(info, "audio_program").kv("voices", p.voices.size()).kv("comp", std::string(comp));
    system_.set_program(std::move(p));
  }

  /// F1 export: the program set_document built, mixed offline over
  /// [startSec, endSec) once every source has conformed (audioMixdown.ts
  /// `mixdownBuffer`: ceil(duration × rate) frames; nothing when no unmuted
  /// voice reaches the range).
  bool mixdown(double startSec, double endSec, CompAudioMix& out, std::string& error) {
    const audio::ProgramPtr program = system_.program();
    out = {};
    out.sampleRate = system_.format().sampleRate;
    out.notes.assign(notes_.begin(), notes_.end());
    if (!program || !(endSec > startSec)) return true;
    // Conform is asynchronous (AudioSystem's worker pool): wait for every source.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(5);
    for (const auto& [path, id] : sources_) {
      if (id == 0) continue;
      while (system_.state(id) == audio::SourceState::conforming || system_.state(id) == audio::SourceState::unknown) {
        if (std::chrono::steady_clock::now() > deadline) {
          error = "audio source did not finish decoding: " + path;
          return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    }
    for (const audio::Voice& v : program->voices) {
      if (v.muted) continue;
      const double rate = std::max(0.01, v.playbackRate);
      const double wall = v.outSec > 0 ? (v.outSec - v.inSec) / rate : std::numeric_limits<double>::infinity();
      if (v.startSec < endSec && v.startSec + wall > startSec) out.audible = true;
    }
    if (!out.audible) return true;
    const auto frames = static_cast<std::int64_t>(std::ceil((endSec - startSec) * out.sampleRate));
    out.channels = system_.render(*program, startSec, frames);
    return true;
  }

 private:
  static audio::AudioSystemOptions options(bool useDevice) {
    audio::AudioSystemOptions o;
    o.useDevice = useDevice;
    return o;
  }

  struct Ctx {
    const doc::Document& d;
    const doc::EditorView& view;
    const doc::ExprEnv& expr;
    doc::ExprCache& cache;
  };

  /// The clip bars of a node as audioScene.ts `readAudioClipTimings`.
  static std::vector<audio::ClipTiming> timings_of(const Ctx& c, const std::string& id) {
    std::vector<audio::ClipTiming> out;
    const auto bars = doc::tl_bars_for_node(c.d, c.view, id);
    if (bars.empty()) return out;
    double fps = doc::tl_fps_for_node(c.d, c.view, id);
    if (!(fps > 0)) fps = 30;
    for (const doc::Bar* b : bars) {
      out.push_back({b->id, b->enabled, b->clip.start / fps, b->clip.sourceIn / fps,
                     (b->clip.sourceIn + b->clip.duration) / fps});
    }
    return out;
  }

  /// A keyframed audio property as a 50 Hz table over the voice's comp span
  /// (audioParams.ts buildRamp samples it the same way); static otherwise.
  static audio::ParamCurve curve_of(const Ctx& c, const std::string& node, std::string_view prop, double staticValue,
                                    double startSec, double durationSec) {
    if (!doc::anim_is_animated(c.d, node, prop) || !(durationSec > 0)) return audio::ParamCurve::constant(staticValue);
    std::vector<double> values;
    const auto n = static_cast<std::size_t>(std::ceil(durationSec * kRampHz)) + 1;
    values.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
      const double t = startSec + static_cast<double>(i) / kRampHz;
      values.push_back(doc::anim_sample(c.d, c.expr, c.cache, node, prop, t).value_or(staticValue));
    }
    return audio::ParamCurve::table(std::move(values), startSec, kRampHz);
  }

  std::uint64_t source_of(const std::string& src) {
    const std::string path = file_url_path(src);
    if (const auto it = sources_.find(path); it != sources_.end()) return it->second;
    std::string err;
    const std::uint64_t id = system_.open_source(path, err);
    if (id == 0) {
      PREMATION_LOG(warn, "audio_source_failed").kv("path", path).kv("error", err);
    }
    sources_.emplace(path, id);
    return id;
  }

  /// audioScene.ts `panOf`: the first component carrying a numeric audioPan.
  static void pan_of(const Ctx& c, const doc::Node& n, audio::Voice& v, double startSec, double durationSec) {
    double pan = 0;
    for (const doc::Component& comp : n.components) {
      if (comp.props.at("audioPan").is_number()) {
        pan = comp.props.at("audioPan").num();
        break;
      }
    }
    const bool animated = doc::anim_is_animated(c.d, n.id, "audioPan");
    v.panner = animated || pan != 0;
    v.pan = curve_of(c, n.id, "audioPan", pan, startSec, durationSec);
  }

  void finish_voice(const Ctx& c, const doc::Node& n, audio::Voice& v, double staticDb) {
    const double dur = std::max(0.0, v.outSec - v.inSec);
    v.levelDb = curve_of(c, n.id, "audioLevelDb", staticDb, v.startSec, dur);
    pan_of(c, n, v, v.startSec, dur);
  }

  /// readAudioVoices (an audio layer).
  std::vector<audio::Voice> audio_voices(const Ctx& c, const doc::Node& n) {
    const doc::Component* a = n.comp("Audio");
    if (a == nullptr) return {};
    const Json& p = a->props;
    const std::string assetId = p.at("__assetId").is_string() ? p.at("__assetId").str() : "";
    std::string src = p.at("__src").is_string() ? p.at("__src").str() : "";
    if (!assetId.empty()) {
      if (const Json* asset = doc::find_asset(c.d, assetId); asset != nullptr && asset->at("src").is_string() &&
                                                             !asset->at("src").str().empty()) {
        src = asset->at("src").str();
      }
    }
    if (src.empty() || assetId.empty()) return {};
    const double db = static_level_db(p, "audioLevelDb", "__level");
    const bool muted = !n.visible || (p.at("__muted").is_bool() && p.at("__muted").b());
    const std::uint64_t source = source_of(src);
    if (source == 0) return {};
    if (p.at("effects").is_array() && !p.at("effects").arr().empty()) notes_.insert("audio effects (" + n.id + ")");
    std::vector<audio::Voice> out;
    auto timings = timings_of(c, n.id);
    if (timings.empty()) {
      const double duration = p.at("__duration").is_number() ? p.at("__duration").num() : 0;
      timings.push_back({n.id, true, p.at("__start").is_number() ? p.at("__start").num() : 0,
                         p.at("__in").is_number() ? p.at("__in").num() : 0,
                         p.at("__out").is_number() ? p.at("__out").num() : duration});
    }
    for (const audio::ClipTiming& t : timings) {
      audio::Voice v;
      v.id = t.id;
      v.nodeId = n.id;
      v.source = source;
      v.startSec = t.startSec;
      v.inSec = t.inSec;
      v.outSec = t.outSec;
      v.muted = muted || !t.enabled;
      finish_voice(c, n, v, db);
      out.push_back(std::move(v));
    }
    return out;
  }

  /// readVideoAudioVoices (a footage layer's own sound).
  std::vector<audio::Voice> video_voices(const Ctx& c, const doc::Node& n) {
    std::string assetId;
    std::string rawSrc;
    bool muted = false;
    Json level = Json::object();
    for (const doc::Component& comp : n.components) {
      const Json& p = comp.props;
      if (p.at("assetId").is_string() && !p.at("assetId").str().empty()) assetId = p.at("assetId").str();
      if (p.at("__assetId").is_string() && !p.at("__assetId").str().empty()) assetId = p.at("__assetId").str();
      if (p.at("src").is_string() && !p.at("src").str().empty()) rawSrc = p.at("src").str();
      if (p.at("audioLevelDb").is_number()) level.set("audioLevelDb", p.at("audioLevelDb"));
      if (p.at("audioLevel").is_number()) level.set("audioLevel", p.at("audioLevel"));
      if (p.at("audioMuted").is_bool() && p.at("audioMuted").b()) muted = true;
    }
    if (assetId.empty()) return {};
    std::string src = rawSrc;
    const Json* asset = doc::find_asset(c.d, assetId);
    if (asset != nullptr && asset->at("src").is_string() && !asset->at("src").str().empty()) src = asset->at("src").str();
    if (src.empty()) return {};
    if (asset != nullptr && asset->at("metadata").at("hasAudioTrack").is_bool() &&
        !asset->at("metadata").at("hasAudioTrack").b()) {
      return {};
    }
    const std::uint64_t source = source_of(src);
    if (source == 0) return {};
    const double db = static_level_db(level, "audioLevelDb", "audioLevel");
    muted = muted || !n.visible;
    const doc::LayerTime lt = doc::get_node_layer_time(n);
    const bool freeze = lt.freeze;
    const double rate = 100 / std::max(0.01, lt.stretch);
    if (doc::read_retime_mode(c.d, n.id) != api::RetimeMode::normal) {
      notes_.insert("time-remapped footage audio plays at one rate (" + n.id + ")");
    }
    auto spans = timings_of(c, n.id);
    if (spans.empty()) {
      const double dur = asset != nullptr ? asset->at("metadata").at("duration").num() : 0;
      spans.push_back({n.id, true, 0, 0, dur});
    }
    std::vector<audio::Voice> out;
    for (const audio::ClipTiming& t : spans) {
      audio::Voice v;
      v.id = t.id;
      v.nodeId = n.id;
      v.source = source;
      v.startSec = t.startSec;
      v.inSec = t.inSec;
      v.outSec = t.outSec;
      v.playbackRate = freeze ? 1 : rate;
      v.reverse = !freeze && lt.reverse;
      v.muted = muted || !t.enabled || freeze;
      finish_voice(c, n, v, db);
      out.push_back(std::move(v));
    }
    return out;
  }

  /// compVoices: one composition's layers (never through a precomp), solo
  /// applied across them, placed compositions' sound on this comp's clock.
  std::vector<audio::Voice> comp_voices(const Ctx& c, std::string_view comp, std::vector<std::string>& stack) {
    constexpr std::size_t kMaxNestedDepth = 8;  // MAX_NESTED_AUDIO_DEPTH
    const SnapshotComp sc = snapshot_comp_of(c.d, comp);
    const std::string root = sc.rootId.empty() ? std::string(comp) : sc.rootId;
    std::vector<const doc::Node*> nodes;
    for (const std::string& id : doc::layer_ids_of_comp(c.d, root)) {
      if (id == root) continue;
      if (const doc::Node* n = c.d.node(id)) nodes.push_back(n);
    }
    const bool anySolo = std::ranges::any_of(nodes, [](const doc::Node* n) { return n->solo; });
    std::vector<audio::Voice> out;
    for (const doc::Node* n : nodes) {
      std::vector<audio::Voice> voices;
      try {
        const std::string kind = n->kind();
        if (kind == "audio") {
          voices = audio_voices(c, *n);
        } else if (kind == "video") {
          voices = video_voices(c, *n);
        } else if (const auto ref = doc::read_comp_ref(*n);
                   ref && std::ranges::find(stack, *ref) == stack.end() && stack.size() < kMaxNestedDepth) {
          stack.push_back(*ref);
          std::vector<audio::Voice> inner = comp_voices(c, *ref, stack);
          stack.pop_back();
          if (!inner.empty()) {
            auto spans = timings_of(c, n->id);
            const doc::LayerTime lt = doc::get_node_layer_time(*n);
            if (doc::read_retime_mode(c.d, n->id) != api::RetimeMode::normal || lt.stretch != 100 || lt.reverse) {
              notes_.insert("retimed precomp audio plays unretimed (" + n->id + ")");
            }
            double fps = doc::tl_fps_for_node(c.d, c.view, n->id);
            if (!(fps > 0)) fps = 30;
            voices = audio::place_nested(n->id, inner, spans, false, [](double t) { return t; }, fps, !n->visible);
          }
        }
      } catch (const std::exception& e) {
        // One bad layer never silences the comp: its voices are dropped, logged.
        PREMATION_LOG(warn, "audio_layer_failed").kv("layer", n->id).kv("error", std::string(e.what()));
        voices.clear();
      }
      const bool soloed = !anySolo || n->solo;
      for (audio::Voice& v : voices) {
        if (!soloed) v.muted = true;
        out.push_back(std::move(v));
      }
    }
    return out;
  }

  audio::AudioSystem system_;
  AudioTransportClock clock_;
  std::map<std::string, std::uint64_t> sources_;
  std::set<std::string> notes_;
  std::uint64_t revision_ = 0;
};

#endif  // PREMATION_HAVE_AUDIO

}  // namespace

std::unique_ptr<FrameBuilder> make_frame_builder(const EngineFramesOptions& options) {
  return std::make_unique<EngineFrameBuilder>(options);
}

std::function<std::unique_ptr<render::BuiltFrameDrawer>(const Gpu&, std::string&)> make_drawer_factory(
    const EngineFramesOptions& options) {
  // Init-capture: a by-copy capture of the const& parameter would be a const
  // member, making the closure's move constructor copy (and possibly throw).
  return [opts = options](const Gpu& gpu, std::string& error) -> std::unique_ptr<render::BuiltFrameDrawer> {
    return ViewportDrawer::create(opts, gpu, error);
  };
}

std::unique_ptr<MediaClock> make_media_clock(bool useDevice, std::string& error) {
#if defined(PREMATION_HAVE_AUDIO)
  auto a = std::make_unique<EngineAudio>(useDevice);
  if (!a->start(error)) {
    PREMATION_LOG(warn, "audio_device_failed").kv("error", error);
  }
  return a;
#else
  (void)useDevice;
  error = "built without audio (E2)";
  return nullptr;
#endif
}

std::vector<std::string> document_font_families(const doc::Document& d) { return document_families(d); }

bool mix_comp_audio(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr, doc::ExprCache& cache,
                    std::string_view comp, double startSec, double endSec, CompAudioMix& out, std::string& error) {
#if defined(PREMATION_HAVE_AUDIO)
  EngineAudio a(false);
  a.set_document(d, view, expr, cache, comp);
  return a.mixdown(startSec, endSec, out, error);
#else
  (void)d, (void)view, (void)expr, (void)cache, (void)comp, (void)startSec, (void)endSec;
  out = {};
  error = "built without audio (E2)";
  return false;
#endif
}

}  // namespace premation::scene
