#include "overlay_geometry.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <iterator>
#include <limits>
#include <map>
#include <numbers>
#include <optional>
#include <set>
#include <string_view>
#include <utility>

#include "jsmath.hpp"

#include "anim.hpp"
#include "readmodel.hpp"
#include "fail.hpp"
#include "layer_geometry.hpp"
#include "overlay_rig_pack.hpp"
#include "scene.hpp"
#include "scene/session_hooks.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::doc {

bool OverlaySubscription::wants(api::OverlayKind k) const { return std::find(kinds.begin(), kinds.end(), k) != kinds.end(); }

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/// getLayerTransforms' matrix (queries.cpp): a 3D layer's world 4×4, else the 2D chain.
std::vector<double> matrix_of(const PCtx& pc, const std::string& layer, double seconds) {
  double cw = 1920;
  double ch = 1080;
  if (const auto comp = comp_of_layer(pc.d, layer)) {
    if (const Json* rec = pc.d.comp(*comp); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
      cw = rec->at("width").num();
      ch = rec->at("height").num();
    }
  }
  if (const auto m3 = world_3d_at(SpaceCtx{pc.d, pc.view, pc.expr, pc.cache}, layer, seconds, cw, ch)) {
    return {m3->begin(), m3->end()};
  }
  const auto m = world_2d_at(pc, layer, seconds);
  return {m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1};
}

/// The layer's own transform at the frame (block 3, OverlayLayerGeometry.local): x, y, z, rotation (Z),
/// scaleX, scaleY, anchorX, anchorY, anchorZ — the resolver the 2D chain and the 3D compose read. Empty without geometry.
std::vector<double> local_of(const PCtx& pc, const Node& n, double seconds) {
  const auto t = local_3d_at(SpaceCtx{pc.d, pc.view, pc.expr, pc.cache}, n, seconds);
  if (!t) return {};
  return {t->x, t->y, t->z, t->rotation_z, t->scale_x, t->scale_y, t->anchor_x, t->anchor_y, t->anchor_z};
}

/// getLayerBounds' box (layer space) and corners (comp space); false when the layer has no box (or no text port for text).
bool bounds_of(const PCtx& pc, TextQueries* text, const std::string& layer, double seconds, api::OverlayLayerGeometry& g) {
  std::optional<LayerGeometry> geo;
  try {
    geo = layer_geometry_at(SpaceCtx{pc.d, pc.view, pc.expr, pc.cache}, text, layer, seconds);
  } catch (const EngineFail&) {
    return false;  // a text layer the text port cannot measure: no box this frame
  }
  if (!geo) return false;
  const double l = geo->offsetX - geo->width / 2;
  const double t = geo->offsetY - geo->height / 2;
  g.box = {l, t, geo->width, geo->height};
  const auto m = world_2d_at(pc, layer, seconds);
  const std::array<double, 8> local{l, t, l + geo->width, t, l + geo->width, t + geo->height, l, t + geo->height};
  g.corners.clear();
  for (std::size_t i = 0; i < local.size(); i += 2) {
    g.corners.push_back(m.a * local[i] + m.c * local[i + 1] + m.e);
    g.corners.push_back(m.b * local[i] + m.d * local[i + 1] + m.f);
  }
  return true;
}

/// The text port's measured box (readGeometry's text branch), local x, y, w, h.
void text_box_of(const PCtx& pc, TextQueries* text, const std::string& layer, double seconds, api::OverlayLayerGeometry& g) {
  if (text == nullptr) return;
  const Node* n = pc.d.node(layer);
  if (n == nullptr || n->comp("Text") == nullptr) return;
  std::vector<std::pair<std::string, double>> av;
  if (const NodeAnim* a = pc.d.anim(layer); a != nullptr && !a->empty()) {
    av = anim_evaluate_node(pc.d, pc.expr, pc.cache, layer, comp_to_keyframe_time(pc.d, pc.view, layer, seconds));
  }
  const auto box = text->text_geometry(*n, av);
  if (!box) return;
  g.text_box = {-box->width / 2, box->dy - box->height / 2, box->width, box->height};
}

