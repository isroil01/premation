// Expression controls as API property groups (B3) — the C++ port of
// src/core/engine/controlProps.ts. The kind table is controlSpecs.ts,
// generated into the catalog data (`registry().fields.at("control")`).
//
//   effects/ctrl_<name>           group, match name 'ADBE <Kind> Control'
//   effects/ctrl_<name>/<param>   the value: the Transform numbers
//                                 `ctrl_<name><suffix>` (+ `ctrlkind_<name>`)
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

inline constexpr std::string_view kControlPrefix = "ctrl_";
inline constexpr std::string_view kControlKindPrefix = "ctrlkind_";

struct ControlSpec {
  std::string kind;
  std::string matchName;
  std::string label;        ///< listGroupTypes display name
  std::string displayName;  ///< auto-name base ("Slider")
  std::string param;
  std::string propName;
  std::string propMatchName;
  api::ValueType valueType = api::ValueType::scalar;
  std::vector<std::string> components;
  std::vector<double> defaults;
  std::string unit;
};

/// controlSpecs.ts CONTROL_SPECS, in order.
[[nodiscard]] const std::vector<ControlSpec>& control_specs();
[[nodiscard]] const ControlSpec* control_spec_for_match_name(std::string_view matchName);

struct LayerControl {
  std::string name;
  const ControlSpec* spec = nullptr;
};

/// A layer's controls in storage order (controlProps.ts readControls).
[[nodiscard]] std::vector<LayerControl> read_controls(const Node& node);
/// The stored numbers behind a control's value, in value order.
[[nodiscard]] std::vector<std::string> control_members(const LayerControl& c);
[[nodiscard]] std::string control_group_path(std::string_view name);
/// The value bindings of a layer's controls (catalog order).
[[nodiscard]] std::vector<PropBinding> control_bindings(const Node& node);
/// Group info of `effects/ctrl_<name>` (nullopt: not a control of this layer).
[[nodiscard]] std::optional<GroupBinding> control_group_info(const Node& node, const std::string& path);
/// The control a group path names on this layer.
[[nodiscard]] std::optional<LayerControl> resolve_control(const Node& node, const std::string& path);
/// The next free "Slider 1"-style name given every control value stored in the document.
[[nodiscard]] std::string next_free_control_name(const Document& d, const ControlSpec& spec);

}  // namespace premation::doc
