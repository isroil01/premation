#include "engine_frames.hpp"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <span>
#include <exception>
#include <filesystem>
#include <limits>
#include <map>
#include <mutex>
#include <thread>
#include <optional>
#include <set>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "anim.hpp"
#include "fail.hpp"
#include "built_frame.hpp"
#include "convert_geometry.hpp"
#include "effect_handoff.hpp"
#include "svg_shapes.hpp"
#include "text_outlines.hpp"
#include "fonts.hpp"
#include "frame_hit.hpp"
#include "item_facts.hpp"
#include "layer_faces.hpp"
#include "merge_paths.hpp"
#include "misc_port.hpp"
#include "snapshot_build.hpp"
#include "log.hpp"
#include "lut_port.hpp"
#include "passes.hpp"
#include "png_write.hpp"
#include "model.hpp"
#include "native_scene.hpp"
#include "host.hpp"
#include "render_glue.hpp"
#include "scene_finish.hpp"
#include "paint_port.hpp"
#include "readmodel.hpp"
#include "rig_coverage.hpp"
#include "rig_overlay.hpp"
#include "scene.hpp"
#include "svg_layer.hpp"
#include "effect_chain.hpp"
#include "scene_renderer.hpp"
#include "scene_textures.hpp"
#include "text_measure.hpp"
#include "text_query.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"
#include "media_paths.hpp"
#include "os_ffi.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_system.hpp"
#include "media_config.hpp"
#include "media_textures.hpp"
#endif
#include "media_reload.hpp"

#if defined(PREMATION_HAVE_AUDIO)
#include "audio_system.hpp"
#include "peaks.hpp"
#include "transport_clock.hpp"
#include "voice_build.hpp"
#endif

namespace premation::scene {
namespace {

using Json = js::Json;

/// A UTF-8 path string as a path (not the ANSI code page on Windows).
std::filesystem::path utf8_path(const std::string& s) { return {std::u8string(s.begin(), s.end())}; }

/// U1: the pasteboard behind an Extended Viewer frame (AE's dark grey; the
/// editor's board colour is the same tone), where the comp's clip is off.
constexpr api::Color kPasteboardColor{0.118, 0.118, 0.118, 1};


// ── fonts ─────────────────────────────────────────────────────────────────

/// A text layer's text and the language it is set in (T3; never empty: the
/// layer's `language`, else its script's).
struct TextRun {
  std::string text;
  std::string language;
};

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

  /// BuiltFrame::fontFamilies marks a per-character fallback family with this
  /// prefix, so the render thread's set registers it as one too; the language
  /// the OS picked it for follows kLangMark (T3).
  static constexpr char kFallbackMark = '\x01';
  static constexpr char kLangMark = '\x02';
  std::set<std::pair<std::string, std::string>> fallbacks;  // (family, language)
  std::set<std::pair<char32_t, std::string>> looked;        // (code point, language) already asked of the OS

  [[nodiscard]] static std::string marked(const std::string& family, const std::string& language) {
    std::string out(1, kFallbackMark);
    out += family;
    if (!language.empty()) {
      out += kLangMark;
      out += language;
    }
    return out;
  }
  /// A fallback family (registered, then marked): characters no requested family has are drawn from it.
  bool add_fallback(std::string_view family, std::string_view language = {}) {
    const bool added = add(family);
    if (fallbacks.emplace(std::string(family), std::string(language)).second) {
      set->mark_fallback(std::string(family), language);
      return true;
    }
    return added;
  }
  /// A BuiltFrame::fontFamilies entry made by marked().
  bool add_marked(std::string_view m) {
    m.remove_prefix(1);
    const std::size_t at = m.find(kLangMark);
    return at == std::string_view::npos ? add_fallback(m) : add_fallback(m.substr(0, at), m.substr(at + 1));
  }

  /// Per-character fallback for `text`: every code point outside ASCII not
  /// asked about before is looked up ONCE in the OS's fallback (the family it
  /// would draw it with) and that family registered as a fallback. Kanji in a
  /// font that is not installed, Hangul in a Latin font, an emoji, a ★ — glyphs
  /// instead of boxes. Runs where the set may grow (before shaping), never while
  /// rasterising. Returns whether a family was added.
  bool cover(const std::vector<TextRun>& runs) {
    bool added = false;
    for (const TextRun& r : runs) {
      // The text's language steers Han to a Japanese / Chinese / Korean face (T3).
      for (const raster::CodePoint& c : raster::decode_utf8(r.text)) {
        if (c.cp < 0x80 || !looked.emplace(c.cp, r.language).second) continue;
        if (const std::optional<std::string> fam = raster::FontSet::fallback_family_for(c.cp, 400, false, r.language)) {
          added = add_fallback(*fam, r.language) || added;
        }
      }
    }
    return added;
  }
};

/// Every effect type the document's layers carry (P7 pipeline warm-up), sorted, unique.
std::vector<std::string> document_effect_types(const doc::Document& d) {
  std::vector<std::string> out;
  for (const auto& [id, node] : d.nodes()) {
    if (!node) continue;
    for (const doc::Component& c : node->components) {
      const Json& fx = c.props.at("effects");
      if (!fx.is_array()) continue;
      for (const Json& e : fx.arr()) {
        if (e.at("type").is_string()) out.push_back(e.at("type").str());
      }
    }
  }
  std::ranges::sort(out);
  out.erase(std::ranges::unique(out).begin(), out.end());
  return out;
}

/// Every text of the document (text layers' Source Text and rich-text runs),
/// one entry per Text component with the language it is set in — what
/// per-character fallback must cover.
std::vector<TextRun> document_text_runs(const doc::Document& d) {
  std::vector<TextRun> out;
  for (const auto& [id, node] : d.nodes()) {
    if (!node) continue;
    for (const doc::Component& c : node->components) {
      TextRun run;
      const Json& t = c.props.at("content");
      if (t.is_string()) run.text += t.str();
      const Json& runs = c.props.at("richText").at("runs");
      if (runs.is_array()) {
        for (const Json& r : runs.arr()) {
          if (r.at("text").is_string()) run.text += r.at("text").str();
        }
      }
      if (run.text.empty()) continue;
      // `language` (T3): the layer's own, or its script's ('auto').
      const Json& lang = c.props.at("language");
      if (lang.is_string() && !lang.str().empty() && lang.str() != "auto") {
        run.language = lang.str();
      } else {
        std::u32string u;
        for (const raster::CodePoint& cp : raster::decode_utf8(run.text)) u.push_back(cp.cp);
        run.language = raster::script_language(u);
      }
      out.push_back(std::move(run));
    }
  }
  return out;
}

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
      std::memcpy(&w, b.subspan(i, 8).data(), 8);
      mix(w);
    }
    std::uint64_t tail = 0;
    if (i < b.size()) std::memcpy(&tail, b.subspan(i).data(), b.size() - i);
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

/// D4 / P6: the frame's pixels as one hash — the encoded RenderFrameFile
/// (FrameScene, view, colour, blobs), the texture feed each key resolves
/// through (raster drawables, footage paths and source times), the font
/// families and the media base. Everything but the slot size, which the
/// drawer mixes in (BuiltFrameDrawer::content_key). Computed once, on the core
/// thread, as the frame is built: the render thread no longer encodes the file
/// again for every draw.
std::uint64_t frame_content_hash(const BuiltFrame& frame, wire::Writer& scratch) {
  // One writer reused across frames: encoding allocates only when a frame
  // outgrows the last one. The raster specs' JSON text is a per-frame
  // string per texture request (small, bounded by the layer count).
  scratch.clear();
  api::encode(scratch, frame.file);
  ContentHash h;
  h.bytes(scratch.bytes());
  for (const TextureRequest& t : frame.textures) {
    h.str(t.key);
    h.u64(static_cast<std::uint64_t>(t.kind));
    if (!t.spec.is_undefined()) h.str(js::stringify(t.spec));
    h.f64(t.resolutionScale);
    h.f64(t.padding);
    h.str(t.src);
    // Use Proxies: a proxy frame is never the original's (src is the proxy
    // then); mixed only when set, so every other frame keeps its key.
    if (!t.fallbackSrc.empty()) h.str(t.fallbackSrc);
    h.f64(t.sourceTime);
    h.u64((t.video ? 1U : 0U) | (t.premultiplied ? 2U : 0U) | (t.pixelMotion ? 4U : 0U));
    h.f64(t.compFps);
    // Footage interpretation and the Pixel Motion pair pick other pixels.
    h.u64((t.pulldownPhase ? static_cast<std::uint64_t>(*t.pulldownPhase) + 1U : 0U) |
          (static_cast<std::uint64_t>(static_cast<unsigned char>(t.fields)) << 8U));
    h.f64(t.blendTime);
    h.f64(t.blendWeight);
    h.f64(t.bake ? t.bakeTargetScale + 1 : 0);  // a footage bake and the size it bakes at
    // Builder-computed textures (TexKind::pixels: the colour-LUT strips).
    h.u64((std::uint64_t{t.pxWidth} << 32U) | t.pxHeight);
    h.bytes(t.pixels);
    // A subject matte: which subjects, their frames and their live edge.
    h.u64(t.subjectParts.size());
    for (const SubjectPart& p : t.subjectParts) {
      h.str(p.id);
      h.str(p.src);
      for (const auto& [src, w] : p.blend) {
        h.str(src);
        h.f64(w);
      }
      h.f64(p.feather);
      h.f64(p.choke);
      h.f64(p.contrast);
      h.u64((p.invert ? 1U : 0U) | (p.hidden ? 2U : 0U));
    }
  }
  for (const std::string& f : frame.fontFamilies) h.str(f);
  h.str(frame.mediaBase);
  return h.value();
}

