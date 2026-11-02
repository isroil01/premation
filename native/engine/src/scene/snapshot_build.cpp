#include "snapshot_build.hpp"

#include "native_contrib.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <exception>
#include <functional>
#include <limits>
#include <map>
#include <numbers>
#include <ranges>
#include <set>
#include <unordered_map>
#include <utility>

#include "canvas.hpp"
#include "cloner_port.hpp"
#include "comp_instance.hpp"
#include "fonts.hpp"
#include "effect_handoff.hpp"
#include "effects_port.hpp"
#include "effects_spatial.hpp"
#include "frame_build.hpp"
#include "rig_bridge.hpp"
#include "rig_coverage.hpp"
#include "fxstate.hpp"
#include "layer_styles.hpp"
#include "media_paths.hpp"
#include "merge_paths.hpp"
#include "misc_port.hpp"
#include "paint_port.hpp"
#include "particle_port.hpp"
#include "path_ops.hpp"
#include "timeline.hpp"
#include "precomp_frame.hpp"
#include "jsmath.hpp"
#include "raw_world.hpp"
#include "readers.hpp"
#include "rigid_body.hpp"
#include "readmodel.hpp"
#include "handlers_native.hpp"
#include "scene.hpp"
#include "scene_math.hpp"
#include "subjects.hpp"
#include "corner_pin.hpp"
#include "svg_layer.hpp"
#include "temporal_ghosts.hpp"
#include "deep_fx_scene.hpp"
#include "sourcetext.hpp"
#include "text_port.hpp"
#include "text_query.hpp"
#include "text_unicode.hpp"
#include "text_runs.hpp"
#include "threed_port.hpp"
#include "transform.hpp"

namespace premation::scene {

// snapshot_build.hpp WalkTopology: time-independent, so the WalkCache keeps it across frames.
struct WalkTopology {  // NOLINT(bugprone-exception-escape): as WalkNodes (MSVC's node-based containers)
  /// Flatten → collapsed instances → the sealed pass's overrides (cloners not yet expanded).
  WalkNodes walk;
  /// `walk.nodes` by id (the first node with an id wins, as the walk always did).
  std::unordered_map<std::string, const doc::Node*> byId;
  /// A walked node carries a `__cloner` object: the walk expands cloners per
  /// frame (a cloner can read the raw graph at the frame's time). False proves
  /// expand_cloners a no-op (read_cloner reads only that object).
  bool mayClone = false;
};

namespace {

using doc::Bar;
using doc::Document;
namespace xf = motion::xf;

/// SIZE (buildSnapshot.ts) per layer kind.
std::pair<double, double> kind_size(LayerKind k) {
  switch (k) {
    case LayerKind::shape: return {220, 220};
    case LayerKind::text: return {320, 80};
    case LayerKind::image: return {280, 180};
    case LayerKind::video: return {480, 270};
  }
  return {220, 220};
}

/// KIND_FILL (sceneDerive.ts) — the category colour a kind falls back to.
std::optional<std::string> kind_fill(std::string_view kind) {
  static constexpr std::array<std::pair<std::string_view, std::string_view>, 13> kFill = {{
      {"group", "#64748b"}, {"null", "#64748b"}, {"shape", "#3b8276"}, {"text", "#4f7ea8"},
      {"image", "#b47836"}, {"video", "#a84e62"}, {"svg", "#3b8276"}, {"audio", "#3a8b9e"},
      {"camera", "#4a7bb0"}, {"light", "#ba8e3a"}, {"adjustment", "#7965aa"}, {"particle", "#9e5a82"},
      {"comp", "#a84e62"},
  }};
  for (const auto& [k, v] : kFill) {
    if (k == kind) return std::string(v);
  }
  return std::nullopt;
}

double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

/// JavaScript truthiness of a JSON value.
bool truthy(const Json& v) {
  if (v.is_bool()) return v.b();
  if (v.is_number()) return v.num() != 0 && !std::isnan(v.num());
  if (v.is_string()) return !v.str().empty();
  return v.is_array() || v.is_object();
}

/// continuousRaster.ts `readContinuousRaster`.
bool read_continuous_raster(const doc::Node& n) {
  return std::ranges::any_of(n.components, [](const doc::Component& c) {
    const Json& v = c.props.at("continuousRasterize");
    return v.is_bool() && v.b();
  });
}

/// continuousRaster.ts `supportsContinuousRaster`: vector kinds, and a shape only
/// when it is not a flat solid rect (no path, stroke or corner radius).
bool supports_continuous_raster(const doc::Node& n) {
  const std::string kind = n.kind();
  if (kind == "text" || kind == "svg") return true;
  if (kind != "shape") return false;
  for (const doc::Component& c : n.components) {
    const Json& p = c.props;
    if (p.at("pathPoints").is_array() && !p.at("pathPoints").arr().empty()) return true;
    if (truthy(p.at("stroke")) || truthy(p.at("strokeWidth"))) return true;
    if (p.at("cornerRadius").is_number() && p.at("cornerRadius").num() > 0) return true;
    if (truthy(p.at("shapeType")) && !(p.at("shapeType").is_string() && p.at("shapeType").str() == "rect")) return true;
  }
  return false;
}

/// flattenComposition(graph, rootId): the root, then its subtree depth-first,
/// children back-most first.
std::vector<const doc::Node*> flatten_composition(const Document& d, std::string_view rootId) {
  std::vector<const doc::Node*> out;
  const doc::Node* root = d.node(rootId);
  if (root == nullptr) return out;
  struct Frame {
    const doc::Node* n;
    std::size_t next;
  };
  std::vector<Frame> stack{{root, 0}};
  out.push_back(root);
  std::set<std::string, std::less<>> seen{root->id};
  while (!stack.empty()) {
    Frame& f = stack.back();
    if (f.next >= f.n->children.size()) {
      stack.pop_back();
      continue;
    }
    const std::string& cid = f.n->children[f.next++];
    const doc::Node* child = d.node(cid);
    if (child == nullptr || !seen.insert(child->id).second) continue;
    out.push_back(child);
    stack.push_back({child, 0});
  }
  return out;
}

/// readBase — the base (authoring) props of a node's components.
struct Base {
  double x = 0, y = 0, rotation = 0, opacity = 1, scaleX = 1, scaleY = 1;
  std::optional<double> width, height, cornerRadius, cornerRadiusTL, cornerRadiusTR, cornerRadiusBR, cornerRadiusBL,
      backdropBlur;
  std::optional<std::string> fill, text;
  double fontSize = 48;
  std::optional<std::string> fontFamily, fontWeight, fontStyle, align;
  std::optional<double> fontWidth, fontSlant, letterSpacing, lineHeight, paragraphSpacing;
  /// Tracking in 1/1000 em (AE's Character-panel unit); `letterSpacing` is its px, keyframeable twin.
  std::optional<double> tracking;
  /// "alignment": the anchor sits at the alignment edge of point text (AE); absent / "center" = the box centre.
  std::optional<std::string> textAnchor;
  std::optional<bool> strokeOverFill;
  std::optional<std::string> textTransform, fontVariant, verticalAlign;
  std::optional<double> verticalScale, horizontalScale, baselineShift;
  std::optional<std::string> textStroke;
  std::optional<double> textStrokeWidth;
  std::optional<std::string> src, assetId, color;
};

Base read_base(const doc::Node& node) {
  Base b;
  std::optional<double> x, y, rotation, scaleX, scaleY, scale;
  double opacity = 100;
  for (const auto& c : node.components) {
    const Json& p = c.props;
    const auto n = [&p](const char* k) { return jnum(p.at(k)); };
    if (auto v = n("x")) x = v;
    if (auto v = n("y")) y = v;
    if (auto v = n("rotation")) rotation = v;
    if (auto v = n("opacity")) opacity = *v;
    if (auto v = n("scaleX")) scaleX = v;
    if (auto v = n("scaleY")) scaleY = v;
    if (auto v = n("scale")) scale = v;
    if (auto v = n("fontSize")) b.fontSize = *v;
    if (p.at("fill").is_string()) b.fill = p.at("fill").str();
    if (p.at("content").is_string()) b.text = p.at("content").str();
    if (p.at("fontFamily").is_string()) b.fontFamily = p.at("fontFamily").str();
    if (p.at("fontWeight").is_string()) b.fontWeight = p.at("fontWeight").str();
    else if (p.at("fontWeight").is_number()) b.fontWeight = js::number_to_string(p.at("fontWeight").num());
    if (p.at("fontWidth").is_number()) b.fontWidth = p.at("fontWidth").num();
    if (p.at("fontSlant").is_number()) b.fontSlant = p.at("fontSlant").num();
    if (p.at("fontStyle").is_string()) b.fontStyle = p.at("fontStyle").str();
    if (auto v = n("letterSpacing")) b.letterSpacing = v;
    if (auto v = n("tracking")) b.tracking = v;
    if (p.at("textAnchor").is_string()) b.textAnchor = p.at("textAnchor").str();
    if (auto v = n("lineHeight")) b.lineHeight = v;
    if (p.at("align").is_string()) b.align = p.at("align").str();
    if (auto v = n("paragraphSpacing")) b.paragraphSpacing = v;
    if (p.at("strokeOverFill").is_bool()) b.strokeOverFill = p.at("strokeOverFill").b();
    if (p.at("textTransform").is_string()) b.textTransform = p.at("textTransform").str();
    if (p.at("fontVariant").is_string()) b.fontVariant = p.at("fontVariant").str();
    if (p.at("verticalAlign").is_string()) b.verticalAlign = p.at("verticalAlign").str();
    if (auto v = n("verticalScale")) b.verticalScale = v;
    if (auto v = n("horizontalScale")) b.horizontalScale = v;
    if (auto v = n("baselineShift")) b.baselineShift = v;
    if (p.at("stroke").is_string()) b.textStroke = p.at("stroke").str();
    if (p.at("strokeWidth").is_number() && p.at("content").is_string()) b.textStrokeWidth = p.at("strokeWidth").num();
    if (p.at("src").is_string()) b.src = p.at("src").str();
    if (p.at("assetId").is_string()) b.assetId = p.at("assetId").str();
    if (p.at("color").is_string()) b.color = p.at("color").str();
    if (auto v = n("width")) b.width = v;
    if (auto v = n("height")) b.height = v;
    if (auto v = n("cornerRadius")) b.cornerRadius = v;
    if (auto v = n("cornerRadiusTL")) b.cornerRadiusTL = v;
    if (auto v = n("cornerRadiusTR")) b.cornerRadiusTR = v;
    if (auto v = n("cornerRadiusBR")) b.cornerRadiusBR = v;
    if (auto v = n("cornerRadiusBL")) b.cornerRadiusBL = v;
    if (auto v = n("backdropBlur")) b.backdropBlur = v;
  }
  const doc::ViewTransform vt = doc::view_transform(node);
  b.x = x.value_or(vt.x);
  b.y = y.value_or(vt.y);
  b.rotation = rotation.value_or(vt.rotation);
  b.opacity = opacity / 100;
  b.scaleX = scaleX ? *scaleX : scale.value_or(1);
  b.scaleY = scaleY ? *scaleY : scale.value_or(1);
  return b;
}

/// `anim.sampleData(id, 'path.points', t)` → BezierPoint[] (handles defaulted), or undefined.
Json live_path_points(const Document& d, std::string_view id, double t) {
  const doc::DataTrack* tr = doc::anim_data_track(d, id, "path.points");
  if (tr == nullptr) return {};
  const auto v = doc::sample_data_track(*tr, t);
  if (!v || !v->is_array() || v->arr().size() <= 1) return {};
  const Json& first = v->arr()[0];
  if (!first.is_object() || !first.has("x")) return {};
  Json out = Json::array();
  for (const Json& p : v->arr()) {
    const Json& px = p.at("x");
    const Json& py = p.at("y");
    Json q = Json::object();
    q.set("x", px);
    q.set("y", py);
    q.set("inX", p.at("inX").is_undefined() || p.at("inX").is_null() ? px : p.at("inX"));
    q.set("inY", p.at("inY").is_undefined() || p.at("inY").is_null() ? py : p.at("inY"));
    q.set("outX", p.at("outX").is_undefined() || p.at("outX").is_null() ? px : p.at("outX"));
    q.set("outY", p.at("outY").is_undefined() || p.at("outY").is_null() ? py : p.at("outY"));
    out.arr_mut().push_back(std::move(q));
  }
  return out;
}

/// Mask Path expressions (AE path properties): each path of `mask` whose
/// `mask.<id>.path` expression is on, replaced by what it returns at layer time `t`.
Json apply_mask_path_expressions(const Document& d, const doc::ExprEnv& env, doc::ExprCache& cache,
                                 std::string_view node, Json mask, double t) {
  if (mask.is_undefined() || !mask.at("paths").is_array()) return mask;
  const doc::NodeAnim* na = d.anim(node);
  if (na == nullptr || na->exprs.empty()) return mask;
  bool changed = false;
  Json paths = Json::array();
  for (const Json& p : mask.at("paths").arr()) {
    const Json& id = p.at("id");
    const std::string key = id.is_string() ? "mask." + id.str() + ".path" : std::string();
    if (key.empty() || !na->exprs.contains(key)) {
      paths.arr_mut().push_back(p);
      continue;
    }
    const bool closed = !p.at("closed").is_bool() || p.at("closed").b();
    const motion::expr::PathSample base = doc::path_sample_of_points(p.at("points"), closed);
    const auto out = doc::anim_evaluate_path(d, env, cache, node, key, base, t);
    if (!out) {
      paths.arr_mut().push_back(p);
      continue;
    }
    Json q = p;
    q.set("points", doc::points_of_path_sample(*out, &p.at("points")));
    q.set("closed", Json::boolean(out->closed));
    paths.arr_mut().push_back(std::move(q));
    changed = true;
  }
  if (!changed) return mask;
  mask.set("paths", std::move(paths));
  return mask;
}

/// motionBlurSampleTimes.
std::vector<double> motion_blur_sample_times(double t, double fps, double shutterAngle, double samples,
                                             double shutterPhase, double limit) {
  const double effective = std::min(std::max(1.0, std::floor(samples)), std::max(1.0, std::floor(limit)));
  const double duration = (std::max(0.0, std::min(720.0, shutterAngle)) / 360) / std::max(1.0, fps);
  if (effective <= 1 || duration <= 0) return {t};
  const double phaseOffset = ((std::max(-360.0, std::min(360.0, shutterPhase)) + 90) / 360) / std::max(1.0, fps);
  std::vector<double> out;
  const auto n = static_cast<int>(effective);
  out.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) out.push_back(t + phaseOffset + (i / (effective - 1) - 0.5) * duration);
  return out;
}

double adaptive_samples(double base0, double travelPx, double limit0) {
  const double base = std::max(1.0, std::floor(base0));
  const double limit = std::max(base, std::floor(limit0));
  if (!(travelPx > 0) || !std::isfinite(travelPx)) return std::min(base, limit);
  const double fromTravel = std::ceil(travelPx / 2);
  return std::min(limit, std::max(base, fromTravel));
}

// ── the walk ───────────────────────────────────────────────────────────────

class Walk final : public Scene3DHost {
 public:
  Walk(const BuildContext& c, const SnapshotComp& comp, double t, const std::optional<MotionBlurCfg>& mb)
      : c_(c), d_(c.d), comp_(comp), t_(t), mb_(mb) {}

  Snapshot run();

  // ── Scene3DHost (threed_port.cpp reads the walk's caches) ──
  [[nodiscard]] const doc::Node* node3d(std::string_view id) const override { return node(id); }
  const Values& values3d(const std::string& id) override { return values_of(id); }
  double remap3d(const std::string& id, double tt) override { return remap(id, tt, false); }
  double sub_remap3d(const std::string& id, double tt) override { return remap(id, tt, true); }
  xf::Local2D world2d(const std::string& id) override { return world_of(id); }
  [[nodiscard]] std::optional<std::string> parent3d_of(const std::string& id) const override { return parent_of(id); }
  bool live3d(const std::string& id) override { return is_live_at(id); }
  [[nodiscard]] std::string anim_id3d(const std::string& id) const override { return wn_->src(id); }

 private:
  /// `srcId(id)` (comp_instance.cpp): the node a walked id samples animation and clips from.
  [[nodiscard]] const std::string& sid(const std::string& id) const { return wn_->src(id); }
  /// The animation wrapper's `sample` (an Essential-Properties override drops the track).
  std::optional<double> anim_sample_of(const std::string& id, std::string_view prop, double tt) {
    if (wn_->is_overridden(id, prop)) return std::nullopt;
    return doc::anim_sample(d_, c_.expr, c_.cache, sid(id), prop, tt);
  }
  // ── lookups ──
  [[nodiscard]] const doc::Node* node(std::string_view id) const {
    const auto it = byId_->find(std::string(id));
    return it == byId_->end() ? nullptr : it->second;
  }
  const Values& values_of(const std::string& id);
  double remap(const std::string& id, double tt, bool subFrame, bool extrapolate = false);
  /// `cloneTimeOffsetOf(id)`: the nearest clone root's cascade delay, or 0.
  [[nodiscard]] double clone_time_offset(const std::string& id) const;
  /// buildSnapshot `retimedAt` / `retimedSourceAt` (retime_port.cpp).
  std::optional<double> retimed_at(const std::string& id, double tt);
  double retimed_source_at(const std::string& id, double tt);
  std::vector<const Bar*> governing_clips(const std::string& id);
  bool is_live_at(const std::string& id);
  xf::Mat2D world_matrix(const std::string& id);
  xf::Local2D world_of(const std::string& id) { return xf::matrix_to_local(world_matrix(id)); }
  std::optional<xf::Local2D> local_of(const std::string& id);
  [[nodiscard]] std::optional<std::string> parent_of(const std::string& id) const;
  [[nodiscard]] const doc::Node* nearest_precomp_root(const doc::Node& n) const;

  // ── emission ──
  void emit(RLayer l, const doc::Node& n);
  /// `buildPrecompContainer(group, nested?.layers, nested?.scene3d)`.
  RLayer precomp_container(const doc::Node& group, std::optional<NestedComp>* nested = nullptr);
  void emit_stub(const doc::Node& n);
  void emit_time_taps(const doc::Node& n, const RLayer& now);
  void build_node(const doc::Node& n);
  void unported(RLayer& l, const doc::Node& n, std::string what);
  /// A `warning` layer error: the layer draws without `what` (a clone source,
  /// a sky asset, a plugin …) and the frame is still exportable.
  void warning(RLayer& l, const doc::Node& n, std::string what);
  /// T4: a `font` layer error when none of the text's families is registered.
  void note_missing_font(RLayer& l, const doc::Node& n, std::string_view cssFamilies);
  std::vector<Json> effects_of(const doc::Node& n, const Values& a, std::optional<double> layerTime, RLayer* note);
  /// `matrixAt` (3D layers): the projected affine per sample (threed_port `matrix_at`).
  /// `quadAt`: a 3D comp card's perspective quad per sample (MotionSample.quad).
  /// AE Mask Motion Blur: `motionSamples` on each animated outline of `mask`.
  void mask_motion_samples(Json& mask, const doc::Node& n);
  void motion_samples(RLayer& l, const doc::Node& n, const Base& base, const std::string& id,
                      const std::function<Scene3D::MotionPose(double, double)>& matrixAt = {},
                      const std::function<std::optional<std::array<double, 8>>(double, double)>& quadAt = {});
  void text_fields(RLayer& l, const doc::Node& n, const Base& base, const Values& a);
  void attach_precomps(std::vector<RLayer>& list);

