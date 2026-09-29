// B4 round 5 (ENGINE_API.md §15.14) — the item / layer facts the UI read
// around the API: the document's paint colours, a composition's caption cues,
// a time through a layer's own time, the intrinsic size Fit uses. The
// TypeScript twins are src/core/engine/itemFactsQueries.ts (and
// src/core/paint/documentColors.ts); the precompose dry run is
// handlers_precompose.cpp `precompose_leave_reason`.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "props.hpp"

namespace premation::doc {

/// `getDocumentColors`: every distinct paint colour of every layer of every composition (findLayers order),
/// first-seen, at most `limit` (0 = no limit).
[[nodiscard]] std::vector<std::string> document_colors(const Document& d, std::uint32_t limit);

/// `getCaptionCues`: the composition's top-level caption layers as cues (first bar, trimmed text), by start.
/// Throws `notFound` for no such composition.
[[nodiscard]] std::vector<api::CaptionCue> caption_cues(const Document& d, const std::string& comp);

/// `mapLayerTime`: composition time → the time inside what the layer shows (outward = back); nullopt when the
/// outward map has no single answer. Throws `notFound` for no such layer.
[[nodiscard]] std::optional<api::Time> map_layer_time(const PCtx& pc, const std::string& layer, api::Time time, bool outward);

/// `getSourceSize`: fitCommands.ts `intrinsicSizeOf` per layer; layers with none (and unknown ids) left out.
[[nodiscard]] std::vector<api::LayerSourceSize> source_sizes(const Document& d, const std::vector<std::string>& layers);

/// B4 round 8 — getTimelineRows: each layer's timeline row projection (build_static_property_tree); unknown ids skipped.
[[nodiscard]] std::vector<api::TimelineRowSet> timeline_rows(const Document& d, const std::vector<std::string>& layers);

}  // namespace premation::doc