// ── the core-thread builder ───────────────────────────────────────────────

class EngineFrameBuilder final : public FrameBuilder, public TextQueries, public doc::ConvertGeometry {
 public:
  explicit EngineFrameBuilder(const EngineFramesOptions& o) : fonts_(o), measurer_(make_canvas_measurer(fonts_.canvas)) {}
  void bind_audio(MediaClock* clock) override { audio_ = clock; }
  void set_media_base(std::string_view dir) override {
    if (dir != mediaBase_) mediaBase_ = std::string(dir);
  }
  void set_cancel_flag(const std::atomic<std::uint32_t>* flag) noexcept override { cancel_ = flag; }

  // B4 round 2: text measured on the same fonts the frames are built with (under the session's build lock, like build()).
  TextQueries* text_queries() noexcept override { return this; }
  // B4 round 5: the overlay push's rig records and getRigPose (scene/rig_overlay.cpp).
  RigQueries* rig_queries() noexcept override { return &rig_; }
  api::TextLayout text_layout(const doc::Node& n, const api::TextLayoutOverrides* overrides) override {
    register_families(n);
    return text_layout_of(*measurer_, n, overrides);
  }
  std::optional<TextGeometry> text_geometry(const doc::Node& n,
                                            const std::vector<std::pair<std::string, double>>& overrides) override {
    register_families(n);
    return text_geometry_of(*measurer_, n, overrides);
  }

  // convertLayer (core/handlers_convert.cpp): text outlines on the same fonts.
  doc::ConvertGeometry* convert_geometry() noexcept override { return this; }
  std::optional<doc::TextOutlines> text_outlines(const doc::GeoCtx& c, std::string_view layer, double compSeconds,
                                                 std::string& why) override {
    // shapesFromText.ts `outlineTextNode`: the font's own Béziers unless the
    // style asks for what only the painter lays out, else the trace of the
    // painted text. Both read the layer's values sampled at `compSeconds`
    // (keyed size, weight, width / slant and `text.axis.*`).
    const doc::Node* n = c.d.node(layer);
    if (n == nullptr) {
      why = "no layer '" + std::string(layer) + "'";
      return std::nullopt;
    }
    if (n->kind() != "text") {
      why = "the layer is not a text layer";
      return std::nullopt;
    }
    register_families(*n);
    const std::vector<std::pair<std::string, double>> sampled =
        doc::anim_evaluate_node(c.d, c.expr, c.cache, layer, doc::comp_to_keyframe_time(c.d, c.view, layer, compSeconds));
    const auto to_geo = [](const std::vector<mesh::BezRun>& runs, doc::TextOutlines& o) {
      o.runs.reserve(runs.size());
      for (const mesh::BezRun& r : runs) {
        doc::GeoRun g;
        g.closed = !r.open;
        g.points.reserve(r.points.size());
        for (const mesh::BezPt& p : r.points) g.points.push_back(doc::GeoPt{p.x, p.y, p.inX, p.inY, p.outX, p.outY});
        o.runs.push_back(std::move(g));
      }
    };
    if (const std::optional<MeasuredStyle> style = read_measured_text_style(*n, sampled)) {
      const raster::CanvasOptions* canvas = measurer_->canvas_options();
      const std::optional<std::pair<double, double>> size = measurer_->measure_text_size(*style);
      const bool painted = style->fauxBold || style->fauxItalic || style->vertical ||
                           (size && wants_painted_layout(text_paint_spec_json(*n, *style, *size)));
      if (!painted && canvas != nullptr && canvas->fonts != nullptr) {
        if (std::optional<FontOutlines> f = font_outline_runs(*canvas->fonts, *style, font_variations_of(*n, *style, sampled))) {
          doc::TextOutlines out;
          // The layer box: the measured one; a style the measurer leaves out
          // (variable axes) is boxed from its shaped lines.
          out.width = size ? size->first : f->width;
          out.height = size ? size->second : f->height;
          out.fromFont = true;
          to_geo(f->runs, out);
          return out;
        }
      }
    }
    const std::optional<TracedText> traced = traced_text_of(*n, *measurer_, sampled, why);
    if (!traced) return std::nullopt;
    doc::TextOutlines out;
    out.width = traced->width;
    out.height = traced->height;
    out.fromFont = false;
    to_geo(*traced->runs, out);
    return out;
  }
  std::optional<std::vector<doc::TextGlyphBox>> text_glyphs(const doc::GeoCtx& /*c*/, std::string_view /*layer*/,
                                                            double /*compSeconds*/, std::string& why) override {
    why = "per-character layout is not in the engine's text port yet";
    return std::nullopt;
  }
  std::optional<doc::SvgShapes> svg_shapes(std::string_view markup, const std::optional<std::string>& fillOverride,
                                           std::string& why) override {
    return svg_document_shapes(markup, fillOverride, why);
  }

