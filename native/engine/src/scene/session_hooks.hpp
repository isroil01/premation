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
#include <vector>

#include "core/frame_scene.hpp"
#include "engine_api.hpp"

namespace premation {

namespace doc {
class Document;
struct EditorView;
class ExprEnv;
class ExprCache;
}  // namespace doc

/// One frame the scene builder produced (scene/built_frame.hpp) — opaque to the core.
struct BuiltFrame;

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
};

}  // namespace premation
