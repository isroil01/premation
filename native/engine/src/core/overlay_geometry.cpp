#include "overlay_geometry.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <set>
#include <utility>

#include "anim.hpp"
#include "readmodel.hpp"
#include "fail.hpp"
#include "layer_geometry.hpp"
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
  const auto now = s.raw(comp_to_keyframe_time(pc.d, pc.view, layer, seconds, "x"));
  const auto [nx, ny] = s.to_comp(now[0], now[1]);
  g.path_now = {nx, ny, now[2]};
}

// ── packing ───────────────────────────────────────────────────────────────

/// A conservative payload estimate for one record (field tags, lengths, the id, 8 bytes per f64).
std::size_t estimate(const api::OverlayLayerGeometry& g) {
  std::size_t doubles = g.matrix.size() + g.box.size() + g.corners.size() + g.path.size() + g.path_keys.size() + g.pins.size() +
                        g.bones.size() + g.text_box.size() + g.path_frames.size() + g.path_now.size();
  return 48 + g.layer.size() + 8 * doubles;
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
  head.pins = std::move(g.pins);
  head.bones = std::move(g.bones);
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
  return out;
}

}  // namespace

std::vector<api::OverlayLayerGeometry> overlay_geometry(const PCtx& pc, TextQueries* text, const OverlaySubscription& sub,
                                                       api::Time time) {
  std::vector<api::OverlayLayerGeometry> out;
  if (!sub.active()) return out;
  const double seconds = flicks_to_seconds(time);
  for (const std::string& layer : sub.layers) {
    // A layer is a node with a parent (require_layer's test); a composition root or a gone id is skipped.
    const Node* n = pc.d.node(layer);
    if (n == nullptr || !n->parent) continue;
    api::OverlayLayerGeometry g;
    g.layer = layer;
    if (sub.wants(api::OverlayKind::transform)) g.matrix = matrix_of(pc, layer, seconds);
    if (sub.wants(api::OverlayKind::bounds)) (void)bounds_of(pc, text, layer, seconds, g);
    if (sub.wants(api::OverlayKind::motion_path)) motion_path_of(pc, layer, seconds, g);
    if (sub.wants(api::OverlayKind::text_box)) text_box_of(pc, text, layer, seconds, g);
    // rig (pins / bones): not produced yet — the rig sampler is scene-side (ENGINE_API.md §15.12).
    out.push_back(std::move(g));
  }
  return out;
}

std::vector<api::FrameGeometry> pack_frame_geometry(std::uint32_t viewport, std::uint32_t generation, std::int64_t frame,
                                                   api::Time time, api::Revision revision,
                                                   std::vector<api::OverlayLayerGeometry> layers) {
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