/// motionPath.ts over one layer: the position sampler, the key times, the tangents — mapped into comp space
/// through the parent's world matrix at the frame's time (useWorkspace.ts pathToComp).
class PathSampler {
 public:
  PathSampler(const PCtx& pc, const Node& n, double seconds) : pc_(pc), n_(n) {
    for (const Component& c : n.components) {
      if (c.props.at("x").is_number()) baseX_ = c.props.at("x").num();
      if (c.props.at("y").is_number()) baseY_ = c.props.at("y").num();
    }
    if (const Component* t = n.comp("Transform"); t != nullptr && t->props.at("z").is_number()) baseZ_ = t->props.at("z").num();
    if (n.parent && pc.d.node(*n.parent) != nullptr) parent_ = world_2d_at(pc, *n.parent, seconds);
  }

  /// The layer's own position at keyframe-axis time `t` (parent space) and its z.
  [[nodiscard]] std::array<double, 3> raw(double t) const {
    return {anim_sample(pc_.d, pc_.expr, pc_.cache, n_.id, "x", t).value_or(baseX_),
            anim_sample(pc_.d, pc_.expr, pc_.cache, n_.id, "y", t).value_or(baseY_),
            anim_sample(pc_.d, pc_.expr, pc_.cache, n_.id, "z", t).value_or(baseZ_)};
  }
  /// Parent space → comp space (2D).
  [[nodiscard]] std::pair<double, double> to_comp(double x, double y) const {
    return {parent_.a * x + parent_.c * y + parent_.e, parent_.b * x + parent_.d * y + parent_.f};
  }
  void push(std::vector<double>& out, double t) const {
    const auto p = raw(t);
    const auto [cx, cy] = to_comp(p[0], p[1]);
    out.insert(out.end(), {t, cx, cy, p[2]});
  }

 private:
  const PCtx& pc_;
  const Node& n_;
  double baseX_ = 0;
  double baseY_ = 0;
  double baseZ_ = 0;
  motion::xf::Mat2D parent_{1, 0, 0, 1, 0, 0};
};

/// The key on `track` at exactly keyframe time `t`, with its index.
std::optional<std::size_t> key_index_at(const std::vector<Key>* keys, double t) {
  if (keys == nullptr) return std::nullopt;
  for (std::size_t i = 0; i < keys->size(); ++i) {
    if ((*keys)[i].t == t) return i;
  }
  return std::nullopt;
}

