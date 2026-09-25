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
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "canvas.hpp"
#include "frame_build.hpp"
#include "render_context.hpp"

namespace premation::effects {
class ThreadPool;
}

namespace premation::media {
class MediaSystem;
class MediaTextures;
}

namespace premation::scene {

struct RasterEntry {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  // premultiplied RGBA8, rows top-down
  std::vector<std::string> unsupported;
  std::string error;
};

/// A document media `src` as a file path: `file://` and the desktop app's
/// `local-file://` URLs decoded; anything else returned unchanged.
[[nodiscard]] std::string file_url_path(std::string_view src);

struct PrepareStats {
  std::uint32_t rasterHits = 0;
  std::uint32_t rasterMisses = 0;
  double rasterMs = 0;        // wall time spent drawing misses (parallel)
  std::uint32_t mediaRefs = 0;
  /// Features the painters could not draw (key → what), for the explicit-fallback report.
  std::vector<std::pair<std::string, std::string>> unsupported;
};

class SceneTextures final : public rg::ExternalTextureSource {
 public:
  struct Options {
    raster::CanvasOptions canvas;
    /// CPU raster cache budget (bytes of RGBA8).
    std::size_t rasterCacheBytes = std::size_t{768} << 20U;
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

  /// Resolve a frame's requests into refs (key → hash), rasterising misses.
  void prepare(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs, PrepareStats& stats);

  [[nodiscard]] rg::TexRef external_texture(std::string_view hash) override;

  /// A cached raster by its hash (the parity tool reads pixels back).
  [[nodiscard]] const RasterEntry* raster(std::string_view hash) const;
  /// Drop every cached raster (fonts changed).
  void clear();

 private:
  struct Slot {
    std::string hash;
    std::shared_ptr<const RasterEntry> entry;  // shared: a frame in flight keeps its pixels while the LRU evicts
  };
  std::string media_ref(const TextureRequest& r, PrepareStats& stats, std::optional<api::RenderColorSpace>& space);
  std::string image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats);
  void insert(std::string hash, std::shared_ptr<const RasterEntry> e);
  [[nodiscard]] std::shared_ptr<const RasterEntry> find(std::string_view hash);

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
  std::unordered_map<std::string, std::uint32_t> sources_;  // resolved path → SourceId
  std::unordered_map<std::string, std::string> openErrors_;
  /// The CPU bakes' kernel pool (bake_chain.hpp SharedPool): one bake at a time
  /// uses it, the others run their kernels inline — the bytes are the same.
  std::unique_ptr<effects::ThreadPool> bakePool_;
  std::mutex bakePoolM_;
};

}  // namespace premation::scene
