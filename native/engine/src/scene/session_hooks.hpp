// What the document core (Session, engine_core) asks of the engine's scene and
// audio systems — header-only interfaces, so engine_core keeps no link
// dependency on the render graph, the rasters, the media or the audio code
// (the sanitizer and fuzz builds compile the core without them). The
// implementations live in engine_scene (engine_frames.cpp) and are injected by
// the process (engine_process.cpp); a Session without them behaves as before
// (C2's quad compositor, the wall clock).
#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/frame_scene.hpp"
#include "engine_api.hpp"

namespace premation {

namespace doc {
class Document;
struct EditorView;
class ExprEnv;
class ExprCache;
struct Node;
}  // namespace doc

/// One frame the scene builder produced (scene/built_frame.hpp) — opaque to the core.
struct BuiltFrame;

class MediaClock;

/// readGeometry's measured box of a text layer (B4 round 2, getLayerBounds):
/// its size and the box centre's vertical offset from the layer origin, local
/// px before the layer's own scale.
struct TextGeometry {
  double width = 0;
  double height = 0;
  double dy = 0;
};

/// What the document core asks of the text port for the B4 round-2 queries
/// (ENGINE_API.md §15.12) — measurement needs fonts, which engine_core does not
/// link. Implemented over the scene port's TextMeasurer (scene/text_query.cpp,
/// on the frame builder's fonts); a Session without it answers `unsupported`
/// (the headless engine).
class TextQueries {
 public:
  TextQueries() = default;
  virtual ~TextQueries() = default;
  TextQueries(const TextQueries&) = delete;
  TextQueries& operator=(const TextQueries&) = delete;
  TextQueries(TextQueries&&) = delete;
  TextQueries& operator=(TextQueries&&) = delete;

  /// `getTextLayout` for the text node `n` (the stored style, `overrides`
  /// winning). Throws EngineFail: `invalidArgument` (no content), `unsupported`
  /// (a style outside the text port — vertical type, line runs,
  /// variable axes, Capitalize case — the message names it).
  [[nodiscard]] virtual api::TextLayout text_layout(const doc::Node& n, const api::TextLayoutOverrides* overrides) = 0;
  /// readGeometry's text box for `n` with the evaluated `overrides` (x, fontSize,
  /// boxWidth, …): the fixed paragraph box, else the font-metric selection box
  /// (an anchored auto-height box offset by its line block); nullopt when the
  /// style is outside the port.
  [[nodiscard]] virtual std::optional<TextGeometry> text_geometry(
      const doc::Node& n, const std::vector<std::pair<std::string, double>>& overrides) = 0;
};

/// The composition at a time → the frame the render thread draws (D2w).
class FrameBuilder {
 public:
  FrameBuilder() = default;
  virtual ~FrameBuilder() = default;
  FrameBuilder(const FrameBuilder&) = delete;
  FrameBuilder& operator=(const FrameBuilder&) = delete;
  FrameBuilder(FrameBuilder&&) = delete;
  FrameBuilder& operator=(FrameBuilder&&) = delete;

  /// Build on the core thread (the document is read here, never on the render
  /// thread). `errors` receives the frame's per-layer errors — build failures
  /// and features outside the port — as `layerErrors` event records.
  // shared_ptr: the frame changes hands once, core thread → render thread, and
  // the RenderJob that carries it is destroyed in translation units that only
  // see the forward declaration (shared_ptr type-erases the deleter).
  [[nodiscard]] virtual std::shared_ptr<BuiltFrame> build(const doc::Document& d, const doc::EditorView& view,
                                                          const doc::ExprEnv& expr, doc::ExprCache& cache,
                                                          std::string_view comp, api::Time time,
                                                          const ViewportConfig& viewport, bool playing,
                                                          std::vector<api::LayerError>& errors) = 0;
  virtual void bind_audio(MediaClock* /*clock*/) {}
  /// The text measurer's queries on this builder's fonts (B4 round 2); null = none.
  [[nodiscard]] virtual TextQueries* text_queries() noexcept { return nullptr; }

  /// The folder relative media paths resolve against — the project's (its
  /// bundle, or the folder of its file); '' = none. Set before every build.
  virtual void set_media_base(std::string_view /*dir*/) {}