void motion_path_of(const PCtx& pc, const std::string& layer, double seconds, api::OverlayLayerGeometry& g) {
  const Node* n = pc.d.node(layer);
  if (n == nullptr) return;
  const std::vector<Key>* xs = anim_track(pc.d, layer, "x");
  const std::vector<Key>* ys = anim_track(pc.d, layer, "y");
  std::set<double> timeSet;
  for (const auto* keys : {xs, ys}) {
    if (keys == nullptr) continue;
    for (const Key& k : *keys) timeSet.insert(k.t);
  }
  if (timeSet.empty()) return;
  const std::vector<double> times(timeSet.begin(), timeSet.end());
  const double tmin = times.front();
  const double tmax = times.back();
  const PathSampler s(pc, *n, seconds);

  // motionPathSamples: 16 per segment, at least 8, over the keyed span.
  if (tmax > tmin) {
    const auto segments = static_cast<double>(std::max<std::size_t>(1, times.size() - 1));
    const auto count = static_cast<std::uint32_t>(std::max(8.0, 16 * segments));
    const std::uint32_t steps = std::min(count, kOverlayPathPoints - 1);
    for (std::uint32_t i = 0; i <= steps; ++i) s.push(g.path, tmin + (tmax - tmin) * i / steps);
    // motionPathFrameSamples: every comp frame of the span (the velocity dots).
    const auto comp = comp_of_layer(pc.d, layer);
    const double fps = std::max(1.0, comp ? comp_fps(pc.d, *comp) : 30.0);
    const double dt = 1 / fps;
    constexpr double kEps = 1e-5;
    for (double t = tmin; t <= tmax + kEps; t += dt) {
      const double c = std::min(tmax, t);
      s.push(g.path_frames, c);
      if (c >= tmax - kEps) break;
    }
  }

  // motionPathTangents: each key's point and its effective in / out handles (NaN where none).
  for (std::size_t i = 0; i < times.size(); ++i) {
    const double t = times[i];
    const auto p = s.raw(t);
    const auto ix = key_index_at(xs, t);
    const auto iy = key_index_at(ys, t);
    const auto tx = ix ? effective_spatial_tangents_of(*xs, *ix) : std::pair<std::optional<double>, std::optional<double>>{};
    const auto ty = iy ? effective_spatial_tangents_of(*ys, *iy) : std::pair<std::optional<double>, std::optional<double>>{};
    std::optional<api::SpatialInterp> mode;
    if (ix && (*xs)[*ix].spatial) mode = (*xs)[*ix].spatial;
    else if (iy && (*ys)[*iy].spatial) mode = (*ys)[*iy].spatial;
    const bool linear = mode == api::SpatialInterp::linear;
    const auto [cx, cy] = s.to_comp(p[0], p[1]);
    std::array<double, 8> rec{t, cx, cy, p[2], kNaN, kNaN, kNaN, kNaN};
    if (!linear && i > 0) {
      const auto q = s.raw(times[i - 1]);
      const auto [hx, hy] = s.to_comp(p[0] + tx.first.value_or((q[0] - p[0]) / 3), p[1] + ty.first.value_or((q[1] - p[1]) / 3));
      rec[4] = hx;
      rec[5] = hy;
    }
    if (!linear && i + 1 < times.size()) {
      const auto q = s.raw(times[i + 1]);
      const auto [hx, hy] = s.to_comp(p[0] + tx.second.value_or((q[0] - p[0]) / 3), p[1] + ty.second.value_or((q[1] - p[1]) / 3));
      rec[6] = hx;
      rec[7] = hy;
    }
    g.path_keys.insert(g.path_keys.end(), rec.begin(), rec.end());
  }

  // The position at the frame's own time (the playhead marker).
  const double nowT = comp_to_keyframe_time(pc.d, pc.view, layer, seconds, "x");
  const auto now = s.raw(nowT);
  const auto [nx, ny] = s.to_comp(now[0], now[1]);
  g.path_now = {nx, ny, now[2], nowT};
}

// ── B4 round 5: the view cameras and the scene3d records (overlayScene3d.ts) ──

/// A resolved camera as the push carries it: position, focalLength, principal, yaw, pitch, roll.
std::vector<double> lens_of(const motion::xf::Camera& cam) {
  const double yaw = cam.orientation ? cam.orientation->yaw : 0;
  const double pitch = cam.orientation ? cam.orientation->pitch : 0;
  const double roll = cam.orientation ? cam.orientation->roll.value_or(0) : 0;
  return {cam.position.x, cam.position.y, cam.position.z, cam.focal_length, cam.principal.x, cam.principal.y, yaw, pitch, roll};
}

/// The composition's width / height (1920 × 1080 when it has no record).
std::pair<double, double> comp_size(const Document& d, const std::optional<std::string>& comp) {
  double cw = 1920;
  double ch = 1080;
  if (comp) {
    if (const Json* rec = d.comp(*comp); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
      cw = rec->at("width").num();
      ch = rec->at("height").num();
    }
  }
  return {cw, ch};
}

using Values = std::map<std::string, double, std::less<>>;

/// `defaultAnimation.evaluateNode(id, getRemappedTime(id, seconds))`.
Values values_at(const PCtx& pc, const std::string& id, double seconds) {
  Values av;
  for (auto& [prop, v] : anim_evaluate_node(pc.d, pc.expr, pc.cache, id, comp_to_keyframe_time(pc.d, pc.view, id, seconds))) {
    av.insert_or_assign(prop, v);
  }
  return av;
}

