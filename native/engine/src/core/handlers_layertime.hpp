// Edit handlers: Layer timing — src/core/engine/handlers/layerTime.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
//
// Also the layer-time and retime edits those handlers are built from:
// layerTime.ts `updateNodeLayerTime`, retime.ts (the speed integral) and
// retimeCommands.ts `setRetimeMode`.
#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <vector>

#include "handlers_common.hpp"

namespace premation::doc {

/// layerTime.ts `updateNodeLayerTime(node, patch)`: patch the node's time
/// config (normalized; cleared back to undefined when identity).
void update_node_layer_time(Document& d, std::string_view node, const std::function<void(LayerTime&)>& patch);

/// retimeCommands.ts `setRetimeMode(ids, mode)` — converts what each layer had.
void set_retime_mode(HCtx& x, const std::vector<std::string>& ids, api::RetimeMode mode);

ResultOf<api::SetLayerTiming> handle(const api::SetLayerTiming& c, HCtx& x);
ResultOf<api::MoveLayersInTime> handle(const api::MoveLayersInTime& c, HCtx& x);
ResultOf<api::TrimLayers> handle(const api::TrimLayers& c, HCtx& x);
ResultOf<api::SlipLayers> handle(const api::SlipLayers& c, HCtx& x);
ResultOf<api::SlideLayer> handle(const api::SlideLayer& c, HCtx& x);
ResultOf<api::RollEdit> handle(const api::RollEdit& c, HCtx& x);
ResultOf<api::SplitLayers> handle(const api::SplitLayers& c, HCtx& x);
ResultOf<api::RippleDeleteLayers> handle(const api::RippleDeleteLayers& c, HCtx& x);
ResultOf<api::EditWorkArea> handle(const api::EditWorkArea& c, HCtx& x);
ResultOf<api::InsertGap> handle(const api::InsertGap& c, HCtx& x);
ResultOf<api::TimeReverseLayers> handle(const api::TimeReverseLayers& c, HCtx& x);
ResultOf<api::SetTimeRemap> handle(const api::SetTimeRemap& c, HCtx& x);
ResultOf<api::FreezeFrame> handle(const api::FreezeFrame& c, HCtx& x);
ResultOf<api::SetRetime> handle(const api::SetRetime& c, HCtx& x);
ResultOf<api::SequenceLayers> handle(const api::SequenceLayers& c, HCtx& x);
ResultOf<api::UnfreezeLayers> handle(const api::UnfreezeLayers& c, HCtx& x);
ResultOf<api::TimeStretchLayers> handle(const api::TimeStretchLayers& c, HCtx& x);
ResultOf<api::RippleDeleteRange> handle(const api::RippleDeleteRange& c, HCtx& x);
ResultOf<api::ShiftLayerKeyframes> handle(const api::ShiftLayerKeyframes& c, HCtx& x);
ResultOf<api::AddTransition> handle(const api::AddTransition& c, HCtx& x);
ResultOf<api::SetTransition> handle(const api::SetTransition& c, HCtx& x);
ResultOf<api::RemoveTransitions> handle(const api::RemoveTransitions& c, HCtx& x);

}  // namespace premation::doc
