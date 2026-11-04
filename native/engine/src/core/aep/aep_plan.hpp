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

#include <array>
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

/// One outline key of an animated path (mask or shape), points in this editor's form.
struct PlannedPathKey {
  double t = 0;
  std::vector<PlannedMaskPoint> points;
  api::Easing easing = api::Easing::linear;
  std::optional<std::array<double, 4>> bezier;
};

struct PlannedMask {
  std::string name;
  std::string mode;
  bool inverted = false;
  bool locked = false;
  /// AE's mask colour, 0..255 per channel.
  std::array<std::uint32_t, 3> color = {0, 0, 0};
  bool closed = true;
  std::vector<PlannedMaskPoint> points;
  std::vector<PlannedPathKey> keys;
  double feather = 0;
  double opacity = 1;
  double expansion = 0;
};

/// An AE expression on a property this editor has: where it goes, what it says.
struct PlannedExpression {
  /// API property path (`transform/position`, `effects/<planned effect index>/<key>`: the applier
  /// swaps the index for the effect's id).
  std::string path;
  std::string source;
  bool enabled = true;
  /// One dimension of an unseparated vector (AE's separated Position X / Y / Z).
  std::optional<std::uint32_t> member;
  /// False on the second half of an AE point split into two params here (one AE expression).
  bool counted = true;
};

struct PlannedEffect {
  std::string type;
  /// Param key → value (a number, or a `#rrggbb` string), insertion order.
  std::vector<std::pair<std::string, js::Json>> params;
  std::vector<PlannedTrack> tracks;
  /// Param key → expression.
  std::vector<std::pair<std::string, PlannedExpression>> expressions;
  bool defaultsOnly = false;
};

/// One contour of a shape layer: its outline, and its keys when it is animated.
struct PlannedRun {
  bool closed = true;
  std::vector<PlannedMaskPoint> points;
  std::vector<PlannedPathKey> keys;
};

/// An AE shape layer as ONE path layer here: every contour a subpath, one fill, one stroke.
/// Points are layer-local, centred on the outline's box (`cx`, `cy` in AE layer space).
struct PlannedShape {
  std::vector<PlannedRun> runs;
  double cx = 0, cy = 0, width = 1, height = 1;
  std::optional<std::string> fill;  ///< `#rrggbb`; absent = no fill
  double fillOpacity = 1;
  /// Per-run fills when the layer's groups paint in different colours (index = run).
  std::vector<std::string> runFills;
  struct Stroke {
    std::string color = "#ffffff";
    double width = 2, opacity = 1, miterLimit = 4;
    std::string cap = "butt", join = "miter";
  };
  std::optional<Stroke> stroke;
  /// AE draws the item higher in the Contents list on top: Fill above Stroke.
  bool fillAboveStroke = false;
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
  /// Layer-level expressions (transform), API paths.
  std::vector<PlannedExpression> layerExpressions;
  std::optional<PlannedShape> shape;
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
