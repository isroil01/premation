// The scene builder's texture feed — the engine's AppTextureProvider: every
// texture key a built FrameScene names resolves here, by content.
//
//   text / path / mask   drawn by the E3 painters (native/engine/src/raster) from
//                        the drawable the builder emitted, cached by a hash of
//                        (kind, drawable, raster scale, padding) — a transform-only
//                        animation re-uses one raster, as the TS provider does.
//                        Misses rasterise on a small pool of threads (the painters
//                        are thread-safe per canvas; fonts keep per-thread caches).
//   asset (footage)      E1: the source is opened in the engine's MediaSystem, the
//                        layer's source time is planned to a presentation frame
//                        (time_map.hpp plan_frames) and the ref names the
//                        `media:<source>:<frame>` hash MediaTextures resolves.
//
// It is the render graph's ExternalTextureSource: a ref carries a hash and no
// pixels, and the graph asks here when it samples it — pixels are uploaded once
// per content (rg::Device pools textures by hash) and never copied per frame.
#pragma once

#include <cstdint>
#include <filesystem>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "canvas.hpp"
#include "media_paths.hpp"
#include "frame_build.hpp"
#include "pixel_motion.hpp"
#include "raster_source.hpp"
#include "render_context.hpp"

namespace premation::effects {
class ThreadPool;
}

namespace premation::media {
class MediaSystem;
class MediaTextures;
struct FramePick;
struct ConvertedFrame;
}

namespace premation::scene {

struct RasterEntry {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  // premultiplied RGBA8, rows top-down
  std::vector<std::string> unsupported;
  std::string error;
};

struct PrepareStats {
  std::uint32_t rasterHits = 0;
  std::uint32_t rasterMisses = 0;
  double rasterMs = 0;        // wall time spent drawing misses (parallel)
  // Summed over the misses (thread time, not wall): content paint, bake (mask
  // matte + effect chain), pixel read-back. Measurement only, never an input.
  double contentMs = 0;
  double bakeMs = 0;
  double readMs = 0;
  std::uint32_t mediaRefs = 0;
  /// E4: GPU Vegas contour textures made this frame (once per content + threshold).
  std::uint32_t contourBuilds = 0;
  /// Rasters over the device's 2D texture limit, not uploaded (their layers draw nothing).
  std::uint32_t oversizeRefused = 0;
  /// Bytes the raster cache held past its budget after this frame's rasters:
  /// the frame alone needs more than the budget (nothing of it was evicted).
  std::size_t rasterOverBudget = 0;
  /// E4: SVG rasters handed to the worker this frame (a stand-in or preview drew meanwhile).
  std::uint32_t svgAsync = 0;
  /// Features the painters could not draw (key → what), for the explicit-fallback report.
  std::vector<std::pair<std::string, std::string>> unsupported;
};

/// The raster cache's budget on a machine with `physicalBytes` installed: an
/// eighth of it, within [768 MiB, 4 GiB]; 768 MiB when the OS does not say.
/// (The RAM tier of the frame cache takes up to half — ram_cache.hpp.)
[[nodiscard]] inline std::size_t raster_cache_budget(std::uint64_t physicalBytes) noexcept {
  constexpr std::uint64_t kMiB = std::uint64_t{1} << 20U;
  const std::uint64_t floor = 768 * kMiB;
  const std::uint64_t ceiling = 4096 * kMiB;
  if (physicalBytes == 0) return static_cast<std::size_t>(floor);
  const std::uint64_t want = physicalBytes / 8;
  return static_cast<std::size_t>(want < floor ? floor : (want > ceiling ? ceiling : want));
}

class SceneTextures final : public rg::ExternalTextureSource {
 public:
  struct Options {
    raster::CanvasOptions canvas;
    /// CPU raster cache budget (bytes of RGBA8): a steady-state limit. The
    /// frame being prepared always fits (see `frame_`); raster_cache_budget sizes it.
    std::size_t rasterCacheBytes = std::size_t{768} << 20U;
    /// Baked-content cache budget (bytes of canvas pixels); 0 = off.
    std::size_t contentCacheBytes = std::size_t{256} << 20U;
    /// Raster worker threads for a frame's misses (0 = hardware concurrency, capped at 8).
    unsigned threads = 0;
    /// Relative media paths resolve against this directory (the project's).
    std::filesystem::path mediaBase;
  };

  explicit SceneTextures(Options opts);
  ~SceneTextures() override;
  SceneTextures(const SceneTextures&) = delete;
  SceneTextures& operator=(const SceneTextures&) = delete;
  SceneTextures(SceneTextures&&) = delete;
  SceneTextures& operator=(SceneTextures&&) = delete;

