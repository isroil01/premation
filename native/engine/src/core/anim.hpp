// AnimationEngine (packages/animation/src/AnimationEngine.ts) over
// doc::Document: scalar tracks, data tracks, expressions, and `sample` —
// keyframes through motion_eval, expressions through motion_expr, with the
// SAME cycle / depth rules and the same fallbacks as the TypeScript.
//
// The engine side of an expression (what `thisComp`, `thisLayer`,
// `layer(...)`, `toComp`, `marker`, `text.sourceText` read) comes from an
// `ExprEnv` the core implements over the document — the host providers
// src/providers/Providers.tsx binds in the app.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "expr.hpp"
#include "model.hpp"

namespace premation::doc {

// ── tracks (AnimationEngine track API) ───────────────────────────────────

[[nodiscard]] const std::vector<Key>* anim_track(const Document& d, std::string_view node, std::string_view prop);
[[nodiscard]] bool anim_is_animated(const Document& d, std::string_view node, std::string_view prop);
/// `setTrackKeyframes` (empty removes the track).
void anim_set_track(Document& d, std::string_view node, std::string_view prop, std::vector<Key> keys);
void anim_remove_track(Document& d, std::string_view node, std::string_view prop);
/// `setKeyframes`: de-duplicate by time (last wins), sort.
void anim_set_keyframes(Document& d, std::string_view node, std::string_view prop, const std::vector<Key>& keys);
/// `setKeyframe(node, prop, t, value, easing?)`: re-keying keeps the key's fields.
void anim_set_keyframe(Document& d, std::string_view node, std::string_view prop, double t, double value,
                       std::optional<api::Easing> easing = std::nullopt);
/// `upsertKeyframe` (interpolate.ts): replace the key at `t`, keep sorted.
[[nodiscard]] std::vector<Key> upsert_key(std::vector<Key> keys, Key k);
/// `timeSpan(node)`: first → last key over all scalar tracks.
struct TimeSpan {
  double start = 0;
  double end = 1;
};
[[nodiscard]] std::optional<TimeSpan> anim_time_span(const Document& d, std::string_view node);

// data tracks
[[nodiscard]] const DataTrack* anim_data_track(const Document& d, std::string_view node, std::string_view prop);
[[nodiscard]] bool anim_is_data_animated(const Document& d, std::string_view node, std::string_view prop);
void anim_set_data_track(Document& d, std::string_view node, std::string_view prop, std::optional<DataTrack> t);
[[nodiscard]] std::optional<Json> sample_data_track(const DataTrack& t, double time);

// expressions
[[nodiscard]] const ExprState* anim_expr(const Document& d, std::string_view node, std::string_view prop);
/// `setExpressionState` (null / blank source removes).
void anim_set_expr_state(Document& d, std::string_view node, std::string_view prop, std::optional<ExprState> st);
void anim_set_expr_enabled(Document& d, std::string_view node, std::string_view prop, bool on);
[[nodiscard]] bool anim_has_expr(const Document& d, std::string_view node, std::string_view prop);
[[nodiscard]] bool anim_expr_enabled(const Document& d, std::string_view node, std::string_view prop);

/// `sampleTrack(track, t)` — the keyframed value (nullopt for an empty track).
[[nodiscard]] std::optional<double> sample_keys(const std::vector<Key>& keys, double t);

// ── expression evaluation ────────────────────────────────────────────────

/// What the host providers answer (Providers.tsx). Absent providers mirror
/// AnimationEngine's defaults.
class ExprEnv {
 public:
  ExprEnv() = default;
  ExprEnv(const ExprEnv&) = delete;
  ExprEnv& operator=(const ExprEnv&) = delete;
  ExprEnv(ExprEnv&&) = delete;
  ExprEnv& operator=(ExprEnv&&) = delete;
  virtual ~ExprEnv() = default;

  /// `baseValueProvider(node, prop)`.
  [[nodiscard]] virtual std::optional<double> base_value(std::string_view node, std::string_view prop) const = 0;
  /// `layerResolver(name)` (names, not `#id` refs — those resolve directly).
  [[nodiscard]] virtual std::optional<std::string> resolve_layer(std::u16string_view name) const = 0;
  [[nodiscard]] virtual motion::expr::CompInfo comp_info() const = 0;
  [[nodiscard]] virtual motion::expr::LayerInfo layer_info(std::string_view node) const = 0;
  [[nodiscard]] virtual double ctrl(std::u16string_view name, double t) const = 0;
  [[nodiscard]] virtual double audio_level() const { return 0; }
  [[nodiscard]] virtual std::optional<motion::expr::SourceRect> source_rect(std::string_view node, double t,
                                                                            bool extents) const = 0;
  [[nodiscard]] virtual std::vector<motion::expr::MarkerData> markers(std::string_view node,
                                                                      motion::expr::MarkerScope scope) const = 0;
  /// `layerSpaceProvider(self, name, t)` — false when there is no such layer.
  [[nodiscard]] virtual bool space_exists(std::string_view self, const std::u16string* name, double t) const = 0;
  [[nodiscard]] virtual std::array<double, 3> space_convert(std::string_view self, const std::u16string* name,
                                                            double t, motion::expr::SpaceOp op,
                                                            std::array<double, 3> p) const = 0;
  [[nodiscard]] virtual std::optional<motion::expr::SourceTextSample> source_text(std::string_view node,
                                                                                  double t) const = 0;
};

/// Compiled expressions, shared by source text (compiled once per distinct source).
class ExprCache {
 public:
  [[nodiscard]] const motion::expr::Expression& get(const std::string& src);
  void clear() { cache_.clear(); }

 private:
  std::unordered_map<std::string, std::unique_ptr<motion::expr::Expression>> cache_;
};

/// `defaultAnimation.sample(node, prop, t)`.
[[nodiscard]] std::optional<double> anim_sample(const Document& d, const ExprEnv& env, ExprCache& cache,
                                                std::string_view node, std::string_view prop, double t);
/// `previewExpression(node, prop, src, t)` → {value (number or vector), error}.
[[nodiscard]] motion::expr::Result anim_preview_expression(const Document& d, const ExprEnv& env, ExprCache& cache,
                                                           std::string_view node, std::string_view prop,
                                                           const std::string& src, double t);
/// The compile error of the property's expression (null if valid or none).
[[nodiscard]] std::optional<std::string> anim_expr_error(const Document& d, ExprCache& cache, std::string_view node,
                                                         std::string_view prop);
/// `evaluateNode(node, t)`: every keyed/expressed prop of the node, sampled.
[[nodiscard]] std::vector<std::pair<std::string, double>> anim_evaluate_node(const Document& d, const ExprEnv& env,
                                                                             ExprCache& cache, std::string_view node,
                                                                             double t);
/// `evaluateSourceText(node, t)`. Null when there is no enabled Source Text
/// expression, the layer has no text, or the expression errors (the layer
/// then keeps its un-expressed text).
[[nodiscard]] std::optional<motion::expr::SourceTextResult> anim_evaluate_source_text(
    const Document& d, const ExprEnv& env, ExprCache& cache, std::string_view node, double t);

/// `componentIndexOf(prop)`.
[[nodiscard]] std::size_t component_index_of(std::string_view prop) noexcept;

}  // namespace premation::doc
