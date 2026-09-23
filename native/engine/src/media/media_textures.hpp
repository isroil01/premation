// The media system as a render-graph texture source (rg::ExternalTextureSource).
//
// A footage layer's RenderTextureRef carries a hash with no blob:
//
//     media:<source>:<frame>            one presentation frame
//     media:<source>:<top>~<bottom>     a pulldown weave (even rows top, odd rows bottom)
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
// Converted textures are kept per hash for a few frames (a paused viewport
// re-renders without re-converting) and recycled by size.
#pragma once

#include <chrono>
#include <cstdint>
#include <list>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

#include "frame_convert.hpp"
#include "media_system.hpp"
#include "render_context.hpp"

namespace premation::media {

[[nodiscard]] std::string media_hash(SourceId source, std::int64_t frame);
[[nodiscard]] std::string media_hash(SourceId source, std::int64_t top, std::int64_t bottom);

/// Parsed form of a media hash (nullopt when `hash` is not one).
struct MediaKey {
  SourceId source = 0;
  std::int64_t frame = 0;
  std::int64_t bottom = -1;  // ≥ 0: a weave
};
[[nodiscard]] std::optional<MediaKey> parse_media_hash(std::string_view hash) noexcept;

class MediaTextures final : public rg::ExternalTextureSource {
 public:
  enum class Mode : std::uint8_t { preview, exact };

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
  /// Converted textures kept (by hash) before recycling.
  void set_capacity(std::size_t n) noexcept { capacity_ = n; }

  /// Draws served from a nearest (not exact) frame / skipped, since the last call.
  struct Misses {
    std::uint64_t approximate = 0;
    std::uint64_t skipped = 0;
  };
  [[nodiscard]] Misses take_misses() noexcept;
  [[nodiscard]] FrameConverter& converter() noexcept { return converter_; }

 private:
  struct Entry {
    std::string hash;
    ConvertedFrame tex;
    std::uint64_t id = 0;
    // The frame this texture holds (a nearest stand-in is re-converted once the exact frame arrives).
    std::int64_t heldFrame = -1;
    bool exact = false;
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
  std::unordered_map<SourceId, AlphaMode> alpha_;
  std::list<Entry> lru_;
  std::unordered_map<std::string, std::list<Entry>::iterator, rg::KeyHash, std::equal_to<>> byHash_;
  std::uint64_t nextId_ = 1;
  Misses misses_;
};

}  // namespace premation::media
