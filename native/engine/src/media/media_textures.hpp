// The media system as a render-graph texture source (rg::ExternalTextureSource).
//
// A footage layer's RenderTextureRef carries a hash with no blob:
//
//     media:<source>:<frame>            one presentation frame
//     media:<source>:<top>~<bottom>     a pulldown weave (even rows top, odd rows bottom)
//     …#u / …#l                         Interpret Footage ▸ Fields: the upper / lower
//                                       field kept, the other rebuilt (deinterlace.ts)
//
// (`media_hash()` builds them.) The engine's scene builder turns a layer's
// source time into frames with time_map.hpp `plan_frames`, emits one ref per
// frame (frame blending: `vfa:`/`vfb:` keys as the TS exporter does, B drawn
// over A at the blend weight), and sets inputSpace from `input_space_of`.
//
// Resolution on the render thread:
//   * preview (Mode::preview): never blocks. A frame not yet decoded is
//     requested on the latest lane and the NEAREST cached frame of that source
//     is drawn instead (exactVideoFrames.ts `get` → nearest, exact:false); no
//     frame at all → the draw is skipped (the TS 'pending').
//   * export (Mode::exact): blocks until the exact frame is decoded (or the
//     timeout — then the draw is skipped and `lastMisses()` reports it).
//   * paused viewport (Mode::settle): waits briefly on the LATEST lane (a
//     newer seek supersedes it — a scrub never queues a backlog of stale
//     decodes), then draws the nearest decoded frame; the frames still wanted
//     are reported (`Misses::wanted`) so the render thread draws again once
//     they are decoded (`settled`).
// Converted textures are kept per hash for a few frames (a paused viewport
// re-renders without re-converting) and recycled by size.
#pragma once

#include <chrono>
#include <cstdint>
#include <list>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "frame_convert.hpp"
#include "media_system.hpp"
#include "render_context.hpp"

namespace premation::media {

[[nodiscard]] std::string media_hash(SourceId source, std::int64_t frame);
[[nodiscard]] std::string media_hash(SourceId source, std::int64_t top, std::int64_t bottom);
/// With a field pass: `fields` 'u' / 'l' appends `#u` / `#l` (0 = none).
[[nodiscard]] std::string media_hash(SourceId source, std::int64_t frame, std::optional<std::int64_t> bottom, char fields);

/// Parsed form of a media hash (nullopt when `hash` is not one).
struct MediaKey {
  SourceId source = 0;
  std::int64_t frame = 0;
  std::int64_t bottom = -1;  // ≥ 0: a weave
  char fields = 0;           // 'u' / 'l': deinterlaced keeping that field
};
[[nodiscard]] std::optional<MediaKey> parse_media_hash(std::string_view hash) noexcept;

class MediaTextures final : public rg::ExternalTextureSource {
 public:
  enum class Mode : std::uint8_t { preview, exact, settle };

  MediaTextures(MediaSystem& media, wgpu::Device device, Mode mode = Mode::preview);
  ~MediaTextures() override;
  MediaTextures(const MediaTextures&) = delete;
  MediaTextures& operator=(const MediaTextures&) = delete;
  MediaTextures(MediaTextures&&) = delete;
  MediaTextures& operator=(MediaTextures&&) = delete;

  [[nodiscard]] rg::TexRef external_texture(std::string_view hash) override;

  void set_mode(Mode m) noexcept { mode_ = m; }
  void set_exact_timeout(std::chrono::milliseconds t) noexcept { timeout_ = t; }
  /// Interpret Footage ▸ Alpha per source (default straight).
  void set_alpha(SourceId source, AlphaMode alpha);
  /// Converted textures kept (by hash) before recycling — at most `n`, and at
  /// most `bytes` of them (a 4K RGBA16F frame is 66 MB: 24 of them pinned
  /// 1.6 GB of a laptop GPU's VRAM and the driver paged mid-playback).
  void set_capacity(std::size_t n) noexcept { capacity_ = n; }
  void set_budget(std::uint64_t bytes) noexcept { budget_ = bytes; }
  /// A new frame is being drawn: textures it uses are never recycled before
  /// it is (a later conversion would overwrite one the frame still samples).
  void begin_frame() noexcept { ++frame_; }
  /// Converted footage held on the GPU (the LRU), bytes.
  [[nodiscard]] std::uint64_t held_bytes() const noexcept { return bytes_; }

  /// One presentation frame converted into a texture the CALLER owns (Pixel
  /// Motion reads its pixels back): the exact frame in exact mode, else the
  /// decoded one or the nearest (`exact` false). Give it back with recycle().
  bool convert_frame(SourceId source, std::int64_t frame, ConvertedFrame& out, bool& exact, std::string& error);
  void recycle(ConvertedFrame&& f) { converter_.recycle(std::move(f)); }

  /// Draws served from a nearest (not exact) frame / skipped, since the last call.
  struct Misses {
    std::uint64_t approximate = 0;
    std::uint64_t skipped = 0;
    /// The (source, frame)s drawn from a stand-in or skipped: what a paused
    /// viewport waits on. Allocates only on a miss (a decode not yet done).
    std::vector<std::pair<SourceId, std::int64_t>> wanted;
  };
  [[nodiscard]] Misses take_misses() noexcept;
  /// Whether every frame in `wanted` is decoded now (or never will be).
  [[nodiscard]] bool settled(const std::vector<std::pair<SourceId, std::int64_t>>& wanted);
  /// Blocks (exact lane) until every frame in `wanted` is decoded, `timeout` per
  /// frame: a still whose exact-mode wait timed out draws again instead of
  /// going out with the footage missing. False when one never arrived.
  bool await_wanted(const std::vector<std::pair<SourceId, std::int64_t>>& wanted, std::chrono::milliseconds timeout);
  [[nodiscard]] FrameConverter& converter() noexcept { return converter_; }

 private:
  struct Entry {
    std::string hash;
    ConvertedFrame tex;
    std::uint64_t id = 0;
    // The frame this texture holds (a nearest stand-in is re-converted once the exact frame arrives).
    std::int64_t heldFrame = -1;
    bool exact = false;
    std::uint64_t used = 0;   // frame_ when last drawn
    std::uint64_t bytes = 0;  // tex's size on the GPU
  };
  FramePtr frame_for(SourceId src, std::int64_t frame, bool& exact);
  bool convert_into(Entry& e, const DecodedFrame& f, SourceId src, std::string& error);
  void touch(std::list<Entry>::iterator it);
  void trim();

  MediaSystem& media_;
  FrameConverter converter_;
  Mode mode_;
  std::chrono::milliseconds timeout_{10'000};
  std::size_t capacity_ = 24;
  std::uint64_t budget_ = std::uint64_t{384} << 20U;
  std::uint64_t bytes_ = 0;
  std::uint64_t frame_ = 0;
  std::unordered_map<SourceId, AlphaMode> alpha_;
  std::list<Entry> lru_;
  std::unordered_map<std::string, std::list<Entry>::iterator, rg::KeyHash, std::equal_to<>> byHash_;
  std::uint64_t nextId_ = 1;
  Misses misses_;
};

}  // namespace premation::media
