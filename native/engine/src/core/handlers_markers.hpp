// Edit handlers: Markers — src/core/engine/handlers/markers.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::AddMarkers> handle(const api::AddMarkers& c, HCtx& x);
ResultOf<api::UpdateMarkers> handle(const api::UpdateMarkers& c, HCtx& x);
ResultOf<api::DeleteMarkers> handle(const api::DeleteMarkers& c, HCtx& x);
ResultOf<api::MoveMarkers> handle(const api::MoveMarkers& c, HCtx& x);

}  // namespace premation::doc
