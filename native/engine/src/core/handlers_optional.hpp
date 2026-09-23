// Edit handlers: optional properties (G1) — src/core/engine/handlers/optionalProps.ts.
//
// AE's Add ▸ Property on a text animator (the properties that exist only once
// added: Anchor Point, Skew Axis, Line Anchor, Character Value, Fill / Stroke
// Hue·Saturation·Brightness, Stroke Opacity, Fill Color, Stroke Color, Font
// Axis) and deleting them with their keyframes and expressions.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::AddProperties> handle(const api::AddProperties& c, HCtx& x);
ResultOf<api::RemoveProperties> handle(const api::RemoveProperties& c, HCtx& x);

}  // namespace premation::doc
