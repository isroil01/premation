// Edit handlers: structural outline edits (B3) — src/core/engine/handlers/paths.ts.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::EditPathTopology> handle(const api::EditPathTopology& c, HCtx& x);
ResultOf<api::SetShapeOutline> handle(const api::SetShapeOutline& c, HCtx& x);

}  // namespace premation::doc
