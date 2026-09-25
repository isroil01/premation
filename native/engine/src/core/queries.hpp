// Queries (ENGINE_API.md §7) — src/core/engine/queries.ts: read without
// changing anything, at the revision in the response. What the document core
// cannot answer from document data (rendered pixels, waveforms, thumbnails,
// text layout) says so with `unsupported`, exactly as the TypeScript engine
// does; those arrive with the renderer (D2) and media (E).
#pragma once

#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

#include "catalog_data.hpp"
#include "engine_api.hpp"
#include "engine_ctx.hpp"
#include "props.hpp"

namespace premation::doc {

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
};

/// `catalogFor(layer)` through the query's cache (require_layer first).
[[nodiscard]] const Catalog& query_catalog(QCtx& c, const std::string& layer);

/// Answer one query; throws EngineFail.
[[nodiscard]] api::QueryResult run_query(const api::Query& q, QCtx& c);

/// The query results the handlers also need.
[[nodiscard]] api::EffectInfo effect_info(const EffectDef& def);

}  // namespace premation::doc
