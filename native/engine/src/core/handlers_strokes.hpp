// Edit handlers: the shape stroke stack (B3z) and paint strokes (B3) — src/core/engine/handlers/strokes.ts
// and src/core/engine/paintStrokes.ts.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::RemoveStroke> handle(const api::RemoveStroke& c, HCtx& x);
ResultOf<api::AddPaintStroke> handle(const api::AddPaintStroke& c, HCtx& x);
ResultOf<api::UpdatePaintStroke> handle(const api::UpdatePaintStroke& c, HCtx& x);
ResultOf<api::RemovePaintStrokes> handle(const api::RemovePaintStrokes& c, HCtx& x);
ResultOf<api::SetPaintOnTransparent> handle(const api::SetPaintOnTransparent& c, HCtx& x);
ResultOf<api::SetPaintStrokePath> handle(const api::SetPaintStrokePath& c, HCtx& x);
ResultOf<api::SetPaintPathAnimated> handle(const api::SetPaintPathAnimated& c, HCtx& x);

}  // namespace premation::doc
