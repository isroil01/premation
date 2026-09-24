#include "snapshot_build.hpp"

#include <algorithm>
#include <cmath>
#include <exception>
#include <functional>
#include <map>
#include <numbers>
#include <set>
#include <unordered_map>

#include "effects_port.hpp"
#include "frame_build.hpp"
#include "rig_bridge.hpp"
#include "fxstate.hpp"
#include "layer_styles.hpp"
#include "misc_port.hpp"
#include "path_ops.hpp"
#include "jsmath.hpp"
#include "readers.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "scene_math.hpp"
#include "text_runs.hpp"
#include "threed_port.hpp"
#include "transform.hpp"

namespace premation::scene {
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

/// motionBlurSampleTimes.
std::vector<double> motion_blur_sample_times(double t, double fps, double shutterAngle, double samples,
                                             double shutterPhase, double limit) {
  const double effective = std::min(std::max(1.0, std::floor(samples)), std::max(1.0, std::floor(limit)));
  const double duration = (std::max(0.0, std::min(360.0, shutterAngle)) / 360) / std::max(1.0, fps);
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

 private:
  // ── lookups ──
  [[nodiscard]] const doc::Node* node(std::string_view id) const {
    const auto it = byId_.find(std::string(id));
    return it == byId_.end() ? nullptr : it->second;
  }
  const Values& values_of(const std::string& id);
  double remap(const std::string& id, double tt, bool subFrame, bool extrapolate = false);
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
  RLayer precomp_container(const doc::Node& group);
  void emit_stub(const doc::Node& n);
  void build_node(const doc::Node& n);
  void unported(RLayer& l, const doc::Node& n, std::string what);
  std::vector<Json> effects_of(const doc::Node& n, const Values& a, std::optional<double> layerTime, RLayer* note);
  /// `matrixAt` (3D layers): the projected affine per sample (threed_port `matrix_at`).
  void motion_samples(RLayer& l, const doc::Node& n, const Base& base, const std::string& id,
                      const std::function<std::array<double, 6>(double, double)>& matrixAt = {});
  void text_fields(RLayer& l, const doc::Node& n, const Base& base, const Values& a);
  void attach_precomps(std::vector<RLayer>& list);

  const BuildContext& c_;
  const Document& d_;
  const SnapshotComp& comp_;
  double t_;
  const std::optional<MotionBlurCfg>& mb_;
  double fps_ = 30;
  bool anySolo_ = false;

  std::vector<const doc::Node*> nodes_;
  std::unordered_map<std::string, const doc::Node*> byId_;
  std::unordered_map<std::string, Values> values_;
  std::unordered_map<std::string, std::vector<const Bar*>> clips_;
  std::unordered_map<std::string, bool> live_;
  std::unordered_map<std::string, xf::Mat2D> world_;
  std::set<std::string, std::less<>> fullBuild_;

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
  Values v(doc::anim_evaluate_node(d_, c_.expr, c_.cache, id, remap(id, t_, false)));
  return values_.emplace(id, std::move(v)).first->second;
}

std::vector<const Bar*> Walk::governing_clips(const std::string& id) {
  const auto it = clips_.find(id);
  if (it != clips_.end()) return it->second;
  std::vector<const Bar*> own = doc::tl_bars_for_node(d_, c_.view, id);
  if (own.empty()) {
    const doc::Node* cur = node(id);
    for (int depth = 0; depth < 32 && cur != nullptr; ++depth) {
      if (!cur->parent) break;
      const doc::Node* parent = node(*cur->parent);
      if (parent == nullptr || is_precomp_node(*parent) || parent->kind() != "group") break;
      std::vector<const Bar*> pc = doc::tl_bars_for_node(d_, c_.view, parent->id);
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
  if (!has_retime(d_, id)) return std::nullopt;
  const std::optional<RetimeClip> clip = retime_clip_of(pick_retime_bar(governing_clips(id), motion::js::round(tt * fps_)), fps_);
  return retimed_chain_time(RetimeReader{d_, c_.expr, c_.cache}, id, tt, clip);
}

double Walk::retimed_source_at(const std::string& id, double tt) {
  const std::optional<double> retimed = retimed_at(id, tt);
  return retimed ? remap(id, *retimed, true, true) : remap(id, tt, false);
}

double Walk::remap(const std::string& id, double tt0, bool subFrame, bool extrapolate) {
  const doc::Node* n = node(id);
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
    if (std::ranges::any_of(chain, [&](const doc::Node* pc) { return has_retime(d_, pc->id); })) {
      for (auto it = chain.rbegin(); it != chain.rend(); ++it) tt = retimed_at((*it)->id, tt).value_or(tt);
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
      if (const auto span = doc::anim_time_span(d_, id)) {
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

bool Walk::is_live_at(const std::string& id) {
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
  if (n == nullptr) return std::nullopt;
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

void Walk::unported(RLayer& l, const doc::Node& n, std::string what) {
  if (std::ranges::find(l.unported, what) != l.unported.end()) return;
  errors_.push_back({n.id, n.name, "unported", what});
  l.unported.push_back(std::move(what));
}

void Walk::emit(RLayer l, const doc::Node& n) {
  const doc::Node* pc = nearest_precomp_root(n);
  if (pc == nullptr) {
    layers_.push_back(std::move(l));
    return;
  }
  precompInner_[pc->id].push_back(std::move(l));
  if (precompEmitted_.insert(pc->id).second) emit(precomp_container(*pc), *pc);
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
    if (auto compiled = layer_styles_to_effects(styles, comp_.globalLightAngle, comp_.globalLightAltitude, animated)) {
      for (Json& e : *compiled) own.push_back(std::move(e));
    } else if (note != nullptr) {
      unported(*note, n, "layer styles");
    }
  }
  if (own.empty()) return {};
  std::vector<Json> resolved = resolve_effect_params(own, a, layerTime);
  for (Json& e : resolved) {
    if (!(e.at("type").is_string() && e.at("type").str() == "beam-path") || !effect_enabled(e)) continue;
    // buildSnapshot's path hand-off: the assigned mask path, flattened at the
    // frame's time into `pathPoints` (maskPathPolyline, 16 samples a segment).
    if (std::round(effect_number(e, "source")) == 2) {  // BEAM_SOURCE.text: traceTextRuns
      if (note != nullptr) unported(*note, n, "Energy Beam on the layer's text outline");
      continue;
    }
    const Json& pm = e.at("params").at("pathMaskId");
    if (!pm.is_string() || pm.str().empty()) continue;
    const Json m = layerTime ? read_node_mask_at(n, *layerTime) : Json{};
    const Json mask = m.is_undefined() ? doc::read_node_mask(n).value_or(Json{}) : m;
    const Json* path = nullptr;
    if (mask.at("paths").is_array()) {
      for (const Json& p : mask.at("paths").arr()) {
        if (p.at("id").is_string() && p.at("id").str() == pm.str()) path = &p;
        if (path != nullptr) break;
      }
    }
    Json flat = Json::array();
    bool closed = false;
    if (path != nullptr) {
      closed = path->at("closed").is_bool() && path->at("closed").b();
      if (path->at("expansion").is_number() && path->at("expansion").num() != 0) {
        if (note != nullptr) unported(*note, n, "Energy Beam on an expanded mask path");
        continue;
      }
      const Json::Array& pts = path->at("points").is_array() ? path->at("points").arr() : Json::Array{};
      const std::size_t np = pts.size();
      const std::size_t last = np < 2 ? 0 : (closed ? np : np - 1);
      const auto g = [](const Json& o, std::string_view k) { return o.at(k).num(); };
      for (std::size_t i = 0; i < last; ++i) {
        const Json& pa = pts[i];
        const Json& pb = pts[(i + 1) % np];
        if (i == 0) {
          flat.arr_mut().push_back(Json::number(g(pa, "x")));
          flat.arr_mut().push_back(Json::number(g(pa, "y")));
        }
        for (int s = 1; s <= 16; ++s) {
          const double t = s / 16.0;
          const double u = 1 - t;
          flat.arr_mut().push_back(Json::number(u * u * u * g(pa, "x") + 3 * u * u * t * g(pa, "outX") +
                                                3 * u * t * t * g(pb, "inX") + t * t * t * g(pb, "x")));
          flat.arr_mut().push_back(Json::number(u * u * u * g(pa, "y") + 3 * u * u * t * g(pa, "outY") +
                                                3 * u * t * t * g(pb, "inY") + t * t * t * g(pb, "y")));
        }
      }
    }
    Json params = e.at("params");
    params.set("pathPoints", std::move(flat));
    params.set("pathClosed", Json::boolean(closed));
    e.set("params", std::move(params));
  }
  if (note != nullptr) {
    for (const Json& e : resolved) {
      const std::string type = e.at("type").is_string() ? e.at("type").str() : "";
      if (const char* why = effect_unported_reason(e)) unported(*note, n, std::string(why) + " (" + type + ")");
    }
  }
  return resolved;
}

RLayer Walk::precomp_container(const doc::Node& group) {
  const Values& gv = values_of(group.id);
  const Base gb = read_base(group);
  RLayer l;
  l.id = group.id;
  l.kind = LayerKind::shape;
  l.effects = effects_of(group, gv, std::nullopt, &l);
  if (doc::read_comp_ref(group)) unported(l, group, "composition instances");
  l.mask = apply_mask_property_tracks(read_node_mask_at(group, remap(group.id, t_, false)), gv);
  l.blend = read_node_blend(group);
  l.preserveTransparency = read_node_preserve_transparency(group);
  l.matte = read_matte_of(group);
  l.x = comp_.width / 2;
  l.y = comp_.height / 2;
  l.depth = 0;
  const auto groupOpacity = gv.get("opacity");
  l.opacity = groupOpacity ? *groupOpacity / 100 : gb.opacity;
  l.width = comp_.width;
  l.height = comp_.height;
  l.fill = "#000";
  l.visible = group.visible;
  l.precompLayers = std::vector<RLayer>{};  // filled by attach_precomps once the walk is done
  l.sourceTime = remap(group.id, t_, false);
  if (doc::read_retime_mode(d_, group.id) != api::RetimeMode::normal) unported(l, group, "precomp time remap / retime");
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
                          const std::function<std::array<double, 6>(double, double)>& matrixAt) {
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
  const bool moves = std::ranges::any_of(kMoves, [&](std::string_view p) { return doc::anim_is_animated(d_, id, p); });
  // A 3D layer also moves on screen when the camera does.
  if (!moves && !(matrixAt && three_ && three_->camera_animated())) return;
  const auto sample = [&](std::string_view prop, double tt) { return doc::anim_sample(d_, c_.expr, c_.cache, id, prop, tt); };
  const double limit = cfg.adaptiveSampleLimit;
  const std::vector<double> probe = motion_blur_sample_times(t_, cfg.fps, cfg.shutterAngle, 2, cfg.shutterPhase, limit);
  double travel = 0;
  if (probe.size() >= 2 && matrixAt) {
    // 3D: PROJECTED travel at the box corners (motionBlur.ts affineTravelPx).
    const double ta = probe.front();
    const double tb = probe.back();
    const std::array<double, 6> ma = matrixAt(remap(id, ta, true), ta);
    const std::array<double, 6> mb = matrixAt(remap(id, tb, true), tb);
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
    if (matrixAt) s.matrix = matrixAt(ti, tc);
    out.push_back(s);
  }
  if (out.size() > 1) l.motionSamples = std::move(out);
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
  // textExtras.ts readTextExtrasProps + compactTextExtras (point text).
  Json x = Json::object();
  for (const auto& c : n.components) {
    const Json& p = c.props;
    for (const char* k : {"leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter"}) {
      if (p.at(k).is_number() && std::isfinite(p.at(k).num())) x.set(k, p.at(k));
    }
    if (p.at("strokeLineJoin").is_string()) {
      const std::string& j = p.at("strokeLineJoin").str();
      if (j == "miter" || j == "round" || j == "bevel") x.set("strokeLineJoin", p.at("strokeLineJoin"));
    }
    if (p.at("strokeOrder").is_string()) x.set("strokeOrder", p.at("strokeOrder"));
    for (const char* k : {"fauxBold", "fauxItalic", "noFill", "noStroke"}) {
      if (p.at(k).is_bool()) x.set(k, p.at(k));
    }
    if (p.at("kerningMode").is_string() && (p.at("kerningMode").str() == "metrics" || p.at("kerningMode").str() == "optical")) {
      x.set("kerningMode", p.at("kerningMode"));
    }
    if (p.at("direction").is_string()) {
      const std::string& dir = p.at("direction").str();
      if (dir == "rtl" || dir == "auto") x.set("direction", p.at("direction"));
      else if (dir == "ltr") x.erase("direction");
    }
    if (p.at("orientation").is_string() && p.at("orientation").str() == "vertical") x.set("orientation", Json::string("vertical"));
    else if (p.at("orientation").is_string() && p.at("orientation").str() == "horizontal") x.erase("orientation");
  }
  Json out = Json::object();
  for (const char* k : {"leftIndent", "rightIndent", "firstLineIndent", "spaceBefore", "spaceAfter"}) {
    if (x.at(k).is_number() && x.at(k).num() != 0) out.set(k, x.at(k));
  }
  if (x.at("strokeLineJoin").is_string() && x.at("strokeLineJoin").str() != "round") out.set("strokeLineJoin", x.at("strokeLineJoin"));
  if (x.at("strokeOrder").is_string() && !x.at("strokeOrder").str().empty()) out.set("strokeOrder", x.at("strokeOrder"));
  for (const char* k : {"fauxBold", "fauxItalic", "noFill", "noStroke"}) {
    if (x.at(k).is_bool() && x.at(k).b()) out.set(k, Json::boolean(true));
  }
  if (x.at("kerningMode").is_string() && x.at("kerningMode").str() == "optical") out.set("kerningMode", x.at("kerningMode"));
  if (x.at("direction").is_string()) out.set("direction", x.at("direction"));
  if (x.at("orientation").is_string()) {
    unported(l, n, "vertical text");
  }
  if (!out.obj().empty()) l.textExtras = std::move(out);
  // textMoreOptions / OpenType switches — reported, not produced.
  for (const auto& c : n.components) {
    if (c.type != "Text") continue;
    const Json& p = c.props;
    for (const char* k : {"anchorGrouping", "groupingAlignX", "groupingAlignY", "fillStrokeMode", "interCharacterBlending",
                          "stylisticSets"}) {
      if (!p.at(k).is_undefined()) unported(l, n, std::string("text more options (") + k + ")");
    }
    if (p.at("ligatures").is_bool() && !p.at("ligatures").b()) unported(l, n, "OpenType ligature switches");
    if (p.at("discretionaryLigatures").is_bool() && p.at("discretionaryLigatures").b()) unported(l, n, "OpenType ligature switches");
    if (p.at("contextualAlternates").is_bool() && !p.at("contextualAlternates").b()) unported(l, n, "OpenType ligature switches");
    const Json& sp = p.at("strokePaint");
    if (sp.is_object() && sp.at("stops").is_array() && !sp.at("stops").arr().empty()) unported(l, n, "text stroke gradients");
    const Json& anims = p.at("__animators");
    if (anims.is_array() && !anims.arr().empty()) unported(l, n, "text animators");
    if (p.at("boxWidth").is_number() && p.at("boxWidth").num() > 0) unported(l, n, "paragraph text (box wrapping)");
  }
  if (doc::read_text_path_config(n)) unported(l, n, "text on a path");
  const Json axes = doc::read_font_axes_prop(n);
  if (axes.is_object() && !axes.obj().empty()) unported(l, n, "variable font axes");
  if (doc::anim_has_expr(d_, n.id, "text.source") || doc::anim_expr(d_, n.id, "sourceText") != nullptr) {
    unported(l, n, "source text expressions");
  }
}

void Walk::build_node(const doc::Node& n) {
  const std::string kind = n.kind();
  if (kind == "comp") {
    const auto ref = doc::read_comp_ref(n);
    if (ref && !doc::read_comp_collapse(n)) {
      emit_stub(n);
      errors_.push_back({n.id, n.name, "unported", "composition instances (nested compositions)"});
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
  if (kind == "particle" || kind.find('.') != std::string::npos) {
    RLayer l;
    l.id = n.id;
    unported(l, n, kind == "particle" ? "particle layers" : "plugin generator / shader layers");
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
  if (kind == "svg") unported(l, n, "SVG layers");
  const double layerTimeNow = remap(n.id, t_, false);
  const double baseOpacity = a.has("opacity") ? *a.get("opacity") / 100 : base.opacity;
  l.effects = effects_of(n, a, layerTimeNow, &l);

  const bool isSolid = fx.at("solid").is_bool() && fx.at("solid").b();
  const doc::Component* geom = n.comp("Geometry");
  const Json staticPath = geom != nullptr ? geom->props.at("points") : Json();
  const Json liveOutline = live_path_points(d_, n.id, layerTimeNow);
  Json staticSubpaths = liveOutline.is_undefined() && geom != nullptr ? geom->props.at("subpaths") : Json();
  Json pathPoints = !liveOutline.is_undefined() ? liveOutline
                    : !staticPath.is_undefined() && !staticPath.is_null() ? staticPath
                    : staticSubpaths.is_array() && !staticSubpaths.arr().empty() ? staticSubpaths.arr()[0].at("points")
                                                                                : Json();
  if (geom != nullptr && geom->props.at("pointBindings").is_array() && !geom->props.at("pointBindings").arr().empty()) {
    unported(l, n, "path points bound to nulls");
  }
  const bool pathOpen = geom != nullptr && geom->props.at("open").is_bool() && geom->props.at("open").b();
  const std::optional<std::string> shapeType = jstr(doc::transform_props(n).at("shapeType"));

  // Size: measured text, the authored box, or the kind's default.
  std::optional<std::pair<double, double>> measured;
  if (layerKind == LayerKind::text) {
    const auto style = read_measured_text_style(n, a.items());
    if (style) {
      if (c_.measurer == nullptr) unported(l, n, "text measurement (no fonts)");
      else measured = c_.measurer->measure_text_size(*style);
      if (!measured && c_.measurer != nullptr) unported(l, n, "text measurement of this style");
    }
  }
  const std::optional<double> rawW = a.has("width") ? a.get("width") : base.width;
  const std::optional<double> rawH = a.has("height") ? a.get("height") : base.height;
  const bool solidUnseeded = isSolid && (!rawW || !rawH || (*rawW == 100 && *rawH == 100));
  double layerW = isSolid ? (solidUnseeded || !rawW ? comp_.width : *rawW)
                          : (measured ? measured->first : rawW.value_or(sizeW));
  double layerH = isSolid ? (solidUnseeded || !rawH ? comp_.height : *rawH)
                          : (measured ? measured->second : rawH.value_or(sizeH));

  // Geometry the port does not produce yet.
  if (layerKind == LayerKind::shape) {
    if (apply_polystar(n, a, pathPoints, layerW, layerH) == GeometryStatus::applied) {
      staticSubpaths = Json();
    } else if (doc::read_node_polystar(n)) {
      unported(l, n, "parametric polystar");
    }
  }
  if (fx.at("audioWaveform").is_object()) unported(l, n, "audio waveform generator");
  if (fx.at("booleanOp").is_string() && fx.at("booleanSources").is_array() && fx.at("booleanSources").arr().size() >= 2) {
    unported(l, n, "live merge paths");
  }
  // 3D (threed_port.cpp): placement below; the mesh-carrying kinds are not ported yet.
  const bool is3d = doc::is_3d_enabled(n);
  Layer3D s3;
  s3.mat = three_->material_of(n, a);
  if (is3d) {
    for (const std::string& what : three_->unported_features(n, a)) unported(l, n, what);
  }
  // Auto-orient along the path applies to 2D layers only; Toward Camera is part of the 3D placement.
  if (!is3d && ((fx.at("autoOrient").is_string() && fx.at("autoOrient").str() == "path") ||
                (fx.at("autoOrient").is_bool() && fx.at("autoOrient").b()))) {
    unported(l, n, "auto-orient");
  }
  for (const auto& comp : n.components) {
    const Json& ph = comp.props.at("__physics");
    if (ph.is_object() && !(ph.at("enabled").is_bool() && !ph.at("enabled").b())) unported(l, n, "rigid-body physics");
  }

  double px = world.x;
  double py = world.y;
  double sx = world.scale_x;
  double sy = world.scale_y;
  double rot = world.rotation;
  // Behind the camera's near plane: not drawn (and neither casts nor receives).
  if (is3d && !three_->place(n, a, base.x, base.y, base.rotation, base.scaleX, base.scaleY, world, s3, px, py, sx, sy, rot, l)) return;

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
      if (const doc::DataTrack* st = doc::anim_data_track(d_, n.id, "fill.stops")) {
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
  Json mask = apply_mask_property_tracks(read_node_mask_at(n, layerTimeNow), a);
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
  l.isAdjustment = read_node_adjustment(n);
  l.draft = read_node_quality_s(n) == "draft";
  if (doc::read_node_paint(n)) unported(l, n, "paint strokes");
  if (fx.at("contentAwareFill").is_object() && fx.at("contentAwareFill").at("frames").is_array() &&
      !fx.at("contentAwareFill").at("frames").arr().empty()) {
    unported(l, n, "content-aware fill");
  }
  l.sourceTime = remap(n.id, t_, false);
  if (doc::read_retime_mode(d_, n.id) != api::RetimeMode::normal) unported(l, n, "time remap / speed retime");
  if (layerKind == LayerKind::video) {
    if (const auto cfg = doc::read_node_layer_time(n); cfg && (cfg->frameBlend == "mix" || cfg->frameBlend == "pixelMotion")) {
      unported(l, n, "frame blending");
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
  l.visible = n.visible && (!anySolo_ || n.solo) && !(comp_.forExport && read_is_guide_layer(n));
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
  l.backdropBlur = l.glass ? std::optional<double>(l.glass->blur) : a.get("backdropBlur") ? a.get("backdropBlur") : base.backdropBlur;
  if (!l.glass && l.backdropBlur && *l.backdropBlur > 0) unported(l, n, "backdrop blur");
  l.pathPoints = pathPoints.is_null() ? Json() : pathPoints;
  l.pathOpen = pathOpen;
  // Text (`wrappedLayerText`: point text is the raw string; paragraph text is reported above).
  if (layerKind == LayerKind::text || base.text) {
    std::optional<std::string> txt = base.text;
    if (const doc::DataTrack* st = doc::anim_data_track(d_, n.id, "text.source")) {
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
  l.lineHeight = a.get("lineHeight") ? a.get("lineHeight") : base.lineHeight;
  l.align = base.align;
  l.paragraphSpacing = a.get("paragraphSpacing") ? a.get("paragraphSpacing") : base.paragraphSpacing;
  l.strokeOverFill = base.strokeOverFill;
  // Media source: the asset's src when the node names one (rigMeshInputs resolveRigImageSrc's order).
  if (layerKind == LayerKind::image || layerKind == LayerKind::video) {
    l.assetId = base.assetId;
    std::optional<std::string> src = base.src;
    if (base.assetId) {
      if (const Json* asset = doc::find_asset(d_, *base.assetId)) {
        if (asset->at("src").is_string() && !asset->at("src").str().empty()) src = asset->at("src").str();
        if (asset->at("interpret").at("alpha").is_string() && asset->at("interpret").at("alpha").str() == "premultiplied") {
          l.premultipliedSource = true;
        }
        const Json& fields = asset->at("interpret").at("fields");
        if (fields.is_string() && (fields.str() == "upper" || fields.str() == "lower")) unported(l, n, "interlaced footage (fields)");
        if (asset->at("interpret").at("pulldownPhase").is_number()) unported(l, n, "pulldown removal");
      }
    }
    l.src = src;
    const Json& fit = doc::transform_props(n).at("slotFit");
    if (fit.is_string() && fit.str() == "cover") unported(l, n, "media slot cover crop");
  }
  l.preserveTransparency = read_node_preserve_transparency(n);
  for (const auto& comp : n.components) {
    const Json& cr = comp.props.at("continuousRasterize");
    if (cr.is_bool() && cr.b()) unported(l, n, "continuous rasterization");
  }
  if (!fx.at("cornerPin").is_undefined()) unported(l, n, "corner pin");
  {
    const bool rounded = resolvedCornerRadius > 0 || has_independent_corner_radii(radii);
    if (rounded) l.cornerRadii = radii;
    const double csx = std::abs(sx);
    const double csy = std::abs(sy);
    if (rounded && (csx != 1 || csy != 1) && csx > 1e-6 && csy > 1e-6) l.cornerRadiusScale = std::array<double, 2>{csx, csy};
  }
  if (layerKind == LayerKind::text) text_fields(l, n, base, a);
  three_->shade(s3, l);  // Accepts Lights: per-quad gain + shade3d
  // Anchor point.
  {
    const auto [ax0, ay0] = read_node_anchor(n);
    l.anchorX = a.get("anchorX").value_or(ax0);
    l.anchorY = a.get("anchorY").value_or(ay0);
  }
  // Rigs: puppet pins and skeletons → layer.deformedMesh (rig_mesh.cpp).
  if (rig_present(fx)) {
    const bool pathSilhouette = !l.pathOpen && l.pathPoints.is_array() && l.pathPoints.arr().size() >= 3;
    if (layerKind == LayerKind::image && l.src && !pathSilhouette) {
      // buildSnapshot culls an image's rest mesh by the bitmap's alpha
      // (rigCoverageMask); that needs the decoded pixels on this side.
      unported(l, n, "rigs on image layers (alpha coverage mesh)");
    } else {
      RigInputs ri;
      ri.fx = &fx;
      ri.width = l.width;
      ri.height = l.height;
      ri.pad = raster_padding(l);
      ri.pathPoints = l.pathPoints.is_array() ? &l.pathPoints : nullptr;
      ri.pathOpen = l.pathOpen;
      ri.rigT = l.sourceTime.value_or(t_);
      RigResult rig = build_rig_mesh_for(d_, c_.expr, c_.cache, n.id, ri);
      for (std::string& what : rig.unported) unported(l, n, std::move(what));
      if (rig.unported.empty()) l.deformedMesh = std::move(rig.mesh);
    }
  }
  // Shape geometry: stored multi-run paths; the operator chain is not ported.
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
    if (apply_path_ops(n, a, layerTimeNow, l) == GeometryStatus::unported) {
      unported(l, n, "shape path operators (trim / repeater / zig-zag / wiggle …)");
    }
  }
  motion_samples(l, n, base, n.id, three_->matrix_at(n, a, base.x, base.y, base.rotation, s3));
  if (layerKind == LayerKind::text && l.text) {
    // Per-character styling (richText.ts readRuns + normalizeRuns): emitted only when non-empty.
    const doc::Component* tc = n.comp("Text");
    if (tc != nullptr && tc->props.at("__runs").is_array() && !tc->props.at("__runs").arr().empty()) {
      l.runs = normalize_runs(tc->props, *l.text);
    }
  }
  // Temporal ghosts (Echo / Wide Time).
  for (const Json& e : l.effects) {
    const std::string ty = e.at("type").is_string() ? e.at("type").str() : "";
    if ((ty == "echo" || ty == "wide-time") && !(e.at("enabled").is_bool() && !e.at("enabled").b())) {
      unported(l, n, "temporal ghosts (echo / wide time)");
    }
  }
  three_->effects(s3, isSolid, px, py, l);  // DOF blur, cast shadows, receivers, the Only modes
  // Extrusion / primitive mesh carriers, then the front quad (inset, mesh-drawn, planar DOF).
  RLayer notes;
  notes.id = n.id;
  three_->finish_layer(n, a, s3, std::move(l), [&](RLayer out) { emit(std::move(out), n); },
                       [&](std::string what) { unported(notes, n, std::move(what)); });
}

Snapshot Walk::run() {
  nodes_ = flatten_composition(d_, comp_.rootId);
  for (const doc::Node* n : nodes_) byId_.emplace(n->id, n);
  anySolo_ = std::ranges::any_of(nodes_, [](const doc::Node* n) { return n->solo; });
  fps_ = doc::comp_fps(d_, comp_.rootId);
  // The camera, DOF and lights resolve before the walk (buildSnapshot order).
  three_ = std::make_unique<Scene3D>(*this, c_, comp_, t_, mb_);
  three_->setup(nodes_);

  // Which layers must be fully built (buildSnapshot `needsFullBuild`).
  {
    std::vector<const doc::Node*> order;
    for (const doc::Node* n : nodes_) {
      const std::string k = n->kind();
      if (k == "group" || k == "null" || k == "camera" || k == "audio") continue;
      if (k == "comp" && doc::read_comp_collapse(*n)) continue;
      const Json& bo = fx_props(*n).at("booleanOperand");
      if (bo.is_bool() && bo.b()) continue;
      if (!is_live_at(n->id)) continue;
      order.push_back(n);
    }
    const auto willDraw = [&](const doc::Node& n) {
      return n.visible && (!anySolo_ || n.solo) && !(comp_.forExport && read_is_guide_layer(n));
    };
    for (std::size_t i = 0; i < order.size(); ++i) {
      const doc::Node& n = *order[i];
      if (!willDraw(n)) continue;
      fullBuild_.insert(n.id);
      const auto m = read_matte_of(n);
      if (!m) continue;
      if (m->sourceId) fullBuild_.insert(*m->sourceId);
      else if (i + 1 < order.size()) fullBuild_.insert(order[i + 1]->id);
    }
  }

  for (const doc::Node* n : nodes_) {
    if (n->id == comp_.rootId) continue;  // the composition root is the frame, not a layer
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
  // Landed beams, projected shadows and the 3D depth sort (before the matte pairing, as the TS).
  three_->finish(layers_);
  for (const auto& [id, what] : three_->unported()) {
    const doc::Node* un = node(id);
    errors_.push_back({id, un != nullptr ? un->name : std::string(), "unported", what});
  }

  // resolveMatteSources — per stack level, as the TypeScript applies it to the top level only.
  const auto resolveMattes = [](std::vector<RLayer>& ls) {
    std::unordered_map<std::string, std::size_t> idx;
    for (std::size_t i = 0; i < ls.size(); ++i) idx.emplace(ls[i].id, i);
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

  Snapshot s;
  s.width = comp_.width;
  s.height = comp_.height;
  s.background = comp_.background;
  s.transparent = comp_.transparent;
  s.time = t_;
  s.fps = fps_;
  s.layers = std::move(layers_);
  s.layerErrors = std::move(errors_);
  three_->emit(s, s.layers);  // camera3d / lights3d / ssao when a layer is 3D
  return s;
}

}  // namespace

SnapshotComp snapshot_comp_of(const Document& d, std::string_view comp) {
  SnapshotComp s;
  s.rootId = std::string(comp);
  const Json* rec = d.comp(comp);
  if (rec == nullptr) return s;
  s.width = jnum(rec->at("width")).value_or(1920);
  s.height = jnum(rec->at("height")).value_or(1080);
  if (rec->at("background").is_string()) s.background = rec->at("background").str();
  s.transparent = rec->at("transparent").is_bool() && rec->at("transparent").b();
  s.globalLightAngle = jnum(rec->at("globalLightAngle")).value_or(90);
  s.globalLightAltitude = jnum(rec->at("globalLightAltitude")).value_or(45);
  if (auto ds = jnum(rec->at("durationSeconds"))) s.durationSeconds = ds;
  return s;
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
  Walk w(c, comp, t, motionBlur);
  return w.run();
}

}  // namespace premation::scene