  /// The device rasters upload to (the render thread's). Null = CPU only (tests).
  void set_device(rg::Device* dev) noexcept { dev_ = dev; }
  /// Footage: the engine's media system and the render-graph source of its frames.
  void set_media(media::MediaSystem* system, media::MediaTextures* frames) noexcept;
  void set_media_base(std::filesystem::path base) { opts_.mediaBase = std::move(base); }
  /// Transport playing: footage sources read ahead of the frames they are asked for.
  void set_playing(bool playing) noexcept { playing_ = playing; }
  /// D3: the frame is colour-managed (RenderView.colorManagement present) — every
  /// COLOUR ref gets its interpretation (RenderTextureRef.inputSpace): footage by
  /// what the file says, stills and authored text / shape rasters as sRGB; masks
  /// stay data. Off = no ref is tagged (the TS pipeline, byte for byte).
  void set_color_managed(bool managed) noexcept { colorManaged_ = managed; }
  /// E4 (3D perf program): exact mode — exports, Cache Work Area, stills — an
  /// SVG source is drawn synchronously at its exact display step. Off (the
  /// viewport): the nearest cached step (or a quick 512 px preview) draws now,
  /// the exact step rasterises on the SVG worker, and `svg_stand_in()` says so.
  void set_exact(bool exact) noexcept { exact_ = exact; }
  /// E4: the last prepare drew an SVG from a stand-in step (its exact raster
  /// was still on the worker). The frame is not final: draw again when
  /// `svg_pending()` clears.
  [[nodiscard]] bool svg_stand_in() const noexcept { return svgStandIn_; }
  /// E4: SVG rasters queued or in flight on the worker.
  [[nodiscard]] bool svg_pending() const;
  /// E4: block until the worker's queue is empty (tests; bounded by `timeoutMs`).
  bool wait_svg_idle(std::uint32_t timeoutMs);

  /// Resolve a frame's requests into refs (key → hash), rasterising misses.
  void prepare(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs, PrepareStats& stats);

  [[nodiscard]] rg::TexRef external_texture(std::string_view hash) override;
  /// A raster / still image with a mip chain (its own pool entry, `#mip`): 3D quads.
  [[nodiscard]] rg::TexRef external_texture_mipmapped(std::string_view hash, const rg::MipFootprint& fp) override;

  /// A cached raster by its hash (the parity tool reads pixels back).
  [[nodiscard]] const RasterEntry* raster(std::string_view hash) const;
  /// Drop every cached raster (fonts changed).
  void clear();
  /// Footage files changed on disk (media_reload.hpp): close their decoders and
  /// forget a failed open, so the next request opens the new bytes. Render
  /// thread (the caller of prepare). `everything` = every footage source.
  void forget_media(const std::vector<std::string>& paths, bool everything);

