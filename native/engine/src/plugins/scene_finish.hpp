// G1: the plugin host's frame hook — run once per built frame, after
// build_native_frame, by every engine path that renders the document (the
// engine's frame builder, export, the tools):
//
//   · completes each native-plugin chain entry with what lives in the document
//     beside the effect (the instance's flat sequence data, arbitrary-data
//     params) and the frame's times;
//   · asks each effect's SMART_PRE_RENDER which layers it checks out at OTHER
//     times, builds those layers at those times and adds them to the frame as
//     hidden renderables (`<layer>@<flicks>`, matte sources: never drawn), so
//     the render glue can check them out — the frame stays self-contained;
//   · reports every disabled plugin instance on the frame's layer errors.
#pragma once

#include <string_view>

#include "native_scene.hpp"

namespace premation::plugins {

class PluginHost;

/// `host` nullptr = no plugin host (entries are completed, nothing is checked out).
void finish_native_frame(const scene::BuildContext& c, std::string_view comp, double t, const scene::ViewSpec& view,
                         bool motionBlur, scene::NativeFrame& frame, PluginHost* host);

}  // namespace premation::plugins
