// Edit handlers: Project items (footage, folders) and the render queue — src/core/engine/handlers/items.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::ImportFiles> handle(const api::ImportFiles& c, HCtx& x);
ResultOf<api::RelinkItem> handle(const api::RelinkItem& c, HCtx& x);
ResultOf<api::RemoveItems> handle(const api::RemoveItems& c, HCtx& x);
ResultOf<api::RenameItem> handle(const api::RenameItem& c, HCtx& x);
ResultOf<api::CreateFolder> handle(const api::CreateFolder& c, HCtx& x);
ResultOf<api::MoveItems> handle(const api::MoveItems& c, HCtx& x);
ResultOf<api::SetInterpretation> handle(const api::SetInterpretation& c, HCtx& x);
ResultOf<api::SetItemLabel> handle(const api::SetItemLabel& c, HCtx& x);
ResultOf<api::RemoveUnusedItems> handle(const api::RemoveUnusedItems& c, HCtx& x);
ResultOf<api::SetProxy> handle(const api::SetProxy& c, HCtx& x);
ResultOf<api::SetItemComment> handle(const api::SetItemComment& c, HCtx& x);
ResultOf<api::SetItemTags> handle(const api::SetItemTags& c, HCtx& x);
ResultOf<api::AddRenderItems> handle(const api::AddRenderItems& c, HCtx& x);
ResultOf<api::SetRenderItem> handle(const api::SetRenderItem& c, HCtx& x);
ResultOf<api::RemoveRenderItems> handle(const api::RemoveRenderItems& c, HCtx& x);
ResultOf<api::ReorderRenderItems> handle(const api::ReorderRenderItems& c, HCtx& x);

/// JavaScript `String.prototype.trim()` (ASCII and the common Unicode spaces).
[[nodiscard]] std::string js_trim(std::string_view s);

}  // namespace premation::doc
