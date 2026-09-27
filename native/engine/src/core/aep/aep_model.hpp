// The After Effects project, decoded (src/core/aep/aepModel.ts).
//
// What aep_read.cpp produces and aep_plan.cpp consumes: a faithful model of
// what the `.aep` says, in AE's own vocabulary and units — seconds, degrees,
// AE percentages, AE's top-left y-down comp space. Nothing here is translated
// into this editor's terms; that happens once, in the planner, so "did we read
// the file right?" and "did we map it right?" stay separable questions.
// Properties keep their AE match names (stable across AE versions and UI
// languages), which is what the mapping tables key on.
#pragma once

#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::doc::aep {

enum class Interp : std::uint8_t { linear, bezier, hold };

struct AepKeyframe {
  /// Seconds, already converted out of the comp's internal timebase.
  double time = 0;
  /// One number per dimension; colours arrive as [r, g, b, a] in 0–1.
  std::vector<double> value;
  Interp inInterp = Interp::linear;
  Interp outInterp = Interp::linear;
  /// Temporal ease per dimension: speed in value-units per second, influence 0–1.
  std::vector<double> inSpeed, inInfluence, outSpeed, outInfluence;
  /// Spatial tangents (position only), value-space offsets from `value`.
  std::optional<std::vector<double>> inTangent, outTangent;
  bool temporalAutoBezier = false;
  bool temporalContinuous = false;
  bool spatialAutoBezier = false;
  bool spatialContinuous = false;
  bool roving = false;
};

struct AepShapeVertex {
  double x = 0, y = 0;
  /// Tangent handles, relative to the vertex.
  double inX = 0, inY = 0, outX = 0, outY = 0;
};

struct AepShape {
  bool closed = true;
  std::vector<AepShapeVertex> vertices;
};

/// `AepTextDocument`: what a text layer says, as much as is recoverable.
struct AepTextDocument {
  std::string text;
  std::optional<std::string> font;
  std::optional<double> fontSize;
  /// 0–1 per channel.
  struct Rgb {
    double r = 0, g = 0, b = 0;
  };
  std::optional<Rgb> fillColor;
  std::optional<std::string> justification;  ///< left | center | right
  std::optional<double> tracking;
  std::optional<double> leading;
  bool fauxBold = false;
  bool fauxItalic = false;
  /// How many character-style runs; more than one = flattened to the first.
  std::size_t styleRuns = 0;
};

/// A property or a group (AepPropertyNode): `isGroup` says which fields mean anything.
struct AepProp {
  bool isGroup = false;
  std::string matchName;
  /// The name shown in AE, when the user renamed it (or a parameter's label).
  std::optional<std::string> name;
  // ── group ──
  std::vector<AepProp> children;
  // ── property ──
  std::size_t dimensions = 1;
  bool isColor = false;
  bool isSpatial = false;
  bool isInteger = false;
  bool animated = false;
  std::vector<double> value;
  std::vector<AepKeyframe> keyframes;
  std::optional<AepShape> shape;
  std::optional<AepTextDocument> text;
  std::optional<std::string> expression;
  bool expressionEnabled = false;
  /// AE SDK `PF_ParamType` of an effect parameter (6 = point, 5 colour, …).
  std::optional<int> controlType;
};

struct AepMask {
  std::string name;
  std::string mode = "add";  ///< none | add | subtract | intersect | lighten | darken | difference
  bool inverted = false;
  bool locked = false;
  std::uint32_t color[3] = {0, 0, 0};
  std::optional<AepShape> shape;
  AepProp properties;
};

enum class LayerKind : std::uint8_t { av, light, camera, text, shape, model, mesh };

