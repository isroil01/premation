// PLUGIN properties (B3z) — the C++ port of src/core/engine/pluginProps.ts
// (ENGINE_API.md §15.9 "Plugin properties"): the values JavaScript plugins keep
// on a layer, as ordinary engine-API properties.
//
//   plugin/<name>                  a plugin layer kind's prop (the `pluginLayer:<…>`
//                                  component; keyed on the `plugin.<name>` track)
//   plugin/<slug>/<panel>          a contributed inspector panel's property GROUP
//                                  (the `PluginParams.<slug>.<panel>` component)
//   plugin/<slug>/<panel>/<name>   one of its params (keyed on the
//                                  `pluginUi.<slug>.<panel>.<name>[.<axis>]` tracks)
//
// Typed by what the document stores (the engine never sees a plugin's schema):
// a number is an animatable scalar (a point's `.x`/`.y`/`.z` one vec2 / vec3),
// a boolean a bool, a string a string, anything else json; a non-numeric param
// also takes ANY json. Bindings are added in SORTED order (names, then panel
// component types) so both engines list the same tree.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

/// `pluginApiPath(prop)`: the API path of a plugin member track, or nullopt.
[[nodiscard]] std::optional<std::string> plugin_api_path(std::string_view prop);

/// The static number of a plugin member track: outer nullopt = not a plugin track,
/// inner nullopt = it stores none.
[[nodiscard]] std::optional<std::optional<double>> read_plugin_static(const Node& n, std::string_view prop);
/// Write it: nullopt = not a plugin track; false = the layer has no such component.
[[nodiscard]] std::optional<bool> write_plugin_static(Document& d, std::string_view nodeId, std::string_view prop,
                                                      double value);

/// `addPluginBindings(node, trackNames, add)`.
void add_plugin_bindings(const Node& node, const std::vector<std::string>& trackNames,
                         const std::function<void(PropBinding)>& add);
/// `pluginPanelGroupPaths(node)`: plugin/<slug>/<panel> for each stored panel component, sorted.
[[nodiscard]] std::vector<std::string> plugin_panel_group_paths(const Node& node);

/// A `plugin` field binding (FieldRef.animatorId = the component TYPE — TS `groupId`).
[[nodiscard]] api::Value read_plugin_field(const Node& node, const PropBinding& b);
void write_plugin_field(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value);

struct PanelGroup {
  std::string slug;
  std::string panel;
  std::string type;  ///< PluginParams.<slug>.<panel>
  std::string id;    ///< pluginui_<slug>_<panel>
};
/// `parsePanelGroupPath(path)`.
[[nodiscard]] std::optional<PanelGroup> parse_panel_group_path(std::string_view path);
/// `panelGroupForMatchName(matchName)`: the group path a `PluginParams.<slug>.<panel>` match name adds.
[[nodiscard]] std::optional<std::string> panel_group_for_match_name(std::string_view matchName);
/// `panelInitProps(init)`: the stored props of a new panel group (typeMismatch / invalidArgument).
[[nodiscard]] Json panel_init_props(const std::vector<api::PropertyInit>& init);

inline constexpr std::string_view kPluginPanelTrackPrefix = "pluginUi.";

}  // namespace premation::doc
