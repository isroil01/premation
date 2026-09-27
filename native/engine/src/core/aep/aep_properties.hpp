// Property trees, values and keyframes (src/core/aep/aepProperties.ts).
//
// A group is a `LIST tdgp` whose children alternate a `tdmn` (40-byte match
// name) with the member it names, ending at `tdmn "ADBE Group End"`. A leaf is
// a `LIST tdbs` holding `tdb4` (what kind of property), `cdat` (the static
// value) and, when animated, `LIST list` → `lhd3` + `ldat`. Members also come
// as `sspc` (effects), `om-s` (mask outlines), `otst` (3-D orientation) and
// `btds` (text), and a member can have a chunk wedged between its name and its
// value (a mask's `mkif`) — so a name pairs with the next VALUE list.
//
// The keyframe layout is decided by the `lhd3` item SIZE, not by a type tag;
// 3-D position and 3-D scale are both 128 bytes and are told apart only by the
// spatial flag in `tdb4`.
#pragma once

#include <string>
#include <vector>

#include "core/aep/aep_model.hpp"
#include "core/aep/riff.hpp"

namespace premation::doc::aep {

struct PropertyContext {
  /// The comp's internalTimebase (keyframe times are counts of it); 0 → 24576.
  double timebase = 24576;
  /// The owning layer's size (its source's, else the comp's) — what normalised values are fractions of.
  double layerWidth = 0;
  double layerHeight = 0;
  /// Anchor points are normalised against the source only on layers that have one.
  bool hasSource = false;
  std::vector<std::string>* warnings = nullptr;
};

/// `readGroup(list, ctx, matchName)`.
[[nodiscard]] AepProp read_group(const Chunk& list, const PropertyContext& ctx, const std::string& matchName);

/// `groupMembers(list)`: name, the chunks between name and value, and the value chunk.
struct GroupMember {
  std::string matchName;
  std::vector<const Chunk*> between;
  const Chunk* value = nullptr;
};
[[nodiscard]] std::vector<GroupMember> group_members(const Chunk& list);

}  // namespace premation::doc::aep
