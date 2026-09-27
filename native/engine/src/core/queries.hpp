// Queries (ENGINE_API.md §7) — src/core/engine/queries.ts: read without
// changing anything, at the revision in the response. What the document core
// cannot answer from document data — waveforms, thumbnails, hit tests, pixels —
// it asks the engine's audio and render systems through the QCtx hooks below
// (the Session wires them to session_hooks.hpp / FrameSink); a build without
// them answers `unsupported`, as the TypeScript engine does.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "catalog_data.hpp"
#include "engine_api.hpp"
#include "engine_ctx.hpp"
#include "frame_scene.hpp"
#include "props.hpp"

namespace premation {
class TextQueries;  // scene/session_hooks.hpp
}

namespace premation::doc {

/// getThumbnail, resolved (queries.cpp): what to draw and at what size. The
/// Session has the frame builder build it and the render thread draw it.
struct StillRequest {
  /// A composition's frame at `time` (comp time) …
  std::string comp;
  /// … with only this layer drawing ('' = the whole comp).
  std::string isolateLayer;
  api::Time time = 0;
  /// Or a footage item: its media (a still, or a video's frame at sourceSec).
  std::string footageSrc;
  bool video = false;
  double sourceSec = 0;
  double sourceWidth = 0;
  double sourceHeight = 0;
  /// The still's pixels (the source's aspect, the long side ≤ maxSize).
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

struct QCtx {
  PCtx pc;
  KeyIndex& keys;
  api::Revision revision = 0;
  std::string projectPath;
  bool dirty = false;
  std::function<api::HistoryState()> history;
  std::function<std::vector<api::LogRecord>(api::Revision)> log;
  std::function<api::Capabilities()> capabilities;
  std::function<api::RenderStats()> renderStats;
  /// Property catalogs by layer, valid until the next command (the session
  /// clears it before any command runs): repeated queries at one revision —
  /// a scrub, a panel re-reading its rows — build each layer's catalog once.
  std::unordered_map<std::string, Catalog>* catalogs = nullptr;
  /// D5: the per-layer errors the frame builder last reported for a comp ('' =
  /// the comp it last built) — what `layerErrors` announced. Unset = none.
  std::function<std::vector<api::LayerError>(const std::string&)> layerErrors;
  /// The installed fonts matching a `listFonts` query (SessionOptions::systemFonts).
  /// Unset = none (the test ports, and hosts without a font catalogue).
  std::function<api::FontList(const std::string&)> fonts;
  /// E2: a media source's peaks (session_hooks.hpp MediaClock::peaks). Unset =
  /// no audio engine: getWaveform answers `unsupported`.
  std::function<HookAnswer(std::string_view src, double fromSec, double durationSec, std::uint32_t buckets,
                           api::WaveformPeaks& out)>
      waveform{};  // default initialisers: the Session's positional QCtx{…} may stop before these
  /// D2w: what the built frame draws under a comp point, topmost first
  /// (session_hooks.hpp FrameBuilder::hit_test). Unset, or false = no frame
  /// geometry: hitTest answers `unsupported`.
  std::function<bool(const std::string& comp, api::Time time, api::Vec2 point, std::vector<std::string>& topmostFirst)>
      hitTest{};
  /// D2w: draw a still (getThumbnail). Unset = no renderer: `unsupported`.
  std::function<StillImage(const StillRequest& request)> still{};
  /// D2w: a viewport's slot size in physical pixels; nullopt = no such viewport open.
  std::function<std::optional<std::pair<std::uint32_t, std::uint32_t>>(std::uint32_t viewport)> viewportSlot{};
  /// D2w: a region of the frame the viewport shows, in working space
  /// (readPixels; the region is inside the slot). Unset = `unsupported`.
  std::function<WorkingPixels(std::uint32_t viewport, PixelRegion region)> readPixels{};
  /// B4 round 2: text measurement on the frame builder's fonts (getTextLayout,
  /// getLayerBounds' text boxes). Null = no fonts in this engine: `unsupported`.
  TextQueries* text = nullptr;  // after the positional members (Session builds QCtx{…} positionally)
};

/// `catalogFor(layer)` through the query's cache (require_layer first).
[[nodiscard]] const Catalog& query_catalog(QCtx& c, const std::string& layer);

/// Answer one query; throws EngineFail.
[[nodiscard]] api::QueryResult run_query(const api::Query& q, QCtx& c);

/// The query results the handlers also need.
[[nodiscard]] api::EffectInfo effect_info(const EffectDef& def);

}  // namespace premation::doc