  /// getThumbnail: a still of `comp` at `time`, contain-fitted into a
  /// width × height surface over a transparent void, for FrameSink::render_still.
  /// `isolateLayer` non-empty = only that layer (and what it holds) draws.
  /// Null = this builder cannot build one.
  [[nodiscard]] virtual std::shared_ptr<BuiltFrame> build_still(const doc::Document& /*d*/, const doc::EditorView& /*view*/,
                                                                const doc::ExprEnv& /*expr*/, doc::ExprCache& /*cache*/,
                                                                std::string_view /*comp*/, api::Time /*time*/,
                                                                std::uint32_t /*width*/, std::uint32_t /*height*/,
                                                                std::string_view /*isolateLayer*/) {
    return nullptr;
  }
  /// getThumbnail of a footage item: `src` (a still, or a video's frame at
  /// `sourceSec`), sourceWidth × sourceHeight, contain-fitted into width × height.
  [[nodiscard]] virtual std::shared_ptr<BuiltFrame> build_footage_still(const doc::Document& /*d*/, std::string_view /*src*/,
                                                                        bool /*video*/, double /*sourceSec*/,
                                                                        double /*sourceWidth*/, double /*sourceHeight*/,
                                                                        std::uint32_t /*width*/, std::uint32_t /*height*/) {
    return nullptr;
  }

  /// hitTest: the ids of what the frame of `comp` at `time` draws under
  /// `point` (comp pixels), topmost first — renderable ids as the builder names
  /// them: a layer's id, `id::…` for a layer's extra draws, and the inner
  /// comp's layer ids for a collapsed precomp's children (frame_hit.hpp).
  /// False = this builder has no frame geometry to answer from.
  virtual bool hit_test(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                        doc::ExprCache& /*cache*/, std::string_view /*comp*/, api::Time /*time*/, api::Vec2 /*point*/,
                        std::vector<std::string>& /*topmostFirst*/) {
    return false;
  }
};

/// The transport's master clock and the document's sound — the seam of
/// audio/transport_clock.hpp as the core sees it (implemented over
/// AudioTransportClock + AudioSystem).
class MediaClock {
 public:
  MediaClock() = default;
  virtual ~MediaClock() = default;
  MediaClock(const MediaClock&) = delete;
  MediaClock& operator=(const MediaClock&) = delete;
  MediaClock(MediaClock&&) = delete;
  MediaClock& operator=(MediaClock&&) = delete;

  enum class Loop : std::uint8_t { once, loop, pingPong };
  virtual void play(double fromSec, double rate, Loop loop, double rangeStartSec, double rangeEndSec) = 0;
  virtual void pause() = 0;
  virtual void seek(double sec, bool scrub) = 0;
  /// Media seconds since play began (× rate, across loop wraps); nullopt =
  /// the wall clock paces (no device, not locked yet, not playing).
  [[nodiscard]] virtual std::optional<double> media_elapsed(std::chrono::steady_clock::time_point now) const = 0;
  /// Rebuild the audio program from the document's audio / footage layers of `comp`.
  virtual void set_document(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                            doc::ExprCache& cache, std::string_view comp) = 0;
  /// The layer's decoded mono envelope (1024 buckets). False until conform finishes.
  /// True with empty `peaks` means the source is silent or could not be opened.
  virtual bool waveform(std::string_view /*layerId*/, std::vector<float>& /*peaks*/, double& /*duration*/) {
    return false;
  }
  /// getWaveform: min/max per bucket per channel (+ RMS of channel 0) of a
  /// media source (a footage / audio asset's `src`) over [fromSec, fromSec +
  /// durationSec) of SOURCE time, clamped to the source (durationSec ≤ 0 = to
  /// its end). `pending` while the source is still decoding; a source with no
  /// sound (or that cannot be opened) is `ready` with channels = 0.
  virtual HookAnswer peaks(std::string_view /*src*/, double /*fromSec*/, double /*durationSec*/,
                           std::uint32_t /*buckets*/, api::WaveformPeaks& /*out*/) {
    return HookAnswer::unsupported;
  }
};

}  // namespace premation
