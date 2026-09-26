// Write-on's brush form (D2w effects): the dab history buildSnapshot samples at
// PAST times and hands to the kernel as resolved params — writeOnBrush.ts
// `resolveWriteOnTrail`, line for line.
//
// Dab times sit on a fixed grid of Brush Spacing multiples from the node's
// first keyframe (clamped to Stroke Length) up to the layer time, plus the
// playhead's own dab; past WRITE_ON_MAX_TRAIL grid points the samples spread
// evenly and `filled` asks the kernel to fill between them. An unanimated brush
// position is one dab at the layer time.
//
// Pure: the caller supplies the animation sampler (the walk's `anim_sample_of`,
// which drops Essential-Properties-overridden tracks), `isAnimated` and the
// node's first key time. Pinned by tests/data/write_on_trail_parity.json.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"

namespace premation::scene {

using doc::Json;

/// WRITE_ON_MAX_TRAIL.
inline constexpr int kWriteOnMaxTrail = 2048;

struct WriteOnTrail {
  std::vector<double> xy;    ///< dab positions, layer-centred px, flat x, y
  std::vector<double> size;  ///< dab diameters, px
  std::vector<double> attr;  ///< per dab: hardness %, opacity %, r, g, b (0..255)
  bool filled = false;       ///< thinned: the kernel fills between samples
};

using TrailSample = std::function<std::optional<double>(std::string_view prop, double t)>;
using TrailIsAnimated = std::function<bool(std::string_view prop)>;

/// `writeOnUsesBrush(params)`: Mode ▸ Brush Position (0).
[[nodiscard]] bool write_on_uses_brush(const Json& params);

/// `resolveWriteOnTrail(effectId, params, layerTimeSec, sample, isAnimated, earliestSec)`.
[[nodiscard]] WriteOnTrail resolve_write_on_trail(const std::string& effectId, const Json& params, double layerTimeSec,
                                                  const TrailSample& sample, const TrailIsAnimated& isAnimated,
                                                  std::optional<double> earliestSec);

}  // namespace premation::scene
