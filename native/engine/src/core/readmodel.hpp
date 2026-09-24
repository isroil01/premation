// The read model — src/core/engine/model.ts: the API's records (LayerInfo,
// CompSettings, ItemInfo, Marker, PropertyInfo, KeyframeSet,
// DocumentSnapshot) built from the document. Pure reads.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "props.hpp"

namespace premation::doc {

[[nodiscard]] api::Color hex_to_color(const Json& hex, api::Color fallback = {0, 0, 0, 1});
/// Label colour hex → AE label index (1-based into LABEL_COLORS, 0 = none/custom).
[[nodiscard]] std::uint32_t label_index_of(const Json& color);
[[nodiscard]] std::optional<std::string> label_color_of(std::uint32_t index);
/// The palette entry's id for a label index (B3z: setItemLabel stores footage labels by id).
[[nodiscard]] std::optional<std::string> label_id_of(std::uint32_t index);
/// A custom label colour: #rgb, #rrggbb or #rrggbbaa (setLayerSwitches labelColor).
[[nodiscard]] bool is_label_color(std::string_view s);

[[nodiscard]] double comp_fps(const Document& d, std::string_view comp);
[[nodiscard]] double comp_duration_frames(const Document& d, std::string_view comp);

[[nodiscard]] api::LayerTiming layer_timing(const Document& d, std::string_view layer);
[[nodiscard]] api::LayerSwitches layer_switches(const Document& d, const Node& n);
[[nodiscard]] api::TrackMatte layer_matte(const Node& n);
[[nodiscard]] api::BlendMode layer_blend(const Node& n);
/// `readMatte(fx.matte)` normalised: {mode: alpha|luma, inverted, sourceId?} or nullopt.
struct MatteState {
  std::string mode;
  bool inverted = false;
  std::optional<std::string> sourceId;
};
[[nodiscard]] std::optional<MatteState> read_node_matte(const Node& n);
[[nodiscard]] std::string read_node_quality(const Node& n);
[[nodiscard]] std::string read_auto_orient_mode(const Node& n);
[[nodiscard]] bool is_layer_audio_muted(const Node& n);
[[nodiscard]] api::RetimeMode read_retime_mode(const Document& d, std::string_view layer);
/// `collapseSwitchKind`: "collapse" | "raster" | "".
[[nodiscard]] std::string collapse_switch_kind(const Node& n);
[[nodiscard]] bool read_layer_flag(const Document& d, const Node& n, std::string_view flag);

[[nodiscard]] std::vector<api::Marker> layer_markers(const Document& d, std::string_view layer);
[[nodiscard]] std::vector<api::Marker> comp_markers(const Document& d, std::string_view comp);
[[nodiscard]] api::Marker marker_from_data(const TMarker& m, api::MarkerOwner owner, double fps);
[[nodiscard]] api::LayerInfo layer_info(const Document& d, std::string_view layer);

[[nodiscard]] api::CompSettings comp_settings(const Document& d, std::string_view comp);
[[nodiscard]] api::CompInfo comp_info(const Document& d, std::string_view comp);
/// B3z: a stored transition record as the API reports it (model.ts transitionInfo).
[[nodiscard]] api::Transition transition_info(const Document& d, std::string_view comp, const Json& rec);
/// model.ts `transitionsOf(comp)`.
[[nodiscard]] std::vector<api::Transition> transitions_of(const Document& d, std::string_view comp);

[[nodiscard]] api::ItemInfo footage_info(const Json& asset);
[[nodiscard]] api::ItemInfo folder_info(const Folder& f);
[[nodiscard]] api::ItemInfo comp_item_info(const Document& d, std::string_view comp);
[[nodiscard]] std::optional<api::ItemInfo> item_info(const Document& d, std::string_view id);
[[nodiscard]] std::vector<api::ItemInfo> all_item_infos(const Document& d);

[[nodiscard]] api::PropertyInfo property_info(const PCtx& c, std::string_view layer, const Catalog& cat,
                                              const PropBinding& b);
[[nodiscard]] api::PropertyInfo group_info(const Catalog& cat, std::string_view path);
[[nodiscard]] std::vector<api::PropertyInfo> property_tree(const PCtx& c, std::string_view layer, const Catalog& cat,
                                                           std::string_view root = {}, std::uint32_t depth = 0);
[[nodiscard]] std::vector<api::KeyframeSet> keyframe_sets(const PCtx& c, std::string_view layer, const Catalog& cat);

[[nodiscard]] api::DocumentSnapshot document_snapshot(const PCtx& c, api::Revision revision, const std::string& projectPath,
                                                      bool dirty, bool includeProperties, bool includeKeyframes);

}  // namespace premation::doc
