// The composition at a time → the FrameScene the C2 compositor draws (filled,
// transformed quads). The full frame description for the render graph is D2's
// (render_graph/**); this keeps the C2 viewport path alive over the D1b
// document: solids and rectangle shapes, evaluated transforms and opacity.
#pragma once

#include <string_view>

#include "frame_scene.hpp"
#include "props.hpp"

namespace premation::doc {

/// Build `out` for composition `comp` at comp time `t` (flicks).
void build_frame_scene(const PCtx& c, std::string_view comp, api::Time t, FrameScene& out);

}  // namespace premation::doc
