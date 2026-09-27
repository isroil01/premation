// After Effects effects → this editor's effects (src/core/aep/aepEffects.ts).
//
// AE identifies an effect by its MATCH NAME (`ADBE Gaussian Blur 2`), stable
// across versions and UI languages. Parameters are matched by LABEL (off each
// parameter's `pard`), never by position: `<effect>-000N` numbering is the
// plug-in's undocumented declaration order. Labels are normalised (lower case,
// letters and digits only) and compared against this editor's param keys, its
// labels, and a small synonym table for the names the two products disagree
// on. A point is one AE parameter and two here (`…X` / `…Y`).
//
// An effect that maps but whose parameters found nothing lands at its own
// defaults (`defaultsOnly`) and is reported; one with no equivalent maps to
// nothing and the caller reports it by name.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::doc::aep {

/// An AE parameter as the reader found it.
struct AeParam {
  std::string matchName;
  std::optional<std::string> label;
  std::optional<int> controlType;
};

struct MappedPoint {
  std::string keyX;
  std::string keyY;
  std::string from;  ///< the AE point parameter's match name
};

struct MappedEffect {
  std::string type;
  /// Our parameter key → the AE parameter match name that supplies it (insertion order).
  std::vector<std::pair<std::string, std::string>> params;
  /// Our point base → the AE point feeding its X/Y pair (insertion order).
  std::vector<std::pair<std::string, MappedPoint>> points;
  bool defaultsOnly = false;
};

/// `EFFECT_BY_MATCH_NAME[matchName]`.
[[nodiscard]] std::optional<std::string> effect_for_match_name(std::string_view matchName);
/// `mapEffect(matchName, params)`: the effects to add, in order (empty = no equivalent here).
[[nodiscard]] std::vector<MappedEffect> map_effect(std::string_view matchName, const std::vector<AeParam>& params);
/// `normalize(label)`.
[[nodiscard]] std::string normalize_label(std::string_view label);

}  // namespace premation::doc::aep