 private:
  struct Slot {
    std::string hash;
    std::shared_ptr<const RasterEntry> entry;  // shared: a frame in flight keeps its pixels while the LRU evicts
    /// The prepare (frame_) that last read or made it: eviction never takes a
    /// raster of the frame being prepared, whatever the budget says (below).
    std::uint64_t lastUse = 0;
  };
  /// prepare without the device-limit check.
  void prepare_refs(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs, PrepareStats& stats);
  std::string media_ref(const TextureRequest& r, PrepareStats& stats, std::optional<api::RenderColorSpace>& space);
  std::string image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats);
  /// A subject matte (r.subjectParts): each subject's stored frame decoded (image_ref), its live
  /// edge applied and the subjects united (subject_matte.hpp), cached by the files and the settings.
  std::string subject_ref(const TextureRequest& r, PrepareStats& stats);
  /// P7b: footage a native plugin importer reads (scene_textures_plugin.cpp).
  std::string plugin_image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats);
  /// A still carried as a `data:image/…;base64,` URL (a content-aware fill frame).
  std::string data_image_ref(const TextureRequest& r, PrepareStats& stats);
  std::string svg_ref(const TextureRequest& r, PrepareStats& stats);
  /// A CPU-baked chain on footage: `base` (the decoded frame, premultiplied;
  /// default = the cached raster `baseHash`) drawn at the bake size, fields
  /// rebuilt, then bake_chain bake_footage — an `img:bake:` raster.
  std::string footage_bake_ref(const TextureRequest& r, const std::string& baseHash, PrepareStats& stats,
                               std::shared_ptr<const RasterEntry> base = nullptr);
  // Footage (defined with E1 media; declared unconditionally so the class is
  // one layout in every translation unit).
  /// A baked video frame: converted, read back, then footage_bake_ref.
  std::string video_bake_ref(const TextureRequest& r, std::uint32_t id, const media::FramePick& pick, PrepareStats& stats);
  /// Pixel Motion (`vfm:`): the flow-warped in-between of frames a and b of
  /// source `id` at the request's weight, as an `img:pm2:` raster — or the
  /// nearer frame's media hash while either is still decoding.
  std::string pixel_motion_ref(const TextureRequest& r, std::uint32_t id, const media::FramePick& a,
                               const media::FramePick& b, PrepareStats& stats);
  /// The media source of a resolved footage path (`key`), opened on first use;
  /// nullopt with `error` when it does not open (remembered: no re-probe per frame).
  std::optional<std::uint32_t> open_media(const std::string& key, std::string& error);
  /// A converted frame's pixels as RGBA8 (premultiplied, as converted), top-down.
  bool read_frame_rgba8(const media::ConvertedFrame& f, std::vector<std::uint8_t>& rgba, std::string& error);
  /// Pixel Motion flow per frame pair (render thread only), most recent first.
  struct FlowEntry {
    std::string key;
    pixmo::PairFlow flow;
  };
  std::list<FlowEntry> flows_;
  /// `gltf:<modelKey>#<image>`: a registered model's image (scene_textures_model.cpp).
  std::string model_ref(const TextureRequest& r, PrepareStats& stats);
  /// E4: TexKind::contours — each request's source raster (a ref of this frame,
  /// by key) as the Vegas contour texture, keyed by that raster's hash + threshold.
  void resolve_contours(std::span<const std::pair<const TextureRequest*, std::size_t>> reqs,
                        std::vector<api::RenderTextureRef>& refs, PrepareStats& stats);
  void insert(std::string hash, std::shared_ptr<const RasterEntry> e);
  [[nodiscard]] std::shared_ptr<const RasterEntry> find(std::string_view hash);
  /// Baked rasters' painted content (raster_source.hpp BakedContent), by content key.
  [[nodiscard]] std::shared_ptr<const raster::BakedContent> find_content(std::uint64_t key);
  void insert_content(std::uint64_t key, std::shared_ptr<const raster::BakedContent> c);

  Options opts_;
  rg::Device* dev_ = nullptr;
  media::MediaSystem* media_ = nullptr;
  media::MediaTextures* mediaFrames_ = nullptr;
  bool playing_ = false;
  bool colorManaged_ = false;
  mutable std::mutex m_;
  std::list<Slot> lru_;
  std::unordered_map<std::string, std::list<Slot>::iterator, rg::KeyHash, std::equal_to<>> byHash_;
  std::size_t bytes_ = 0;
  /// The current prepare, counted per `prepare` (guarded by m_). A frame's
  /// rasters all carry it; `insert` evicts from the LRU's tail only while the
  /// tail is of an EARLIER frame. Before this, one frame whose rasters
  /// outgrew the budget (a 3D comp with the camera close: each layer's raster
  /// follows its projected size, up to 64 MB) evicted its own earlier layers
  /// while rasterising the later ones — and an evicted raster is not
  /// re-prepared, so those layers drew nothing on that frame: objects and
  /// strokes blinking out at the frames where the comp was heaviest. The
  /// budget is a steady-state limit; one frame may exceed it.
  std::uint64_t frame_ = 0;
  // The baked content cache: a re-bake whose content key is unchanged (only
  // the stack's params or the fill opacity moved) copies the painted canvas
  // instead of repainting it. Small LRU; guarded by m_.
  struct ContentSlot {
    std::uint64_t key;
    std::shared_ptr<const raster::BakedContent> content;  // shared: a bake in flight keeps its copy source
    std::size_t bytes;
  };
  std::list<ContentSlot> contentLru_;
  std::unordered_map<std::uint64_t, std::list<ContentSlot>::iterator> contentByKey_;
  std::size_t contentBytes_ = 0;
  std::unordered_map<std::string, std::uint32_t> sources_;  // resolved path → SourceId
  std::unordered_map<std::string, std::string> openErrors_;
  /// SVG documents seen (svg_ref's document key) → whether they animate.
  std::unordered_map<std::string, bool> svgAnimated_;
  // E4: SVGs at the displayed size. A request's display long edge is quantised
  // to a step (√2 apart, 16 … 4096 px); while playing, a request keeps its last
  // step until the need leaves [½, 1] × that step's size (no re-raster per frame).
  std::unordered_map<std::string, int> svgLastStep_;  // request key → the step last drawn
  bool exact_ = false;
  bool svgStandIn_ = false;
  struct SvgJob {
    std::string key;
    std::string src;
    std::optional<std::string> fill;
    std::string path;
    double time = 0;
    double targetLong = 0;
  };
  struct SvgWorker;  // scene_textures.cpp: one thread, FIFO, keys de-duplicated
  std::unique_ptr<SvgWorker> svgWorker_;
  void svg_enqueue(SvgJob job);
  /// A static document keeps one raster: once step `step` is in, the steps below it are dropped.
  void svg_drop_below(const std::string& doc, int step);
  /// The SVG display step for a request's need, with playback hysteresis (remembers it per request key).
  [[nodiscard]] int svg_step_for(const TextureRequest& r);
  /// The CPU bakes' kernel pool (bake_chain.hpp SharedPool): one bake at a time
  /// uses it, the others run their kernels inline — the bytes are the same.
  std::unique_ptr<effects::ThreadPool> bakePool_;
  std::mutex bakePoolM_;
};

}  // namespace premation::scene