  const BuildContext& c_;
  const Document& d_;
  const SnapshotComp& comp_;
  double t_;
  const std::optional<MotionBlurCfg>& mb_;
  /// The raw graph's world transforms (rawLocalOf / rawWorldCache).
  RawWorld raw_{c_.d, c_.expr, c_.cache, t_};
  double fps_ = 30;
  /// Rigid-body poses at this frame (physicsPosesAt, rigid_body.cpp), by node id.
  std::map<std::string, physics::Pose> physics_;
  bool anySolo_ = false;
  /// BuildContext::isolateLayer, when this walk holds it: the layer, the
  /// layers under it and the groups above it — soloed for this walk alone.
  std::set<std::string, std::less<>> isolated_;
  [[nodiscard]] bool soloed(const doc::Node& n) const { return isolated_.empty() ? n.solo : isolated_.contains(n.id); }
  /// The Layer panel's layer (BuildContext::layerView): drawn whatever its switches say.
  [[nodiscard]] bool layer_view_of(const doc::Node& n) const { return c_.layerView && c_.layerView->id == n.id; }
  /// The layer's eye, plus the viewport's editor-side hide (BuildContext::hiddenLayers).
  [[nodiscard]] bool shown(const doc::Node& n) const {
    if (layer_view_of(n)) return true;
    return n.visible && std::ranges::find(c_.hiddenLayers, n.id) == c_.hiddenLayers.end();
  }
  /// A collapsed comp layer — except in the Layer panel, where it is sealed (shown as a card).
  [[nodiscard]] bool collapsed(const doc::Node& n) const { return !layer_view_of(n) && doc::read_comp_collapse(n); }

  /// The walk's topology (flatten + collapsed instances + sealed overrides),
  /// from the frame builder's WalkCache or built for this walk alone.
  // shared_ptr: shared with the builder's WalkCache, which may drop its entry
  // (a nested pass's insert past the cap, a new document) while this walk still
  // reads the nodes and clones the topology owns.
  std::shared_ptr<const WalkTopology> topo_;
  /// This frame's cloner expansion, only when the topology holds a cloner
  /// (cloners read the raw graph at t_): the topology's nodes by pointer plus
  /// this frame's clones, which it owns.
  WalkNodes clonedWn_;
  std::unordered_map<std::string, const doc::Node*> clonedById_;
  /// What the walk reads: the topology's, or this frame's cloner expansion.
  const WalkNodes* wn_ = nullptr;
  const std::unordered_map<std::string, const doc::Node*>* byId_ = nullptr;
  [[nodiscard]] const std::vector<const doc::Node*>& walked() const { return wn_->nodes; }
  std::unordered_map<std::string, Values> values_;
  std::unordered_map<std::string, std::vector<const Bar*>> clips_;
  std::unordered_map<std::string, bool> live_;
  std::unordered_map<std::string, xf::Mat2D> world_;
  std::set<std::string, std::less<>> fullBuild_;
  /// Matte sources of layers that will NOT draw (hidden, soloed out): still
  /// matte-only, never drawn as ordinary layers (AE keeps a matte layer's
  /// video off whatever its consumer does).
  std::set<std::string, std::less<>> hiddenMatteSources_;

