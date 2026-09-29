// Edit handlers: dynamics — 3D IK pose / bake (B4 round 8) — src/core/engine/handlers/dynamics.ts.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::PoseIk3D> handle(const api::PoseIk3D& c, HCtx& x);
ResultOf<api::BakeIk3D> handle(const api::BakeIk3D& c, HCtx& x);

}  // namespace premation::doc
