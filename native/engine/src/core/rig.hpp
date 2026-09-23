// Puppet pins and skeletons as API property groups and properties (B3z WS-R) —
// the C++ port of src/core/engine/rigProps.ts (ENGINE_API.md §15.9 "Rigging —
// puppet and skeleton paths"). The property table is rigSpecs.ts, generated
// into the catalog data (`registry().fields.at("rig")`).
//
//   puppet                              fx.puppet (After Effects' Puppet effect)
//   puppet/mesh/<field>                 the rig's mesh settings
//   puppet/pins/<pin>/<prop>            one pin
//   skeleton                            fx.skeleton
//   skeleton/mesh/<field>, skeleton/weightPaint
//   skeleton/bones/<bone>/<prop>        one bone
//   skeleton/bones/<bone>/ik/<prop>     the IK goal whose end bone this is
//   skeleton/controllers/<ctrl>/<prop>  one rig controller
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

/// Every rig binding of a layer, in catalog order.
void add_rig_bindings(const Document& d, const Node& node, std::string_view layerId,
                      const std::function<void(PropBinding)>& add);
/// The rig groups that exist even when empty, in order.
[[nodiscard]] std::vector<std::string> rig_group_paths(const Node& node);
/// Name / match name / switch / kind of a rig group path (nullopt: not a rig group).
[[nodiscard]] std::optional<GroupBinding> rig_group_info(const Node& node, const std::string& path);
/// API units per stored unit for a rig keyframe TRACK (pin / bone scale, bone rotation).
[[nodiscard]] std::optional<double> rig_member_factor(std::string_view member);

[[nodiscard]] api::Value read_rig_static(const Node& node, const PropBinding& b);
/// `creating`: the write initialises a group addPropertyGroup just made (no bind-pose capture).
void write_rig_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value,
                      bool creating = false);

/// A `puppet.<pin>.position` key value ⇄ the API vec2.
[[nodiscard]] api::Value pin_key_to_api(const Json& v);
[[nodiscard]] Json api_to_pin_key(const PropBinding& b, const api::Value& v);
/// A pin key's spatial tangents (the data key's si/so of point 0) as API per-dimension lists.
void pin_key_spatial(const std::optional<Json>& si, const std::optional<Json>& so, std::vector<double>& spatialIn,
                     std::vector<double>& spatialOut);

// ── groups ──────────────────────────────────────────────────────────────

struct RigGroupRef {
  /// rigRoot | pin | bone | controller | ik
  std::string kind;
  std::string layer;
  std::string id;  ///< rigRoot: 'puppet' | 'skeleton'
  int index = 0;
};

/// A rig group path (nullopt: not a rig path; notFound when it names a missing group).
[[nodiscard]] std::optional<RigGroupRef> resolve_rig_group(const Node& node, const std::string& layer, const std::string& path);
[[nodiscard]] std::string rig_group_path(const RigGroupRef& r);

struct RigAddPlan {
  std::string path;
  std::function<void()> run;
};

/// Plan addPropertyGroup for a rig group (nullopt: not a rig parent / match name).
[[nodiscard]] std::optional<RigAddPlan> plan_rig_add(
    Document& d, const std::string& layer, const std::string& parent, const std::string& matchName,
    std::optional<std::uint32_t> index, const std::optional<std::string>& name, const std::vector<api::PropertyInit>& init,
    const std::function<std::string(std::string_view, const std::function<bool(const std::string&)>&)>& mint);

void remove_rig_group(Document& d, const RigGroupRef& r);
void move_rig_group(Document& d, const RigGroupRef& r, std::size_t toIndex);
void rename_rig_group(Document& d, const RigGroupRef& r, const std::string& name);
void set_rig_group_enabled(Document& d, const RigGroupRef& r, bool on);

/// The listGroupTypes rows of the rig groups.
struct RigGroupType {
  std::string parent;
  std::string matchName;
  std::string displayName;
};
[[nodiscard]] const std::vector<RigGroupType>& rig_group_types();

// ── optional properties (the IK pole) ───────────────────────────────────

/// `skeleton/bones/<b>/ik` → the bone id (nullopt: not an IK goal path).
[[nodiscard]] std::optional<std::string> ik_parent_of(const std::string& path);
/// addProperties on an IK goal (only `pole`). Validates, then returns the apply step.
[[nodiscard]] std::function<void()> plan_ik_add_properties(Document& d, const std::string& layer, const std::string& parentPath,
                                                           const std::vector<std::string>& names);
/// removeProperties of an IK pole (nullopt: not an IK path).
struct IkRemovePlan {
  std::string key;
  std::function<void()> run;
};
[[nodiscard]] std::optional<IkRemovePlan> plan_ik_remove_property(Document& d, const std::string& layer, const std::string& path);

}  // namespace premation::doc