  std::vector<RLayer> layers_;
  std::map<std::string, std::vector<RLayer>, std::less<>> precompInner_;
  std::set<std::string, std::less<>> precompEmitted_;
  std::vector<LayerError> errors_;
  /// The 3D block (camera, lights, placement, shadows, depth sort).
  std::unique_ptr<Scene3D> three_;
};

const Values& Walk::values_of(const std::string& id) {
  const auto it = values_.find(id);
  if (it != values_.end()) return it->second;
  Values v(doc::anim_evaluate_node(d_, c_.expr, c_.cache, sid(id), remap(id, t_, false)));
  if (const auto ov = wn_->overridden.find(id); ov != wn_->overridden.end()) {
    for (const std::string& p : ov->second) v.erase(p);
  }
  return values_.emplace(id, std::move(v)).first->second;
}

std::vector<const Bar*> Walk::governing_clips(const std::string& id) {
  const auto it = clips_.find(id);
  if (it != clips_.end()) return it->second;
  std::vector<const Bar*> own = doc::tl_bars_for_node(d_, c_.view, sid(id));
  if (own.empty()) {
    const doc::Node* cur = node(id);
    for (int depth = 0; depth < 32 && cur != nullptr; ++depth) {
      if (!cur->parent) break;
      const doc::Node* parent = node(*cur->parent);
      if (parent == nullptr || is_precomp_node(*parent) || parent->kind() != "group") break;
      std::vector<const Bar*> pc = doc::tl_bars_for_node(d_, c_.view, sid(parent->id));
      if (!pc.empty()) {
        own = std::move(pc);
        break;
      }
      cur = parent;
    }
  }
  return clips_.emplace(id, std::move(own)).first->second;
}

std::optional<double> Walk::retimed_at(const std::string& id, double tt) {
  if (!has_retime(d_, sid(id))) return std::nullopt;
  const std::optional<RetimeClip> clip = retime_clip_of(pick_retime_bar(governing_clips(id), motion::js::round(tt * fps_)), fps_);
  return retimed_chain_time(RetimeReader{d_, c_.expr, c_.cache}, sid(id), tt, clip);
}

double Walk::retimed_source_at(const std::string& id, double tt) {
  // The Layer panel scrubbing in layer time: its source time wins over the layer's own retime.
  if (c_.layerView && c_.layerView->sourceTime && id == c_.layerView->id) return *c_.layerView->sourceTime;
  const std::optional<double> retimed = retimed_at(id, tt);
  return retimed ? remap(id, *retimed, true, true) : remap(id, tt, false);
}

double Walk::remap(const std::string& id, double ttIn, bool subFrame, bool extrapolate) {
  const doc::Node* n = node(id);
  // Cloner cascade: a clone plays its animation `timeOffset` behind, at COMP time,
  // outside every clip map, loop and precomp remap (the offset lives on the clone root).
  const double tt0 = ttIn - clone_time_offset(id);
  // Precomp time remap (buildRemap): the precomp ANCESTORS' retimes fold first,
  // outermost → innermost; the node's own retime is its container sourceTime.
  double tt = tt0;
  if (n != nullptr) {
    std::vector<const doc::Node*> chain;  // precompAncestorChain
    std::optional<std::string> pid = n->parent;
    for (int guard = 0; pid && guard < 256; ++guard) {
      const doc::Node* p = node(*pid);
      if (p == nullptr) break;
      if (is_precomp_node(*p)) chain.push_back(p);
      pid = p->parent;
    }
    if (std::ranges::any_of(chain, [&](const doc::Node* pc) { return has_retime(d_, sid(pc->id)); })) {
      for (const auto& link : std::ranges::reverse_view(chain)) tt = retimed_at(link->id, tt).value_or(tt);
    }
  }
  // Governing clips (buildRemap baseMap).
  double time = tt;
  const std::vector<const Bar*> clips = governing_clips(id);
  if (!clips.empty()) {
    const double exact = tt * fps_;
    const double frame = motion::js::round(exact);
    const Bar* active = nullptr;
    for (const Bar* b : clips) {
      if (b->active_at(frame)) {
        active = b;
        break;
      }
    }
    if (active == nullptr && extrapolate) active = pick_retime_bar(clips, frame);
    if (active != nullptr) time = active->clip.source_frame_at(subFrame ? exact : frame) / fps_;
  }
  if (n != nullptr) {
    // Loop the source (Interpret Footage ▸ Loop).
    std::optional<std::string> assetId;
    for (const auto& comp : n->components) {
      if (comp.props.at("assetId").is_string() && !comp.props.at("assetId").str().empty()) assetId = comp.props.at("assetId").str();
      if (comp.props.at("__assetId").is_string() && !comp.props.at("__assetId").str().empty()) assetId = comp.props.at("__assetId").str();
    }
    if (assetId) {
      if (const Json* a = doc::find_asset(d_, *assetId)) {
        const double loopCount = jnum(a->at("interpret").at("loopCount")).value_or(1);
        const std::optional<double> dur = jnum(a->at("metadata").at("duration"));
        if (loopCount != 1 && dur && *dur > 0 && time >= *dur) {
          const double pass = std::floor(time / *dur);
          time = (loopCount != 0 && pass >= loopCount) ? *dur - 1e-6 : time - pass * *dur;
        }
      }
    }
    // Posterize Time.
    for (const Json& e : doc::read_node_effects(*n)) {
      if (!(e.at("type").is_string() && e.at("type").str() == "posterize-time")) continue;
      if (e.at("enabled").is_bool() && !e.at("enabled").b()) continue;
      const double pf = doc::params_of(e).at("frameRate").is_number() ? doc::params_of(e).at("frameRate").num() : 0;
      if (std::isfinite(pf) && pf >= 1) time = std::floor(time * pf) / pf;
      break;
    }
    // Per-layer time (stretch / reverse / freeze).
    if (const auto cfg = doc::read_node_layer_time(*n)) {
      double s0 = 0;
      double s1 = 1;
      if (const auto span = doc::anim_time_span(d_, sid(id))) {
        s0 = span->start;
        s1 = span->end;
      } else if (!clips.empty() && clips[0]->clip.duration > 0) {
        s0 = clips[0]->clip.sourceIn / fps_;
        s1 = s0 + clips[0]->clip.duration / fps_;
      } else if (assetId) {
        if (const Json* a = doc::find_asset(d_, *assetId)) {
          if (const auto dur = jnum(a->at("metadata").at("duration")); dur && *dur > 0) s1 = *dur;
        }
      }
      time = doc::remap_time(time, *cfg, s0, s1);
    }
  }
  return time;
}

double Walk::clone_time_offset(const std::string& id) const {
  if (wn_->cloneOffsets.empty()) return 0;
  const doc::Node* cur = node(id);
  for (int i = 0; cur != nullptr && i < 64; ++i) {
    if (const auto it = wn_->cloneOffsets.find(cur->id); it != wn_->cloneOffsets.end()) return it->second.timeOffset;
    cur = cur->parent ? node(*cur->parent) : nullptr;
  }
  return 0;
}

bool Walk::is_live_at(const std::string& id) {
  // The Layer panel shows the whole source, In/Out or not.
  if (c_.layerView && id == c_.layerView->id) return true;
  const auto it = live_.find(id);
  if (it != live_.end()) return it->second;
  bool live = true;
  const std::vector<const Bar*> clips = governing_clips(id);
  if (!clips.empty()) {
    const double raw = motion::js::round(t_ * fps_);
    const double gate = comp_.durationSeconds
                            ? std::min(raw, std::max(0.0, motion::js::round(*comp_.durationSeconds * fps_) - 1))
                            : raw;
    live = std::ranges::any_of(clips, [gate](const Bar* b) { return b->active_at(gate); });
  }
  live_.emplace(id, live);
  return live;
}

std::optional<xf::Local2D> Walk::local_of(const std::string& id) {
  const doc::Node* n = node(id);
  if (n == nullptr) return std::nullopt;
  const Base b = read_base(*n);
  const Values& av = values_of(id);
  const auto sc = av.get("scale");
  xf::Local2D l;
  l.x = av.get("x").value_or(b.x);
  l.y = av.get("y").value_or(b.y);
  l.rotation = av.get("rotation").value_or(b.rotation);
  l.scale_x = av.get("scaleX").value_or(sc.value_or(b.scaleX));
  l.scale_y = av.get("scaleY").value_or(sc.value_or(b.scaleY));
  return l;
}

std::optional<std::string> Walk::parent_of(const std::string& id) const {
  const doc::Node* n = node(id);
  // A comp instance's top clones are authored in the referenced comp's own
  // space: the transform chain stops at them (isCompInstanceRoot).
  if (n == nullptr || wn_->instance_root(id)) return std::nullopt;
  return n->parent;
}

xf::Mat2D Walk::world_matrix(const std::string& nodeId) {
  // worldTransform.ts worldMatrixOf: walk up to a cached ancestor or a root,
  // then compose down, caching every node on the way; parent cycles make the
  // cycle's nodes roots.
  if (const auto it = world_.find(nodeId); it != world_.end()) return it->second;
  std::vector<std::string> path;
  std::unordered_map<std::string, std::size_t> onPath;
  std::optional<xf::Mat2D> above;
  std::ptrdiff_t cycleFrom = -1;
  for (std::string id = nodeId;;) {
    onPath.emplace(id, path.size());
    path.push_back(id);
    const auto parent = parent_of(id);
    if (!parent) break;
    if (const auto it = world_.find(*parent); it != world_.end()) {
      above = it->second;
      break;
    }
    if (const auto seen = onPath.find(*parent); seen != onPath.end()) {
      cycleFrom = static_cast<std::ptrdiff_t>(seen->second);
      break;
    }
    id = *parent;
  }
  xf::Mat2D world;
  for (std::ptrdiff_t i = static_cast<std::ptrdiff_t>(path.size()) - 1; i >= 0; --i) {
    const std::string& id = path[static_cast<std::size_t>(i)];
    const auto local = local_of(id);
    const xf::Mat2D lm = local ? xf::local_matrix(*local) : xf::Mat2D{};
    if (cycleFrom >= 0 && i >= cycleFrom) world = lm;
    else if (i == static_cast<std::ptrdiff_t>(path.size()) - 1) world = above ? xf::multiply(*above, lm) : lm;
    else world = xf::multiply(world, lm);
    world_[id] = world;
  }
  return world;
}

const doc::Node* Walk::nearest_precomp_root(const doc::Node& n) const {
  std::optional<std::string> pid = n.parent;
  int guard = 0;
  while (pid && guard++ < 256) {
    const doc::Node* p = node(*pid);
    if (p == nullptr) break;
    if (composites_as_unit(*p)) return p;
    pid = p->parent;
  }
  return nullptr;
}

void Walk::note_missing_font(RLayer& l, const doc::Node& n, std::string_view cssFamilies) {
  // A family the font set does not have is drawn in a fallback face SILENTLY —
  // the samurai session's Cormorant / Playfair / Yu Mincho all came out as one
  // sans. Recorded as a `font` layer error naming what was asked for (the
  // first family that is not a CSS generic; the list's later entries are the
  // author's own fallbacks, so the layer is only reported when NONE is there).
  const raster::CanvasOptions* canvas = c_.measurer != nullptr ? c_.measurer->canvas_options() : nullptr;
  if (canvas == nullptr || canvas->fonts == nullptr) return;
  static constexpr std::array<std::string_view, 8> kGeneric = {"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system", "ui-sans-serif"};
  std::string first;
  std::string_view rest = cssFamilies;
  while (!rest.empty()) {
    const std::size_t comma = rest.find(',');
    std::string_view one = rest.substr(0, comma);
    while (!one.empty() && (one.front() == ' ' || one.front() == '"' || one.front() == '\'')) one.remove_prefix(1);
    while (!one.empty() && (one.back() == ' ' || one.back() == '"' || one.back() == '\'')) one.remove_suffix(1);
    if (!one.empty()) {
      std::string low(one);
      std::ranges::transform(low, low.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
      if (std::ranges::find(kGeneric, low) != kGeneric.end() || canvas->fonts->has_family(one)) return;  // drawn as asked
      if (first.empty()) first = std::string(one);
    }
    if (comma == std::string_view::npos) break;
    rest.remove_prefix(comma + 1);
  }
  if (first.empty()) return;
  const std::string what = "font '" + first + "' is not installed or bundled — the text is drawn in a fallback face (list_fonts shows what is available)";
  if (std::ranges::any_of(errors_, [&](const LayerError& e) { return e.layerId == n.id && e.stage == "font"; })) return;
  (void)l;
  errors_.push_back({n.id, n.name, "font", what});
}

void Walk::unported(RLayer& l, const doc::Node& n, std::string what) {
  if (std::ranges::find(l.unported, what) != l.unported.end()) return;
  errors_.push_back({n.id, n.name, "unported", what});
  l.unported.push_back(std::move(what));
}

void Walk::warning(RLayer& l, const doc::Node& n, std::string what) {
  if (std::ranges::find(l.unported, what) != l.unported.end()) return;
  errors_.push_back({n.id, n.name, "warning", what});
  l.unported.push_back(std::move(what));
}

void Walk::emit(RLayer l, const doc::Node& n) {
  const doc::Node* pc = nearest_precomp_root(n);
  if (pc == nullptr) {
    layers_.push_back(std::move(l));
    return;
  }
  precompInner_[pc->id].push_back(std::move(l));
  if (precompEmitted_.insert(pc->id).second) {
    RLayer c = precomp_container(*pc);
    emit_time_taps(*pc, c);
    emit(std::move(c), *pc);
  }
}

// Program X1: time taps — the layer's content at other times for its temporal
// deep effects, placed where it is now and hidden (deep_fx_scene.hpp). Each is
// the layer built alone (with what it holds: a precomp's subtree) at t + dt.
void Walk::emit_time_taps(const doc::Node& n, const RLayer& now) {
  if (!c_.timeTaps) return;
  for (const TimeTap& tap : deep_time_taps(now)) {
    BuildContext tc = c_;
    tc.timeTaps = false;
    tc.isolateLayer = n.id;
    tc.isolateAlso.clear();
    tc.layerView.reset();
    tc.hiddenLayers.clear();
    tc.focusLayers.clear();
    Snapshot at = build_snapshot(tc, comp_, std::max(0.0, t_ + tap.dt), std::nullopt);
    for (RLayer& built : at.layers) {
      if (built.id != n.id) continue;
      emit(time_tap_layer(std::move(built), now, tap.id), n);
      break;
    }
  }
}

void Walk::emit_stub(const doc::Node& n) {
  RLayer l;
  l.id = n.id;
  l.kind = LayerKind::shape;
  l.opacity = 0;
  l.width = 1;
  l.height = 1;
  l.fill = "#000";
  l.visible = false;
  l.matte = read_matte_of(n);
  emit(std::move(l), n);
}

std::vector<Json> Walk::effects_of(const doc::Node& n, const Values& a, std::optional<double> layerTime, RLayer* note) {
  const Json& fxEnabled = fx_props(n).at("fxEnabled");
  const bool on = !(fxEnabled.is_bool() && !fxEnabled.b());
  std::vector<Json> own = on ? doc::read_node_effects(n) : std::vector<Json>{};
  const Json styles = doc::get_node_layer_styles(n);
  const bool hasStyles = styles.is_object() && !styles.obj().empty() &&
                         std::ranges::any_of(styles.obj(), [](const Json::Member& m) { return !m.value.is_undefined(); });
  if (hasStyles) {
    // layerStylesToEffects: styles carrying ANY track stay alive at a zero stored value.
    const auto animated = [&a](std::string_view key) {
      for (const auto& [k, v] : a.items()) {
        constexpr std::string_view kPrefix = "effect.layerstyle:";
        if (!k.starts_with(kPrefix)) continue;
        const std::string_view rest = std::string_view(k).substr(kPrefix.size());
        const std::size_t dot = rest.find('.');
        if ((dot == std::string_view::npos ? rest : rest.substr(0, dot)) == key) return true;
      }
      return false;
    };
    for (Json& e : layer_styles_to_effects(styles, comp_.globalLightAngle, comp_.globalLightAltitude, animated)) own.push_back(std::move(e));
  }
  if (own.empty()) return {};
  std::vector<Json> resolved = resolve_effect_params(own, a, layerTime);
  {  // path / paint effects' resolved geometry (effect_handoff.cpp)
    std::vector<std::string> notes;
    // buildSnapshot's `anim` bound to this node (Write-on's dab history).
    HandoffAnim anim{
        [this, &n](std::string_view prop, double tt) { return anim_sample_of(n.id, prop, tt); },
        [this, &n](std::string_view prop) { return !wn_->is_overridden(n.id, prop) && doc::anim_is_animated(d_, sid(n.id), prop); },
        std::nullopt};
    if (const auto span = doc::anim_time_span(d_, sid(n.id))) anim.firstKey = span->start;
    resolve_effect_handoffs(resolved, n, a, layerTime, c_.measurer, notes, &anim);
    // Energy Beam on a text outline the fonts cannot trace, Write-on's brush
    // history without a sampler: the effect draws without that input.
    if (note != nullptr) {
      for (std::string& w : notes) warning(*note, n, std::move(w));
    }
  }
  if (note != nullptr) {
    for (const Json& e : resolved) {
      const std::string type = e.at("type").is_string() ? e.at("type").str() : "";
      if (const char* why = effect_unported_reason(e)) {
        // A missing plugin / an effect outside every ported list passes its input
        // through: the frame draws and exports, the user is told. A Cloud-locked
        // plugin keeps its own stage (is_plugin_locked_error, the notice's heading).
        if (std::string_view(why) == kPluginLockedReason) unported(*note, n, std::string(why) + " (" + type + ")");
        else warning(*note, n, std::string(why) + " (" + type + ")");
      }
    }
  }
  // Image Fill: the project item it names, as a file (a plugin FILE param's rule: its live source,
  // then a collected copy, then the recorded path). A missing one draws nothing, and is said.
  for (Json& e : resolved) {
    if (!e.at("type").is_string() || e.at("type").str() != "image-fill" || !e.at("params").is_object()) continue;
    const Json& item = e.at("params").at("image");
    if (!item.is_string() || item.str().empty()) continue;
    const doc::NativeActionRequest::File file = doc::native_file_of(d_, "image", item.str());
    if (!file.missing) {
      Json p = e.at("params");
      p.set(kImageFillFile, Json::string(file.path));
      e.set("params", std::move(p));
    } else if (note != nullptr) {
      warning(*note, n, "Image Fill: the image '" + (file.name.empty() ? file.item : file.name) + "' is missing — the layer draws without it");
    }
  }
  // Camera program D2: a Lens Flare linked to a light sits where the light
  // projects through the active camera (in this layer's own space), goes dark
  // behind the camera, and carries the light's view depth for the chain's
  // occlusion test against the scene depth. A missing light is reported and
  // the flare renders as authored.
  if (three_) {
    for (Json& e : resolved) {
      if (!e.at("type").is_string() || e.at("type").str() != "lens-flare" || !e.at("params").is_object()) continue;
      const Json& link = e.at("params").at("linkLight");
      if (!link.is_string() || link.str().empty()) continue;
      const doc::Node* light = node(link.str());
      const auto pr = light != nullptr ? three_->project_light(*light) : std::nullopt;
      if (!pr) {
        if (note != nullptr) {
          warning(*note, n, "Lens Flare: the linked light '" + link.str() + "' is not a light in this composition — the flare draws at its own Centre");
        }
        continue;
      }
      const xf::Vec2 local = xf::transform_point(xf::invert(world_matrix(n.id)), xf::Vec2{pr->x, pr->y});
      Json p = e.at("params");
      p.set("centerX", Json::number(local.x));
      p.set("centerY", Json::number(local.y));
      // The chain places the flare from the comp point itself: Centre X / Y are
      // an offset from the layer box's centre, not a layer-space point.
      p.set("__linkX", Json::number(pr->x));
      p.set("__linkY", Json::number(pr->y));
      p.set("__linkDepth", Json::number(pr->clipped ? -1.0 : pr->depth));
      e.set("params", std::move(p));
    }
  }
  // Camera program D1: Camera Lens Blur with Blur Map = Scene Depth focuses
  // where the active camera does (its Focus Distance, else its Zoom).
  if (three_) {
    for (Json& e : resolved) {
      if (!e.at("type").is_string() || e.at("type").str() != "camera-lens-blur" || !e.at("params").is_object()) continue;
      const auto focus = three_->view_focus();
      if (!focus) continue;
      Json p = e.at("params");
      p.set("__viewFocus", Json::number(*focus));
      e.set("params", std::move(p));
    }
  }
  // Program X batch 4: the 3D-aware deep effects see the frame's camera (or
  // AE's default one) and the comp's lights (deep_fx_scene.hpp).
  inject_deep_scene(resolved, three_ ? three_->camera() : std::optional<motion::xf::Camera>{}, three_ ? &three_->scene_lights() : nullptr, comp_.width,
                    comp_.height);
  inject_deep_fps(resolved, fps_, layerTime);
  return resolved;
}

RLayer Walk::precomp_container(const doc::Node& group, std::optional<NestedComp>* nested) {
  const Values& gv = values_of(group.id);
  const Base gb = read_base(group);
  RLayer l;
  l.id = group.id;
  l.kind = LayerKind::shape;
  // The container's layer time (as a layer's): its time-driven effects follow it too.
  l.effects = effects_of(group, gv, remap(group.id, t_, false), &l);
  // A comp INSTANCE has an intrinsic frame: the referenced comp's size, at the
  // instance's own world transform, cropped to it (comp_instance.cpp).
  const std::optional<std::string> ref = doc::read_comp_ref(group);
  const std::optional<std::pair<double, double>> refSize = ref ? comp_size_of(d_, *ref) : std::nullopt;
  const bool isInstance = refSize.has_value();
  const double groupTime = remap(group.id, t_, false);
  const Json authored = apply_mask_path_expressions(d_, c_.expr, c_.cache, sid(group.id),
                                                    apply_mask_property_tracks(read_node_mask_at(group, groupTime), gv), groupTime);
  l.mask = isInstance ? instance_frame_mask(authored, group.id, refSize->first, refSize->second) : authored;
  l.blend = read_node_blend(group);
  l.preserveTransparency = read_node_preserve_transparency(group);
  l.matte = read_matte_of(group);
  l.x = comp_.width / 2;
  l.y = comp_.height / 2;
  l.depth = 0;
  const auto groupOpacity = gv.get("opacity");
  l.opacity = groupOpacity ? *groupOpacity / 100 : gb.opacity;
  l.width = isInstance ? refSize->first : comp_.width;
  l.height = isInstance ? refSize->second : comp_.height;
  l.fill = "#000";
  l.visible = group.visible;
  l.precompLayers = std::vector<RLayer>{};  // filled by attach_precomps once the walk is done
  // precompSourceTime: its own retime (Speed % / Time Remap) through the clip map.
  l.sourceTime = retimed_source_at(group.id, t_);
  if (nested != nullptr && *nested) {
    l.precompLayers = std::move((*nested)->layers);  // attach_precomps leaves a sealed pass's layers alone
    l.precompScene3d = std::move((*nested)->scene3d);
  }
  if (isInstance) {
    const xf::Local2D gWorld = world_of(group.id);
    const auto [ax0, ay0] = read_node_anchor(group);
    l.anchorX = gv.get("anchorX").value_or(ax0);
    l.anchorY = gv.get("anchorY").value_or(ay0);
    l.x = gWorld.x;
    l.y = gWorld.y;
    l.rotation = gWorld.rotation;
    l.scaleX = gWorld.scale_x;
    l.scaleY = gWorld.scale_y;
    if (doc::is_3d_enabled(group)) {
      // A 3D comp CARD: the comp drawn flat onto its projected corners (threed_card.cpp).
      const Scene3D::CardPlan card = three_->comp_card(
          group, gv, gWorld, gb.x, gb.y, gb.rotation, gb.scaleX, gb.scaleY, refSize->first, refSize->second, l.anchorX,
          l.anchorY, [&](std::string_view p, double tt) { return anim_sample_of(group.id, p, tt); });
      if (!card.still) {  // behind the camera: not drawn, like any 3D layer
        l.visible = false;
        l.opacity = 0;
      } else {
        const Scene3D::Card& c = *card.still;
        const auto& m = c.matrix;
        l.x = c.x;
        l.y = c.y;
        l.rotation = motion::js::atan2(m[1], m[0]) / kDeg;
        l.scaleX = hypot2(m[0], m[1]);
        l.scaleY = hypot2(m[2], m[3]);
        l.depth = c.depth;
        l.matrix = m;
        l.quad3d = c.quad;
        if (card.lighting) l.lighting = *card.lighting;
        // Motion blur through its own perspective: one quad per shutter sample.
        std::map<std::pair<double, double>, std::optional<Scene3D::Card>> seen;
        const auto cardOf = [&](double ti, double tc) -> const std::optional<Scene3D::Card>& {
          const auto key = std::make_pair(ti, tc);
          auto it = seen.find(key);
          if (it == seen.end()) it = seen.emplace(key, card.at(ti, tc)).first;
          return it->second;
        };
        motion_samples(
            l, group, gb, group.id,
            [&](double ti, double tc) {
              const auto& k = cardOf(ti, tc);
              return Scene3D::MotionPose{k ? k->matrix : c.matrix, {}};  // a card: no world matrix (flat quad)
            },
            [&](double ti, double tc) -> std::optional<std::array<double, 8>> {
              const auto& k = cardOf(ti, tc);
              return k ? std::optional<std::array<double, 8>>(k->quad) : std::nullopt;
            });
        if (!std::ranges::all_of(l.motionSamples, [](const MotionSample& s) { return s.quad.has_value(); })) l.motionSamples.clear();
      }
    } else {
      // A comp LAYER's own motion blur: the walk's samples on its local pose,
      // carried onto the world pose (the parent chain held still).
      motion_samples(l, group, gb, group.id);
      if (!l.motionSamples.empty()) {
        LocalPose now;
        now.x = gv.get("x").value_or(gb.x);
        now.y = gv.get("y").value_or(gb.y);
        now.rotation = gv.get("rotation").value_or(gb.rotation);
        now.scaleX = gv.get("scale").value_or(gv.get("scaleX").value_or(gb.scaleX));
        now.scaleY = gv.get("scale").value_or(gv.get("scaleY").value_or(gb.scaleY));
        l.motionSamples = instance_world_samples(l.motionSamples, now, gWorld);
      }
    }
  }
  return l;
}

void Walk::attach_precomps(std::vector<RLayer>& list) {
  for (RLayer& l : list) {
    if (!l.precompLayers) continue;
    auto it = precompInner_.find(l.id);
    if (it != precompInner_.end()) {
      l.precompLayers = std::move(it->second);
      precompInner_.erase(it);
    }
    attach_precomps(*l.precompLayers);
  }
}

void Walk::motion_samples(RLayer& l, const doc::Node& n, const Base& base, const std::string& id,
                          const std::function<Scene3D::MotionPose(double, double)>& matrixAt,
                          const std::function<std::optional<std::array<double, 8>>(double, double)>& quadAt) {
  if (!mb_) return;
  // Force Motion Blur (forceMotionBlur.ts readForceMotionBlur) overrides the two opt-ins.
  std::optional<MotionBlurCfg> forced;
  for (const Json& e : l.effects) {
    if (!(e.at("type").is_string() && e.at("type").str() == "force-motion-blur")) continue;
    if (e.at("enabled").is_bool() && !e.at("enabled").b()) continue;
    const Json p = doc::params_of(e);
    const double angle = std::max(0.0, std::min(720.0, p.at("shutterAngle").num()));
    if (angle <= 0) break;
    MotionBlurCfg f = *mb_;
    f.enabled = true;
    f.shutterAngle = angle;
    f.samples = std::max(2.0, std::min(32.0, motion::js::round(p.at("samples").num())));
    f.shutterPhase = std::max(-360.0, std::min(360.0, p.at("shutterPhase").num()));
    forced = f;
    break;
  }
  const MotionBlurCfg& cfg = forced ? *forced : *mb_;
  const bool optIn = forced.has_value() || (mb_->enabled && read_node_motion_blur(n));
  if (!optIn) return;
  static constexpr std::array<std::string_view, 12> kMoves = {
      "x", "y", "rotation", "scale", "scaleX", "scaleY", "z", "rotationX", "rotationY",
      "orientationX", "orientationY", "orientationZ"};
  const bool moves = std::ranges::any_of(
      kMoves, [&](std::string_view p) { return !wn_->is_overridden(id, p) && doc::anim_is_animated(d_, sid(id), p); });
  // A 3D layer also moves on screen when the camera does.
  if (!moves && !(matrixAt && three_ && three_->camera_animated())) return;
  const auto sample = [&](std::string_view prop, double tt) { return anim_sample_of(id, prop, tt); };
  const double limit = cfg.adaptiveSampleLimit;
  const std::vector<double> probe = motion_blur_sample_times(t_, cfg.fps, cfg.shutterAngle, 2, cfg.shutterPhase, limit);
  double travel = 0;
  if (probe.size() >= 2 && matrixAt) {
    // 3D: PROJECTED travel at the box corners (motionBlur.ts affineTravelPx).
    const double ta = probe.front();
    const double tb = probe.back();
    const std::array<double, 6> ma = matrixAt(remap(id, ta, true), ta).matrix;
    const std::array<double, 6> mb = matrixAt(remap(id, tb, true), tb).matrix;
    const double hw = std::max(0.0, base.width.value_or(0)) / 2;
    const double hh = std::max(0.0, base.height.value_or(0)) / 2;
    const std::array<std::array<double, 2>, 5> corners = {{{0, 0}, {-hw, -hh}, {hw, -hh}, {hw, hh}, {-hw, hh}}};
    for (const auto& [x, y] : corners) {
      const double ax = ma[0] * x + ma[2] * y + ma[4];
      const double ay = ma[1] * x + ma[3] * y + ma[5];
      const double bx = mb[0] * x + mb[2] * y + mb[4];
      const double by = mb[1] * x + mb[3] * y + mb[5];
      const double dd = hypot2(bx - ax, by - ay);
      if (std::isfinite(dd) && dd > travel) travel = dd;
    }
  } else if (probe.size() >= 2) {
    const double ta = remap(id, probe.front(), true);
    const double tb = remap(id, probe.back(), true);
    struct P {
      double x, y, r, sx, sy;
    };
    const auto at = [&](double tt) {
      const auto sc = sample("scale", tt);
      P p{};
      p.x = sample("x", tt).value_or(base.x);
      p.y = sample("y", tt).value_or(base.y);
      p.r = sample("rotation", tt).value_or(base.rotation);
      p.sx = sc ? *sc : sample("scaleX", tt).value_or(base.scaleX);
      p.sy = sc ? *sc : sample("scaleY", tt).value_or(base.scaleY);
      return p;
    };
    const P a = at(ta);
    const P b = at(tb);
    const double hd = std::max(0.0, hypot2(base.width.value_or(0), base.height.value_or(0)) / 2);
    const double anchor = hypot2(b.x - a.x, b.y - a.y);
    const double rot = std::abs(b.r - a.r) * (std::numbers::pi / 180) * hd;
    const double scale = std::max(std::abs(b.sx - a.sx), std::abs(b.sy - a.sy)) * hd;
    travel = anchor + rot + scale;
  }
  const double samples = adaptive_samples(cfg.samples, travel, limit);
  const std::vector<double> times = motion_blur_sample_times(t_, cfg.fps, cfg.shutterAngle, samples, cfg.shutterPhase, limit);
  std::vector<MotionSample> out;
  out.reserve(times.size());
  for (const double tc : times) {
    const double ti = remap(id, tc, true);
    const auto sc = sample("scale", ti);
    const auto op = sample("opacity", ti);
    MotionSample s;
    s.x = sample("x", ti).value_or(base.x);
    s.y = sample("y", ti).value_or(base.y);
    s.rotation = sample("rotation", ti).value_or(base.rotation);
    s.scaleX = sc ? *sc : sample("scaleX", ti).value_or(base.scaleX);
    s.scaleY = sc ? *sc : sample("scaleY", ti).value_or(base.scaleY);
    s.opacity = op ? *op / 100 : base.opacity;
    if (matrixAt) {
      const Scene3D::MotionPose pose = matrixAt(ti, tc);
      s.matrix = pose.matrix;
      if (pose.world[15] != 0) s.world3d = pose.world;  // all zeros = no world matrix
    }
    if (quadAt) s.quad = quadAt(ti, tc);
    out.push_back(s);
  }
  if (out.size() > 1) l.motionSamples = std::move(out);
}

void Walk::mask_motion_samples(Json& mask, const doc::Node& n) {
  if (!mb_ || !mb_->enabled || mask.is_undefined() || !mask.at("paths").is_array()) return;
  // Only an outline keyed to change shape moves within the shutter; a layer's
  // own travel is its transform's motion blur.
  if (doc::read_node_mask_anim(n).size() < 2) return;
  const bool layerOn = read_node_motion_blur(n);
  const auto wants = [&](const Json& p) {
    const Json& m = p.at("motionBlur");
    const std::string_view s = m.is_string() ? std::string_view(m.str()) : std::string_view("sameAsLayer");
    return s == "on" || (s != "off" && layerOn);
  };
  if (!std::ranges::any_of(mask.at("paths").arr(), wants)) return;
  const MotionBlurCfg& cfg = *mb_;
  const double limit = cfg.adaptiveSampleLimit;
  const auto pathsAt = [&](double tc) {
    const double lt = remap(n.id, tc, true);
    return apply_mask_path_expressions(d_, c_.expr, c_.cache, sid(n.id), read_node_mask_at(n, lt), lt);
  };
  const auto findPath = [](const Json& m, const Json& id) -> const Json* {
    if (m.is_undefined() || !m.at("paths").is_array() || !id.is_string()) return nullptr;
    for (const Json& q : m.at("paths").arr()) {
      if (q.at("id").is_string() && q.at("id").str() == id.str()) return &q;
    }
    return nullptr;
  };
  // Samples from the outline's travel across the shutter, as the transform's are.
  const std::vector<double> probe = motion_blur_sample_times(t_, cfg.fps, cfg.shutterAngle, 2, cfg.shutterPhase, limit);
  if (probe.size() < 2) return;
  const Json a = pathsAt(probe.front());
  const Json b = pathsAt(probe.back());
  double travel = 0;
  for (const Json& p : mask.at("paths").arr()) {
    const Json* pa = findPath(a, p.at("id"));
    const Json* pb = findPath(b, p.at("id"));
    if (pa == nullptr || pb == nullptr || !wants(p)) continue;
    const auto& va = pa->at("points").arr();
    const auto& vb = pb->at("points").arr();
    for (std::size_t i = 0; i < std::min(va.size(), vb.size()); ++i) {
      const double d = hypot2(vb[i].at("x").num() - va[i].at("x").num(), vb[i].at("y").num() - va[i].at("y").num());
      if (std::isfinite(d)) travel = std::max(travel, d);
    }
  }
  if (!(travel > 0.25)) return;  // the outline holds still across this frame's shutter
  const double samples = std::min(64.0, adaptive_samples(cfg.samples, travel, limit));
  const std::vector<double> times = motion_blur_sample_times(t_, cfg.fps, cfg.shutterAngle, samples, cfg.shutterPhase, limit);
  if (times.size() < 2) return;
  std::vector<Json> shapes;
  shapes.reserve(times.size());
  for (const double tc : times) shapes.push_back(pathsAt(tc));
  Json paths = Json::array();
  for (const Json& p : mask.at("paths").arr()) {
    Json q = p;
    if (wants(p)) {
      Json per = Json::array();
      for (const Json& s : shapes) {
        const Json* at = findPath(s, p.at("id"));
        per.arr_mut().push_back(at != nullptr ? at->at("points") : p.at("points"));
      }
      q.set("motionSamples", std::move(per));
    }
    paths.arr_mut().push_back(std::move(q));
  }
  mask.set("paths", std::move(paths));
}

/// Character-panel extras and the text paint fields (buildSnapshot's `kind === 'text'` block).
void Walk::text_fields(RLayer& l, const doc::Node& n, const Base& base, const Values& a) {
  l.textTransform = base.textTransform;
  l.fontVariant = base.fontVariant;
  l.verticalAlign = base.verticalAlign;
  l.verticalScale = a.get("verticalScale") ? a.get("verticalScale") : base.verticalScale;
  l.horizontalScale = a.get("horizontalScale") ? a.get("horizontalScale") : base.horizontalScale;
  l.baselineShift = a.get("baselineShift") ? a.get("baselineShift") : base.baselineShift;
  l.textStroke = base.textStroke;
  l.textStrokeWidth = a.get("strokeWidth") ? a.get("strokeWidth") : base.textStrokeWidth;
  Json out = point_text_extras(n);  // text_port.cpp
  with_text_more_options(out, n, a);  // textMoreOptions + OpenType switches (text_port.cpp)
  if (!out.obj().empty()) l.textExtras = std::move(out);
  if (doc::read_text_path_config(n)) l.textPath = resolve_layer_text_path(n, a);  // text_port.cpp
  l.textStrokePaint = text_stroke_paint(n, a);                                     // text_port.cpp
  // Variable font axes (fontAxes.ts resolveFontAxes): the stored registered tags,
  // a keyed `text.axis.<tag>` value winning. The painter sets them as
  // font-variation-settings over the weight / width / slant (text_paint.cpp);
  // the measurer measures with the same variations (text_measure.cpp).
  Json axes = doc::read_font_axes_prop(n);
  for (const auto& [k, v] : a.items()) {
    if (!std::isfinite(v)) continue;
    if (const auto tag = doc::parse_axis_prop_path(k); tag && *tag != "wght" && *tag != "wdth" && *tag != "slnt") {
      if (!axes.is_object()) axes = Json::object();
      axes.set(*tag, Json::number(v));
    }
  }
  if (axes.is_object() && !axes.obj().empty()) l.fontAxes = std::move(axes);
}

/// applySourceTextExpressionResult: layer-wide style overrides and the
/// expression's text. Stored runs are shifted across a string rewrite
/// (runOffsets.ts diffEdit + shiftRunsForEdits) so a style stays on the same
/// letters. Ranges the expression sets become the run list on the result.
void apply_source_text(RLayer& l, const motion::expr::SourceTextResult& result) {
  namespace ex = motion::expr;
  const auto& o = result.style;
  ex::SourceTextStyle base;
  base.font_family = ex::utf8_to_utf16(l.fontFamily.value_or("Inter"));
  base.font_size = l.fontSize;
  base.font_weight = ex::utf8_to_utf16(l.fontWeight.value_or("600"));
  base.font_style = ex::utf8_to_utf16(l.fontStyle.value_or("normal"));
  base.fill = ex::utf8_to_utf16(l.fill.value_or("#ffffff"));
  if (l.textStroke) base.stroke = ex::utf8_to_utf16(*l.textStroke);
  base.stroke_width = l.textStrokeWidth.value_or(0);
  base.letter_spacing = l.letterSpacing.value_or(0);
  base.line_height = l.lineHeight.value_or(1.2);
  base.baseline_shift = l.baselineShift.value_or(0);
  base.horizontal_scale = l.horizontalScale.value_or(100);
  base.vertical_scale = l.verticalScale.value_or(100);
  base.text_transform = ex::utf8_to_utf16(l.textTransform.value_or("none"));
  base.font_variant = ex::utf8_to_utf16(l.fontVariant.value_or("normal"));
  base.align = ex::utf8_to_utf16(l.align.value_or("left"));
  base.paragraph_spacing = l.paragraphSpacing.value_or(0);
  const ex::SourceTextStyle eff = ex::detail::resolve_style(base, o);
  const auto u8 = [](const std::u16string& s) { return ex::utf16_to_utf8(s); };
  if (o.font_family) l.fontFamily = u8(eff.font_family);
  if (o.font_size) l.fontSize = eff.font_size;
  if (o.font_weight) l.fontWeight = u8(eff.font_weight);
  if (o.font_style) l.fontStyle = u8(eff.font_style);
  if (o.fill || o.apply_fill) l.fill = u8(eff.fill);
  if (o.stroke && eff.stroke) l.textStroke = u8(*eff.stroke);
  if (o.stroke_width || o.apply_stroke) l.textStrokeWidth = eff.stroke_width;
  if (o.tracking) l.letterSpacing = eff.letter_spacing;
  if (o.leading) l.lineHeight = eff.line_height;
  if (o.baseline_shift) l.baselineShift = eff.baseline_shift;
  if (o.horizontal_scale) l.horizontalScale = eff.horizontal_scale;
  if (o.vertical_scale) l.verticalScale = eff.vertical_scale;
  if (o.text_transform) l.textTransform = u8(eff.text_transform);
  if (o.font_variant) l.fontVariant = u8(eff.font_variant);
  if (o.align) l.align = u8(eff.align);
  if (o.space_after || o.space_before) l.paragraphSpacing = eff.paragraph_spacing;
  if (o.direction) {
    Json extras = l.textExtras.is_object() ? l.textExtras : Json::object();
    if (*o.direction == u"rtl") extras.set("direction", Json::string("rtl"));
    else extras.erase("direction");
    l.textExtras = extras.obj().empty() ? Json() : std::move(extras);
  }
  const std::string before = l.text.value_or("");
  const std::string after = u8(result.text);
  if (before != after && l.runs.is_array() && !l.runs.arr().empty()) {
    // runOffsets.ts diffEdit + shiftRunsForEdits, one prefix/suffix edit.
    const std::vector<std::string> ga = raster::split_graphemes(before);
    const std::vector<std::string> gb = raster::split_graphemes(after);
    int pre = 0;
    while (std::cmp_less(pre, ga.size()) && std::cmp_less(pre, gb.size()) && ga[static_cast<std::size_t>(pre)] == gb[static_cast<std::size_t>(pre)]) ++pre;
    int suf = 0;
    while (suf < static_cast<int>(ga.size()) - pre && suf < static_cast<int>(gb.size()) - pre &&
           ga[ga.size() - 1 - static_cast<std::size_t>(suf)] == gb[gb.size() - 1 - static_cast<std::size_t>(suf)]) {
      ++suf;
    }
    const int eStart = pre;
    const int eEnd = static_cast<int>(ga.size()) - suf;
    const int insert = static_cast<int>(gb.size()) - pre - suf;
    const int nlen = static_cast<int>(gb.size());
    const auto map_boundary = [&](int i, bool isEnd) {
      if (i <= eStart) return i;
      const int delta = insert - (eEnd - eStart);
      if (i >= eEnd) return i + delta;
      return eStart + (isEnd ? insert : 0);
    };
    Json shifted = Json::array();
    for (const Json& r : l.runs.arr()) {
      if (!r.at("start").is_number() || !r.at("end").is_number()) continue;
      const int start = std::clamp(map_boundary(static_cast<int>(r.at("start").num()), false), 0, nlen);
      const int end = std::clamp(map_boundary(static_cast<int>(r.at("end").num()), true), 0, nlen);
      if (end <= start) continue;
      Json q = r;
      q.set("start", Json::number(static_cast<double>(start)));
      q.set("end", Json::number(static_cast<double>(end)));
      shifted.arr_mut().push_back(std::move(q));
    }
    l.runs = shifted.arr().empty() ? Json() : std::move(shifted);
  }
  if (!result.ranges.empty()) {
    const std::vector<std::string> gs = raster::split_graphemes(after);
    const auto n = static_cast<std::ptrdiff_t>(gs.size());
    Json runs = Json::array();
    if (n > 0) {
      struct Slot {
        bool on = false;
        double fontSize = 0;
        bool hasSize = false;
        std::string family, weight, style, fill;
        bool hasFamily = false, hasWeight = false, hasStyle = false, hasFill = false;
        double tracking = 0;
        bool hasTracking = false;
      };
      std::vector<Slot> per(static_cast<std::size_t>(n));
      for (const ex::SourceTextRangeOverride& range : result.ranges) {
        const auto from = static_cast<std::ptrdiff_t>(std::max(0.0, range.start));
        const auto to = static_cast<std::ptrdiff_t>(std::min(static_cast<double>(n), range.start + range.count));
        for (std::ptrdiff_t i = from; i < to; ++i) {
          Slot& s = per[static_cast<std::size_t>(i)];
          s.on = true;
          const auto& st = range.style;
          if (st.font_size) { s.fontSize = *st.font_size; s.hasSize = true; }
          if (st.font_family) { s.family = u8(*st.font_family); s.hasFamily = true; }
          if (st.font_weight) { s.weight = u8(*st.font_weight); s.hasWeight = true; }
          if (st.font_style) { s.style = u8(*st.font_style); s.hasStyle = true; }
          if (st.fill) { s.fill = u8(*st.fill); s.hasFill = true; }
          if (st.apply_fill && !*st.apply_fill) { s.fill = "transparent"; s.hasFill = true; }
          if (st.tracking) { s.tracking = *st.tracking; s.hasTracking = true; }
        }
      }
      std::ptrdiff_t i = 0;
      while (i < n) {
        const Slot& s = per[static_cast<std::size_t>(i)];
        if (!s.on) { ++i; continue; }
        std::ptrdiff_t j = i + 1;
        while (j < n) {
          const Slot& b = per[static_cast<std::size_t>(j)];
          if (b.on != s.on || b.hasSize != s.hasSize || b.fontSize != s.fontSize || b.family != s.family || b.weight != s.weight ||
              b.style != s.style || b.fill != s.fill || b.hasTracking != s.hasTracking || b.tracking != s.tracking) {
            break;
          }
          ++j;
        }
        Json style = Json::object();
        if (s.hasSize) style.set("fontSize", Json::number(s.fontSize));
        if (s.hasFamily) style.set("fontFamily", Json::string(s.family));
        if (s.hasWeight) style.set("fontWeight", Json::string(s.weight));
        if (s.hasStyle) style.set("fontStyle", Json::string(s.style));
        if (s.hasFill) style.set("fill", Json::string(s.fill));
        // Tracking stays in 1/1000 em on the run: the painter and the measurer
        // resolve it at the run's size (the layer's when the run sets none).
        if (s.hasTracking) style.set("tracking", Json::number(s.tracking));
        Json run = Json::object();
        run.set("start", Json::number(static_cast<double>(i)));
        run.set("end", Json::number(static_cast<double>(j)));
        run.set("style", std::move(style));
        runs.arr_mut().push_back(std::move(run));
        i = j;
      }
    }
    l.runs = runs.arr().empty() ? Json() : std::move(runs);
  }
  l.text = after;
}

namespace {

/// Subjects Pro view modes (setViewport subjectView): viewer-only effects after the layer's own
/// that show one subject (or all of them) through the subject matte the effects already read
/// (Apply To = subjectScope, compositing/subjectId) — so the live edge shows exactly as it renders.
void add_subject_view_effects(RLayer& l, const api::SubjectView& sv, const Json& entries) {
  const std::string sid = sv.subject.value_or(std::string());
  std::string colour = sv.color.value_or(std::string());
  if (colour.empty() && !sid.empty()) {
    const Json& e = doc::subject_entry(entries, sid);
    if (e.at("color").is_string() && e.at("color").str().size() == 7) colour = e.at("color").str();
  }
  if (colour.empty()) colour = "#ff3fd4";
  const auto add = [&](std::string_view type, std::string_view scope, Json params, double opacity = 100) {
    Json fx = Json::object();
    fx.set("id", Json::string("subject-view:" + std::string(type) + ":" + std::string(scope)));
    fx.set("type", Json::string(std::string(type)));
    fx.set("enabled", Json::boolean(true));
    fx.set("params", std::move(params));
    // Effect Opacity (the effect blended back over its input): the overlay's see-through tint.
    if (opacity < 100) fx.set("opacity", Json::number(opacity));
    if (!scope.empty()) fx.set("subjectScope", Json::string(std::string(scope)));
    if (!sid.empty()) fx.set("subjectId", Json::string(sid));
    l.effects.push_back(std::move(fx));
  };
  const auto fill = [](std::string_view hex, double opacity) {
    Json p = Json::object();
    p.set("color", Json::string(std::string(hex)));
    p.set("opacity", Json::number(opacity));
    return p;
  };
  if (sv.mode == "overlay") {
    add("fill", "subject", fill(colour, 100), 45);
  } else if (sv.mode == "black") {
    add("fill", "background", fill("#000000", 100));
  } else if (sv.mode == "white") {
    add("fill", "background", fill("#ffffff", 100));
  } else if (sv.mode == "alpha") {
    add("fill", "subject", fill("#ffffff", 100));
    add("fill", "background", fill("#000000", 100));
  } else if (sv.mode == "boundary") {
    Json p = Json::object();
    p.set("width", Json::number(std::max(2.0, std::max(l.width, l.height) / 640.0)));
    p.set("softness", Json::number(0));
    p.set("position", Json::number(1));  // centred on the edge
    p.set("color", Json::string(colour));
    p.set("opacity", Json::number(100));
    p.set("composite", Json::number(0));
    p.set("glowAmount", Json::number(0));
    p.set("glowRadius", Json::number(0));
    add("matte-stroke", "", std::move(p));
  }
}

}  // namespace

void Walk::build_node(const doc::Node& n) {  const std::string kind = n.kind();
  if (kind == "comp") {
    // A SEALED instance renders the referenced comp through its own recursive
    // pass; a COLLAPSED one was expanded into this walk and draws nothing itself.
    const auto ref = doc::read_comp_ref(n);
    if (ref && !collapsed(n)) {
      if (!fullBuild_.contains(n.id)) {
        emit_stub(n);
      } else {
        std::optional<NestedComp> nested = nested_comp_layers(c_, comp_, fps_, n, *ref, retimed_source_at(n.id, t_), mb_);
        if (nested) {
          for (LayerError& e : nested->errors) errors_.push_back(std::move(e));
        }
        RLayer c = precomp_container(n, &nested);
        // Collapsed layers re-rasterise through the container whatever the comp says (AE).
        c.preserveResolution = nested && nested->preserveResolution && !c.continuousRaster;
        emit_time_taps(n, c);
        emit(std::move(c), n);
      }
    }
    return;
  }
  if (kind == "group" || kind == "null" || kind == "camera" || kind == "audio") return;
  const Json& fx = fx_props(n);
  if (fx.at("booleanOperand").is_bool() && fx.at("booleanOperand").b()) return;  // live-boolean operand
  if (!is_live_at(n.id)) return;
  if (kind == "light" && comp_.draft3d) return;  // Draft 3D: lights draw nothing
  if (!fullBuild_.contains(n.id)) {
    emit_stub(n);
    return;
  }
  if (kind == "light") {  // the glow wash (threed_port.cpp); lighting is the 3D block's
    if (auto wash = three_->light_layer(n)) emit(std::move(*wash), n);
    return;
  }
  if (kind == "particle") {  // a self-drawing emitter layer (particle_port.cpp)
    const Json staticCfg = read_node_particle(n);
    if (staticCfg.is_undefined()) return;
    const Values& pv = values_of(n.id);
    const xf::Local2D w = world_of(n.id);
    // readGeometry's box: an authored width AND height (the evaluated values
    // winning), else 2·radius, else the particle kind's 140×140.
    std::optional<double> gw, gh, radius;
    for (const auto& comp : n.components) {
      const Json& p = comp.props;
      if (p.at("width").is_number()) gw = p.at("width").num();
      if (p.at("height").is_number()) gh = p.at("height").num();
      if (p.at("radius").is_number()) radius = p.at("radius").num();
      else if (p.at("outerRadius").is_number()) radius = p.at("outerRadius").num();
      else if (p.at("r").is_number()) radius = p.at("r").num();
    }
    if (const auto v = pv.get("width")) gw = v;
    if (const auto v = pv.get("height")) gh = v;
    const bool authored = gw && gh && *gw > 0 && *gh > 0;
    const double boxW = authored ? *gw : radius && *radius > 0 ? *radius * 2 : 140;
    const double boxH = authored ? *gh : radius && *radius > 0 ? *radius * 2 : 140;
    Json synced = staticCfg;
    synced.set("emitterWidth", Json::number(boxW));
    synced.set("emitterHeight", Json::number(boxH));
    Json cfg = resolve_particle_config(synced, pv);
    // The comp shutter (velocity streaks) when this layer's motion-blur switch is on.
    const bool blurOn = mb_ && mb_->enabled && read_node_motion_blur(n);
    cfg.set("shutterSec", Json::number(blurOn ? (std::max(0.0, std::min(720.0, mb_->shutterAngle)) / 360) / std::max(1.0, mb_->fps) : 0));
    if (cfg.at("spriteAssetId").is_string() && !cfg.at("spriteAssetId").str().empty()) {
      if (const Json* asset = doc::find_asset(d_, cfg.at("spriteAssetId").str()); asset != nullptr && asset->at("src").is_string()) {
        cfg.set("spriteSrc", Json::string(doc::asset_media_src(*asset)));
      }
    }
    // A 3D emitter with no lens of its own takes the scene camera's focal length.
    if (doc::is_3d_enabled(n) && three_->camera() && !(cfg.at("perspective").is_number() && cfg.at("perspective").num() > 0)) {
      cfg.set("perspective", Json::number(three_->camera()->focal_length));
    }
    RLayer l;
    l.id = n.id;
    l.kind = LayerKind::shape;
    l.x = w.x;
    l.y = w.y;
    l.rotation = w.rotation;
    l.scaleX = w.scale_x;
    l.scaleY = w.scale_y;
    l.depth = 0;
    l.opacity = pv.has("opacity") ? *pv.get("opacity") / 100 : 1;
    l.width = boxW;
    l.height = boxH;
    l.fill = "#000";
    l.visible = n.visible;
    l.blend = read_node_blend(n);
    l.preserveTransparency = read_node_preserve_transparency(n);
    l.particles = std::move(cfg);
    emit(std::move(l), n);
    return;
  }
  if (kind.find('.') != std::string::npos) {
    // A plugin GENERATOR layer of the retired JS / WGSL tiers (G2): there is no
    // host for it in the C++ engine. The layer draws nothing; the frame is told.
    RLayer l;
    l.id = n.id;
    warning(l, n, "plugin generator / shader layer '" + kind + "' (a retired JS / WGSL plugin layer) — drawn empty");
    emit_stub(n);
    return;
  }

  const Base base = read_base(n);
  const Values& a = values_of(n.id);
  const xf::Local2D world = world_of(n.id);
  const LayerKind layerKind = kind == "svg" ? LayerKind::image
                              : kind == "text" ? LayerKind::text
                              : kind == "image" ? LayerKind::image
                              : kind == "video" ? LayerKind::video
                                                : LayerKind::shape;
  const auto [sizeW, sizeH] = kind_size(layerKind);
  RLayer l;
  l.id = n.id;
  l.kind = layerKind;
  const double layerTimeNow = remap(n.id, t_, false);
  // A cloner clone's opacity MULTIPLIES the resolved one (cloner_port.cpp).
  const auto cloneOff = wn_->cloneOffsets.find(n.id);
  const CloneOffset* clone = cloneOff != wn_->cloneOffsets.end() ? &cloneOff->second : nullptr;
  // Focus Mode: a layer outside the working set is a dim reference (buildSnapshot GHOST_OPACITY).
  constexpr double kGhostOpacity = 0.12;
  const bool ghost = !c_.focusLayers.empty() && !layer_view_of(n) &&
                     std::ranges::find(c_.focusLayers, n.id) == c_.focusLayers.end();
  const double baseOpacity = (a.has("opacity") ? *a.get("opacity") / 100 : base.opacity) *
                             (clone != nullptr ? clone->opacity / 100 : 1) * (ghost ? kGhostOpacity : 1);
  l.effects = effects_of(n, a, layerTimeNow, &l);
  if (c_.subjectView && c_.subjectView->layer == n.id) add_subject_view_effects(l, *c_.subjectView, n.fx().at("subjects"));
  const bool isSolid = fx.at("solid").is_bool() && fx.at("solid").b();
  const doc::Component* geom = n.comp("Geometry");
  const Json staticPath = geom != nullptr ? geom->props.at("points") : Json();
  const Json liveOutline = live_path_points(d_, sid(n.id), layerTimeNow);
  Json staticSubpaths = liveOutline.is_undefined() && geom != nullptr ? geom->props.at("subpaths") : Json();
  Json pathPoints = !liveOutline.is_undefined() ? liveOutline
                    : !staticPath.is_undefined() && !staticPath.is_null() ? staticPath
                    : staticSubpaths.is_array() && !staticSubpaths.arr().empty() ? staticSubpaths.arr()[0].at("points")
                                                                                : Json();
  // POINTS FOLLOW NULLS: bound vertices track their null's world position (raw_world.cpp).
  if (geom != nullptr && geom->props.at("pointBindings").is_array() && !geom->props.at("pointBindings").arr().empty()) {
    if (Json moved = bind_path_points(raw_, n.id, pathPoints, geom->props.at("pointBindings")); !moved.is_undefined()) {
      pathPoints = std::move(moved);
    }
  }
  bool pathOpen = geom != nullptr && geom->props.at("open").is_bool() && geom->props.at("open").b();
  // The shape Path's expression (AE path properties): what it returns is the outline drawn.
  if (pathPoints.is_array() && !pathPoints.arr().empty()) {
    const motion::expr::PathSample authoredPath = doc::path_sample_of_points(pathPoints, !pathOpen);
    if (const auto out = doc::anim_evaluate_path(d_, c_.expr, c_.cache, sid(n.id), doc::kShapePathTrack, authoredPath, layerTimeNow)) {
      pathPoints = doc::points_of_path_sample(*out, &pathPoints);
      pathOpen = !out->closed;
    }
  }
  const std::optional<std::string> shapeType = jstr(doc::transform_props(n).at("shapeType"));

  // Size: measured text, the authored box, or the kind's default.
  std::optional<std::pair<double, double>> measured;
  std::optional<MeasuredStyle> textStyle;  // kept for the alignment anchor below
  if (layerKind == LayerKind::text) {
    textStyle = read_measured_text_style(n, a.items());
    const std::optional<MeasuredStyle>& style = textStyle;
    if (style) {
      // No measurer (a headless build) or a style the measurer refuses: the box
      // falls back to the authored / default size and the text still paints into it.
      if (c_.measurer == nullptr) warning(l, n, "text measurement (no fonts) — the text box keeps its authored size");
      else measured = c_.measurer->measure_text_size(*style);
      if (!measured && c_.measurer != nullptr) warning(l, n, "text measurement of this style — the text box keeps its authored size");
      note_missing_font(l, n, style->fontFamily);
    }
  }
  const std::optional<double> rawW = a.has("width") ? a.get("width") : base.width;
  const std::optional<double> rawH = a.has("height") ? a.get("height") : base.height;
  const bool solidUnseeded = isSolid && (!rawW || !rawH || (*rawW == 100 && *rawH == 100));
  double layerW = isSolid ? (solidUnseeded || !rawW ? comp_.width : *rawW)
                          : (measured ? measured->first : rawW.value_or(sizeW));
  double layerH = isSolid ? (solidUnseeded || !rawH ? comp_.height : *rawH)
                          : (measured ? measured->second : rawH.value_or(sizeH));

  // Parametric polystar (path_ops.cpp): the outline replaces the stored path.
  if (layerKind == LayerKind::shape && apply_polystar(n, a, pathPoints, layerW, layerH) == GeometryStatus::applied) {
    staticSubpaths = Json();
  }
  if (const Json& wave = fx.at("audioWaveform"); wave.is_object()) {
    const std::string source = wave.at("sourceLayerId").is_string() ? wave.at("sourceLayerId").str() : std::string();
    std::vector<float> peaks;
    double duration = 0;
    const auto emptyPath = [] {  // EMPTY_WAVEFORM_PATH
      Json z = Json::object();
      for (const char* k : {"x", "y", "inX", "inY", "outX", "outY"}) z.set(k, Json::number(0));
      Json pts = Json::array();
      pts.arr_mut().push_back(z);
      pts.arr_mut().push_back(z);
      return pts;
    };
    if (c_.waveform == nullptr) {
      // A headless build without an audio engine: the generator draws its empty path.
      warning(l, n, "audio waveform generator (no audio engine) — drawn flat");
      pathPoints = emptyPath();
    } else if (source.empty() || !c_.waveform(source, peaks, duration)) {
      // resolveAudioWaveformPoints: no source, or a source still decoding (getWave
      // undefined), draws the empty path; the next frame after the conform draws it.
      pathPoints = emptyPath();
    } else {
      const double samples = wave.at("samples").is_number() ? wave.at("samples").num() : 128;
      const double heightScale = wave.at("heightScale").is_number() ? wave.at("heightScale").num() : 1;
      const double thickness = wave.at("thickness").is_number() ? wave.at("thickness").num() : 2;
      const double windowSec = wave.at("windowSec").is_number() ? wave.at("windowSec").num() : 1;
      const std::string mode = wave.at("mode").is_string() ? wave.at("mode").str() : "full";
      double local = t_;
      if (const doc::Node* src = d_.node(source)) {
        const auto bars = doc::tl_bars_for_node(d_, c_.view, source);
        double fps = doc::tl_fps_for_node(d_, c_.view, source);
        if (!(fps > 0)) fps = 30;
        bool hit = false;
        for (const doc::Bar* b : bars) {
          const double start = b->clip.start / fps;
          const double inSec = b->clip.sourceIn / fps;
          const double span = b->clip.duration / fps;
          if (t_ >= start && t_ < start + span) {
            local = inSec + (t_ - start);
            hit = true;
            break;
          }
        }
        if (!hit && !bars.empty()) local = bars[0]->clip.sourceIn / fps + (t_ - bars[0]->clip.start / fps);
        else if (!hit) {
          const Json& st = src->comp("Audio") != nullptr ? src->comp("Audio")->props.at("__start") : Json();
          if (st.is_number()) local = t_ - st.num();
        }
      }
      Json pts = waveform_points(peaks, duration, layerW, layerH, local, mode, samples, heightScale, thickness, windowSec);
      if (pts.arr().size() < 2) pts = emptyPath();
      pathPoints = std::move(pts);
    }
  }
  // Live Merge Paths (merge_paths.cpp): the boolean re-evaluated from the operands'
  // world outlines each frame, recentred onto this layer (the pose lands after 3D).
  std::optional<LiveBooleanResult> liveBoolean;
  if (has_live_boolean(n)) {
    OperandReader reader;
    reader.node = [this](const std::string& id) { return d_.node(id); };
    reader.world = [this](const std::string& id) { return world_of(id); };
    reader.values = [this](const std::string& id) -> const Values& { return values_of(id); };
    reader.pathPoints = [this](const std::string& id) -> Json {
      const doc::DataTrack* tr = doc::anim_data_track(d_, sid(id), "path.points");
      if (tr == nullptr) return {};
      const auto v = doc::sample_data_track(*tr, remap(id, t_, false));
      if (!v || !v->is_array() || v->arr().size() < 3 || !v->arr()[0].is_object() || !v->arr()[0].has("x")) return {};
      return live_path_points(d_, sid(id), remap(id, t_, false));
    };
    liveBoolean = evaluate_live_boolean(n, reader);
    if (liveBoolean) {
      pathPoints = liveBoolean->points;
      if (liveBoolean->subpaths.is_array() && liveBoolean->subpaths.arr().size() > 1) {
        staticSubpaths = liveBoolean->subpaths;
        pathPoints = liveBoolean->subpaths.arr()[0].at("points");
      }
    }
  }
  // 3D (threed_port.cpp): placement below; the mesh-carrying kinds are not ported yet.
  const bool is3d = doc::is_3d_enabled(n);
  Layer3D s3;
  s3.mat = three_->material_of(n, a);
  if (is3d) {
    for (const std::string& what : three_->unported_features(n, a)) unported(l, n, what);
  }
  // Auto-orient along the path applies to 2D layers only (below); Toward Camera is part of the 3D placement.
  const bool autoOrientPath = !is3d && ((fx.at("autoOrient").is_string() && fx.at("autoOrient").str() == "path") ||
                                        (fx.at("autoOrient").is_bool() && fx.at("autoOrient").b()));
  double px = world.x;
  double py = world.y;
  double sx = world.scale_x;
  double sy = world.scale_y;
  double rot = world.rotation;
  // Physics REPLACES the position (a dynamic body's position IS the solver's
  // output); the rotation only for a body that spins. Static bodies are absent.
  if (const auto sim = physics_.find(n.id); sim != physics_.end()) {
    px = sim->second.x;
    py = sim->second.y;
    if (sim->second.rotation) rot = *sim->second.rotation;
  }
  if (clone != nullptr) {  // the cloner offset, on the RESOLVED transform
    px += clone->x;
    py += clone->y;
    rot += clone->rotation;
    sx *= clone->scaleX;
    sy *= clone->scaleY;
  }
  // Auto-orient (motionPath.ts autoOrientAngleDeg): a moving layer faces its
  // direction of travel, the velocity over 1/120 s at its own time.
  if (autoOrientPath) {
    double bx = 0;
    double by = 0;
    for (const auto& comp : n.components) {  // baseXY: the last numeric x / y
      if (comp.props.at("x").is_number()) bx = comp.props.at("x").num();
      if (comp.props.at("y").is_number()) by = comp.props.at("y").num();
    }
    const double tt = remap(n.id, t_, false);
    const double x0 = anim_sample_of(n.id, "x", tt).value_or(bx);
    const double y0 = anim_sample_of(n.id, "y", tt).value_or(by);
    const double x1 = anim_sample_of(n.id, "x", tt + 1.0 / 120).value_or(bx);
    const double y1 = anim_sample_of(n.id, "y", tt + 1.0 / 120).value_or(by);
    const double dx = x1 - x0;
    const double dy = y1 - y0;
    if (!(dx == 0 && dy == 0)) rot = (motion::js::atan2(dy, dx) * 180) / std::numbers::pi;
  }
  // Behind the camera's near plane: not drawn (and neither casts nor receives).
  if (is3d && !three_->place(n, a, base.x, base.y, base.rotation, base.scaleX, base.scaleY, world, s3, px, py, sx, sy, rot, l)) return;
  if (liveBoolean) {  // the merge rides its union centre, identity scale: the outline is in world px
    px = liveBoolean->cx;
    py = liveBoolean->cy;
    layerW = liveBoolean->width;
    layerH = liveBoolean->height;
    sx = 1;
    sy = 1;
    rot = 0;
    l.matrix.reset();
    l.world3d.reset();
  }

  // Fill paint (+ its keyframed geometry and stops).
  Json fillPaint = read_node_fill(n);
  if (fillPaint.is_object()) {
    const std::string ft = fillPaint.at("type").str();
    if (ft == "linear" && a.has("fillAngle")) fillPaint.set("angle", Json::number(*a.get("fillAngle")));
    else if (ft == "radial") {
      if (a.has("fillCenterX")) fillPaint.set("cx", Json::number(*a.get("fillCenterX")));
      if (a.has("fillCenterY")) fillPaint.set("cy", Json::number(*a.get("fillCenterY")));
      if (a.has("fillRadius")) fillPaint.set("radius", Json::number(*a.get("fillRadius")));
    }
    if (ft == "linear" || ft == "radial") {
      if (const doc::DataTrack* st = doc::anim_data_track(d_, sid(n.id), "fill.stops")) {
        if (const auto live = doc::sample_data_track(*st, layerTimeNow);
            live && live->is_array() && !live->arr().empty() && live->arr()[0].is_object() && live->arr()[0].has("pos")) {
          Json stops = Json::array();
          std::size_t i = 0;
          for (const Json& s : live->arr()) {
            Json o = Json::object();
            o.set("id", Json::string("anim_" + std::to_string(i++)));
            o.set("offset", s.at("pos"));
            o.set("color", s.at("color"));
            stops.arr_mut().push_back(std::move(o));
          }
          fillPaint.set("stops", std::move(stops));
        }
      }
    }
  }
  std::optional<std::string> finalFill = base.fill;
  if (!finalFill) {
    if (kind == "image" || kind == "video" || kind == "svg") finalFill = std::nullopt;
    else if (kind == "text") finalFill = base.color.value_or("#ffffff");
    else finalFill = kind_fill(kind);
  }
  if (fillPaint.is_object() && fillPaint.at("type").str() == "solid" && fillPaint.at("color").is_string()) {
    finalFill = fillPaint.at("color").str();
  }
  if (a.has("fill_r")) {
    finalFill = color_to_hex({a.get("fill_r").value_or(0), a.get("fill_g").value_or(0), a.get("fill_b").value_or(0),
                              a.get("fill_a").value_or(1)});
  } else if (layerKind == LayerKind::text && a.has("color_r")) {
    finalFill = color_to_hex({a.get("color_r").value_or(0), a.get("color_g").value_or(0), a.get("color_b").value_or(0),
                              a.get("color_a").value_or(1)});
  }

  const StrokeStack strokeFold = resolve_stroke_stack(read_node_strokes(n), a, layerW, layerH);
  const std::vector<Json> fillStack = read_node_fills(n);
  Json fillPaints;
  if (fillStack.size() > 1) {
    fillPaints = Json::array();
    fillPaints.arr_mut().push_back(fillPaint.is_undefined() ? fillStack[0] : fillPaint);
    for (std::size_t i = 1; i < fillStack.size(); ++i) fillPaints.arr_mut().push_back(fillStack[i]);
  }
  // Textured kinds: a paint stroke / fill compiles to the GPU stroke / fill effects.
  if (layerKind != LayerKind::shape && strokeFold.stroke.is_object() && strokeFold.stroke.at("enabled").b() &&
      strokeFold.stroke.at("width").num() > 0 && strokeFold.stroke.at("opacity").num() > 0 &&
      !std::ranges::any_of(l.effects, [](const Json& e) {
        return e.at("type").is_string() && e.at("type").str() == "stroke" && !(e.at("enabled").is_bool() && !e.at("enabled").b());
      })) {
    Json e = Json::object();
    e.set("id", Json::string("paintstroke:primary"));
    e.set("type", Json::string("stroke"));
    e.set("enabled", Json::boolean(true));
    Json p = Json::object();
    p.set("width", Json::number(std::max(0.0, strokeFold.stroke.at("width").num())));
    p.set("color", strokeFold.stroke.at("color"));
    p.set("opacity", Json::number(motion::js::round(clamp01(strokeFold.stroke.at("opacity").num()) * 100)));
    e.set("params", std::move(p));
    l.effects.push_back(std::move(e));
  }
  if ((layerKind == LayerKind::image || layerKind == LayerKind::video) && fillPaint.is_object() &&
      !std::ranges::any_of(l.effects, [](const Json& e) {
        const std::string ty = e.at("type").is_string() ? e.at("type").str() : "";
        return (ty == "fill" || ty == "gradient-ramp") && !(e.at("enabled").is_bool() && !e.at("enabled").b());
      })) {
    const std::string ft = fillPaint.at("type").str();
    if (ft == "solid" && fillPaint.at("color").is_string()) {
      Json e = Json::object();
      e.set("id", Json::string("paintfill:primary"));
      e.set("type", Json::string("fill"));
      e.set("enabled", Json::boolean(true));
      Json p = Json::object();
      p.set("color", fillPaint.at("color"));
      p.set("opacity", Json::number(100));
      e.set("params", std::move(p));
      l.effects.push_back(std::move(e));
    } else if ((ft == "linear" || ft == "radial") && fillPaint.at("stops").is_array() && fillPaint.at("stops").arr().size() >= 2) {
      Json e = Json::object();
      e.set("id", Json::string("paintfill:primary"));
      e.set("type", Json::string("gradient-ramp"));
      e.set("enabled", Json::boolean(true));
      Json p = Json::object();
      p.set("colorA", fillPaint.at("stops").arr().front().at("color"));
      p.set("colorB", fillPaint.at("stops").arr().back().at("color"));
      p.set("angle", Json::number(ft == "linear" ? jnum(fillPaint.at("angle")).value_or(90) : 90));
      p.set("blend", Json::number(100));
      e.set("params", std::move(p));
      l.effects.push_back(std::move(e));
    }
  }

  // Corners.
  const auto sampleCorner = [&](const char* key, std::optional<double> fb) -> std::optional<double> {
    const auto live = a.get(key);
    if (live && std::isfinite(*live)) return std::max(0.0, *live);
    return fb && std::isfinite(*fb) ? std::optional<double>(std::max(0.0, *fb)) : std::nullopt;
  };
  const Radii radii = clamp_corner_radii(
      layerW, layerH,
      resolve_corner_radii(sampleCorner("cornerRadius", base.cornerRadius), sampleCorner("cornerRadiusTL", base.cornerRadiusTL),
                           sampleCorner("cornerRadiusTR", base.cornerRadiusTR), sampleCorner("cornerRadiusBR", base.cornerRadiusBR),
                           sampleCorner("cornerRadiusBL", base.cornerRadiusBL)));
  const double resolvedCornerRadius = std::max({radii[0], radii[1], radii[2], radii[3]});
  Json mask = apply_mask_path_expressions(d_, c_.expr, c_.cache, sid(n.id),
                                          apply_mask_property_tracks(read_node_mask_at(n, layerTimeNow), a), layerTimeNow);
  mask_motion_samples(mask, n);
  if ((layerKind == LayerKind::image || layerKind == LayerKind::video) && resolvedCornerRadius > 0.5 && layerW > 0 && layerH > 0) {
    Json round = rounded_rect_mask(layerW, layerH, radii, n.id + "::corners");
    if (mask.is_undefined() || mask.at("paths").arr().empty()) {
      Json m = Json::object();
      Json paths = Json::array();
      paths.arr_mut().push_back(std::move(round));
      m.set("paths", std::move(paths));
      mask = std::move(m);
    } else {
      round.set("mode", Json::string("intersect"));
      Json paths = mask.at("paths");
      paths.arr_mut().push_back(std::move(round));
      mask.set("paths", std::move(paths));
    }
  }
  std::optional<std::string> finalColor = base.color;
  if (a.has("color_r")) {
    finalColor = color_to_hex({a.get("color_r").value_or(0), a.get("color_g").value_or(0), a.get("color_b").value_or(0),
                               a.get("color_a").value_or(1)});
  }
  l.glass = resolve_glass(doc::get_node_layer_styles(n).at("glass"), a, comp_.globalLightAngle);

  // The literal.
  l.blend = read_node_blend(n);
  l.mask = std::move(mask);
  l.matte = read_matte_of(n);
  if (const Json& bs = n.fx().at("behindSubject"); bs.is_string() && !bs.str().empty()) l.behindSubject = bs.str();
  if (const Json& ids = n.fx().at("behindSubjects"); ids.is_array())
    for (const Json& id : ids.arr())
      if (id.is_string() && !id.str().empty() && std::ranges::find(l.behindSubjects, id.str()) == l.behindSubjects.end()) l.behindSubjects.push_back(id.str());
  if (const Json& soft = n.fx().at("behindSubjectSoftness"); soft.is_number() && std::isfinite(soft.num())) l.behindSubjectSoftness = std::clamp(soft.num(), 0.0, 100.0);
  if (const Json& choke = n.fx().at("behindSubjectChoke"); choke.is_number() && std::isfinite(choke.num())) l.behindSubjectChoke = std::clamp(choke.num(), -100.0, 100.0);
  l.isAdjustment = read_node_adjustment(n);
  l.draft = read_node_quality_s(n) == "draft";
  if (doc::read_node_paint(n)) {  // paint_port.cpp: the frame's live strokes
    LayerPaint lp = resolve_layer_paint(d_, n, layerTimeNow, a, sid(n.id));
    // A clone stroke sampling another layer or another time has no source in a
    // raster: that stroke is left out and the rest of the paint draws.
    for (std::string& why : lp.unported) warning(l, n, std::move(why));
    // Shapes draw paint in their path raster, text in its text raster (text_spec's
    // `paint`, raster_source), footage bakes it onto the decoded frame
    // (frame_build's paint-only bake → bake_footage), as the TypeScript does.
    l.paint = std::move(lp.paint);
  }
  // Content-aware fill (contentAwareFillVideo.ts contentAwareFillAt): the stored
  // fill frame nearest the layer's time stands in for the footage.
  if (fx.at("contentAwareFill").is_object() && fx.at("contentAwareFill").at("frames").is_array() &&
      !fx.at("contentAwareFill").at("frames").arr().empty()) {
    const Json::Array& frames = fx.at("contentAwareFill").at("frames").arr();
    const Json* best = &frames.front();
    double bestD = std::abs(best->at("t").num() - layerTimeNow);
    for (const Json& fr : frames) {
      const double dd = std::abs(fr.at("t").num() - layerTimeNow);
      if (dd < bestD) {
        best = &fr;
        bestD = dd;
      }
    }
    if (best->at("dataUrl").is_string()) l.contentAwareFillSrc = best->at("dataUrl").str();
  }
  // A per-frame soft matte (AE parity 3.2, setLayerMatte): each stored frame is
  // the layer's matte at that time (stream B1: an alpha plane; a legacy file's
  // alpha is read), applied to the footage as it composites — the footage is
  // always the source, the matte its coverage.
  if (const Json& am = fx.at("alphaMatte"); am.is_object() && am.at("frames").is_array() && !am.at("frames").arr().empty()) {
    // Each visible subject (core/subjects.hpp): its frame nearest the layer's time, its live edge,
    // and for Temporal Smooth its neighbouring frames (the stored frames either side, within 2.5 frames).
    // Stream B3: the frames are indexed once per document revision (sorted per subject, the tracked
    // span read off the index) and the nearest frame is a binary search — a walk's thousands of
    // frames are not scanned per subject per snapshot.
    const Json& entries = fx.at("subjects");
    const auto num = [](const Json& e, const char* k) { return e.at(k).is_number() && std::isfinite(e.at(k).num()) ? e.at(k).num() : 0.0; };
    std::shared_ptr<const doc::SubjectIndex> index = c_.walkCache != nullptr ? c_.walkCache->subject_index(n.id, am, entries, fps_) : nullptr;
    if (index == nullptr) index = std::make_shared<const doc::SubjectIndex>(am, entries, fps_);
    constexpr std::size_t kAhead = 8;  // stream B5: frames handed to the texture feed's read-ahead
    for (const doc::SubjectIndex::Subject& s : index->subjects()) {
      const std::size_t at = doc::SubjectIndex::nearest(s, layerTimeNow);
      if (at == doc::SubjectIndex::npos) continue;
      const Json& en = doc::subject_entry(entries, s.id);
      const Json* best = s.frames[at].json;
      SubjectPart p;
      p.id = s.id;
      p.src = best->at("src").str();
      // Hidden in the panel; or a tracked subject (frames every frame or so, Follow's) outside its
      // frames' span (and a frame either side) — one selected on a frame, or edited on a few far
      // apart, holds everywhere.
      p.hidden = (en.at("hidden").is_bool() && en.at("hidden").b()) || doc::SubjectIndex::away(s, layerTimeNow, fps_);
      p.feather = std::clamp(num(en, "feather"), 0.0, 200.0);
      p.choke = std::clamp(num(en, "choke"), -200.0, 200.0);
      p.contrast = std::clamp(num(en, "contrast"), 0.0, 100.0) / 100;
      p.invert = en.at("invert").is_bool() && en.at("invert").b();
      if (const double smooth = std::clamp(num(en, "smooth"), 0.0, 100.0) / 100; smooth > 0) {
        const double t0 = s.frames[at].t;
        const double reach = 2.5 / std::max(1.0, fps_);
        if (at > 0 && t0 - s.frames[at - 1].t <= reach) p.blend.emplace_back(s.frames[at - 1].json->at("src").str(), smooth / 3);
        if (at + 1 < s.frames.size() && s.frames[at + 1].t - t0 <= reach) p.blend.emplace_back(s.frames[at + 1].json->at("src").str(), smooth / 3);
      }
      for (std::size_t k = at + 1; k < s.frames.size() && k <= at + kAhead; ++k) p.ahead.push_back(s.frames[k].json->at("src").str());
      l.subjects.push_back(std::move(p));
    }
    // Read as a matte by an effect (the Object Matte effect, which cuts the
    // layer with it live, or Selective Color (AI)), the frame is that effect's
    // texture and the footage stays whole. A matte stored with its Object
    // Matte effect (`cutByEffect`, setLayerMatte) cuts only through it: that
    // effect disabled or removed, the layer shows uncut. A record from before
    // the effect existed (no card, not stored for one) cuts the layer through
    // an implicit card: the stored frame is coverage alone (stream B1), so it
    // can no longer stand in for the footage — the footage stays the source
    // and the card applies the matte, decontaminating the edge as it goes.
    if (!l.subjects.empty()) {
      const std::string& first = l.subjects.front().src;
      l.subjectSrc = first;
      const Json& by = am.at("cutByEffect");
      const bool byEffect = by.is_bool() && by.b();
      const bool hasCard = std::ranges::any_of(l.effects, [](const Json& e) { return e.at("type").is_string() && e.at("type").str() == "object-matte"; });
      if (reads_own_object_matte(l)) {
        l.objectMatteSrc = first;
      } else if (!byEffect && !hasCard) {
        Json card = Json::object();
        card.set("id", Json::string("object-matte:stored"));
        card.set("type", Json::string("object-matte"));
        Json params = Json::object();
        params.set("decontaminate", Json::boolean(true));
        params.set("decontaminationAmount", Json::number(50));
        card.set("params", std::move(params));
        l.effects.insert(l.effects.begin(), std::move(card));
        l.objectMatteSrc = first;
      }
    }
  }
  l.sourceTime = retimed_source_at(n.id, t_);  // its own Speed % / Time Remap (retime_port.cpp)
  if (layerKind == LayerKind::video) {
    // Frame blending: the source frames bracketing the (retimed) source time, on
    // the source's own rate (Interpret Footage conform, then the probe, then the comp).
    if (const auto cfg = doc::read_node_layer_time(n); comp_.frameBlending && cfg && (cfg->frameBlend == "mix" || cfg->frameBlend == "pixelMotion")) {
      double sourceFps = fps_;
      if (base.assetId) {
        if (const Json* asset = doc::find_asset(d_, *base.assetId)) {
          const Json& conform = asset->at("interpret").at("conformFps");
          const Json& probed = asset->at("metadata").at("fps");
          const std::optional<double> f = conform.is_number() ? conform.num() : probed.is_number() ? std::optional<double>(probed.num()) : std::nullopt;
          if (f && *f > 0) sourceFps = *f;
        }
      }
      const double st = retimed_source_at(n.id, t_);
      if (sourceFps > 0 && std::isfinite(st)) {  // bracketFrames
        const double exact = st * sourceFps;
        const double lo = std::floor(exact);
        const double weight = exact - lo;
        if (weight > 1e-3) {
          l.frameBlend = RLayer::FrameBlend{lo / sourceFps, (lo + 1) / sourceFps, weight, cfg->frameBlend};
        }
      }
    }
  }
  {
    const auto fo = a.get("fillOpacity") ? a.get("fillOpacity") : read_num_prop(n, "fillOpacity");
    if (fo) l.fillOpacity = std::max(0.0, std::min(1.0, *fo / 100));
  }
  l.skew = a.get("skew") ? a.get("skew") : read_num_prop(n, "skew");
  l.skewAxis = a.get("skewAxis") ? a.get("skewAxis") : read_num_prop(n, "skewAxis");
  const bool pin = isSolid && !is3d && solidUnseeded;
  l.x = pin ? comp_.width / 2 : px;
  l.y = pin ? comp_.height / 2 : py;
  l.rotation = pin ? 0 : rot;
  l.scaleX = pin ? 1 : sx;
  l.scaleY = pin ? 1 : sy;
  l.depth = is3d ? s3.depth : 0;
  l.opacity = baseOpacity;
  l.width = layerW;
  l.height = layerH;
  l.fill = finalFill;
  l.fillPaint = fillPaint;
  l.fillPaints = fillPaints;
  l.stroke = strokeFold.stroke;
  l.strokes = strokeFold.strokes;
  l.color = finalColor;
  l.visible = shown(n) && (!anySolo_ || soloed(n)) && !(comp_.forExport && read_is_guide_layer(n));
  std::string name = n.name;
  std::ranges::transform(name, name.begin(), [](char ch) { return ch >= 'A' && ch <= 'Z' ? static_cast<char>(ch - 'A' + 'a') : ch; });
  const bool nameEllipse = name.find("circle") != std::string::npos || name.find("ellip") != std::string::npos ||
                           name.find("dot") != std::string::npos || name.find("orb") != std::string::npos;
  l.primitive = !pathPoints.is_undefined() && !pathPoints.is_null() ? "path"
                : isSolid                                            ? "rect"
                : (shapeType == "ellipse" || (!shapeType && nameEllipse)) ? "ellipse"
                                                                            : "rect";
  l.cornerRadius = resolvedCornerRadius;
  // Glass owns the backdrop blur when it is on (buildSnapshot).
  // Standalone backdrop blur is the composition pass's half-res blur (glass uses
  // the same path with its own radius). It used to be reported unported after
  // that pass landed.
  l.backdropBlur = l.glass ? std::optional<double>(l.glass->blur) : a.get("backdropBlur") ? a.get("backdropBlur") : base.backdropBlur;
  l.pathPoints = pathPoints.is_null() ? Json() : pathPoints;
  l.pathOpen = pathOpen;
  // Text (`wrappedLayerText`: point text is the raw string; paragraph text is reported above).
  if (layerKind == LayerKind::text || base.text) {
    std::optional<std::string> txt = base.text;
    if (const doc::DataTrack* st = doc::anim_data_track(d_, sid(n.id), "text.source")) {
      if (const auto live = doc::sample_data_track(*st, layerTimeNow); live && live->is_string()) txt = live->str();
    }
    l.text = txt;
  }
  l.fontSize = a.get("fontSize").value_or(base.fontSize);
  l.fontFamily = base.fontFamily;
  if (const auto fw = a.get("fontWeight")) {
    l.fontWeight = js::number_to_string(std::max(1.0, std::min(1000.0, *fw)));
  } else {
    l.fontWeight = base.fontWeight;
  }
  l.fontWidth = a.get("fontWidth") ? a.get("fontWidth") : base.fontWidth;
  l.fontSlant = a.get("fontSlant") ? a.get("fontSlant") : base.fontSlant;
  l.fontStyle = base.fontStyle;
  l.letterSpacing = a.get("letterSpacing") ? a.get("letterSpacing") : base.letterSpacing;
  // Tracking (1/1000 em) resolves to px at the layer's font size, on top of the
  // px letter spacing — the measurer does the same (read_measured_text_style),
  // so the box and the paint agree. A run's own font size keeps the layer's px.
  if (base.tracking && *base.tracking != 0 && std::isfinite(*base.tracking)) {
    l.letterSpacing = l.letterSpacing.value_or(0) + *base.tracking * l.fontSize / 1000;
    l.tracking = base.tracking;  // a run at another size re-resolves it (raster TextStyle::merged)
  }
  l.lineHeight = a.get("lineHeight") ? a.get("lineHeight") : base.lineHeight;
  l.align = base.align;
  l.paragraphSpacing = a.get("paragraphSpacing") ? a.get("paragraphSpacing") : base.paragraphSpacing;
  l.strokeOverFill = base.strokeOverFill;
  // Media source: the asset's src when the node names one (rigMeshInputs resolveRigImageSrc's order).
  if (layerKind == LayerKind::image || layerKind == LayerKind::video) {
    l.assetId = base.assetId;
    std::optional<std::string> src = base.src;
    const Json* asset = base.assetId ? doc::find_asset(d_, *base.assetId) : nullptr;
    if (asset != nullptr) {
      if (std::string media = doc::asset_media_src(*asset); !media.empty()) src = std::move(media);
      if (asset->at("interpret").at("alpha").is_string() && asset->at("interpret").at("alpha").str() == "premultiplied") {
        l.premultipliedSource = true;
      }
      // Interpret Footage > Color > Assign Profile (a RenderColorSpace's API name; handlers_items validates it).
      if (const Json& cp = asset->at("interpret").at("colorProfile"); cp.is_string()) {
        for (std::uint32_t k = 0; k < 64; ++k) {
          api::RenderColorSpace s{};
          if (!api::from_u32(k, s)) break;
          if (api::to_string(s) == cp.str()) l.colorProfile = s;
        }
      }
      // Mutually exclusive (footageSourceOf): Remove Pulldown serves progressive
      // frames, so its fields are not separated again.
      const Json& fields = asset->at("interpret").at("fields");
      const Json& phase = asset->at("interpret").at("pulldownPhase");
      // interpretationOf: only a whole phase 0..4 means anything; anything else is off.
      const double ph = phase.is_number() ? phase.num() : -1;
      if (ph >= 0 && ph <= 4 && std::floor(ph) == ph) {
        l.pulldownSource = static_cast<int>(ph);
      } else if (fields.is_string() && (fields.str() == "upper" || fields.str() == "lower")) {
        l.fieldsSource = fields.str() == "upper" ? 'u' : 'l';
      }
    }
    l.src = src;
    // Use Proxies (a viewport frame): the item's enabled proxy is decoded in
    // place of the original — the layer keeps the original's box, so the
    // proxy frame is scaled up into it and nothing moves; its timing and
    // interpretation stay the original's (the proxy is a 1:1 transcode). A
    // proxy the engine cannot reach is drawn from the original and said.
    if (c_.useProxies && layerKind == LayerKind::video && asset != nullptr && src && !src->empty()) {
      if (std::string proxy = doc::asset_proxy_src(*asset); !proxy.empty()) {
        if (doc::is_session_url(proxy) || proxy.starts_with("data:")) {
          warning(l, n, "proxy is not a file on disk; drawn from the original");
        } else {
          std::filesystem::path p = file_url_fs_path(proxy);
          if (p.is_relative() && !c_.mediaBase.empty()) p = c_.mediaBase / p;
          std::error_code ec;
          if (std::filesystem::is_regular_file(p, ec)) {
            l.proxySrc = std::move(proxy);
          } else {
            warning(l, n, "proxy file is missing (" + utf8_path(p) + "); drawn from the original");
          }
        }
      }
    }
    // P7b: footage a native plugin importer failed to read (scene_textures_plugin.cpp) — named on
    // layerErrors; the layer draws nothing and the frame renders.
    if (asset != nullptr && asset->at("path").is_string()) {
      const std::string& path = asset->at("path").str();
      const std::size_t slash = path.find_last_of("/\\");
      if (auto why = doc::NativeImporters::failure(slash == std::string::npos ? path : path.substr(slash + 1))) {
        errors_.push_back({n.id, n.name, "footage", std::move(*why)});
      }
    }
    if (kind == "svg") {  // svgLayerSrc: the stored document (svg_layer.cpp)
      SvgLayerSource svg = svg_layer_source(n);
      if (svg.src) l.src = std::move(svg.src);
      // The stored markup draws as a still either way: an older sanitize policy
      // or SMIL / CSS animation the renderer does not play is said, not refused.
      for (std::string& why : svg.unported) warning(l, n, std::move(why));
    }
    // buildSnapshot: a cover slot keeps the authored box and crops in UV space
    // (mediaSlots.ts coverUvRect). The source size is footageSourceOf's display
    // size: stored pixels × pixel aspect, width rounded like Math.round.
    const Json& fit = doc::transform_props(n).at("slotFit");
    if (fit.is_string() && fit.str() == "cover" && asset != nullptr) {
      const Json& md = asset->at("metadata");
      const double storedW = md.at("width").is_number() ? md.at("width").num() : 0;
      const double storedH = md.at("height").is_number() ? md.at("height").num() : 0;
      const Json& par = asset->at("interpret").at("par");
      const double pixelAspect = par.is_number() && par.num() > 0 ? par.num() : 1;
      if (auto uv = cover_uv_rect(motion::js::round(storedW * pixelAspect), storedH, base.width.value_or(0), base.height.value_or(0))) {
        l.uvRect = *uv;
      }
    }
  }
  l.preserveTransparency = read_node_preserve_transparency(n);
  l.continuousRaster = read_continuous_raster(n) && supports_continuous_raster(n);  // continuousRaster.ts
  l.cornerPin = read_node_corner_pin(n);  // readNodeCornerPin (corner_pin.cpp)
  {
    const bool rounded = resolvedCornerRadius > 0 || has_independent_corner_radii(radii);
    if (rounded) l.cornerRadii = radii;
    // A 3D layer's sx / sy are its PROJECTED size (perspective included), so
    // dividing the radius by them made it shrink near the camera and grow far
    // from it. The layer's own world scale (the world matrix's X / Y axes,
    // column-major, no projection) is what the radius is authored against.
    double csx = std::abs(sx);
    double csy = std::abs(sy);
    if (is3d && l.world3d) {
      const auto& w3 = *l.world3d;
      csx = std::sqrt(w3[0] * w3[0] + w3[1] * w3[1] + w3[2] * w3[2]);
      csy = std::sqrt(w3[4] * w3[4] + w3[5] * w3[5] + w3[6] * w3[6]);
    }
    if (rounded && (csx != 1 || csy != 1) && csx > 1e-6 && csy > 1e-6) l.cornerRadiusScale = std::array<double, 2>{csx, csy};
  }
  if (layerKind == LayerKind::text) text_fields(l, n, base, a);
  three_->shade(s3, l);  // Accepts Lights: per-quad gain + shade3d
  // Anchor point.
  {
    const auto [ax0, ay0] = read_node_anchor(n);
    l.anchorX = a.get("anchorX").value_or(ax0);
    l.anchorY = a.get("anchorY").value_or(ay0);
    // Point text anchored at its alignment edge and first baseline (AE: the
    // text origin; a vertical column at its top): the Anchor Point value is
    // then relative to that origin, as AE's is.
    if (layerKind == LayerKind::text && measured && textStyle && c_.measurer != nullptr && base.textAnchor && *base.textAnchor == "alignment") {
      const PointTextAnchor pa = point_text_anchor(*c_.measurer, n, *textStyle, measured->first, measured->second);
      l.anchorX += pa.x;
      l.anchorY += pa.y;
    }
  }
  // Rigs: puppet pins and skeletons → layer.deformedMesh (rig_mesh.cpp).
  if (rig_present(fx)) {
    const bool pathSilhouette = !l.pathOpen && l.pathPoints.is_array() && l.pathPoints.arr().size() >= 3;
    // rigCoverageMask: an image's rest mesh is culled by / traced from the
    // bitmap's alpha (rig_coverage.cpp; key = assetId ?? src).
    CoverageLookup coverage;
    if (layerKind == LayerKind::image && l.src && !l.src->empty() && !pathSilhouette) {
      coverage = image_coverage_mask(l.assetId.value_or(*l.src), *l.src, c_.mediaBase);
    }
    // An image the engine cannot read here (a session URL, a relative path with
    // no project folder): the rig deforms the layer's full grid instead of its
    // alpha-traced outline.
    if (!coverage.unreachable.empty()) warning(l, n, "rig on an image layer: " + coverage.unreachable + " — the mesh covers the whole layer");
    RigInputs ri;
    ri.fx = &fx;
    ri.width = l.width;
    ri.height = l.height;
    ri.pad = raster_padding(l);
    ri.pathPoints = l.pathPoints.is_array() ? &l.pathPoints : nullptr;
    ri.pathOpen = l.pathOpen;
    ri.rigT = l.sourceTime.value_or(t_);
    ri.coverage = coverage.mask.get();
    RigResult rig = build_rig_mesh_for(d_, c_.expr, c_.cache, sid(n.id), ri);
    for (std::string& what : rig.warnings) warning(l, n, std::move(what));
    if (rig.mesh) l.deformedMesh = std::move(rig.mesh);
  }
  // Shape geometry: stored multi-run paths, then the operator chain.
  if (layerKind == LayerKind::shape) {
    if (staticSubpaths.is_array() && staticSubpaths.arr().size() > 1) {
      Json subs = Json::array();
      for (const Json& r : staticSubpaths.arr()) {
        Json pts = Json::array();
        if (r.at("points").is_array()) {
          for (const Json& p : r.at("points").arr()) {
            Json q = Json::object();
            q.set("x", p.at("x"));
            q.set("y", p.at("y"));
            q.set("inX", p.at("inX").is_undefined() || p.at("inX").is_null() ? p.at("x") : p.at("inX"));
            q.set("inY", p.at("inY").is_undefined() || p.at("inY").is_null() ? p.at("y") : p.at("inY"));
            q.set("outX", p.at("outX").is_undefined() || p.at("outX").is_null() ? p.at("x") : p.at("outX"));
            q.set("outY", p.at("outY").is_undefined() || p.at("outY").is_null() ? p.at("y") : p.at("outY"));
            pts.arr_mut().push_back(std::move(q));
          }
        }
        Json sp = Json::object();
        sp.set("points", std::move(pts));
        sp.set("open", Json::boolean(r.at("open").is_bool() && r.at("open").b()));
        subs.arr_mut().push_back(std::move(sp));
      }
      l.subpaths = std::move(subs);
      l.pathPoints = Json();
      l.pathOpen = false;
      l.primitive = "path";
    }
    // The operator chain (trim / repeater / zig-zag / wiggle / offset / pucker /
    // twist / round / merge …, path_ops.cpp) — the viewport's and the export's one evaluator.
    (void)apply_path_ops(n, a, layerTimeNow, l);
  }
  motion_samples(l, n, base, n.id, three_->matrix_at(n, a, base.x, base.y, base.rotation, s3));
  if (layerKind == LayerKind::text && l.text) {
    // Text animators (text_port.cpp): per-glyph transforms over the unwrapped text.
    const std::vector<Json> anims = resolve_text_animators(n, a);
    const auto glyphs_of = [&](const std::string& text) {
      if (anims.empty()) return;
      std::string why;
      Json glyphs = evaluate_text_animators(text, anims, layerTimeNow, &why);
      if (why.empty()) l.glyphs = std::move(glyphs);
      else unported(l, n, why);
    };
    glyphs_of(*l.text);
    // Per-character styling (richText.ts readRuns + normalizeRuns): emitted only when non-empty.
    const doc::Component* tc = n.comp("Text");
    if (tc != nullptr && tc->props.at("__runs").is_array() && !tc->props.at("__runs").arr().empty()) {
      l.runs = normalize_runs(tc->props, *l.text);
    }
    // Source Text expression (applySourceTextExpressionResult). Null when the
    // layer has none, or the expression errored — the un-expressed text stays.
    if (const auto expr = doc::anim_evaluate_source_text(d_, c_.expr, c_.cache, sid(n.id), layerTimeNow)) {
      apply_source_text(l, *expr);
      if (l.text) glyphs_of(*l.text);
    }
    // Paragraph text renders WRAPPED (wrappedLayerText, text_port.cpp) — after the animators
    // and runs, which index the raw text.
    if (l.text) {
      // A box the measurer cannot wrap draws its text unwrapped (said, not refused).
      if (std::string why = paragraph_layer(l, n, c_.measurer, *l.text); !why.empty()) warning(l, n, why + " — drawn unwrapped");
    }
  }
  three_->effects(s3, isSolid, px, py, l);  // DOF blur, cast shadows, receivers, the Only modes
  // Temporal ghosts (Echo / Wide Time, temporal_ghosts.cpp): copies at other
  // times, behind the layer — or after it for Composite In Front.
  std::vector<RLayer> echoesInFront;
  if (const std::optional<GhostSpec> ghosts = read_ghost_spec(l.effects, fps_)) {
    const GhostSampler sample = [&](std::string_view p, double tt) { return anim_sample_of(n.id, p, tt); };
    GhostPlace3D place3d;
    if (is3d && l.matrix) {
      place3d = [&](RLayer& g, double ti, double dx, double dy, double drot) { three_->place_ghost(s3, sample, ti, dx, dy, drot, g); };
    }
    std::vector<RLayer> copies = ghost_layers(l, *ghosts, t_, sample, a.get("x").value_or(base.x), a.get("y").value_or(base.y),
                                              a.get("rotation").value_or(base.rotation), px, py, rot, place3d);
    for (RLayer& g : copies) {
      if (ghosts->inFront) echoesInFront.push_back(std::move(g));
      else emit(std::move(g), n);
    }
  }
  emit_time_taps(n, l);
  // Extrusion / primitive mesh carriers, then the front quad (inset, mesh-drawn, planar DOF).
  RLayer notes;
  notes.id = n.id;
  three_->finish_layer(n, a, s3, std::move(l), [&](RLayer out) { emit(std::move(out), n); },
                       [&](std::string what) { unported(notes, n, std::move(what)); });
  for (RLayer& g : echoesInFront) emit(std::move(g), n);
}

Snapshot Walk::run() {
  // The flattened comp with its collapsed instances expanded and the sealed
  // pass's overrides applied: a function of the document alone, so the frame
  // builder's WalkCache keeps it across frames (built here when there is none).
  const std::optional<std::string> layerViewId = c_.layerView ? std::optional<std::string>(c_.layerView->id) : std::nullopt;
  topo_ = c_.walkCache != nullptr ? c_.walkCache->topology(d_, comp_.rootId, comp_.compOverrides, layerViewId)
                                  : make_walk_topology(d_, comp_.rootId, comp_.compOverrides, layerViewId);
  wn_ = &topo_->walk;
  byId_ = &topo_->byId;
  if (topo_->mayClone) {
    // Cloners stay per frame: a layer falloff or a path cloner reads the raw
    // graph's world matrices at t_ (cloner_port.cpp fieldOf / pathOf). The
    // cached nodes are shared by pointer; only this frame's clones are owned here.
    clonedWn_.nodes = topo_->walk.nodes;
    clonedWn_.source = topo_->walk.source;
    clonedWn_.instanceRoots = topo_->walk.instanceRoots;
    clonedWn_.overridden = topo_->walk.overridden;
    clonedWn_.cloneOffsets = topo_->walk.cloneOffsets;
    expand_cloners(clonedWn_, raw_);  // cloner_port.cpp
    clonedById_.reserve(clonedWn_.nodes.size());
    for (const doc::Node* n : clonedWn_.nodes) clonedById_.emplace(n->id, n);
    wn_ = &clonedWn_;
    byId_ = &clonedById_;
  }
  // The Layer panel's layer draws un-soloed.
  anySolo_ = !c_.layerView && std::ranges::any_of(walked(), [](const doc::Node* n) { return n->solo; });
  std::set<std::string, std::less<>> roots;
  if (!c_.isolateLayer.empty() && byId_->contains(c_.isolateLayer)) roots.insert(c_.isolateLayer);
  for (const std::string& id : c_.isolateAlso) {
    if (byId_->contains(id)) roots.insert(id);
  }
  if (!roots.empty()) {
    // getThumbnail of a layer: it alone draws (with what it holds), as if the
    // only soloed layer (Rig Logo: several together). A nested comp's walk
    // does not hold them: unaffected.
    for (const doc::Node* n : walked()) {
      for (const doc::Node* up = n; up != nullptr;) {
        if (roots.contains(up->id)) {
          isolated_.insert(n->id);
          break;
        }
        const auto it = up->parent ? byId_->find(*up->parent) : byId_->end();
        up = it != byId_->end() ? it->second : nullptr;
      }
    }
    // The groups above them: a group draws nothing of its own, but its
    // visibility carries to what it holds.
    for (const std::string& root : roots) {
      const doc::Node* n = byId_->at(root);
      while (n->parent) {
        const auto it = byId_->find(*n->parent);
        if (it == byId_->end()) break;
        n = it->second;
        if (n->kind() == "group") isolated_.insert(n->id);
      }
    }
    anySolo_ = true;
  }
  fps_ = comp_.fps ? *comp_.fps : doc::comp_fps(d_, comp_.rootId);
  {
    // Rigid-body poses: a PRE-PASS (bodies collide, so every body is known before
    // any is placed), seeded from each layer's AUTHORED pose (readBase). The world
    // is physicsStore's default: gravity 0 / 1800, the comp rectangle, 4 passes.
    std::vector<physics::BodySeed> seeds;
    for (const doc::Node* n : walked()) {
      std::optional<physics::BodyConfig> cfg;
      for (const auto& comp : n->components) {
        const Json& raw = comp.props.at("__physics");
        if (!raw.is_object()) continue;
        cfg = physics::read_physics(raw);
        break;
      }
      if (!cfg) continue;
      const Base pb = read_base(*n);
      physics::BodySeed s;
      s.id = n->id;
      s.x = pb.x;
      s.y = pb.y;
      s.rotation = pb.rotation;
      s.width = pb.width.value_or(100);
      s.height = pb.height.value_or(100);
      s.cfg = *cfg;
      seeds.push_back(std::move(s));
    }
    if (!seeds.empty()) {
      physics::World world;
      world.bounds = physics::Bounds{0, 0, comp_.width, comp_.height};
      physics_ = physics::poses_at(seeds, world, fps_, motion::js::round(t_ * (fps_ != 0 ? fps_ : 30)));
    }
  }
  // The camera, DOF and lights resolve before the walk (buildSnapshot order).
  three_ = std::make_unique<Scene3D>(*this, c_, comp_, t_, mb_);
  three_->setup(walked());

  // Which layers must be fully built (buildSnapshot `needsFullBuild`).
  {
    std::vector<const doc::Node*> order;
    for (const doc::Node* n : walked()) {
      const std::string k = n->kind();
      if (k == "group" || k == "null" || k == "camera" || k == "audio") continue;
      if (k == "comp" && collapsed(*n)) continue;
      const Json& bo = fx_props(*n).at("booleanOperand");
      if (bo.is_bool() && bo.b()) continue;
      if (!is_live_at(n->id)) continue;
      order.push_back(n);
    }
    const auto willDraw = [&](const doc::Node& n) {
      return shown(n) && (!anySolo_ || soloed(n)) && !(comp_.forExport && read_is_guide_layer(n));
    };
    for (std::size_t i = 0; i < order.size(); ++i) {
      const doc::Node& n = *order[i];
      const auto m = read_matte_of(n);
      if (!willDraw(n)) {
        // A hidden matted layer: its matte source stays a matte (drawn by
        // nobody), instead of appearing as a plain layer the moment the
        // consumer's eye went off — the scan bar of a logo reveal, say.
        if (!m) continue;
        if (m->sourceId) hiddenMatteSources_.insert(*m->sourceId);
        else if (i + 1 < order.size()) hiddenMatteSources_.insert(order[i + 1]->id);
        continue;
      }
      fullBuild_.insert(n.id);
      if (!m) continue;
      if (m->sourceId) fullBuild_.insert(*m->sourceId);
      else if (i + 1 < order.size()) fullBuild_.insert(order[i + 1]->id);
    }
  }

  for (const doc::Node* n : walked()) {
    if (n->id == comp_.rootId) continue;  // the composition root is the frame, not a layer
    // An edit waits for this build's lock: the frame would describe a document
    // that is about to change. Stop here (one layer's work at most) rather than
    // make the edit wait for the whole frame — at 4000 effects, 125 ms per edit.
    if (c_.cancel != nullptr && c_.cancel->load(std::memory_order_relaxed) != 0) throw BuildCancelled{};
    const std::size_t markTop = layers_.size();
    std::map<std::string, std::size_t, std::less<>> markInner;
    for (const auto& [k, v] : precompInner_) markInner[k] = v.size();
    const std::set<std::string, std::less<>> emittedBefore = precompEmitted_;
    try {
      build_node(*n);
    } catch (const std::exception& e) {
      errors_.push_back({n->id, n->name, "snapshot", e.what()});
      // dropEmittedLayers: everything this node emitted, with its helpers.
      layers_.resize(std::min(layers_.size(), markTop));
      for (auto it = precompInner_.begin(); it != precompInner_.end();) {
        const auto mk = markInner.find(it->first);
        if (mk == markInner.end()) {
          it = precompInner_.erase(it);
          continue;
        }
        it->second.resize(std::min(it->second.size(), mk->second));
        ++it;
      }
      precompEmitted_ = emittedBefore;
      try {
        emit_stub(*n);
      } catch (const std::exception&) {  // NOLINT(bugprone-empty-catch): the matte read threw — leave the slot empty (TS)
      }
    }
  }
  attach_precomps(layers_);
  if (c_.layerView) {
    // LAYER PANEL (buildSnapshot `comp.layerView`): keep only the layer itself —
    // the `::shadow` / `::ext-*` / `::ch<n>` helpers a node can emit belong to the
    // comp render — and take back off it everything the comp does TO it:
    // placement, 3D, opacity, blending, mattes. With Render off, also the masks,
    // effects and paint, leaving the untouched source.
    const std::string& id = c_.layerView->id;
    std::erase_if(layers_, [&](const RLayer& l) { return l.id != id; });
    for (RLayer& l : layers_) {
      l.x = comp_.width / 2;
      l.y = comp_.height / 2;
      l.rotation = 0;
      l.scaleX = 1;
      l.scaleY = 1;
      l.depth = 0;
      l.opacity = 1;
      l.blend = "normal";
      l.visible = true;
      l.matrix.reset();
      l.world3d.reset();
      l.quad3d.reset();
      l.anchorX = 0;
      l.anchorY = 0;
      l.skew.reset();
      l.skewAxis.reset();
      l.motionSamples.clear();
      l.lighting.reset();
      l.shade3d.reset();
      l.matte.reset();
      l.matteSourceId.reset();
      l.isMatteSource = false;
      l.preserveTransparency = false;
      if (!c_.layerView->render) {
        l.effects.clear();
        l.mask = Json();
        l.paint = Json();
        l.cornerPin.reset();
        l.glass.reset();
        l.backdropBlur.reset();
      }
    }
    // The alpha views (the Layer panel's matte views, AE's Alpha / Alpha
    // Boundary / Alpha Overlay). Viewer-only, built from what is already here:
    // the shown layer, a copy of it as the untouched source, flat backdrops and
    // the Fill / Stroke effects.
    const std::string& alphaView = c_.layerView->alphaView;
    if (!alphaView.empty() && !layers_.empty() && layers_.front().width > 0 && layers_.front().height > 0) {
      const auto effect = [](std::string_view fxId, std::string_view type, Json params) {
        Json fx = Json::object();
        fx.set("id", Json::string(std::string(fxId)));
        fx.set("type", Json::string(std::string(type)));
        fx.set("enabled", Json::boolean(true));
        fx.set("params", std::move(params));
        return fx;
      };
      const auto flat = [&](std::string_view suffix, std::string_view color, double opacity) {
        const RLayer& shown = layers_.back();
        RLayer r;
        r.id = id + "::" + std::string(suffix);
        r.kind = LayerKind::shape;
        r.primitive = "rect";
        r.x = shown.x;
        r.y = shown.y;
        r.width = shown.width;
        r.height = shown.height;
        r.fill = std::string(color);
        r.opacity = opacity;
        return r;
      };
      // The untouched source: the layer with none of what cuts or changes it.
      const auto source = [&] {
        RLayer src = layers_.back();
        src.id = id + "::alpha-source";
        src.effects.clear();
        src.mask = Json();
        src.paint = Json();
        src.cornerPin.reset();
        src.glass.reset();
        src.backdropBlur.reset();
        return src;
      };
      if (alphaView == "alpha") {
        // The matte itself: the layer filled white, on black.
        Json p = Json::object();
        p.set("color", Json::string("#ffffff"));
        p.set("opacity", Json::number(100));
        layers_.back().effects.push_back(effect("alpha-view-fill", "fill", std::move(p)));
        layers_.insert(layers_.begin(), flat("alpha-black", "#000000", 1));
      } else if (alphaView == "overlay") {
        // The source everywhere; outside the matte it sits under the overlay
        // tint (setViewport layerAlphaOverlayColor / Opacity; magenta, 50 %).
        RLayer src = source();
        RLayer tint = flat("alpha-tint", c_.layerView->overlayColor, c_.layerView->overlayOpacity);
        layers_.insert(layers_.begin(), std::move(tint));
        layers_.insert(layers_.begin(), std::move(src));
      } else if (alphaView == "boundary") {
        // The source everywhere, and the matte's edge as a line.
        RLayer src = source();
        Json p = Json::object();
        p.set("color", Json::string("#ff00ff"));
        p.set("opacity", Json::number(100));
        p.set("width", Json::number(std::max(2.0, layers_.back().width / 480.0)));
        p.set("position", Json::string("outside"));
        layers_.back().effects.push_back(effect("alpha-view-edge", "stroke", std::move(p)));
        layers_.insert(layers_.begin(), std::move(src));
      }
    }
    // The transparency grid: a checkerboard the size of the layer, under it.
    // A viewer-only backdrop (never in a composition render, an export or a
    // thumbnail): the layer's own pixels are untouched, and where it is
    // transparent the grid shows through.
    // (Not under the Alpha view: that one is on black.)
    if (c_.layerView->grid && alphaView != "alpha" && !layers_.empty() && layers_.front().width > 0 && layers_.front().height > 0) {
      const RLayer& shown = layers_.front();
      RLayer grid;
      grid.id = id + "::transparency-grid";
      grid.kind = LayerKind::shape;
      grid.primitive = "rect";
      grid.x = shown.x;
      grid.y = shown.y;
      grid.width = shown.width;
      grid.height = shown.height;
      grid.fill = "#3d3d3d";
      Json params = Json::object();
      params.set("width", Json::number(16));
      params.set("height", Json::number(16));
      params.set("anchorX", Json::number(0));
      params.set("anchorY", Json::number(0));
      params.set("colorA", Json::string("#3d3d3d"));
      params.set("colorB", Json::string("#2b2b2b"));
      params.set("opacity", Json::number(100));
      Json fx = Json::object();
      fx.set("id", Json::string("transparency-grid"));
      fx.set("type", Json::string("checkerboard"));
      fx.set("enabled", Json::boolean(true));
      fx.set("params", std::move(params));
      grid.effects.push_back(std::move(fx));
      layers_.insert(layers_.begin(), std::move(grid));
    }
  }
  // Landed beams, projected shadows and the 3D depth sort (before the matte pairing, as the TS).
  three_->finish(layers_);
  // An environment light / reflection whose image sky could not be read: the
  // scene renders without that light (said, not refused).
  for (const auto& [id, what] : three_->unported()) {
    const doc::Node* un = node(id);
    errors_.push_back({id, un != nullptr ? un->name : std::string(), "warning", what});
  }

  // resolveMatteSources — per stack level, as the TypeScript applies it to the top level only.
  const auto resolveMattes = [this](std::vector<RLayer>& ls) {
    std::unordered_map<std::string, std::size_t> idx;
    for (std::size_t i = 0; i < ls.size(); ++i) idx.emplace(ls[i].id, i);
    for (RLayer& l : ls) {
      if (hiddenMatteSources_.contains(l.id)) l.isMatteSource = true;
    }
    for (std::size_t i = 0; i < ls.size(); ++i) {
      RLayer& l = ls[i];
      if (!l.matte) continue;
      if (l.matte->sourceId && idx.contains(*l.matte->sourceId)) {
        ls[idx[*l.matte->sourceId]].isMatteSource = true;
        l.matteSourceId = l.matte->sourceId;
      } else if (i + 1 < ls.size()) {
        ls[i + 1].isMatteSource = true;
        l.matteSourceId = ls[i + 1].id;
      }
    }
  };
  resolveMattes(layers_);
  // Behind Subject: a layer hidden behind another layer's subject reads that layer's matte frame.
  {
    std::unordered_map<std::string, std::size_t> idx;
    for (std::size_t i = 0; i < layers_.size(); ++i) idx.emplace(layers_[i].id, i);
    for (RLayer& l : layers_) {
      if (!l.behindSubject) continue;
      const auto it = idx.find(*l.behindSubject);
      if (it == idx.end() || it->second >= layers_.size() || layers_[it->second].id == l.id || !layers_[it->second].subjectSrc) {
        l.behindSubject.reset();
        continue;
      }
      RLayer& owner = layers_[it->second];
      if (!l.behindSubjects.empty()) {
        // Only the named subjects that are shown now, in the owner's order (one texture per set).
        std::vector<std::string> named;
        for (const SubjectPart& p : owner.subjects)
          if (std::ranges::find(l.behindSubjects, p.id) != l.behindSubjects.end()) named.push_back(p.id);
        if (named.empty()) {  // every subject it is behind is hidden: nothing covers it
          l.behindSubject.reset();
          continue;
        }
        if (named.size() == owner.subjects.size()) named.clear();  // all of them: the whole subject's texture
        l.behindSubjects = std::move(named);
      }
      owner.subjectReferenced = true;
      if (std::ranges::find(owner.subjectSubsets, l.behindSubjects) == owner.subjectSubsets.end()) owner.subjectSubsets.push_back(l.behindSubjects);
    }
  }

  // The viewer's transparency grid (AE's Toggle Transparency Grid): the
  // composition over a checkerboard instead of its background colour, so what
  // is transparent in it reads as transparent. The same backdrop the Layer
  // panel's grid uses, the size of the comp, under everything.
  if (comp_.transparencyGrid && comp_.width > 0 && comp_.height > 0) {
    RLayer grid;
    grid.id = comp_.rootId + "::transparency-grid";
    grid.kind = LayerKind::shape;
    grid.primitive = "rect";
    grid.width = comp_.width;
    grid.height = comp_.height;
    grid.fill = "#3d3d3d";
    Json params = Json::object();
    params.set("width", Json::number(16));
    params.set("height", Json::number(16));
    params.set("anchorX", Json::number(0));
    params.set("anchorY", Json::number(0));
    params.set("colorA", Json::string("#3d3d3d"));
    params.set("colorB", Json::string("#2b2b2b"));
    params.set("opacity", Json::number(100));
    Json fx = Json::object();
    fx.set("id", Json::string("transparency-grid"));
    fx.set("type", Json::string("checkerboard"));
    fx.set("enabled", Json::boolean(true));
    fx.set("params", std::move(params));
    grid.effects.push_back(std::move(fx));
    layers_.insert(layers_.begin(), std::move(grid));
  }

  Snapshot s;
  s.width = comp_.width;
  s.height = comp_.height;
  s.background = comp_.background;
  s.transparent = comp_.transparent || comp_.transparencyGrid;
  s.time = t_;
  s.fps = fps_;
  s.layers = std::move(layers_);
  s.layerErrors = std::move(errors_);
  three_->emit(s, s.layers);  // camera3d / lights3d / ssao when a layer is 3D
  return s;
}

/// The memo's cap (comp × overrides × Layer panel layer); past it the memo starts over.
constexpr std::size_t kWalkCacheEntries = 256;

}  // namespace

// ── the walk memo (snapshot_build.hpp WalkCache) ────────────────────────────

std::shared_ptr<const WalkTopology> make_walk_topology(const Document& d, const std::string& rootId,
                                                       const std::map<std::string, Json, std::less<>>& overrides,
                                                       const std::optional<std::string>& layerViewId) {
  auto t = std::make_shared<WalkTopology>();
  if (layerViewId) {
    // LAYER PANEL: the one layer and nothing else — not the layers parented to
    // it — and sealed: no collapsed-instance expansion (the panel shows a
    // collapsed comp as a card, drawn by its own pass).
    std::vector<const doc::Node*> flat = flatten_composition(d, rootId);
    std::erase_if(flat, [&](const doc::Node* n) { return n->id != *layerViewId; });
    t->walk.nodes = std::move(flat);
  } else {
    // Collapsed instances expand into clones; a sealed pass applies its overrides (comp_instance.cpp).
    t->walk = expand_walk_nodes(d, flatten_composition(d, rootId), rootId, overrides);
  }
  t->byId.reserve(t->walk.nodes.size());
  for (const doc::Node* n : t->walk.nodes) t->byId.emplace(n->id, n);
  t->mayClone = std::ranges::any_of(t->walk.nodes, [](const doc::Node* n) {
    return std::ranges::any_of(n->components, [](const doc::Component& c) { return c.props.at("__cloner").is_object(); });
  });
  return t;
}

struct WalkCache::State {
  /// The document the memo was built from, by entity identity (see the header).
  std::vector<std::shared_ptr<const doc::Node>> nodePins;
  std::vector<std::shared_ptr<const Json>> compPins;
  struct Entry {
    std::map<std::string, Json, std::less<>> overrides;
    std::shared_ptr<const WalkTopology> topo;
  };
  /// "<rootId>\x1f[L<layerViewId>]" → the entries for each override set.
  std::unordered_map<std::string, std::vector<Entry>> entries;
  std::size_t count = 0;
  /// Stream B3: layer id → its subject frames indexed (dropped with the memo when the document changes).
  std::unordered_map<std::string, std::shared_ptr<const doc::SubjectIndex>> subjectIndexes;
};

WalkCache::WalkCache() : s_(std::make_unique<State>()) {}
WalkCache::~WalkCache() = default;

void WalkCache::clear() noexcept {
  s_->entries.clear();
  s_->count = 0;
  s_->nodePins.clear();
  s_->compPins.clear();
  s_->subjectIndexes.clear();
}

std::shared_ptr<const doc::SubjectIndex> WalkCache::subject_index(const std::string& layerId, const Json& alphaMatte, const Json& entries,
                                                                  double fps) {
  std::shared_ptr<const doc::SubjectIndex>& slot = s_->subjectIndexes[layerId];
  // The memo is dropped when the document changes (revalidate); the pointer check covers a node
  // replaced between revalidations inside one Scope (a nested build) and a comp at another rate.
  if (slot == nullptr || !slot->built_from(alphaMatte, fps)) slot = std::make_shared<const doc::SubjectIndex>(alphaMatte, entries, fps);
  return slot;
}

void WalkCache::revalidate(const Document& d) {
  State& s = *s_;
  validatedDoc_ = &d;
  const auto& nodes = d.nodes().entries();
  const auto& comps = d.comps().entries();
  bool same = s.nodePins.size() == nodes.size() && s.compPins.size() == comps.size();
  for (std::size_t i = 0; same && i < nodes.size(); ++i) same = s.nodePins[i].get() == nodes[i].second.get();
  for (std::size_t i = 0; same && i < comps.size(); ++i) same = s.compPins[i].get() == comps[i].second.get();
  if (same) return;
  ++revisions_;
  clear();
  s.nodePins.reserve(nodes.size());
  for (const auto& e : nodes) s.nodePins.emplace_back(e.second);
  s.compPins.reserve(comps.size());
  for (const auto& e : comps) s.compPins.emplace_back(e.second);
}

std::shared_ptr<const WalkTopology> WalkCache::topology(const Document& d, const std::string& rootId,
                                                        const std::map<std::string, Json, std::less<>>& overrides,
                                                        const std::optional<std::string>& layerViewId) {
  // Outside a Scope, or a nested build over another document: compare here.
  if (depth_ == 0 || &d != validatedDoc_) revalidate(d);
  State& s = *s_;
  std::string key = rootId;
  key.push_back('\x1f');
  if (layerViewId) {
    key.push_back('L');
    key += *layerViewId;
  }
  if (const auto it = s.entries.find(key); it != s.entries.end()) {
    for (const State::Entry& e : it->second) {
      if (e.overrides == overrides) return e.topo;
    }
  }
  if (s.count >= kWalkCacheEntries) {
    // Walks in flight hold their topologies (shared_ptr): dropping the memo is safe mid-build.
    s.entries.clear();
    s.count = 0;
  }
  std::shared_ptr<const WalkTopology> topo = make_walk_topology(d, rootId, overrides, layerViewId);
  ++flattens_;
  s.entries[key].push_back({overrides, topo});
  ++s.count;
  return topo;
}

WalkCache::Scope::Scope(WalkCache* cache, const Document& d) : cache_(cache) {
  if (cache_ == nullptr) return;
  if (cache_->depth_ == 0) cache_->revalidate(d);
  ++cache_->depth_;
}

WalkCache::Scope::~Scope() {
  if (cache_ != nullptr) --cache_->depth_;
}

SnapshotComp snapshot_comp_of(const Document& d, std::string_view comp) {
  SnapshotComp s;
  s.rootId = std::string(comp);
  const Json* rec = d.comp(comp);
  if (rec == nullptr) return s;
  s.width = jnum(rec->at("width")).value_or(1920);
  s.height = jnum(rec->at("height")).value_or(1080);
  if (rec->at("background").is_string()) s.background = rec->at("background").str();
  s.transparent = rec->at("transparent").is_bool() && rec->at("transparent").b();
  s.frameBlending = !(rec->at("frameBlending").is_bool() && !rec->at("frameBlending").b());
  s.globalLightAngle = jnum(rec->at("globalLightAngle")).value_or(90);
  s.globalLightAltitude = jnum(rec->at("globalLightAltitude")).value_or(45);
  if (auto ds = jnum(rec->at("durationSeconds"))) s.durationSeconds = ds;
  return s;
}

SnapshotComp with_viewport_view(SnapshotComp sc, const ViewportConfig& viewport) {
  sc.draft3d = viewport.draft3d;
  sc.transparencyGrid = viewport.transparencyGrid && viewport.layer.empty();
  if (viewport.view.empty() || viewport.view == "active") return sc;
  if (viewport.view != "custom") {
    sc.camera3dMode = viewport.view;
    return sc;
  }
  if (!viewport.customView) return sc;
  // customViews.ts resolveCustomView + customViewCamera.
  const CustomViewParams& p = *viewport.customView;
  const double w = std::max(1.0, sc.width);
  const double h = std::max(1.0, sc.height);
  const motion::xf::Camera def = motion::xf::default_camera(w, h);
  const double distance = p.distance.value_or(def.focal_length * 1.2);
  const motion::xf::Vec3 poi = p.poi ? motion::xf::Vec3{(*p.poi)[0], (*p.poi)[1], (*p.poi)[2]} : motion::xf::Vec3{w / 2, h / 2, 0};
  const motion::xf::Orbited orbited = motion::xf::orbit_camera({poi.x, poi.y, poi.z - distance}, poi, p.yaw, p.pitch);
  const motion::xf::Orientation look = motion::xf::look_at_orientation(orbited.position, poi);
  motion::xf::Camera cam{.position = orbited.position, .focal_length = def.focal_length, .principal = def.principal, .orientation = std::nullopt};
  if (look.yaw != 0 || look.pitch != 0) cam.orientation = look;
  sc.camera3dMode = "active";
  sc.customViewCamera = cam;
  return sc;
}

std::optional<std::array<double, 4>> cover_uv_rect(double sourceW, double sourceH, double slotW, double slotH) {
  if (!(sourceW > 0) || !(sourceH > 0) || !(slotW > 0) || !(slotH > 0)) return std::nullopt;
  const double sourceAspect = sourceW / sourceH;
  const double slotAspect = slotW / slotH;
  if (std::abs(sourceAspect - slotAspect) < 1e-6) return std::nullopt;
  if (sourceAspect > slotAspect) {
    const double frac = slotAspect / sourceAspect;
    return std::array<double, 4>{(1.0 - frac) / 2, 0, frac, 1};
  }
  const double frac = sourceAspect / slotAspect;
  return std::array<double, 4>{0, (1.0 - frac) / 2, 1, frac};
}

MotionBlurCfg motion_blur_of(const Document& d, std::string_view comp) {
  const doc::MotionBlur& mb = d.motion_blur();
  MotionBlurCfg c;
  c.enabled = mb.enabled;
  c.shutterAngle = mb.shutterAngle;
  c.shutterPhase = mb.shutterPhase;
  c.samples = mb.samples;
  c.adaptiveSampleLimit = mb.adaptiveSampleLimit;
  const double fps = doc::comp_fps(d, comp);
  c.fps = fps > 0 ? fps : 60;
  return c;
}

Snapshot build_snapshot(const BuildContext& c, const SnapshotComp& comp, double t, const std::optional<MotionBlurCfg>& motionBlur) {
  // The build only READS the document: clip-bar lookups answer from the
  // per-timeline index (timeline.hpp) instead of scanning every bar per layer.
  const doc::TlReadScope readOnly;
  // The outermost build compares the document with the walk memo's (nested passes share the answer).
  const WalkCache::Scope memo(c.walkCache, c.d);
  Walk w(c, comp, t, motionBlur);
  return w.run();
}

}  // namespace premation::scene