std::optional<double> value(const Values& av, std::string_view k) {
  const auto it = av.find(k);
  return it == av.end() ? std::nullopt : std::optional<double>(it->second);
}

/// The last component's number `k` carries (the camera readers' static props).
std::optional<double> static_num(const Node& n, std::string_view k) {
  std::optional<double> out;
  for (const Component& c : n.components) {
    if (const Json& v = c.props.at(k); v.is_number()) out = v.num();
  }
  return out;
}

/// threeD.ts `readNode3D(node)` field: the Transform's number, else 0.
double transform_prop(const Node& n, std::string_view k) {
  const Component* t = n.comp("Transform");
  if (t == nullptr) return 0;
  const Json& v = t->props.at(k);
  return v.is_number() ? v.num() : 0;
}

/// camera3d.ts `readCameraPoi(node, w, h, sample)` (nullopt: a one-node camera).
std::optional<motion::xf::Vec3> camera_poi(const Node& n, const Values& av, double w, double h) {
  std::optional<double> px = value(av, "poiX");
  std::optional<double> py = value(av, "poiY");
  std::optional<double> pz = value(av, "poiZ");
  if (!px) px = static_num(n, "poiX");
  if (!py) py = static_num(n, "poiY");
  if (!pz) pz = static_num(n, "poiZ");
  if (!px && !py && !pz) return std::nullopt;
  return motion::xf::Vec3{px.value_or(w / 2), py.value_or(h / 2), pz.value_or(0)};
}

/// camera3d.ts `readNodeDof(node, w, h, sample)` — the fields the focus plane reads: strength, focus, aperture,
/// focalLength, fStop (NaN = absent); empty when the camera has no blur level. (scene/camera3d_port.cpp is the
/// renderer's full port; engine_core cannot link the scene library.)
std::vector<double> camera_dof(const Node& n, const Values& av, double w, double h) {
  const auto pick = [&](std::string_view k) {
    const auto v = value(av, k);
    return v ? v : static_num(n, k);
  };
  const std::optional<double> strength = pick("dofStrength");
  if (!strength || std::isnan(*strength) || *strength <= 0) return {};
  const double lens = pick("focalLength").value_or(motion::xf::default_camera(w, h).focal_length);
  const std::optional<double> fStop = pick("fStop");
  return {*strength, pick("focusDistance").value_or(lens), pick("dofAperture").value_or(*strength), lens,
          fStop && *fStop > 0 ? *fStop : kNaN};
}

/// light.ts `lightType`.
std::string light_type_of(const Node& n) {
  std::string type = "point";
  for (const Component& c : n.components) {
    if (const Json& v = c.props.at("lightType"); v.is_string()) {
      const std::string& s = v.str();
      type = s == "ambient" || s == "spot" || s == "parallel" || s == "environment" ? s : "point";
    }
  }
  return type;
}

/// light.ts `readNodeLight`'s number `k` (the last component carrying it), else `fallback`.
double light_num(const Node& n, std::string_view k, double fallback) {
  return static_num(n, k).value_or(fallback);
}

