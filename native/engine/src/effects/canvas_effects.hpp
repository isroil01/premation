// E4 × E3: the CANVAS-DRAWN effects of the bake chain (applyCanvas2dEffect,
// src/core/effects/canvas2dEffects.ts) — the ones that paint with gradients,
// arcs, composites and shadows instead of transforming an RGBA buffer — ported
// call for call onto the raster module's Canvas2D, so they run wherever that
// runs (Skia's CPU raster in the engine, a recording canvas in the tests).
//
// Conventions shared with the pixel kernels (kernel_dispatch.hpp): one entry
// point by effect type, a canvas `w` × `h` device px at identity (the chain
// runs after the layer content, at identity, on the raster canvas), and the
// effect's parameters already RESOLVED — `paramsOf(effect)` (registry defaults
// merged under the stored params) as a JSON object, which is what a raster
// spec's `effects[i].params` carries once the chain is wired (E4 open work).
// The pixel kernels reach this canvas through Canvas2D::getImageData /
// putImageData (straight RGBA, like the TS's ImageData).
#pragma once

#include <span>
#include <string_view>

#include "raster/canvas.hpp"
#include "raster/json.hpp"

namespace premation::effects {

/// Draw canvas effect `type` onto `oc`. False when `type` is not ported here.
bool run_canvas_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w, double h);

/// Every effect type `run_canvas_effect` accepts.
[[nodiscard]] std::span<const std::string_view> ported_canvas_effects() noexcept;

}  // namespace premation::effects
