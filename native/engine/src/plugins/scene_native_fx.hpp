// G1: the scene builder's half of native plugin effects — a document effect of
// a native type → its FrameScene chain entry (fx_wire.hpp). Compiled into
// engine_scene (the only hook in its effect port calls these); GPU-free and
// host-free: it reads the document's registry (native_effects.hpp) only.
#pragma once

#include <optional>
#include <string_view>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// A native SDK plugin effect type (registered by the plugin host).
[[nodiscard]] bool is_native_effect(std::string_view type) noexcept;

/// The chain entry for a native effect `e` (params already resolved at the
/// frame's time, `params` = paramsOf(e)) on layer `l`; nullopt when `e` is not
/// a native effect. Times and the document-held data (sequence, arbitrary
/// data) are completed by the plugin host's frame hook (scene_finish.cpp).
[[nodiscard]] std::optional<api::RenderEffect> native_effect_entry(const Json& e, const Json& params, const RLayer& l);

}  // namespace premation::scene