/// A layer is inside its in/out bar at comp `seconds` (the renderer's `isLiveAt`: the governing bars — its own,
/// else the nearest plain group's — end-exclusive, the frame clamped to the composition's last).
bool live_at(const PCtx& pc, const Node& n, const std::string& comp, double seconds) {
  std::vector<const Bar*> clips = tl_bars_for_node(pc.d, pc.view, n.id);
  if (clips.empty()) {
    const Node* cur = &n;
    for (int depth = 0; depth < 32 && cur != nullptr && cur->parent; ++depth) {
      const Node* parent = pc.d.node(*cur->parent);
      if (parent == nullptr || is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(pc.d, pc.view, parent->id);
      if (!clips.empty()) break;
      cur = parent;
    }
  }
  if (clips.empty()) return true;
  const double fps = comp_fps(pc.d, comp);
  const double raw = motion::js::round(seconds * fps);
  double frame = raw;
  if (const Json* rec = pc.d.comp(comp); rec != nullptr && rec->at("durationSeconds").is_number()) {
    frame = std::min(raw, std::max(0.0, motion::js::round(rec->at("durationSeconds").num() * fps) - 1));
  }
  return std::ranges::any_of(clips, [frame](const Bar* b) { return b->active_at(frame); });
}

/// camera3d.ts `flattenComposition(graph, root)`: the root then its subtree depth-first in child order; no root
/// (or a missing one) = every root's (flattenScene).
std::vector<const Node*> flatten_comp(const Document& d, const std::optional<std::string>& root) {
  std::vector<const Node*> out;
  std::set<std::string> seen;
  std::function<void(const Node&)> walk = [&](const Node& n) {
    if (!seen.insert(n.id).second) return;
    out.push_back(&n);
    for (const auto& ch : n.children) {
      if (const Node* child = d.node(ch)) walk(*child);
    }
  };
  if (root) {
    if (const Node* r = d.node(*root)) {
      walk(*r);
      return out;
    }
  }
  for (const auto& [id, n] : d.nodes()) {
    if (!n->parent) walk(*n);
  }
  return out;
}

/// camera3d.ts `viewCameraNode(graph, mode, root, filter)`: a live `camera:<id>` view's camera, else the topmost
/// visible camera (that `live` accepts, when given).
const Node* view_camera_node(const std::vector<const Node*>& nodes, const std::string& mode,
                             const std::function<bool(const Node&)>& live) {
  constexpr std::string_view kPrefix = "camera:";
  if (mode.size() > kPrefix.size() && mode.starts_with(kPrefix)) {
    const std::string_view id = std::string_view(mode).substr(kPrefix.size());
    for (const Node* n : nodes) {
      if (n->id != id) continue;
      if (n->kind() == "camera" && n->visible) return n;
      break;
    }
  }
  for (std::size_t i = nodes.size(); i-- > 0;) {
    const Node* n = nodes[i];
    if (n->kind() != "camera" || !n->visible) continue;
    if (live && !live(*n)) continue;
    return n;
  }
  return nullptr;
}

// ── packing ───────────────────────────────────────────────────────────────

/// A conservative payload estimate for one record (field tags, lengths, the id, 8 bytes per f64).
std::size_t estimate(const api::OverlayLayerGeometry& g) {
  std::size_t doubles = g.matrix.size() + g.box.size() + g.corners.size() + g.path.size() + g.path_keys.size() + g.pins.size() +
                        g.bones.size() + g.text_box.size() + g.path_frames.size() + g.path_now.size() + g.local.size();
  std::size_t extra = 0;
  if (g.scene) {
    const api::OverlayScene3D& s = *g.scene;
    doubles += s.lens.size() + s.poi.size() + s.dof.size() + s.position.size() + s.light.size() + s.local.size() + s.parent.size() + 2;
    extra += 48 + s.light_type.size();
  }
  if (g.rig) extra += estimate_overlay_rig(*g.rig);  // B4 round 5 (overlay_rig_pack.cpp)
  return 48 + g.layer.size() + 8 * doubles + extra;
}

/// Per-message budget for records: the payload cap less the FrameGeometry header and slack.
constexpr std::size_t kRecordBudget = 3600;

/// Split the long arrays of `g` into pieces that each fit the budget; array groups stay whole.
std::vector<api::OverlayLayerGeometry> split(api::OverlayLayerGeometry g) {
  std::vector<api::OverlayLayerGeometry> out;
  api::OverlayLayerGeometry head;
  head.layer = g.layer;
  head.matrix = std::move(g.matrix);
  head.box = std::move(g.box);
  head.corners = std::move(g.corners);
  head.text_box = std::move(g.text_box);
  head.path_now = std::move(g.path_now);
  head.local = std::move(g.local);
  head.pins = std::move(g.pins);
  head.bones = std::move(g.bones);
  head.scene = std::move(g.scene);  // B4 round 5: rides the head record
  out.push_back(std::move(head));
  const std::size_t perPiece = (kRecordBudget - 48 - g.layer.size()) / 8;
  const auto chunk = [&](std::vector<double> api::OverlayLayerGeometry::*field, std::vector<double>& src, std::size_t group) {
    const std::size_t take = std::max<std::size_t>(group, (perPiece / group) * group);
    for (std::size_t i = 0; i < src.size(); i += take) {
      api::OverlayLayerGeometry piece;
      piece.layer = g.layer;
      const auto end = static_cast<std::ptrdiff_t>(std::min(src.size(), i + take));
      (piece.*field).assign(src.begin() + static_cast<std::ptrdiff_t>(i), src.begin() + end);
      out.push_back(std::move(piece));
    }
  };
  chunk(&api::OverlayLayerGeometry::path, g.path, 4);
  chunk(&api::OverlayLayerGeometry::path_keys, g.path_keys, 8);
  chunk(&api::OverlayLayerGeometry::path_frames, g.path_frames, 4);
  // B4 round 5: the rig travels in rig-only records, its arrays cut in whole groups (overlay_rig_pack.cpp).
  if (g.rig) split_overlay_rig(g.layer, std::move(*g.rig), kRecordBudget, out);
  return out;
}

}  // namespace

