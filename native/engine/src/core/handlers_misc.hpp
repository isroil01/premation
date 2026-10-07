// Edit handlers: Guides / swatches / materials, motion blur, colour management, project settings, project import, jobs, plugin data, content-aware fill — src/core/engine/handlers/misc.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include <optional>
#include <string_view>

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::RestoreDocument> handle(const api::RestoreDocument& c, HCtx& x);
ResultOf<api::SetGuides> handle(const api::SetGuides& c, HCtx& x);
ResultOf<api::SetSwatches> handle(const api::SetSwatches& c, HCtx& x);
ResultOf<api::SetMaterials> handle(const api::SetMaterials& c, HCtx& x);
ResultOf<api::SetProjectSettings> handle(const api::SetProjectSettings& c, HCtx& x);
ResultOf<api::SetMotionBlur> handle(const api::SetMotionBlur& c, HCtx& x);
ResultOf<api::SetColorManagement> handle(const api::SetColorManagement& c, HCtx& x);
ResultOf<api::ImportProject> handle(const api::ImportProject& c, HCtx& x);
ResultOf<api::ApplyJobResult> handle(const api::ApplyJobResult& c, HCtx& x);
ResultOf<api::SetPluginData> handle(const api::SetPluginData& c, HCtx& x);
ResultOf<api::SetEssentialProp> handle(const api::SetEssentialProp& c, HCtx& x);
ResultOf<api::SetContentAwareFill> handle(const api::SetContentAwareFill& c, HCtx& x);
ResultOf<api::SetCaptions> handle(const api::SetCaptions& c, HCtx& x);
ResultOf<api::SetLayerTrackers> handle(const api::SetLayerTrackers& c, HCtx& x);
ResultOf<api::SetCameraSolve> handle(const api::SetCameraSolve& c, HCtx& x);
ResultOf<api::SetLayerMatte> handle(const api::SetLayerMatte& c, HCtx& x);

/// The layer's stored camera solve (`fx.cameraSolve`, AE parity 3.5), frame times in composition time.
[[nodiscard]] std::optional<api::CameraSolveData> camera_solve_of(const Document& d, const EditorView& view, std::string_view layer);

/// The layer's saved trackers (`fx.trackers`), sample times mapped to composition time.
[[nodiscard]] api::LayerTrackers layer_trackers(const Document& d, const EditorView& view, std::string_view layer);

}  // namespace premation::doc
