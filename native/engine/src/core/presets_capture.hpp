// Save as Preset (B4 `capturePreset`, ENGINE_API.md §15.12) — the capture half
// of src/core/animation/animationPresets.ts: `capturePresetBody` (captureAnimation
// + readAnimatorData + captureEffects + captureExpressions) resolved against the
// layer's OWN composition (presetContext.ts `presetContextFor(layer, comp)`).
// The apply half is handlers_groups.cpp `apply_preset`.
#pragma once

#include <optional>
#include <string_view>

#include "model.hpp"

namespace premation::doc {

/// The preset body — `{tracks, animators?, requires?, effects?, expressions?}`,
/// in the TypeScript's key order — or nullopt when the layer has nothing to
/// save (no keyframes, animators, effects or enabled expressions). The layer
/// must exist (require_layer first).
[[nodiscard]] std::optional<Json> capture_preset_body(const Document& d, std::string_view layer);

}  // namespace premation::doc