  std::shared_ptr<BuiltFrame> build(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                    doc::ExprCache& cache, std::string_view comp, api::Time time,
                                    const ViewportConfig& viewport, bool playing,
                                    std::vector<api::LayerError>& errors) override {
    const auto t0 = std::chrono::steady_clock::now();
    auto out = std::make_shared<BuiltFrame>();
    try {
      // Fonts the text names, registered before measuring (and forwarded to the render thread).
      out->fontFamilies = register_fonts(d);
      out->effectTypes = document_effect_types(d);
      out->mediaBase = mediaBase_;
      BuildContext ctx = context(d, view, expr, cache);
      ctx.cancel = cancel_;                      // an edit waiting for the lock stops this build (BuildCancelled)
      ctx.hiddenLayers = viewport.hiddenLayers;  // setViewportHiddenLayers: the text under the in-place editor
      ctx.focusLayers = viewport.focusLayers;    // setViewportFocus: layers outside the set are dim references
      ctx.useProxies = viewport.useProxies;      // setUseProxies: footage from its enabled proxy (viewport frames only)
      ctx.subjectView = viewport.subjectView;    // setViewport subjectView: the Subjects view modes (viewer only)
      SnapshotComp sc = with_viewport_view(snapshot_comp_of(d, comp), viewport);
      if (!viewport.layer.empty()) {
        // The Layer panel: the layer alone at its source size, over transparency,
        // through the composition's own camera (useLayerViewerRenderer).
        ctx.layerView = BuildContext::LayerView{
            viewport.layer, viewport.layerRenderEffects,
            viewport.layerSourceTime ? std::optional<double>(doc::flicks_to_seconds(*viewport.layerSourceTime)) : std::nullopt,
            viewport.layerTransparencyGrid, viewport.layerAlphaView, viewport.layerAlphaOverlayColor, viewport.layerAlphaOverlayOpacity};
        for (const api::LayerSourceSize& z : doc::source_sizes(d, {viewport.layer})) {
          if (z.width > 0 && z.height > 0) {
            sc.width = z.width;
            sc.height = z.height;
          }
        }
        sc.transparent = true;
        sc.camera3dMode = "active";
        sc.customViewCamera.reset();
      }
      // The comp contain-fitted into the slot, centred, over black — C2's
      // compositor placement (render/compositor.cpp), which the page's
      // overlays are drawn against (docs/VIEWPORT_ROUTE.md).
      // Preview resolution (Full / Half / Third / Quarter): the frame is drawn at
      // that fraction of the viewport's pixels, into a slot of that size
      // (render_thread rebuild), and the page scales it up to the viewer — fewer
      // pixels to fill and every raster drawn smaller, for heavy comps.
      const double res = preview_scale(viewport.resolution);
      ViewSpec vs = export_view(std::max(1.0, std::round(viewport.width * res)), std::max(1.0, std::round(viewport.height * res)),
                                std::max(1.0, sc.width), std::max(1.0, sc.height));
      vs.gpuEffects = engine_gpu_effects();  // E4: drawn on the render thread's device
      vs.svgDisplayScale = svg_display_scale_on();  // 3D perf E4: SVGs at the displayed size
      if (viewport.zoom > 0) {
        // D5: the page's own camera (viewToCamera), so the engine's frame lines up
        // with the overlays the page draws over it: CSS px, DPR, zoom, centre.
        const double dpr = viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1.0;
        vs.cssWidth = std::max(1.0, static_cast<double>(viewport.width) / dpr);
        vs.cssHeight = std::max(1.0, static_cast<double>(viewport.height) / dpr);
        vs.dpr = dpr * res;
        vs.zoom = viewport.zoom;
        vs.centerX = viewport.panX;
        vs.centerY = viewport.panY;
      }
      if (viewport.compSpace) {
        // Comp-space caching (core/frame_scene.hpp comp_space_frame): the same
        // scale and sub-pixel phase as the slot's camera, over a surface of the
        // comp's own size — the render thread copies it into the slot at an
        // integer offset. Nothing in the picture changes; only where it is drawn.
        const CompSpaceFrame& cs = *viewport.compSpace;
        vs.dpr = cs.dpr;
        vs.zoom = cs.zoom;
        vs.cssWidth = static_cast<double>(cs.width) / cs.dpr;
        vs.cssHeight = static_cast<double>(cs.height) / cs.dpr;
        vs.centerX = (vs.cssWidth / 2 - cs.phaseX / cs.dpr) / cs.zoom;
        vs.centerY = (vs.cssHeight / 2 - cs.phaseY / cs.dpr) / cs.zoom;
        out->compSpace = cs;
      }
      vs.clear = viewport.ghost ? api::Color{0, 0, 0, 0} : api::Color{0, 0, 0, 1};
      vs.channel = viewport.channel;  // View ▸ Show Channel, on the final blit
      if (!viewport.ghost) vs.exposure = viewport.exposure;  // Adjust Exposure, on the final blit (not twice through a ghost)
      if (viewport.layer.empty()) vs.regionOfInterest = viewport.regionOfInterest;
      if (viewport.ghost) sc.transparent = true;
      vs.surfaceFormat = api::RenderTextureFormat::rgba8unorm;
      const double seconds = doc::flicks_to_seconds(time);
      // What this viewport changed of the comp reaches the frame: build_native_frame
      // reads the comp from the document again, and used to drop all of it — a
      // Layer panel painted the comp's background under its layer, and a 2- / 4-up
      // layout or a custom view drew every pane through the active camera.
      CompOverrides ov;
      if (sc.transparent) ov.transparent = true;
      ov.camera3dMode = sc.camera3dMode;
      ov.customViewCamera = sc.customViewCamera;
      ov.draft3d = sc.draft3d;
      ov.transparencyGrid = sc.transparencyGrid;
      // The Layer panel draws the layer at its own size, centred in the comp's
      // frame: the comp's clip cut whatever of it falls outside the composition (a
      // picture wider or taller than the comp) along a straight line.
      if (!viewport.layer.empty()) {
        vs.clipToComp = false;
      } else if (!viewport.clipToComp) {
        // U1 Extended Viewer (setViewport clipToComp false): layers draw outside
        // the frame, over the pasteboard rather than black; the UI draws the
        // frame outline on top. A ghost keeps its transparent clear.
        vs.clipToComp = false;
        if (!viewport.ghost) vs.clear = kPasteboardColor;
      }
      // E8: the engine-drawn ground grid, a composition view's aid only (never a layer view, a ghost, an export).
      vs.groundGrid = viewport.groundGrid && viewport.layer.empty() && !viewport.ghost;
      // setPreviewQuality `motionBlur` false (Preview ▸ Draft Quality): no blur samples in this viewport.
      NativeFrame nf = build_native_frame(ctx, comp, seconds, vs, viewport.previewMotionBlur, {}, 0, ov);
      // G1: native plugin entries completed from the document (sequence data,
      // times), their checkouts at other times added, disabled instances reported.
      plugins::PluginHost* host = plugins::PluginHost::active();
      plugins::finish_native_frame(ctx, comp, seconds, vs, viewport.previewMotionBlur, nf, host);
      if (host != nullptr) {
        host->next_frame();
        // Instances no frame has used for a while give their state back
        // (SEQUENCE_SETDOWN); the document's flat copy rebuilds them on use.
        if ((++builtFrames_ & 255U) == 0) host->collect_instances(kIdleInstanceFrames);
      }
      // The viewer LUT (setViewerLut): graded on the final blit of a viewport
      // frame (EffectPass), never in an export or a thumbnail.
      if (viewport.viewerLut && !viewport.ghost) attach_viewer_lut(viewport.viewerLut, nf);
      out->file = std::move(nf.file);
      out->textures = std::move(nf.textures);
      errors.reserve(nf.errors.size());
      for (LayerError& e : nf.errors) {
        api::LayerError le;
        le.layer = std::move(e.layerId);
        le.stage = std::move(e.stage);
        le.message = std::move(e.message);
        if (!e.path.empty()) le.path = std::move(e.path);  // stage `expression`: the property
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
    // P6: the frame-cache key, hashed here (counted in buildMs) instead of on
    // the render thread for every draw. A ghost (onion skin) is never cached.
    if (!viewport.ghost) out->contentHash = frame_content_hash(*out, hashWriter_);
    out->buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return out;
  }

  std::shared_ptr<BuiltFrame> build_still(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                          doc::ExprCache& cache, std::string_view comp, api::Time time,
                                          std::uint32_t width, std::uint32_t height,
                                          std::string_view isolateLayer) override {
    auto out = std::make_shared<BuiltFrame>();
    out->fontFamilies = register_fonts(d);
    out->mediaBase = mediaBase_;
    BuildContext ctx = context(d, view, expr, cache);
    ctx.isolateLayer = std::string(isolateLayer);
    const SnapshotComp sc = snapshot_comp_of(d, comp);
    ViewSpec vs = export_view(width, height, std::max(1.0, sc.width), std::max(1.0, sc.height));
    vs.clear = api::Color{0, 0, 0, 0};
    vs.gpuEffects = engine_gpu_effects();
    vs.svgDisplayScale = svg_display_scale_on();
    vs.surfaceFormat = api::RenderTextureFormat::rgba8unorm;
    try {
      // The document's own motion blur: a thumbnail is the frame as it renders.
      const double seconds = doc::flicks_to_seconds(time);
      NativeFrame nf = build_native_frame(ctx, comp, seconds, vs, true);
      plugins::finish_native_frame(ctx, comp, seconds, vs, true, nf, plugins::PluginHost::active());
      out->file = std::move(nf.file);
      out->textures = std::move(nf.textures);
    } catch (const std::exception& e) {
      doc::fail(api::ErrorCode::internal, std::string("the frame could not be built: ") + e.what());
    }
    return out;
  }

  std::shared_ptr<BuiltFrame> build_layer_pixels(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                                 doc::ExprCache& cache, std::string_view comp, std::string_view layer,
                                                 double seconds, bool postEffect, doc::LayerPixels& drawn) override {
    auto out = std::make_shared<BuiltFrame>();
    out->fontFamilies = register_fonts(d);
    out->effectTypes = document_effect_types(d);
    out->mediaBase = mediaBase_;
    ViewSpec vs;
    vs.gpuEffects = engine_gpu_effects();
    vs.svgDisplayScale = svg_display_scale_on();
    try {
      BuildContext ctx = context(d, view, expr, cache);
      layer_pixels_context(ctx, layer, postEffect);
      LayerPixelsFrame lf = build_layer_pixels_frame(ctx, comp, layer, seconds, vs);
      plugins::finish_native_frame(ctx, comp, seconds, lf.view, false, lf.nf, plugins::PluginHost::active());
      out->file = std::move(lf.nf.file);
      out->textures = std::move(lf.nf.textures);
      drawn.width = lf.width;
      drawn.height = lf.height;
      drawn.scale = lf.scale;
      drawn.boxWidth = lf.boxWidth;
      drawn.boxHeight = lf.boxHeight;
    } catch (const std::exception& e) {
      doc::fail(api::ErrorCode::internal, std::string("the layer could not be built: ") + e.what());
    }
    return out;
  }

  std::shared_ptr<BuiltFrame> build_footage_still(const doc::Document& d, std::string_view src, bool video,
                                                  double sourceSec, double sourceWidth, double sourceHeight,
                                                  std::uint32_t width, std::uint32_t height) override {
    // One footage layer filling a snapshot of the source's own size — the
    // same texture feed and quad an image / video layer gets (frame_build.cpp).
    Snapshot snap;
    snap.width = std::max(1.0, sourceWidth);
    snap.height = std::max(1.0, sourceHeight);
    snap.transparent = true;
    RLayer l;
    l.id = "thumbnail";
    l.kind = video ? LayerKind::video : LayerKind::image;
    l.x = snap.width / 2;
    l.y = snap.height / 2;
    l.width = snap.width;
    l.height = snap.height;
    l.src = std::string(src);
    l.sourceTime = video ? std::max(0.0, sourceSec) : 0.0;
    snap.layers.push_back(std::move(l));
    ViewSpec vs = export_view(width, height, snap.width, snap.height);
    vs.clear = api::Color{0, 0, 0, 0};
    vs.surfaceFormat = api::RenderTextureFormat::rgba8unorm;
    auto out = std::make_shared<BuiltFrame>();
    out->mediaBase = mediaBase_;
    const double w = snap.width;
    const double h = snap.height;
    NativeFrame nf = native_frame_of(d, std::move(snap), vs, w, h);
    out->file = std::move(nf.file);
    out->textures = std::move(nf.textures);
    return out;
  }

  bool hit_test(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr, doc::ExprCache& cache,
                std::string_view comp, api::Time time, api::Vec2 point, std::vector<std::string>& topmostFirst) override {
    topmostFirst.clear();
    (void)register_fonts(d);
    const BuildContext ctx = context(d, view, expr, cache);
    const SnapshotComp sc = snapshot_comp_of(d, comp);
    // The frame in comp pixels (a 1:1 camera over the comp): only the scene's
    // geometry is read, nothing is rasterised or drawn. No motion blur — the
    // layer is where it is at `time`, not where its samples smear.
    const double w = std::max(1.0, sc.width);
    const double h = std::max(1.0, sc.height);
    try {
      const NativeFrame nf = build_native_frame(ctx, comp, doc::flicks_to_seconds(time), export_view(w, h, w, h), false);
      topmostFirst = hit_renderables(nf.file.scene, point.x, point.y);
    } catch (const std::exception& e) {
      doc::fail(api::ErrorCode::internal, std::string("the frame could not be built: ") + e.what());
    }
    return true;
  }

  // B4 round 8: createLiveMerge's probe (merge_paths.cpp).
  std::optional<doc::LiveMergeProbe> live_merge_probe(const doc::Document& d, const std::vector<std::string>& layers,
                                                      std::string_view op) override {
    return scene::live_merge_probe(d, layers, op);
  }

  // B4 round 8: face picking's geometry (layer_faces.cpp) from the snapshot of the layer's composition.
  std::optional<api::LayerFaces> layer_faces(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                             doc::ExprCache& cache, std::string_view comp, api::Time time,
                                             std::string_view layer) override {
    const doc::Node* n = d.node(layer);
    if (n == nullptr) return api::LayerFaces{};
    (void)register_fonts(d);
    register_families(*n);
    const BuildContext ctx = context(d, view, expr, cache);
    try {
      const Snapshot snap = build_snapshot(ctx, snapshot_comp_of(d, comp), doc::flicks_to_seconds(time), std::nullopt);
      return layer_faces_of(snap, *n, layer, measurer_->canvas_options());
    } catch (const std::exception& e) {
      doc::fail(api::ErrorCode::internal, std::string("the faces could not be built: ") + e.what());
    }
  }

 private:
  /// The families one text node names (document_families for a node), registered before measuring it.
  void register_families(const doc::Node& n) {
    std::vector<std::string> fams;
    for (const doc::Component& c : n.components) {
      const Json& f = c.props.at("fontFamily");
      if (f.is_string()) split_families(f.str(), fams);
      const Json& runs = c.props.at("richText").at("runs");
      if (!runs.is_array()) continue;
      for (const Json& r : runs.arr()) {
        const Json& rf = r.at("fontFamily");
        if (rf.is_string()) split_families(rf.str(), fams);
      }
    }
    bool added = false;
    for (const std::string& f : fams) added = fonts_.add(f) || added;
    if (added) measurer_ = make_canvas_measurer(fonts_.canvas);
  }

  /// Register the document's font families before measuring text (the
  /// measurer is rebuilt when the FontSet grew); returns them.
  std::vector<std::string> register_fonts(const doc::Document& d) {
    std::vector<std::string> families = document_families(d);
    bool added = false;
    for (const std::string& f : families) added = fonts_.add(f) || added;
    // Per-character fallback, only when the text changed (the revision of
    // its content, not every frame's walk of it).
    const std::vector<TextRun> runs = document_text_runs(d);
    std::string text;
    for (const TextRun& r : runs) {
      text += r.text;
      text += Fonts::kLangMark;
      text += r.language;
      text += Fonts::kFallbackMark;
    }
    if (text != lastText_) {
      lastText_ = std::move(text);
      added = fonts_.cover(runs) || added;
    }
    if (added) measurer_ = make_canvas_measurer(fonts_.canvas);
    // The render thread's set registers the same fallbacks (marked).
    for (const auto& [f, lang] : fonts_.fallbacks) families.push_back(Fonts::marked(f, lang));
    return families;
  }
  BuildContext context(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                       doc::ExprCache& cache) {
    BuildContext ctx{d, view, expr, cache, measurer_.get(), {}};
    ctx.mediaBase = utf8_path(mediaBase_);
    ctx.walkCache = &walkCache_;
    if (audio_ != nullptr) {
      ctx.waveform = [this](std::string_view layerId, std::vector<float>& peaks, double& duration) {
        return audio_->waveform(layerId, peaks, duration);
      };
    }
    return ctx;
  }

  /// B4 round 5: an image / SVG layer's alpha coverage for the overlay rig mesh — the source the layer
  /// draws (resolveRigImageSrc: the components' src / assetId, the asset's src, an SVG's document), keyed
  /// assetId ?? src as snapshot_build keys the render's.
  std::shared_ptr<const rig::CoverageMask> rig_coverage(const doc::Document& d, const doc::Node& n, std::string& unreachable) const {
    std::optional<std::string> src;
    std::optional<std::string> assetId;
    for (const doc::Component& c : n.components) {
      if (c.props.at("src").is_string()) src = c.props.at("src").str();
      if (c.props.at("assetId").is_string()) assetId = c.props.at("assetId").str();
    }
    if (assetId) {
      if (const Json* asset = doc::find_asset(d, *assetId); asset != nullptr && asset->at("src").is_string() && !asset->at("src").str().empty()) {
        src = asset->at("src").str();
      }
    }
    if (n.kind() == "svg") {
      SvgLayerSource svg = svg_layer_source(n);
      if (svg.src) src = std::move(svg.src);
    }
    if (!src || src->empty()) return nullptr;
    CoverageLookup c = image_coverage_mask(assetId.value_or(*src), *src, utf8_path(mediaBase_));
    unreachable = std::move(c.unreachable);
    return c.mask;
  }

  /// setViewerLut's table → RenderView.viewerLut + its `viewer-lut` strip.
  /// Parsed once per table (the Session hands every frame the same pointer).
  void attach_viewer_lut(const std::shared_ptr<const ViewerLut>& lut, NativeFrame& nf) {
    const ViewerLut& src = *lut;
    if (viewerLutSrc_ != lut) {
      viewerLutSrc_ = lut;
      viewerLutStrip_.reset();
      if (const std::optional<CubeLut> cube = parse_stored_cube_lut(src.table)) {
        viewerLutStrip_ = cube_lut_strip(*cube, std::string(rg::kViewerLutKey));
        viewerLutMeta_.size = static_cast<std::uint32_t>(cube->size1d > 0 ? cube->size1d : cube->size);
        viewerLutMeta_.is1d = cube->size1d > 0;
        viewerLutMeta_.domain_min = cube->domainMin[0];
        viewerLutMeta_.domain_max = cube->domainMax[0];
      }
    }
    if (!viewerLutStrip_) return;
    api::RenderViewerLut meta = viewerLutMeta_;
    meta.intensity = src.intensity;
    nf.file.view.viewer_lut_active = true;
    nf.file.view.viewer_lut = meta;
    nf.textures.push_back(*viewerLutStrip_);
  }

  static constexpr std::uint64_t kIdleInstanceFrames = 600;
  /// attach_viewer_lut's memo: the table it last parsed (held, so a new table
  /// can never reuse its address) and what it made of it. Under the session's
  /// build lock, like build() (core/session.hpp "the build worker").
  std::shared_ptr<const ViewerLut> viewerLutSrc_;
  std::optional<TextureRequest> viewerLutStrip_;
  api::RenderViewerLut viewerLutMeta_;
  Fonts fonts_;
  std::string lastText_;  // the document text per-character fallback last covered
  std::unique_ptr<TextMeasurer> measurer_;
  /// The walks' flatten / instance-expansion memo across frames (snapshot_build.hpp),
  /// used under the build lock like the rest of the builder.
  WalkCache walkCache_;
  MediaClock* audio_ = nullptr;
  std::uint64_t builtFrames_ = 0;
  wire::Writer hashWriter_;  // P6: frame_content_hash's scratch, reused across frames
  std::string mediaBase_;
  /// The session's edits-waiting counter (set_cancel_flag); null until set.
  const std::atomic<std::uint32_t>* cancel_ = nullptr;
  /// B4 round 5: the rig as the overlays see it, over this builder's media.
  DocRigQueries rig_{RigMediaHooks{
      [this](const doc::Document& d, const doc::Node& n, std::string& unreachable) { return rig_coverage(d, n, unreachable); },
      [](const Json& paint) { return paint_pad(paint); }}};
};

// ── the render-thread drawer ──────────────────────────────────────────────

class ViewportDrawer final : public render::BuiltFrameDrawer {
 public:
  static std::unique_ptr<ViewportDrawer> create(const EngineFramesOptions& o, const Gpu& gpu, std::string& error) {
    auto d = std::unique_ptr<ViewportDrawer>(new ViewportDrawer(o));  // NOLINT(cppcoreguidelines-owning-memory): private ctor
    d->renderer_ = rg::SceneRenderer::create_on(gpu.instance, gpu.adapter, gpu.device, gpu.float32, error);
    if (!d->renderer_) return nullptr;
    d->renderer_->set_effect_fields(engine_gpu_effects());  // E4: the frames build with gpuEffects the same way
    d->renderer_->set_effect_layer_buffers(true);           // E1: 3D surface chains in layer-sized buffers
    // The frame builder plans rasters against this device's 2D texture limit (device_limits.hpp).
    set_texture_dimension_limit(d->renderer_->device().max_texture_dimension());
    SceneTextures::Options to;
    to.canvas = d->fonts_.canvas;
    // Sized from the machine: a 3D comp with the camera close rasterises its
    // layers at their projected size, and a fixed 768 MB held a dozen of them.
    // PREMATION_RASTER_CACHE_MB pins it (tests make a frame outgrow it).
    to.rasterCacheBytes = raster_cache_budget(os::memory_status().physicalBytes);
    if (const std::optional<std::string> mb = os::env_var("PREMATION_RASTER_CACHE_MB"); mb && !mb->empty()) {
      char* end = nullptr;
      const unsigned long long v = std::strtoull(mb->c_str(), &end, 10);  // NOLINT(google-runtime-int)
      if (end != nullptr && *end == '\0' && v > 0 && v < (1ULL << 24U)) to.rasterCacheBytes = static_cast<std::size_t>(v) << 20U;
    }
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

  bool draw(BuiltFrame& frame, const wgpu::TextureView& target, std::uint32_t width, std::uint32_t height,
            std::string& error) override {
    for (const std::string& t : frame.effectTypes) {
      if (warmSeen_.insert(t).second) warmQueue_.push_back(t);
    }
#if defined(PREMATION_HAVE_MEDIA)
    (void)mediaTex_->take_misses();  // count this draw's own
#endif
    const api::RenderFrameFile& file = prepare(frame, width, height);
    rg::FrameStats st;
    renderer_->set_playing(frame.playing);  // P8b: moving layers reuse their effect chains while playing
    const bool ok = renderer_->render_into(file, target, wgpu::TextureFormat::RGBA8Unorm, st, error);
    // D4: a frame is final unless footage on it was drawn from a nearest decoded
    // frame or skipped — what the media source REPORTS for this draw, not "it
    // is playing and has footage": decode that keeps up makes exact frames
    // while playing, and an exact-mode wait that timed out does not.
#if defined(PREMATION_HAVE_MEDIA)
    media::MediaTextures::Misses m = mediaTex_->take_misses();
    exact_ = m.approximate == 0 && m.skipped == 0;
    wants_ = std::move(m.wanted);
#else
    exact_ = true;
#endif
    // E4: an SVG drawn from a stand-in step (its exact raster still on the SVG
    // worker) is not final either: not cached, and drawn again once it is in.
    svgWant_ = textures_->svg_stand_in();
    if (svgWant_) exact_ = false;
    // A GPU error during the frame (validation, out of memory): what it drew
    // may be missing a layer. Cached, that frame would come back on every pass
    // over it — an object blinking out at the same frame each loop. Never
    // final; a paused frame is drawn again (twice at most: a lasting error
    // must not redraw forever).
    if (!st.gpuError.empty()) {
      exact_ = false;
      gpuRetry_ = ++gpuErrorStreak_ <= kGpuRetries;
      std::string reportKey = "gpu|";
      reportKey += st.gpuError.substr(0, 160);
      if (reported_.insert(std::move(reportKey)).second) {
        PREMATION_LOG(warn, "scene_gpu_error").kv("error", st.gpuError);
      }
    } else {
      gpuErrorStreak_ = 0;
    }
    note_fx_skips(st);
    return ok;
  }

  void set_exact_media(bool exact) override { exactMedia_ = exact; }

  [[nodiscard]] render::MediaWants take_media_wants() override {
    render::MediaWants out;
#if defined(PREMATION_HAVE_MEDIA)
    out.reserve(wants_.size() + 1);
    for (const auto& [src, frame] : wants_) out.emplace_back(src, frame);
    wants_.clear();
#endif
    // E4: the SVG worker's pending step rides the same settle poll (a sentinel source).
    if (svgWant_) out.emplace_back(kSvgWantSource, 0);
    svgWant_ = false;
    // A frame a GPU error spoiled: drawn again on the next settle poll (a sentinel, settled at once).
    if (gpuRetry_) out.emplace_back(kGpuRetrySource, 0);
    gpuRetry_ = false;
    return out;
  }
  [[nodiscard]] std::uint64_t vram_bytes() override {
    std::uint64_t b = renderer_->device().stats().gpuBytes;
#if defined(PREMATION_HAVE_MEDIA)
    b += mediaTex_->held_bytes();
#endif
    return b;
  }
  std::uint64_t trim_vram(std::uint64_t bytes) override { return renderer_->device().trim(bytes); }
  void profile_next_frame() override { renderer_->device().profiler().arm(); }
  std::optional<LayerProfile> take_layer_profile() override {
    rg::GpuProfiler& prof = renderer_->device().profiler();
    prof.poll();
    const std::optional<rg::GpuFrameProfile>& last = prof.last();
    if (!last || last->frame == takenProfileFrame_) return std::nullopt;
    takenProfileFrame_ = last->frame;
    LayerProfile out;
    out.totalMs = last->totalMs;
    out.drawnUs = static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
                                          std::chrono::steady_clock::now().time_since_epoch())
                                          .count());
    out.layers.reserve(last->scopes.size());
    for (const rg::GpuScopeCost& c : last->scopes) {
      const api::LayerCostKind kind = c.kind == rg::GpuScopeCost::Kind::scene3d ? api::LayerCostKind::scene3d
                                      : c.kind == rg::GpuScopeCost::Kind::frame  ? api::LayerCostKind::frame
                                                                                 : api::LayerCostKind::layer;
      out.layers.push_back({c.id, kind, c.gpuMs, c.passes});
    }
    return out;
  }
  [[nodiscard]] double decode_ms() const override {
#if defined(PREMATION_HAVE_MEDIA)
    return media_->slowest_ms_per_frame();
#else
    return 0;
#endif
  }
  [[nodiscard]] bool media_settled(const render::MediaWants& wants) override {
    return std::ranges::all_of(wants, [this](const auto& w) {
      if (w.first == kSvgWantSource) return !textures_->svg_pending();  // E4
      if (w.first == kGpuRetrySource) return true;
#if defined(PREMATION_HAVE_MEDIA)
      return media_->settled(w.first, w.second);
#else
      return true;
#endif
    });
  }

  // P7: compile the document's effect pipelines while the render thread idles.
  [[nodiscard]] bool warm_pending() const override { return !warmQueue_.empty(); }
  bool warm_step() override {
    if (warmQueue_.empty()) return false;
    const std::string type = std::move(warmQueue_.front());
    warmQueue_.pop_front();
    // Every pass the effect draws (rg::effect_warm_passes), into a chain target
    // of the precision the last frame's intermediates ran at (the project's bit
    // depth), one sample — the variants its first real draw asks for. Dawn
    // caches the compiled shader under each, which is the expensive part.
    const rg::IntermediatePrecision p = renderer_->precision();
    const wgpu::TextureFormat format = p == rg::IntermediatePrecision::float32   ? wgpu::TextureFormat::RGBA32Float
                                       : p == rg::IntermediatePrecision::float16 ? wgpu::TextureFormat::RGBA16Float
                                                                                  : wgpu::TextureFormat::RGBA8Unorm;
    for (const auto& [m, blend] : rg::effect_warm_passes(type)) renderer_->device().warm_pipeline(m, blend, format);
    // The field passes of a style draw into rgba16float field targets (fx_distance.cpp).
    for (const auto& [m, blend] : rg::effect_field_warm_passes(type)) {
      renderer_->device().warm_pipeline(m, blend, wgpu::TextureFormat::RGBA16Float);
    }
    return true;
  }

  /// Program X: a deep effect that could not run (a shader that does not
  /// compile, an input that did not arrive) kept its layer's picture; say
  /// which and why, once.
  void note_fx_skips(const rg::FrameStats& st) {
    for (const auto& d : st.diagnostics) {
      if (d.code != "fx-graph") continue;
      if (reported_.insert("fxg|" + d.detail.substr(0, 200)).second) {
        PREMATION_LOG(warn, "fx_graph_skipped").kv("detail", d.detail);
      }
    }
  }

  bool draw_still(BuiltFrame& frame, std::uint32_t width, std::uint32_t height, StillImage& out,
                  std::string& error) override {
    const api::RenderFrameFile& file = prepare(frame, width, height, true);
    rg::Frame px;
    rg::FrameStats st;
    renderer_->set_playing(false);
    if (!renderer_->render(file, &px, st, error)) return false;
    note_fx_skips(st);
    if (px.width == 0 || px.height == 0 || px.rgba.size() != std::size_t{px.width} * px.height * 4) {
      error = "the still read back empty";
      return false;
    }
    // The readback is premultiplied (the golden convention); PNG is straight.
    for (std::size_t i = 0; i + 3 < px.rgba.size(); i += 4) {
      const unsigned a = px.rgba[i + 3];
      if (a == 0 || a == 255) {
        if (a == 0) px.rgba[i] = px.rgba[i + 1] = px.rgba[i + 2] = 0;
        continue;
      }
      for (std::size_t k = 0; k < 3; ++k) {
        px.rgba[i + k] = static_cast<std::uint8_t>(std::min(255U, (px.rgba[i + k] * 255U + a / 2) / a));
      }
    }
    out.width = px.width;
    out.height = px.height;
    out.format = "png";
    if (!exporter::encode_png_rgba8(px.rgba, px.width, px.height, out.data)) {
      error = "PNG encoding failed";
      return false;
    }
    return true;
  }

  bool read_working(BuiltFrame& frame, std::uint32_t width, std::uint32_t height, PixelRegion region,
                    WorkingPixels& out, std::string& error) override {
    // Drawn again, into the renderer's own surface (the slot the host shows is
    // not touched): the graph's targets may hold another frame — the viewport
    // may have shown a frame-cache copy, or a still was drawn since — and
    // telling would cost a content key on every viewport draw. A pixel read
    // is a click or a hover (the UI throttles it), not a per-frame cost.
    // A comp-space frame (BuiltFrame::compSpace) is drawn at its own size; the
    // region, given in slot px, is read through its offset — slot pixels the
    // comp does not reach are the border (transparent black here).
    const std::uint32_t drawW = frame.compSpace ? frame.compSpace->width : width;
    const std::uint32_t drawH = frame.compSpace ? frame.compSpace->height : height;
    const std::int64_t offX = frame.compSpace ? frame.compSpace->slotX : 0;
    const std::int64_t offY = frame.compSpace ? frame.compSpace->slotY : 0;
    const api::RenderFrameFile& file = prepare(frame, drawW, drawH, true);
    rg::FrameStats st;
    if (!renderer_->render(file, nullptr, st, error)) return false;
    rg::TargetPixels scene;
    if (!renderer_->read_target(rg::kSceneColor, scene, error)) return false;
    if (!frame.compSpace && (region.x + region.width > scene.width || region.y + region.height > scene.height)) {
      error = "the scene colour is smaller than the viewport's slot";
      return false;
    }
    out.width = region.width;
    out.height = region.height;
    out.rgba.assign(std::size_t{region.width} * region.height * 4, 0.0F);
    for (std::uint32_t y = 0; y < region.height; ++y) {
      for (std::uint32_t x = 0; x < region.width; ++x) {
        const std::int64_t sx = static_cast<std::int64_t>(region.x) + x - offX;
        const std::int64_t sy = static_cast<std::int64_t>(region.y) + y - offY;
        if (sx < 0 || sy < 0 || std::cmp_greater_equal(sx, scene.width) || std::cmp_greater_equal(sy, scene.height)) continue;
        const std::size_t src = (static_cast<std::size_t>(sy) * scene.width + static_cast<std::size_t>(sx)) * 4;
        const std::size_t dst = (std::size_t{y} * region.width + x) * 4;
        const float a = scene.rgba[src + 3];
        // Premultiplied in the graph; the Info panel and the eyedropper want the colour.
        const float inv = a > 0 ? 1.0F / a : 0.0F;
        out.rgba[dst] = scene.rgba[src] * inv;
        out.rgba[dst + 1] = scene.rgba[src + 1] * inv;
        out.rgba[dst + 2] = scene.rgba[src + 2] * inv;
        out.rgba[dst + 3] = a;
      }
    }
    return true;
  }

  /// D4: everything that decides the frame's pixels — the encoded
  /// RenderFrameFile (FrameScene, view, colour, blobs), the texture feed each
  /// key resolves through (raster drawables, footage paths and source times),
  /// the font families and the slot size. The draw is a pure function of these
  /// (CLAUDE.md determinism), so equal keys draw equal pixels.
  [[nodiscard]] std::optional<std::uint64_t> content_key(const BuiltFrame& frame, std::uint32_t width,
                                                         std::uint32_t height) const override {
    // P6: the build hashed the frame (BuiltFrame::contentHash); a frame built
    // without one (a still, a footage thumbnail) is hashed here.
    ContentHash h;
    h.u64(frame.contentHash ? *frame.contentHash : frame_content_hash(frame, keyWriter_));
    h.u64(width);
    h.u64(height);
    return h.value();
  }

  /// The disk cache's key (render/disk_cache.hpp): content_key, salted with
  /// what a file on disk outlives and content_key cannot see — this engine
  /// build (the executable's stamp), the loaded plugins (id, version, status,
  /// bundle stamp), and every footage file's size and modification time. A
  /// rebuilt engine, an updated plugin or a replaced file is a miss, never a
  /// stale frame. Stamps are re-read at most every kStampRecheck.
  [[nodiscard]] std::optional<std::uint64_t> disk_key(const BuiltFrame& frame, std::uint32_t width,
                                                      std::uint32_t height) override {
    const std::optional<std::uint64_t> key = content_key(frame, width, height);
    if (!key) return std::nullopt;
    const auto now = std::chrono::steady_clock::now();
    refresh_salt(now);
    if (frame.mediaBase != stampBase_) {
      stampBase_ = frame.mediaBase;
      stamps_.clear();
    }
    ContentHash h;
    h.u64(*key);
    h.u64(salt_);
    for (const TextureRequest& t : frame.textures) {
      if (!t.src.empty()) h.u64(footage_stamp(t.src, now));
      if (!t.fallbackSrc.empty()) h.u64(footage_stamp(t.fallbackSrc, now));
    }
    return h.value();
  }

  [[nodiscard]] std::uint64_t alias_salt() override {
    refresh_salt(std::chrono::steady_clock::now());
    return salt_;
  }

  [[nodiscard]] bool reads_files(const BuiltFrame& frame) const override {
    // The sources footage_stamp stamps: a file (gltf:<file> included), not an
    // inline image (a stored SVG is a data: URL) or a URL.
    return std::ranges::any_of(frame.textures, [](const TextureRequest& t) {
      return !t.src.empty() && !t.src.starts_with("data:") && !t.src.starts_with("blob:") && !t.src.starts_with("http:") &&
             !t.src.starts_with("https:");
    });
  }

  [[nodiscard]] bool last_frame_exact() const override { return exact_; }

 private:
  /// The frame's file as it draws into width × height, with its texture feed
  /// prepared (rasters, footage) — what every draw of it starts from.
  const api::RenderFrameFile& prepare(BuiltFrame& frame, std::uint32_t width, std::uint32_t height, bool still = false) {
    // New families: the FontSet grows between frames (never while rasterising),
    // and cached rasters drawn without the face are dropped.
    bool added = false;
    for (const std::string& f : frame.fontFamilies) {
      added = (!f.empty() && f.front() == Fonts::kFallbackMark ? fonts_.add_marked(f) : fonts_.add(f)) || added;
    }
    if (added) textures_->clear();
    // Relative media follow the project the frame was built for.
    if (frame.mediaBase != mediaBase_) {
      mediaBase_ = frame.mediaBase;
      textures_->set_media_base(utf8_path(mediaBase_));
    }
#if defined(PREMATION_HAVE_MEDIA)
    // Playing: never block, nearest frame. Cache Work Area (exactMedia_) and
    // stills wait for the exact frame. Paused: a short wait on the latest lane
    // (a scrub supersedes its stale decodes), then the nearest frame — and the
    // render thread draws again once the exact one is decoded (take_media_wants).
    mediaTex_->begin_frame();
    if (frame.playing && !exactMedia_) {
      mediaTex_->set_mode(media::MediaTextures::Mode::preview);
    } else if (exactMedia_ || still) {
      mediaTex_->set_mode(media::MediaTextures::Mode::exact);
      mediaTex_->set_exact_timeout(std::chrono::milliseconds(250));
    } else {
      mediaTex_->set_mode(media::MediaTextures::Mode::settle);
      mediaTex_->set_exact_timeout(std::chrono::milliseconds(60));
    }
#endif
    // Footage changed on disk since this drawer's last frame (reloadItems): its
    // decoders close, so this frame opens the new bytes, and the disk key re-reads stamps.
    if (MediaReloadLog::Pending reload = MediaReloadLog::instance().take(reloadSeen_);
        reload.everything || !reload.paths.empty()) {
      textures_->forget_media(reload.paths, reload.everything);
      stamps_.clear();
    }
    textures_->set_playing(frame.playing);
    // E4: Cache Work Area and stills draw SVGs at their exact step, synchronously.
    textures_->set_exact(exactMedia_ || still);
    textures_->set_color_managed(frame.file.view.color_management.has_value());
    // P6: in place, back to the frame as built (BuiltFrame::asBuilt); refs are
    // filled per draw (their hashes depend on the cache).
    api::RenderFrameFile& file = frame.file;
    if (!frame.asBuilt) {
      frame.asBuilt = BuiltFrame::AsBuilt{file.textures.size(), file.view.css_width, file.view.css_height,
                                          file.view.device_pixel_ratio};
    }
    file.textures.resize(frame.asBuilt->textureRefs);
    file.view.css_width = frame.asBuilt->cssWidth;
    file.view.css_height = frame.asBuilt->cssHeight;
    file.view.device_pixel_ratio = frame.asBuilt->devicePixelRatio;
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
    return file;
  }


  explicit ViewportDrawer(const EngineFramesOptions& o) : fonts_(o) {}

  /// A file's size and modification time as one word (0 = missing / unreadable).
  static std::uint64_t file_stamp(const std::filesystem::path& p) {
    std::error_code ec;
    std::uintmax_t size = std::filesystem::file_size(p, ec);
    if (ec) size = 0;  // a folder (a plugin bundle) has no size; its time still says it changed
    const auto time = std::filesystem::last_write_time(p, ec);
    if (ec) return 0;
    ContentHash h;
    h.u64(static_cast<std::uint64_t>(size));
    h.u64(static_cast<std::uint64_t>(time.time_since_epoch().count()));
    return h.value();
  }

  /// Everything a cached frame on disk depends on besides the frame itself.
  static std::uint64_t disk_salt() {
    ContentHash h;
    // Bump to orphan every disk cache file (a change in what frames look like
    // that the executable's stamp would not show, e.g. a shared GPU driver path).
    h.str("premation-disk-cache-1");
    h.u64(file_stamp(utf8_path(os::executable_path())));
    if (const plugins::PluginHost* host = plugins::PluginHost::active()) {
      for (const plugins::PluginRecord& p : host->plugins()) {
        h.str(p.id);
        h.str(p.version);
        h.u64(static_cast<std::uint64_t>(p.status));
        h.u64(file_stamp(utf8_path(p.path)));
      }
    }
    return h.value();
  }

  /// A footage source's file stamp, cached for kStampRecheck (sources that are not files: 0).
  std::uint64_t footage_stamp(const std::string& src, std::chrono::steady_clock::time_point now) {
    if (const auto it = stamps_.find(src); it != stamps_.end() && now - it->second.second < kStampRecheck) {
      return it->second.first;
    }
    std::uint64_t stamp = 0;
    if (!src.starts_with("data:") && !src.starts_with("blob:") && !src.starts_with("http:") &&
        !src.starts_with("https:")) {
      // gltf:<file>#… — a model's images: the model file's stamp.
      std::string file = file_url_path(src.starts_with("gltf:") ? std::string_view(src).substr(5) : std::string_view(src));
      if (const std::size_t hash = src.starts_with("gltf:") ? file.find('#') : std::string::npos; hash != std::string::npos) {
        file.resize(hash);
      }
      std::filesystem::path p = utf8_path(file);
      if (p.is_relative() && !stampBase_.empty()) p = utf8_path(stampBase_) / p;
      stamp = file_stamp(p);
    }
    stamps_.insert_or_assign(src, std::make_pair(stamp, now));
    return stamp;
  }

  static constexpr std::chrono::seconds kStampRecheck{2};
  /// disk_salt(), re-read at most every kStampRecheck.
  void refresh_salt(std::chrono::steady_clock::time_point now) {
    if (now - saltAt_ >= kStampRecheck || salt_ == 0) {
      saltAt_ = now;
      salt_ = disk_salt();
    }
  }
  std::uint64_t salt_ = 0;
  std::chrono::steady_clock::time_point saltAt_{};
  std::string stampBase_;
  std::unordered_map<std::string, std::pair<std::uint64_t, std::chrono::steady_clock::time_point>> stamps_;
  mutable wire::Writer keyWriter_;
  bool exact_ = false;
  bool exactMedia_ = false;  // RenderJob::exactMedia of the job being drawn
  /// E4: the last draw used an SVG stand-in step (take_media_wants reports the sentinel want).
  bool svgWant_ = false;
  static constexpr std::uint32_t kSvgWantSource = 0xFFFFFFFFU;
  /// The last draw hit a GPU error: draw it again (take_media_wants' sentinel), up to kGpuRetries in a row.
  bool gpuRetry_ = false;
  std::uint32_t gpuErrorStreak_ = 0;
  static constexpr std::uint32_t kGpuRetries = 2;
  static constexpr std::uint32_t kGpuRetrySource = 0xFFFFFFFEU;
#if defined(PREMATION_HAVE_MEDIA)
  std::vector<std::pair<media::SourceId, std::int64_t>> wants_;  // the last draw's stand-in footage frames
#endif
  std::set<std::string> warmSeen_;      // P7: effect types queued (or warmed) once
  std::deque<std::string> warmQueue_;   // P7: still to compile, while idle
  std::string mediaBase_;    // the texture feed's (BuiltFrame::mediaBase)
  Fonts fonts_;
  std::unique_ptr<rg::SceneRenderer> renderer_;
  /// The profiler frame of the last sample take_layer_profile handed out.
  std::uint64_t takenProfileFrame_ = 0;
  std::unique_ptr<SceneTextures> textures_;
  /// The last footage reload this drawer applied (media_reload.hpp).
  std::uint64_t reloadSeen_ = MediaReloadLog::instance().generation();
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
  bool waveform(std::string_view layerId, std::vector<float>& peaks, double& duration) override {
    peaks.clear();
    duration = 0;
    if (doc_ == nullptr) return false;
    const doc::Node* n = doc_->node(layerId);
    if (n == nullptr) return true;
    const doc::Component* a = n->comp("Audio");
    if (a == nullptr) return true;
    const Json& p = a->props;
    const std::string assetId = p.at("__assetId").is_string() ? p.at("__assetId").str() : "";
    std::string src = p.at("__src").is_string() ? p.at("__src").str() : "";
    if (!assetId.empty()) {
      if (const Json* asset = doc::find_asset(*doc_, assetId); asset != nullptr && asset->at("src").is_string()) src = doc::asset_media_src(*asset);
    }
    if (src.empty()) return true;
    const std::uint64_t id = source_of(src);
    if (id == 0) return true;
    const audio::SourceState st = system_.state(id);
    if (st == audio::SourceState::unknown || st == audio::SourceState::conforming) return false;
    const audio::SourcePtr data = system_.source(id);
    if (!data || !data->complete() || !(data->sample_rate() > 0)) return st == audio::SourceState::ready ? false : true;
    duration = static_cast<double>(data->total_frames()) / data->sample_rate();
    if (!(duration > 0)) return true;
    peaks = audio::ts_envelope(system_.peaks(id, 0, duration, 1024, true));
    return true;
  }

  HookAnswer peaks(std::string_view src, double fromSec, double durationSec, std::uint32_t buckets,
                   api::WaveformPeaks& out) override {
    out = {};
    const std::uint64_t id = source_of(std::string(src));
    if (id == 0) return HookAnswer::ready;  // cannot be opened: no sound (logged by source_of)
    const audio::SourceState st = system_.state(id);
    if (st == audio::SourceState::unknown || st == audio::SourceState::conforming) return HookAnswer::pending;
    const audio::SourcePtr data = system_.source(id);
    if (st != audio::SourceState::ready || !data || !(data->sample_rate() > 0)) return HookAnswer::ready;
    if (!data->complete()) return HookAnswer::pending;
    const double total = static_cast<double>(data->total_frames()) / data->sample_rate();
    const double from = std::clamp(fromSec, 0.0, total);
    const double want = durationSec > 0 ? durationSec : total - from;
    const double inside = std::max(0.0, std::min(want, total - from));
    // Bucket b covers [from + b·want/buckets, …) whatever the source's length:
    // the part of the window past the end is zero buckets, not a stretch of
    // the rest (query_peaks spreads its buckets over the frames it is given).
    std::uint32_t nIn = buckets;
    if (inside < want && want > 0) {
      nIn = static_cast<std::uint32_t>(std::floor(static_cast<double>(buckets) * inside / want));
    }
    const auto channels = static_cast<std::uint32_t>(std::max(0, data->channels()));
    out.channels = channels;
    out.buckets = buckets;
    out.peaks.assign(static_cast<std::size_t>(buckets) * channels * 2, 0.0F);
    out.rms.assign(buckets, 0.0F);
    if (nIn == 0 || channels == 0) return HookAnswer::ready;
    const double span = inside < want ? want * nIn / buckets : inside;
    const audio::WaveformPeaksResult r = system_.peaks(id, from, span, nIn, false);
    std::copy(r.peaks.begin(), r.peaks.begin() + static_cast<std::ptrdiff_t>(std::min(r.peaks.size(), out.peaks.size())),
              out.peaks.begin());
    std::copy(r.rms.begin(), r.rms.begin() + static_cast<std::ptrdiff_t>(std::min(r.rms.size(), out.rms.size())),
              out.rms.begin());
    return HookAnswer::ready;
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
    doc_ = &d;
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
    for (const auto& [path, id] : sources_snapshot()) {
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

  /// The source id of a media path, opened on first use. Reached from the
  /// core thread (set_document, the peaks query hook) AND the build worker
  /// (an audio-waveform layer's `waveform`) — the map is shared under
  /// `sourcesMu_`; AudioSystem::open_source is itself thread-safe.
  std::uint64_t source_of(const std::string& src) {
    const std::string path = file_url_path(src);
    {
      const std::lock_guard<std::mutex> lock(sourcesMu_);
      if (const auto it = sources_.find(path); it != sources_.end()) return it->second;
    }
    std::string err;
    const std::uint64_t id = system_.open_source(path, err);
    if (id == 0) {
      PREMATION_LOG(warn, "audio_source_failed").kv("path", path).kv("error", err);
    }
    const std::lock_guard<std::mutex> lock(sourcesMu_);
    return sources_.emplace(path, id).first->second;
  }

  /// A snapshot of the opened sources (mixdown waits on each; it must not hold
  /// the lock while it waits).
  std::vector<std::pair<std::string, std::uint64_t>> sources_snapshot() {
    const std::lock_guard<std::mutex> lock(sourcesMu_);
    return {sources_.begin(), sources_.end()};
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

  /// Interpret Footage ▸ Loop (`interpret.loopCount`, 0 = forever): the voice
  /// reads its source modulo its length, as the picture does (snapshot_build),
  /// for as long as the layer's bar lasts — a 4 s ambience under a 30 s scene.
  static bool asset_loops(const Json* asset) {
    if (asset == nullptr) return false;
    const Json& n = asset->at("interpret").at("loopCount");
    return n.is_number() && n.num() != 1;
  }

  /// What the PICTURE shows of a retimed layer at comp time `t`: its own
  /// Time Remap / Speed % (retimed_chain_time) through the bar live (or
  /// nearest) at `t`, the footage loop and the layer's stretch / reverse —
  /// Walk::retimed_source_at (snapshot_build.cpp) without the precomp-ancestor
  /// fold (comp_voices places nested comps on the host clock itself) and
  /// without Posterize Time. For a precomp instance the value is the inner
  /// comp time it shows. audioScene.ts fed the same curve to
  /// buildAudioRetimeSegments.
  static double retimed_source_sec(const Ctx& c, const doc::Node& n, const Json* asset, double fps, double t) {
    const std::vector<const doc::Bar*> bars = doc::tl_bars_for_node(c.d, c.view, n.id);
    const double exact = t * fps;
    const doc::Bar* active = nullptr;
    for (const doc::Bar* b : bars) {
      if (b->active_at(std::round(exact))) {
        active = b;
        break;
      }
    }
    if (active == nullptr) active = pick_retime_bar(bars, std::round(exact));
    const std::optional<RetimeClip> clip = retime_clip_of(active, fps);
    const std::optional<double> retimed = retimed_chain_time(RetimeReader{c.d, c.expr, c.cache}, n.id, t, clip);
    const double tt = retimed.value_or(t);
    double time = active != nullptr ? active->clip.source_frame_at(tt * fps) / fps : tt;
    if (asset != nullptr) {
      const Json& lc = asset->at("interpret").at("loopCount");
      const double loopCount = lc.is_number() ? lc.num() : 1;
      const Json& dj = asset->at("metadata").at("duration");
      const double dur = dj.is_number() ? dj.num() : 0;
      if (loopCount != 1 && dur > 0 && time >= dur) {
        const double pass = std::floor(time / dur);
        time = (loopCount != 0 && pass >= loopCount) ? dur - 1e-6 : time - pass * dur;
      }
    }
    if (const auto cfg = doc::read_node_layer_time(n)) {
      double s0 = 0;
      double s1 = 1;
      if (const auto span = doc::anim_time_span(c.d, n.id)) {
        s0 = span->start;
        s1 = span->end;
      } else if (active != nullptr && active->clip.duration > 0) {
        s0 = active->clip.sourceIn / fps;
        s1 = s0 + active->clip.duration / fps;
      } else if (asset != nullptr && asset->at("metadata").at("duration").is_number() &&
                 asset->at("metadata").at("duration").num() > 0) {
        s1 = asset->at("metadata").at("duration").num();
      }
      time = doc::remap_time(time, *cfg, s0, s1);
    }
    return time;
  }

  /// readAudioVoices (an audio layer).
  std::vector<audio::Voice> audio_voices(const Ctx& c, const doc::Node& n) {
    const doc::Component* a = n.comp("Audio");
    if (a == nullptr) return {};
    const Json& p = a->props;
    const std::string assetId = p.at("__assetId").is_string() ? p.at("__assetId").str() : "";
    std::string src = p.at("__src").is_string() ? p.at("__src").str() : "";
    const Json* asset = assetId.empty() ? nullptr : doc::find_asset(c.d, assetId);
    if (asset != nullptr) {
      if (std::string media = doc::asset_media_src(*asset); !media.empty()) src = std::move(media);
    }
    const bool loops = asset_loops(asset);
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
      v.loop = loops;
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
    if (asset != nullptr) {
      if (std::string media = doc::asset_media_src(*asset); !media.empty()) src = std::move(media);
    }
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
    // Time Remap / Speed % (readVideoAudioVoices -> buildAudioRetimeSegments):
    // the bar is cut into constant-rate varispeed windows that follow the
    // picture's source-time curve; stretch and reverse are inside that curve.
    const bool retimed = doc::read_retime_mode(c.d, n.id) != api::RetimeMode::normal;
    double fps = doc::tl_fps_for_node(c.d, c.view, n.id);
    if (!(fps > 0)) fps = 30;
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
      v.loop = asset_loops(asset);
      v.muted = muted || !t.enabled || freeze;
      finish_voice(c, n, v, db);
      if (retimed && !freeze) {
        const auto sourceAt = [&](double at) { return retimed_source_sec(c, n, asset, fps, at); };
        const std::vector<audio::RateSegment> segs = audio::retime_segments(sourceAt, t, fps);
        // Holds and zero-length bars are silence: no voice (as the TS).
        for (audio::Voice& seg : audio::expand_segments(v, t, segs)) out.push_back(std::move(seg));
        continue;
      }
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
            // placeNestedVoices: a retimed / stretched / reversed instance
            // carries its inner comp's sound through the inner-time curve the
            // picture shows (constant-rate stretches of it).
            const bool retimed =
                doc::read_retime_mode(c.d, n->id) != api::RetimeMode::normal || lt.stretch != 100 || lt.reverse;
            double fps = doc::tl_fps_for_node(c.d, c.view, n->id);
            if (!(fps > 0)) fps = 30;
            const doc::Node* inst = n;
            const auto innerAt = [&c, inst, fps](double t) { return retimed_source_sec(c, *inst, nullptr, fps, t); };
            voices = audio::place_nested(n->id, inner, spans, retimed, innerAt, fps, !n->visible);
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
  const doc::Document* doc_ = nullptr;
  AudioTransportClock clock_;
  std::mutex sourcesMu_;  // sources_: core thread + build worker (source_of)
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

std::vector<std::string> document_font_families(const doc::Document& d) {
  // With the per-character fallbacks the document's text needs, marked
  // (Fonts::kFallbackMark) — an export draws the same glyphs the viewport does.
  std::vector<std::string> out = document_families(d);
  std::set<std::pair<std::string, std::string>> seen;
  std::set<std::pair<char32_t, std::string>> looked;
  for (const TextRun& r : document_text_runs(d)) {
    for (const raster::CodePoint& c : raster::decode_utf8(r.text)) {
      if (c.cp < 0x80 || !looked.emplace(c.cp, r.language).second) continue;
      if (auto fam = raster::FontSet::fallback_family_for(c.cp, 400, false, r.language); fam && seen.emplace(*fam, r.language).second) {
        out.push_back(Fonts::marked(*fam, r.language));
      }
    }
  }
  return out;
}

WaveformProvider offline_waveform(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                  doc::ExprCache& cache) {
#if defined(PREMATION_HAVE_AUDIO)
  // shared_ptr: the std::function is copyable, every copy shares the one lazily
  // started audio engine (and its decoded sources).
  auto audio = std::make_shared<std::unique_ptr<EngineAudio>>();
  return [audio, &d, &view, &expr, &cache](std::string_view layerId, std::vector<float>& peaks, double& duration) {
    if (!*audio) {
      *audio = std::make_unique<EngineAudio>(false);
      (*audio)->set_document(d, view, expr, cache, "");
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(5);
    while (!(*audio)->waveform(layerId, peaks, duration)) {
      if (std::chrono::steady_clock::now() > deadline) return false;
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return true;
  };
#else
  (void)d, (void)view, (void)expr, (void)cache;
  return {};
#endif
}

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
