// The TypeScript registries the property catalog is built from, as data —
// generated/catalog_data.inc, written by
// src/core/engine/__tests__/crossEngineCatalog.test.ts from the live modules
// (EFFECT_DEFS, propertyMeta's STATIC table, layer styles, shape operators,
// polystar, text animators/selectors, paint, label colours, animation presets,
// the layer factory's component data). Never hand-edited: a registry change
// regenerates it, and the Jest test fails while it is stale.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"

namespace premation::doc {

using js::Json;

struct EffectOption {
  double value = 0;
  std::string label;
};

struct EffectParamDef {
  std::string key;
  std::string label;
  /// 'number' | 'color' | 'checkbox' | 'curve' | 'layer' | 'resolved' | 'enum' | 'maskPath'
  std::string type;
  std::vector<EffectOption> options;
  std::optional<std::string> group;
  std::optional<std::string> unit;
  std::optional<double> min;
  std::optional<double> max;
  std::optional<double> precision;
  Json def;  ///< `default`
};

struct EffectDef {
  std::string type;
  std::string label;
  bool gpuOnly = false;
  std::vector<EffectParamDef> params;
  std::optional<Json> newInstanceParams;
  [[nodiscard]] const EffectParamDef* param(std::string_view key) const noexcept;
  /// The first `number` param (the legacy primary).
  [[nodiscard]] const EffectParamDef* primary() const noexcept;
};

struct StaticMeta {
  std::string label;
  std::string group;
  std::string type;
  std::string unit;
  std::optional<double> min;
  std::optional<double> max;
  Json defaultValue;  ///< number | string | bool | null
  bool keyframeable = true;
  std::optional<double> displayScale;
};

struct Registry {
  std::vector<EffectDef> effects;
  std::map<std::string, std::size_t, std::less<>> effectIndex;
  std::map<std::string, StaticMeta, std::less<>> staticMeta;
  Json layerStyles;    ///< {numberParams, colorParams, effectType, label, defaults}
  Json pathOps;        ///< {type: {params: [...], default: {...}}}
  Json polystar;       ///< {params, star, polygon, default}
  Json animators;      ///< {animatorParams, selectorParams, optional, defaultAnimator, selectors}
  Json fields;         ///< G1 textFields.ts: {text, animator, animatorOptional, selector, selectorKindParams}
  Json paint;
  Json strokeTracks;
  std::vector<std::string> maskKeys;
  std::vector<std::string> textPathParams;
  std::vector<std::string> labelColors;  ///< LABEL_COLORS[i].color
  Json presets;        ///< listPresets() minus applyFn (hasApplyFn marks those)
  Json factory;        ///< {particle, primitive, textSize, camera1920}
  /// Command wire id → 'edit' | 'control' | 'io' (the schema's attributes).
  std::map<std::uint32_t, std::string> commandKinds;
  /// Command wire id → its TypeScript `type` name (`createLayer`).
  std::map<std::uint32_t, std::string> commandNames;
  /// blendMode.ts BLEND_MODES (what `isBlendMode` accepts).
  std::vector<std::string> blendModes;

  [[nodiscard]] const EffectDef* effect(std::string_view type) const noexcept;
  [[nodiscard]] const StaticMeta* meta(std::string_view path) const noexcept;
};

/// The parsed registries (parsed once, on first use; immutable afterwards).
[[nodiscard]] const Registry& registry();

}  // namespace premation::doc