struct AepLayer {
  std::uint32_t id = 0;
  std::string name;
  LayerKind kind = LayerKind::av;
  /// 1-based, top layer = 1.
  std::size_t index = 1;
  std::uint32_t sourceId = 0;
  std::uint32_t parentId = 0;
  double inPoint = 0, outPoint = 0, startTime = 0;
  /// Percent; 100 = no stretch.
  double stretch = 100;
  bool enabled = true, solo = false, shy = false, locked = false, threeD = false, adjustment = false, guide = false;
  bool nullLayer = false, collapseTransformation = false, motionBlur = false, frameBlending = false;
  bool effectsActive = true, audioEnabled = true, environmentLayer = false;
  std::string blendingMode = "Normal";
  std::string trackMatte = "none";  ///< none | alpha | alpha-inverted | luma | luma-inverted
  std::uint32_t matteLayerId = 0;   ///< 0 = none stated (pre-23: "the layer above")
  std::uint32_t label = 0;
  int autoOrient = 0;
  std::optional<std::uint32_t> lightType;
  AepProp properties;
  std::vector<AepMask> masks;
};

struct AepRgb8 {
  std::uint32_t r = 0, g = 0, b = 0;
};

enum class ItemKind : std::uint8_t { folder, comp, footage };

struct AepComp {
  std::uint32_t id = 0;
  std::string name;
  std::uint32_t label = 0;
  std::vector<std::string> folder;
  double width = 0, height = 0, fps = 0, durationSeconds = 0, pixelAspect = 1;
  AepRgb8 background;
  double displayStartTime = 0, workAreaStart = 0;
  /// +Infinity for AE's "to the end" sentinel.
  double workAreaEnd = std::numeric_limits<double>::infinity();
  bool motionBlur = false;
  double shutterAngle = 180, shutterPhase = 0, motionBlurSamplesPerFrame = 16, motionBlurAdaptiveSampleLimit = 128;
  bool frameBlending = false, hideShyLayers = false, draft3d = false;
  double internalTimebase = 0;
  /// Top layer first.
  std::vector<AepLayer> layers;
};

struct AepFootage {
  std::uint32_t id = 0;
  std::string name;
  std::uint32_t label = 0;
  std::vector<std::string> folder;
  std::string footageKind = "file";  ///< file | solid | placeholder
  double width = 0, height = 0, durationSeconds = 0, frameRate = 0, pixelAspect = 1;
  std::optional<std::string> path;
  bool missingAtSave = false;
  struct Rgb {
    double r = 0, g = 0, b = 0;
  };
  std::optional<Rgb> solidColor;
  std::string sourceFormat;
  bool hasAudio = false;
  bool isStill = false;
};

struct AepItemRef {
  ItemKind kind = ItemKind::folder;
  std::uint32_t id = 0;
  std::string name;
  std::vector<std::string> folder;
  std::size_t index = 0;  ///< into comps / footage (folders: unused)
};

struct AepProject {
  /// Every item in project order (folders by name; comps / footage by index).
  std::vector<AepItemRef> items;
  std::vector<AepComp> comps;
  std::vector<AepFootage> footage;
  std::optional<std::string> aeVersion;
  std::vector<std::string> warnings;
};

// ── Lookups ──────────────────────────────────────────────────────────────

[[nodiscard]] inline const AepProp* find_prop(const AepProp* group, std::string_view matchName) noexcept {
  if (group == nullptr) return nullptr;
  for (const AepProp& c : group->children) {
    if (c.matchName == matchName) return &c;
  }
  return nullptr;
}
[[nodiscard]] inline const AepProp* find_leaf(const AepProp* group, std::string_view matchName) noexcept {
  const AepProp* p = find_prop(group, matchName);
  return p != nullptr && !p->isGroup ? p : nullptr;
}
[[nodiscard]] inline const AepProp* find_group(const AepProp* group, std::string_view matchName) noexcept {
  const AepProp* p = find_prop(group, matchName);
  return p != nullptr && p->isGroup ? p : nullptr;
}
/// `scalarOf`: the first dimension, or the fallback.
[[nodiscard]] inline double scalar_of(const AepProp* p, double fallback = 0) noexcept {
  return p != nullptr && !p->value.empty() ? p->value[0] : fallback;
}

}  // namespace premation::doc::aep
