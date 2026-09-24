// A native plugin effect as a FrameScene chain entry (G1) — the tagged
// parameter bag (engine-api 96_render.eapi RenderEffect) the scene builder
// writes (scene_native_fx.cpp) and the render glue reads (render_glue.cpp):
//
//   type "native-plugin"
//   matchName, instance ("<layer>/<effect id>"), layerId      text
//   sequence                         text   the FLAT sequence data (base64, from the document)
//   compTime, layerTime, timeStep    number flicks
//   fps, layerW, layerH              number
//   draft                            flag
//   p.<key>                          one per document param, at the frame time:
//                                      number (slider / angle / point axis / popup)
//                                      flag (checkbox) · color [r,g,b,a] · text (layer id)
//                                      numbers (path: 6 per vertex) + p.<key>.closed flag
//   a.<key>                          text   an arbitrary-data param's bytes (base64)
//
// So a frame stays a pure function of the document: a plugin instance's state
// travels with the frame, never from a cache only this process has.
#pragma once

#include <string_view>

#include "engine_api.hpp"
#include "host.hpp"

namespace premation::plugins {

inline constexpr std::string_view kNativeFxType = "native-plugin";

/// Decode an entry for `spec` into `out` (values default to the declared ones).
void decode_native_fx(const api::RenderEffect& e, const EffectSpec& spec, RenderInputs& out);

/// The layer id of a checkout at `time` (flicks): `<layer>@<time>` — the hidden
/// renderable the scene hook adds for checkouts at times other than the frame's.
[[nodiscard]] std::string checkout_renderable_id(std::string_view layerId, std::int64_t time);

}  // namespace premation::plugins
