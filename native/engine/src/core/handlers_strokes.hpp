// Edit handler: the shape stroke stack (B3z) — src/core/engine/handlers/strokes.ts.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::RemoveStroke> handle(const api::RemoveStroke& c, HCtx& x);

}  // namespace premation::doc
