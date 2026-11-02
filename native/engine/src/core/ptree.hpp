// A layer's static property rows — src/core/timeline/propertyTree.ts
// `buildStaticPropertyTree`: every property the layer has whether or not it is
// keyed, in After Effects' twirl order. The engine's property catalog
// (props.hpp) is built over these rows, exactly as the TypeScript engine's is.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"

namespace premation::doc {

inline constexpr std::string_view kGroupPlaceholderPrefix = "__static:";
inline constexpr std::string_view kMaskAnimProp = "__mask:path";
inline constexpr std::string_view kPositionPseudoProp = "Position";
inline constexpr std::string_view kSourceTextProp = "text.source";
inline constexpr std::string_view kAudioLevelDbProp = "audioLevelDb";
inline constexpr std::string_view kAudioPanProp = "audioPan";
/// A text layer's Background: the switch, and its colour (keyframeable; a colour row).
inline constexpr std::string_view kTextBackground = "background";
inline constexpr std::string_view kTextBackgroundColor = "backgroundColor";
/// The timeline group of a layer's rig rows (a puppet's pins, a skeleton's bones) — propertyTree.ts `'rig'`.
inline constexpr std::string_view kRigGroup = "rig";

struct StaticPropertyRow {
  std::string prop;
  std::string label;
  std::string group;  ///< TimelineGroupKey
  std::vector<std::string> members;
  std::optional<std::string> merged;
  std::optional<std::string> valueUnit;
  /// The tracks the row's value field edits; absent = its members (propertyTree.ts `valueProps`).
  std::optional<std::vector<std::string>> valueProps;
  bool maskTrack = false;
};

/// `groupForProp(prop, nodeId)`.
[[nodiscard]] std::string group_for_prop(const Document& d, std::string_view prop, const Node* node);
/// A rig keyframe TRACK name (`puppet.<pin>.*`, `bone.<id>.*`, `ikTarget.<id>.*`, `ikPole.<id>.*`, `ikMode.<id>`).
[[nodiscard]] bool is_rig_track(std::string_view prop) noexcept;
/// The layer's rig rows (C2): Puppet ▸ Mesh / Pins ▸ <pin>; Skeleton ▸ Mesh / Bones ▸ <bone> (+ its IK goal).
[[nodiscard]] std::vector<StaticPropertyRow> rig_rows(const Document& d, const Node& n);
/// The Text component's Background switch is on.
[[nodiscard]] bool text_background_on(const Node& n);

/// `buildStaticPropertyTree(nodeId)` (empty for an unknown node).
[[nodiscard]] std::vector<StaticPropertyRow> build_static_property_tree(const Document& d, std::string_view nodeId);

}  // namespace premation::doc