std::vector<std::pair<std::string, std::vector<api::OverlayKind>>> subscribed_layer_kinds(const OverlaySubscription& sub) {
  std::vector<std::pair<std::string, std::vector<api::OverlayKind>>> out;
  const auto add = [&out](const std::string& id, const std::vector<api::OverlayKind>& kinds) {
    auto it = std::find_if(out.begin(), out.end(), [&id](const auto& e) { return e.first == id; });
    if (it == out.end()) {
      out.emplace_back(id, std::vector<api::OverlayKind>{});
      it = std::prev(out.end());
    }
    for (const api::OverlayKind k : kinds) {
      if (std::find(it->second.begin(), it->second.end(), k) == it->second.end()) it->second.push_back(k);
    }
  };
  if (!sub.kinds.empty()) {
    for (const std::string& id : sub.layers) add(id, sub.kinds);
  }
  for (const api::OverlayRequest& g : sub.groups) {
    if (g.kinds.empty()) continue;
    for (const std::string& id : g.layers) add(id, g.kinds);
  }
  return out;
}

std::optional<api::OverlayScene3D> scene3d_of(const PCtx& pc, const std::string& layer, double seconds) {
  const Node* n = pc.d.node(layer);
  if (n == nullptr) return std::nullopt;
  const std::string kind = n->kind();
  const auto [w, h] = comp_size(pc.d, comp_of_layer(pc.d, layer));
  const SpaceCtx sc{pc.d, pc.view, pc.expr, pc.cache};
  api::OverlayScene3D rec;
  rec.role = api::Scene3DRole::layer;
  if (const auto parent = parent_world_at(sc, layer, seconds)) rec.parent.assign(parent->begin(), parent->end());
  if (kind == "camera") {
    const Values av = values_at(pc, layer, seconds);
    rec.role = api::Scene3DRole::camera;
    rec.lens = lens_of(camera_at(sc, *n, w, h, seconds));
    if (const auto localPoi = camera_poi(*n, av, w, h)) {
      const auto p = world_point_at(sc, layer, seconds, *localPoi);
      rec.poi = {p.x, p.y, p.z};
    }
    // camera3d.ts `readCameraFocusDistance`: focus ?? focal ?? defaultFocalLength(width).
    std::optional<double> focus = value(av, "focusDistance");
    if (!focus) focus = static_num(*n, "focusDistance");
    std::optional<double> focal = value(av, "focalLength");
    if (!focal) focal = static_num(*n, "focalLength");
    rec.focus_distance = focus ? *focus : focal ? *focal : motion::xf::default_camera(w, 1).focal_length;
    rec.dof = camera_dof(*n, av, w, h);
    return rec;
  }
  const auto geo = read_geometry_local(*n);
  if (kind == "light") {
    const Values av = values_at(pc, layer, seconds);
    rec.role = api::Scene3DRole::light;
    rec.light_type = light_type_of(*n);
    // liveWorld3d.ts `deviceWorldPosition`.
    const auto pos = world_point_at(sc, layer, seconds,
                                    {value(av, "x").value_or(geo ? geo->x : 0), value(av, "y").value_or(geo ? geo->y : 0),
                                     value(av, "z").value_or(transform_prop(*n, "z"))});
    rec.position = {pos.x, pos.y, pos.z};
    // light.ts: any ONE POI prop present aims the light (the others default to 0).
    const auto px = static_num(*n, "poiX");
    const auto py = static_num(*n, "poiY");
    const auto pz = static_num(*n, "poiZ");
    if (px || py || pz) {
      const auto p = world_point_at(sc, layer, seconds,
                                    {value(av, "poiX").value_or(px.value_or(0)), value(av, "poiY").value_or(py.value_or(0)),
                                     value(av, "poiZ").value_or(pz.value_or(0))});
      rec.poi = {p.x, p.y, p.z};
    }
    // liveWorld3d.ts `deviceWorldRotationDeg`: the Z spin of the world matrix.
    double worldRot = 0;
    if (const auto m = node_world_3d_at(sc, *n, seconds)) worldRot = std::atan2((*m)[1], (*m)[0]) * 180 / std::numbers::pi;
    rec.light = {value(av, "radius").value_or(light_num(*n, "radius", 500)),
                 value(av, "lightCone").value_or(light_num(*n, "lightCone", 45)),
                 value(av, "lightConeFeather").value_or(light_num(*n, "lightConeFeather", 50)),
                 value(av, "lightAngle").value_or(light_num(*n, "lightAngle", 0)) + worldRot};
    return rec;
  }
  if (!can_be_3d(*n) || !is_3d_enabled(*n)) return std::nullopt;
  // ports.ts `sampleTransform3DAtPlayhead` at the frame's time.
  const Values av = values_at(pc, layer, seconds);
  const auto sc2 = value(av, "scale");
  std::optional<double> scaleZ = value(av, "scaleZ");
  if (!scaleZ) {
    const Component* t = n->comp("Transform");
    const Json* v = t != nullptr ? &t->props.at("scaleZ") : nullptr;
    scaleZ = v != nullptr && v->is_number() && std::isfinite(v->num()) ? v->num() : 1.0;
  }
  rec.local = {value(av, "x").value_or(geo ? geo->x : 0),
               value(av, "y").value_or(geo ? geo->y : 0),
               value(av, "z").value_or(transform_prop(*n, "z")),
               value(av, "rotationX").value_or(transform_prop(*n, "rotationX")),
               value(av, "rotationY").value_or(transform_prop(*n, "rotationY")),
               value(av, "rotation").value_or(geo ? geo->rotation : 0),
               value(av, "scaleX") ? *value(av, "scaleX") : sc2 ? *sc2 : geo ? geo->scale_x : 1,
               value(av, "scaleY") ? *value(av, "scaleY") : sc2 ? *sc2 : geo ? geo->scale_y : 1,
               *scaleZ};
  rec.extrusion = std::max(0.0, value(av, "extrusionDepth").value_or(std::max(0.0, transform_prop(*n, "extrusionDepth"))));
  return rec;
}

