// B4 round 5: packing the overlay push's `rig` record under the frame
// channel's payload cap (overlay_geometry.cpp pack_frame_geometry). A rig —
// its pins, bones, IK goals and a whole deformed mesh — outgrows one 4 KiB
// message on any real layer, so it travels as rig-only records, each array
// cut in whole groups (a vertex's x, y; a triangle's three indices); the host
// concatenates a layer's `rig` arrays in arrival order (src/stores/overlayGeometry.ts).
#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "engine_api.hpp"

namespace premation::doc {

/// A conservative encoded size of `r` (tags, lengths, ids, 8 bytes per f64, 5 per u32).
[[nodiscard]] std::size_t estimate_overlay_rig(const api::OverlayRig& r);

/// Append `r` to `out` as records of `layer` carrying only a `rig`, each estimated under `budget` bytes.
void split_overlay_rig(const std::string& layer, api::OverlayRig r, std::size_t budget,
                       std::vector<api::OverlayLayerGeometry>& out);

}  // namespace premation::doc
