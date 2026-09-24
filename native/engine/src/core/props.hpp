// The property catalog — src/core/engine/props.ts: API property paths
// (ENGINE_API.md §3.4) ⇄ the document's storage, for one layer. Built on the
// static property rows (ptree.hpp) and the static value seam
// (propertyValue.ts: `read/writeStaticPropertyValue`), exactly as the
// TypeScript engine's catalog is. A row's MEMBERS are the scalar keyframe
// tracks behind it; a vector or colour property is several members read and
// written together, one API keyframe per time.
//
// Values cross the API in After Effects units (§3.5): the document stores
// transform scale as a multiplier, and the conversion happens here, both ways.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "anim.hpp"
#include "model.hpp"
#include "ordered_map.hpp"
#include "timeline.hpp"
#include "values.hpp"

namespace premation::doc {

/// What a property read or write needs besides the document: the editor view
/// the keyframe axis consults, and the expression environment for sampling.
struct PCtx {
  Document& d;
  const EditorView& view;
  const ExprEnv& expr;
  ExprCache& cache;
};

/// field: a static field (fields.hpp); layerFill: the layer's own solid fill colour (layer/fill);
/// rig: a puppet / skeleton property (rig.hpp).
/// maskRotoBezier: a mask's RotoBezier switch (static, held in every shape key); shapePath: a shape layer's drawn
/// outline (`layer/path.points`: static Geometry points + Closed, keys on the `path.points` data track).
enum class Special : std::uint8_t {
  none, sourceText, maskPath, maskMode, maskInverted, maskRotoBezier, effectParam, field, layerFill, rig, fillStops, shapePath
};

/// A shape layer's whole-outline keyframe track (AE's Path property).
inline constexpr std::string_view kShapePathTrack = "path.points";

/// A rig binding's storage (rigProps.ts RigRef): owner puppet | pin | skeleton | bone | ik | controller.
struct RigRef {
  std::string owner;
  std::string id;    ///< '' for the puppet / skeleton themselves; an IK goal's id is its bone's
  std::string spec;  ///< the spec's path under the owner group
};

/// A field binding's storage (fields.ts FieldRef): owner is text | animator | selector | textPath | styleRuns.
struct FieldRef {
  std::string owner;
  std::string key;
  std::optional<std::string> animatorId;
  std::optional<std::string> selectorId;
};

struct PropBinding {
  std::string path;
  std::string name;
  std::string matchName;
  api::ValueType valueType = api::ValueType::scalar;
  std::vector<std::string> members;
  std::optional<std::string> colorBase;
  std::optional<std::string> dataTrack;
  Special special = Special::none;
  std::optional<std::string> maskId;
  std::optional<std::string> effectId;
  std::optional<std::string> paramKey;
  std::optional<FieldRef> field;
  std::optional<RigRef> rig;
  /// A LATENT binding (latentPropSpecs.ts): the component types its first static write stores on
  /// when no component carries the member yet (empty = the static seam owns it). nullopt = the Transform.
  std::optional<std::vector<std::string>> home;
  bool animatable = true;
  bool separated = false;
  std::string unit;
  std::optional<double> min;
  std::optional<double> max;
  std::optional<std::vector<std::string>> choices;
  std::optional<api::Value> defaultValue;
  bool hidden = false;
  /// `b.members[0] ?? b.dataTrack` — the track the keyframe axis is read for.
  [[nodiscard]] std::string lead() const;
};

struct GroupBinding {
  std::string path;
  std::string name;
  std::string matchName;
  api::PropertyKind kind = api::PropertyKind::group;
  bool enabled = true;
  std::vector<std::string> children;
};

struct Catalog {
  std::string layer;
  std::vector<PropBinding> props;               ///< byPath's insertion order
  std::map<std::string, std::size_t, std::less<>> byPath;
  std::map<std::string, std::size_t, std::less<>> byMember;
  OrderedMap<GroupBinding> groups;              ///< insertion order (TS Map)
  std::vector<std::string> roots;
  [[nodiscard]] const PropBinding* find(std::string_view path) const;
  [[nodiscard]] const PropBinding* by_member(std::string_view member) const;
};

/// `catalogFor(layerId)` — notFound when the layer does not exist.
[[nodiscard]] Catalog catalog_for(const Document& d, std::string_view layerId);
[[nodiscard]] const PropBinding& require_binding(const Catalog& cat, std::string_view path);

// ── values ──────────────────────────────────────────────────────────────
[[nodiscard]] double api_unit_factor(std::string_view member) noexcept;
[[nodiscard]] std::vector<double> to_api_nums(const PropBinding& b, std::vector<double> nums);
[[nodiscard]] std::vector<double> from_api_nums(const PropBinding& b, std::vector<double> nums);
[[nodiscard]] api::Value vector_value(api::ValueType vt, const std::vector<double>& v);
/// `numbersOf(b, value)`: type-checked member numbers (typeMismatch / invalidArgument).
[[nodiscard]] std::vector<double> numbers_of(const PropBinding& b, const api::Value& value);

/// `readStaticPropertyValue(nodeId, prop)` / `writeStaticPropertyValue`.
[[nodiscard]] std::optional<double> read_static_property_value(const Document& d, std::string_view nodeId,
                                                               std::string_view prop);
bool write_static_property_value(Document& d, std::string_view nodeId, std::string_view prop, double value);

[[nodiscard]] api::BezierPath mask_to_bezier(const Json& maskPath);
/// `vertexStatesOf(points)`: the per-vertex editing state (broken / tension) stored points carry.
[[nodiscard]] std::vector<api::PathVertexState> vertex_states_of(const Json& points);
/// `shapePoints(b, prev, path)`: a shape outline's points (no per-vertex feather: a listed one is `unsupported`).
[[nodiscard]] Json shape_points(const api::BezierPath& b, const Json* prev, const std::string& path);
/// `asPoints(v)`: v when it is a non-empty array of point objects, else nullptr.
[[nodiscard]] const Json* as_points(const Json& v);
/// A shape outline's Closed switch (`Geometry.open` marks an open path).
[[nodiscard]] bool shape_closed(const Node& n);
/// Set it — written only when it changes (notFound without a Geometry).
void write_shape_closed(Document& d, std::string_view layer, bool closed);
/// `shapePathValueOf(layer, v)`: stored outline points as the shape Path's value (none when not points).
[[nodiscard]] api::Value shape_path_value_of(const Document& d, std::string_view layer, const Json& v);
/// `bezierToPoints(b, prev)` → the mask point objects.
[[nodiscard]] Json bezier_to_points(const api::BezierPath& b, const Json* prev);

/// The static (un-animated) value of a property.
[[nodiscard]] api::Value read_static(const Document& d, std::string_view layer, const PropBinding& b);
/// Write a property's static value.
void write_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value);

