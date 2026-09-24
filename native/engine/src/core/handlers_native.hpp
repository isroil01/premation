// The edit-command halves of native SDK plugin effects (G1, native_effects.hpp):
// what addEffect and invokeEffectAction do when the effect is a plugin's.
#pragma once

#include <string>
#include <string_view>

#include "engine_ctx.hpp"

namespace premation::doc {

/// addEffect validation: a native type whose plugin is disabled / failed cannot be added (notFound).
void native_check_addable(std::string_view type);

/// addEffect of a native type: store the instance's initial flat sequence data
/// (SEQUENCE_SETUP → FLATTEN, through the host) in the layer's fx.pluginData,
/// inside the same history entry.
void native_effect_added(Document& d, std::string_view layer, std::string_view effectId, std::string_view type);

/// invokeEffectAction on a native effect: USER_CHANGED_PARAM through the host;
/// the plugin's param writes, sequence data and arbitrary data become ONE
/// history entry. Fails (EngineFail) when `group` is not a native effect.
void native_invoke_action(HCtx& x, const api::PropRef& group, const std::string& action);

/// Write one entry of fx.pluginData (setPluginData's storage; empty bytes = delete).
void native_write_plugin_data(Document& d, std::string_view layer, std::string_view group, std::string_view key,
                              const std::vector<std::uint8_t>& bytes);
/// Read one entry (nullopt = absent / not base64).
[[nodiscard]] std::optional<std::vector<std::uint8_t>> native_read_plugin_data(const Node& n, std::string_view group,
                                                                              std::string_view key);

}  // namespace premation::doc
