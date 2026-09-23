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

struct StaticPropertyRow {
  std::string prop;
  std::string label;
  std::string group;  ///< TimelineGroupKey
  std::vector<std::string> members;
  std::optional<std::string> merged;
  std::optional<std::string> valueUnit;
  bool maskTrack = false;
};

/// `groupForProp(prop, nodeId)`.
[[nodiscard]] std::string group_for_prop(const Document& d, std::string_view prop, const Node* node);

/// `buildStaticPropertyTree(nodeId)` (empty for an unknown node).
[[nodiscard]] std::vector<StaticPropertyRow> build_static_property_tree(const Document& d, std::string_view nodeId);

}  // namespace premation::doc