// ── keyframes ───────────────────────────────────────────────────────────
/// One dimension's temporal fields (the API's KeyframeDim).
struct KeyDimAt {
  api::Easing easing = api::Easing::linear;
  std::optional<std::array<double, 4>> bezier;
  bool continuous = false;
};

struct KeyAt {
  double t = 0;  ///< stored (keyframe-axis) seconds
  std::string id;
  api::Value value;
  api::Easing easing = api::Easing::linear;
  std::optional<std::array<double, 4>> bezier;
  bool continuous = false;
  bool roving = false;
  api::SpatialInterp spatialInterp = api::SpatialInterp::legacy;
  std::vector<double> spatialIn;
  std::vector<double> spatialOut;
  double label = 0;
  /// Per-dimension temporal fields when the dimensions differ (Keyframe.dims); empty = uniform.
  std::vector<KeyDimAt> dims;
};

[[nodiscard]] std::string fallback_key_id(std::string_view layer, std::string_view member, double t);
struct FallbackKey {
  std::string layer;
  std::string member;
  double t = 0;
};
[[nodiscard]] std::optional<FallbackKey> parse_fallback_key_id(std::string_view id);

[[nodiscard]] bool is_animated(const Document& d, std::string_view layer, const PropBinding& b);
[[nodiscard]] std::vector<KeyAt> read_keys(const Document& d, std::string_view layer, const PropBinding& b);
[[nodiscard]] std::string mask_key_id(std::string_view layer, const Json& maskKey, std::string_view maskId);

/// Stored seconds → API flicks (comp time), and back.
[[nodiscard]] api::Time key_time_to_flicks(const PCtx& c, std::string_view layer, const PropBinding& b, double t);
[[nodiscard]] double flicks_to_key_time(const PCtx& c, std::string_view layer, const PropBinding& b, api::Time flicks);
[[nodiscard]] api::Keyframe key_at_to_api(const PCtx& c, std::string_view layer, const PropBinding& b, const KeyAt& k);

struct KeyWrite {
  double t = 0;
  std::string id;
  std::optional<api::Value> value;
  std::optional<api::Easing> easing;
  /// nullopt = keep; engaged-with-nullopt = clear (TS `bezier: null`).
  std::optional<std::optional<std::array<double, 4>>> bezier;
  std::optional<bool> continuous;
  std::optional<bool> roving;
  std::optional<api::SpatialInterp> spatialInterp;
  /// nullopt = keep; empty vector inside = clear (TS null); values = set.
  std::optional<std::optional<std::vector<double>>> spatialIn;
  std::optional<std::optional<std::vector<double>>> spatialOut;
  std::optional<double> label;
  /// Keyframe.dims: member i takes dims[i] (used only with one entry per member).
  std::optional<std::vector<KeyDimAt>> dims;
  /// KeyframePatch.dim: easing / bezier / continuous reach only this member.
  std::optional<std::size_t> dim;
};

/// `putKeys`: replace a key at the same stored time (its fields survive unless set). One key per
/// time for every member: a member with no key there gets one carrying the keyed member's fields.
void put_keys(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<KeyWrite>& writes);
/// `normalizeKeysAt`: fill the members missing a key at each of `times` (before a move).
void normalize_keys_at(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<double>& times);
/// `dropKeys`: removing the last key leaves the static value at it.
void drop_keys(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<double>& times);
/// handlers/properties.ts `valueAt(layer, b, t)` (keys + expressions sampled, else static).
[[nodiscard]] std::optional<api::Value> value_at(const PCtx& c, std::string_view layer, const PropBinding& b, double t);

}  // namespace premation::doc
