// Edit handlers: Project settings, project import, jobs, plugin data — src/core/engine/handlers/misc.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::SetProjectSettings> handle(const api::SetProjectSettings& c, HCtx& x);
ResultOf<api::ImportProject> handle(const api::ImportProject& c, HCtx& x);
ResultOf<api::ApplyJobResult> handle(const api::ApplyJobResult& c, HCtx& x);
ResultOf<api::SetPluginData> handle(const api::SetPluginData& c, HCtx& x);

}  // namespace premation::doc
