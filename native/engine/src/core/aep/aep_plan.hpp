// AepProject → an import plan (src/core/aep/aepPlan.ts). PURE.
//
// The whole translation from After Effects' conventions to this editor's
// happens here, which keeps aep_apply.cpp to "do what the plan says":
//
//  • Anchor point: AE measures from the layer's top-left, this editor from its
//    centre (ours = theirs − size/2; mask vertices shift the same way).
//  • Scale: AE is a percentage, the engine a multiplier.
//  • Stacking: AE's layer 1 is the TOP; the plan keeps AE order and the
//    applier walks it backwards.
//  • Defaults are ABSENT, not written: no `ADBE Position` means "centred in
//    the comp", never (0, 0).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "core/aep/aep_model.hpp"
#include "json.hpp"
#include "model.hpp"

namespace premation::doc::aep {

struct PlannedTrack {
  std::string prop;
  std::vector<Key> keyframes;
};

struct PlannedMaskPoint {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};

struct PlannedMask {
  std::string name;
  std::string mode;
  bool inverted = false;
  bool closed = true;
  std::vector<PlannedMaskPoint> points;
  double feather = 0;
  double opacity = 1;
  double expansion = 0;
};

struct PlannedEffect {
  std::string type;
  /// Param key → value (a number, or a `#rrggbb` string), insertion order.
  std::vector<std::pair<std::string, js::Json>> params;
  std::vector<PlannedTrack> tracks;
  bool defaultsOnly = false;
};

/// shape text image video audio null solid camera light adjustment comp group
using PlannedKind = std::string;

struct PlannedLayer {
  /// `<aep comp id>:<aep layer id>` — how parenting and mattes refer to each other.
  std::string uid;
  std::string name;
  PlannedKind kind;
  std::optional<std::string> parentUid;
  struct Source {
    bool comp = false;  ///< false = footage
    std::uint32_t aepId = 0;
  };
  std::optional<Source> source;
  /// Transform props in this editor's units, insertion order.
  std::vector<std::pair<std::string, double>> staticProps;
  std::vector<PlannedTrack> tracks;
  struct Timing {
    double inSec = 0, outSec = 0, startSec = 0, stretch = 100;
  } timing;
  struct Flags {
    bool enabled = true, solo = false, shy = false, locked = false, threeD = false, adjustment = false, guide = false,
         motionBlur = false, collapse = false;
  } flags;
  std::string blendMode;
  std::uint32_t label = 0;
  struct Matte {
    std::string mode;  ///< alpha | luma
    bool inverted = false;
    std::optional<std::string> sourceUid;
  };
  std::optional<Matte> matte;
  std::vector<PlannedMask> masks;
  std::vector<PlannedEffect> effects;
  std::optional<AepTextDocument> text;
  std::optional<std::string> solidColor;
  struct Expression {
    std::string prop;
    std::string source;
  };
  std::vector<Expression> expressions;

  [[nodiscard]] std::optional<double> prop(std::string_view key) const {
    for (const auto& [k, v] : staticProps) {
      if (k == key) return v;
    }
    return std::nullopt;
  }
};

struct PlannedComp {
  std::uint32_t aepId = 0;
  std::string name;
  double width = 0, height = 0, fps = 0, durationSeconds = 0;
  std::string background;
  std::vector<std::string> folder;
  bool motionBlur = false;
  double shutterAngle = 180, shutterPhase = 0, samplesPerFrame = 16;
  double workAreaStart = 0, workAreaEnd = 0;
  /// AE order — layer 1 first. The applier reverses it.
  std::vector<PlannedLayer> layers;
};

struct PlannedFootage {
  std::uint32_t aepId = 0;
  std::string name;
  std::string kind;  ///< file | solid | placeholder
  std::optional<std::string> path;
  double width = 0, height = 0, durationSeconds = 0, frameRate = 0;
  bool isStill = false, hasAudio = false, missingAtSave = false;
  std::optional<std::string> solidColor;
  std::vector<std::string> folder;
};

struct PlanSummary {
  std::uint32_t comps = 0, layers = 0, keyframes = 0, effects = 0, masks = 0, expressions = 0;
  std::vector<std::string> unmappedEffects;
};

struct AepImportPlan {
  std::vector<PlannedComp> comps;
  std::vector<PlannedFootage> footage;
  std::vector<std::string> warnings;
  PlanSummary summary;
  std::optional<std::string> aeVersion;
};

/// `planAepImport(project)`.
[[nodiscard]] AepImportPlan plan_aep_import(const AepProject& project);

/// aepApply.ts `mainComp`: the comp nothing else contains, the longest (then widest) of those.
[[nodiscard]] std::optional<std::size_t> main_comp(const AepImportPlan& plan);

/// `#rrggbb` of 0–255 channels (rounded, clamped).
[[nodiscard]] std::string hex_color(double r, double g, double b);

}  // namespace premation::doc::aep
