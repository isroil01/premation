// Edit handlers: Compositions — src/core/engine/handlers/comps.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

/// comps.ts `createCompRecord(id, fields)`: the record, its root node, its timeline.
void create_comp_record(Document& d, const std::string& id, const Json& fields);
/// comps.ts `applyCompFields(comp, fields, startTimecode?)`.
void apply_comp_fields(Document& d, const std::string& comp, const Json& fields, std::optional<api::Time> startTimecode = std::nullopt);
/// comps.ts `setWorkArea(comp, start, duration)` (flicks).
void set_work_area(Document& d, const std::string& comp, api::Time start, api::Time duration);

ResultOf<api::CreateComposition> handle(const api::CreateComposition& c, HCtx& x);
ResultOf<api::DuplicateComposition> handle(const api::DuplicateComposition& c, HCtx& x);
ResultOf<api::SetCompositionSettings> handle(const api::SetCompositionSettings& c, HCtx& x);
ResultOf<api::SetWorkArea> handle(const api::SetWorkArea& c, HCtx& x);
ResultOf<api::ClearWorkArea> handle(const api::ClearWorkArea& c, HCtx& x);
ResultOf<api::TrimCompToWorkArea> handle(const api::TrimCompToWorkArea& c, HCtx& x);
ResultOf<api::CropComposition> handle(const api::CropComposition& c, HCtx& x);
ResultOf<api::Precompose> handle(const api::Precompose& c, HCtx& x);
ResultOf<api::AssembleComposition> handle(const api::AssembleComposition& c, HCtx& x);

}  // namespace premation::doc