std::vector<api::OverlayView> overlay_views(const PCtx& pc, const OverlaySubscription& sub,
                                            const std::optional<std::string>& comp, api::Time time) {
  std::vector<api::OverlayView> out;
  if (sub.views.empty()) return out;
  const double seconds = flicks_to_seconds(time);
  const auto [w, h] = comp_size(pc.d, comp);
  const std::vector<const Node*> nodes = flatten_comp(pc.d, comp);
  const SpaceCtx sc{pc.d, pc.view, pc.expr, pc.cache};
  for (const std::string& mode : sub.views) {
    api::OverlayView v;
    v.mode = mode;
    v.comp_width = w;
    v.comp_height = h;
    const Node* chrome = view_camera_node(nodes, mode, {});
    const Node* live = comp ? view_camera_node(nodes, mode, [&](const Node& n) { return live_at(pc, n, *comp, seconds); })
                            : chrome;
    if (chrome != nullptr) v.camera = chrome->id;
    if (live != nullptr) v.live_camera = live->id;
    v.lens = lens_of(chrome != nullptr ? camera_at(sc, *chrome, w, h, seconds) : motion::xf::default_camera(w, h));
    out.push_back(std::move(v));
  }
  return out;
}

std::vector<api::OverlayLayerGeometry> overlay_geometry(const PCtx& pc, TextQueries* text, const OverlaySubscription& sub,
                                                       api::Time time) {
  std::vector<api::OverlayLayerGeometry> out;
  if (!sub.active()) return out;
  const double seconds = flicks_to_seconds(time);
  // B4 round 5: each layer with ITS kinds (the `layers` × `kinds` list, then the groups).
  for (const auto& [layer, kinds] : subscribed_layer_kinds(sub)) {
    // A layer is a node with a parent (require_layer's test); a composition root or a gone id is skipped.
    const Node* n = pc.d.node(layer);
    if (n == nullptr || !n->parent) continue;
    const auto wants = [&kinds](api::OverlayKind k) { return std::find(kinds.begin(), kinds.end(), k) != kinds.end(); };
    api::OverlayLayerGeometry g;
    g.layer = layer;
    if (wants(api::OverlayKind::transform)) {
      g.matrix = matrix_of(pc, layer, seconds);
      g.local = local_of(pc, *n, seconds);
    }
    if (wants(api::OverlayKind::bounds)) (void)bounds_of(pc, text, layer, seconds, g);
    if (wants(api::OverlayKind::motion_path)) motion_path_of(pc, layer, seconds, g);
    if (wants(api::OverlayKind::text_box)) text_box_of(pc, text, layer, seconds, g);
    // rig (pins / bones): not produced yet — the rig sampler is scene-side (ENGINE_API.md §15.12).
    if (wants(api::OverlayKind::scene3d)) g.scene = scene3d_of(pc, layer, seconds);
    out.push_back(std::move(g));
  }
  return out;
}

std::vector<api::FrameGeometry> pack_frame_geometry(std::uint32_t viewport, std::uint32_t generation, std::int64_t frame,
                                                   api::Time time, api::Revision revision,
                                                   std::vector<api::OverlayLayerGeometry> layers,
                                                   std::vector<api::OverlayView> views) {
  std::vector<api::FrameGeometry> out;
  const auto fresh = [&] {
    api::FrameGeometry m;
    m.viewport = viewport;
    m.generation = generation;
    m.frame = frame;
    m.time = time;
    m.revision = revision;
    return m;
  };
  api::FrameGeometry cur = fresh();
  std::size_t used = 0;
  // B4 round 5: the views ride the first message (a handful of small records).
  for (const api::OverlayView& v : views) used += 48 + v.mode.size() + v.camera.size() + v.live_camera.size() + 8 * v.lens.size();
  cur.views = std::move(views);
  for (api::OverlayLayerGeometry& g : layers) {
    for (api::OverlayLayerGeometry& piece : split(std::move(g))) {
      const std::size_t size = estimate(piece);
      if (used > 0 && used + size > kRecordBudget) {
        out.push_back(std::move(cur));
        cur = fresh();
        used = 0;
      }
      used += size;
      cur.layers.push_back(std::move(piece));
    }
  }
  cur.last = true;
  out.push_back(std::move(cur));
  return out;
}

}  // namespace premation::doc
