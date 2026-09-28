#include "rig_overlay.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "fail.hpp"
#include "layer_geometry.hpp"
#include "rig_mesh.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::scene {

namespace {

using js::Json;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
/// vectorDraw.ts MAX_GLYPH_PAD.
constexpr double kMaxPad = 512;
/// PuppetOverlay's pin path samples per key span.
constexpr std::size_t kPinPathSegments = 24;

double num_or_nan(const Json& v) { return v.is_number() ? v.num() : kNaN; }

/// nodeRestMesh's pad: rasterPadding of `{kind: ellipse ? 'shape' : 'rect', stroke, strokes, paint}` — a rect
/// record takes the non-shape branch (no effects, no glyphs, not text: 0); an ellipse its strokes' reach and
/// its paint's (no path points, no primitive: no path escape, no miter).
double mesh_pad(const doc::Node& n, bool ellipse, const std::function<double(const Json&)>& paintReach) {
  if (!ellipse) return 0;
  std::vector<const Json*> strokes;
  const doc::Component* many = n.comp("Strokes");
  if (many != nullptr && many->props.at("strokes").is_array() && !many->props.at("strokes").arr().empty()) {
    for (const Json& s : many->props.at("strokes").arr()) strokes.push_back(&s);
  } else if (const doc::Component* one = n.comp("Stroke"); one != nullptr && one->props.at("stroke").is_object()) {
    strokes.push_back(&one->props.at("stroke"));
  }
  double pad = 0;
  for (const Json* s : strokes) {
    if (!s->is_object() || !(s->at("width").num() > 0)) continue;
    const std::string align = s->at("align").is_string() ? s->at("align").str() : "center";
    if (align == "inside") continue;
    const double width = s->at("width").num();
    const double band = align == "outside" ? width * 2 : width;
    const Json& w = s->at("wave");
    const bool identityWave = !w.is_object() || w.at("amount").num() == 0 || w.at("wavelength").num() <= 0;
    pad = std::max(pad, band + (identityWave ? 0 : std::abs(w.at("amount").num())));
  }
  if (paintReach) {
    if (const doc::Component* p = n.comp("Paint"); p != nullptr) pad = std::max(pad, paintReach(p->props.at("paint")));
  }
  return pad > 0 ? std::min(kMaxPad, std::ceil(pad + 1)) : 0;
}

struct Resolved {
  std::optional<RigModel> model;
  double rigT = 0;
};

/// The layer's rig model at comp `seconds` (nodeRestMesh's inputs, the document's animation).
Resolved resolve(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr, doc::ExprCache& cache,
                 TextQueries* text, const RigMediaHooks& hooks, std::string_view layer, double seconds, bool authoring) {
  Resolved out;
  const doc::Node* n = d.node(layer);
  if (n == nullptr || !n->parent) return out;
  const Json& fx = n->fx();
  if (!authoring && !rig_present(fx)) return out;
  std::optional<doc::LayerGeometry> geo;
  try {
    geo = doc::layer_geometry_at(doc::SpaceCtx{d, view, expr, cache}, text, layer, seconds);
  } catch (const doc::EngineFail&) {
    return out;  // a layer the text port cannot measure: no rig this frame
  }
  if (!geo) return out;
  const std::string kind = n->kind();
  const bool imageLike = kind == "image" || kind == "svg";
  RigInputs in;
  in.fx = &fx;
  in.width = geo->width;
  in.height = geo->height;
  in.pad = mesh_pad(*n, geo->ellipse, hooks.paintReach);
  if (const doc::Component* g = n->comp("Geometry"); g != nullptr && g->props.at("points").is_array()) {
    in.pathPoints = &g->props.at("points");
    in.pathOpen = g->props.at("open").is_bool() && g->props.at("open").b();
  }
  const bool pathSilhouette = !in.pathOpen && in.pathPoints != nullptr && in.pathPoints->arr().size() >= 3;
  std::shared_ptr<const rig::CoverageMask> coverage;
  if (imageLike && !pathSilhouette && hooks.coverage) {
    std::string unreachable;
    coverage = hooks.coverage(d, *n, unreachable);
    if (!unreachable.empty()) return out;
  }
  in.coverage = coverage.get();
  out.rigT = doc::comp_to_keyframe_time(d, view, layer, seconds);
  in.rigT = out.rigT;
  const std::string id(layer);
  RigSampler s;
  s.sample = [&d, &expr, &cache, &id](std::string_view path, double t) { return doc::anim_sample(d, expr, cache, id, path, t); };
  s.sampleData = [&d, &id](std::string_view path, double t) -> std::optional<Json> {
    const doc::DataTrack* tr = doc::anim_data_track(d, id, path);
    if (tr == nullptr) return std::nullopt;
    return doc::sample_data_track(*tr, t);
  };
  std::vector<std::string> unported;
  out.model = build_rig_model(in, s, authoring, imageLike, unported);
  return out;
}

void xy_pairs(const std::vector<float>& v, std::vector<double>& out) {
  out.reserve(v.size() / 2);
  for (std::size_t i = 0; i + 1 < v.size(); i += 4) {
    out.push_back(v[i]);
    out.push_back(v[i + 1]);
  }
}

api::RigBonePose bone_pose(const RigBoneOut& b) {
  api::RigBonePose o;
  o.id = b.id;
  o.x = b.x;
  o.y = b.y;
  o.rotation = b.rotation;
  o.scale_x = b.scaleX;
  o.scale_y = b.scaleY;
  o.posed_x = b.posedX;
  o.posed_y = b.posedY;
  o.posed_rotation = b.posedRotation;
  if (b.world) o.world.assign(b.world->begin(), b.world->end());
  return o;
}

api::RigIkGoal ik_goal(const RigIkOut& g) {
  api::RigIkGoal o;
  o.bone = g.bone;
  o.enabled = g.enabled;
  o.x = g.x;
  o.y = g.y;
  if (g.pole) o.pole = {(*g.pole)[0], (*g.pole)[1]};
  o.chain_length = g.chainLength;
  o.mode = g.mode;
  return o;
}

/// A data key's first point (`(k.value as DataPoint[])?.[0]`), when it is one.
std::optional<std::array<double, 2>> point_of(const Json& value) {
  if (!value.is_array() || value.arr().empty() || !value.arr()[0].is_object()) return std::nullopt;
  const Json& p = value.arr()[0];
  return std::array<double, 2>{num_or_nan(p.at("x")), num_or_nan(p.at("y"))};
}

/// A key's spatial tangent for point 0 (`k.so?.[0]`), when it carries one.
std::optional<std::array<double, 2>> tangent_of(const std::optional<Json>& list) {
  if (!list || !list->is_array() || list->arr().empty() || !list->arr()[0].is_object()) return std::nullopt;
  const Json& t = list->arr()[0];
  return std::array<double, 2>{t.at("x").is_number() ? t.at("x").num() : kNaN, t.at("y").is_number() ? t.at("y").num() : kNaN};
}

/// The focus pin's trajectory and keys (PuppetOverlay's motion path; dataPathTangents over its Position track).
void pin_path(const doc::Document& d, std::string_view layer, const std::string& pin, const RigModel& m, api::OverlayRig& out) {
  const doc::DataTrack* tr = doc::anim_data_track(d, layer, "puppet." + pin + ".position");
  if (tr == nullptr || tr->keys.size() < 2) return;
  const auto& keys = tr->keys;
  const double first = keys.front().t;
  const double last = keys.back().t;
  const std::size_t steps = kPinPathSegments * (keys.size() - 1);
  for (std::size_t i = 0; i <= steps; ++i) {
    const auto v = doc::sample_data_track(*tr, first + (last - first) * static_cast<double>(i) / static_cast<double>(steps));
    if (!v) continue;
    const auto p = point_of(*v);
    if (!p) continue;
    const auto s = m.skin((*p)[0], (*p)[1]);
    out.pin_path.push_back(s[0]);
    out.pin_path.push_back(s[1]);
  }
  for (std::size_t i = 0; i < keys.size(); ++i) {
    const auto p = point_of(keys[i].value);
    const double px = p ? (*p)[0] : 0;
    const double py = p ? (*p)[1] : 0;
    std::optional<std::array<double, 2>> in;
    std::optional<std::array<double, 2>> outH;
    if (p && i + 1 < keys.size()) {
      if (const auto nx = point_of(keys[i + 1].value)) {
        const auto so = tangent_of(keys[i].so);
        const double sx = so && !std::isnan((*so)[0]) ? (*so)[0] : ((*nx)[0] - px) / 3;
        const double sy = so && !std::isnan((*so)[1]) ? (*so)[1] : ((*nx)[1] - py) / 3;
        outH = std::array<double, 2>{px + sx, py + sy};
      }
    }
    if (p && i > 0) {
      if (const auto pv = point_of(keys[i - 1].value)) {
        const auto si = tangent_of(keys[i].si);
        const double sx = si && !std::isnan((*si)[0]) ? (*si)[0] : ((*pv)[0] - px) / 3;
        const double sy = si && !std::isnan((*si)[1]) ? (*si)[1] : ((*pv)[1] - py) / 3;
        in = std::array<double, 2>{px + sx, py + sy};
      }
    }
    const auto posed = m.skin(px, py);
    const auto pin_ = in ? m.skin((*in)[0], (*in)[1]) : std::array<double, 2>{kNaN, kNaN};
    const auto pout = outH ? m.skin((*outH)[0], (*outH)[1]) : std::array<double, 2>{kNaN, kNaN};
    out.pin_keys.insert(out.pin_keys.end(), {keys[i].t, px, py, posed[0], posed[1], pin_[0], pin_[1], pout[0], pout[1]});
  }
}

}  // namespace

std::optional<api::OverlayRig> DocRigQueries::rig_overlay(const doc::Document& d, const doc::EditorView& view,
                                                          const doc::ExprEnv& expr, doc::ExprCache& cache, TextQueries* text,
                                                          std::string_view layer, double seconds,
                                                          const api::OverlayRigOptions& opts) {
  const Resolved r = resolve(d, view, expr, cache, text, hooks_, layer, seconds, opts.authoring);
  if (!r.model) return std::nullopt;
  const RigModel& m = *r.model;
  api::OverlayRig out;
  for (const RigPinOut& p : m.pins) {
    api::RigPinPose o;
    o.id = p.id;
    o.kind = p.kind;
    o.x = p.x;
    o.y = p.y;
    o.cx = p.cx;
    o.cy = p.cy;
    o.rotation = p.rotation;
    o.scale = p.scale;
    out.pins.push_back(std::move(o));
  }
  for (const RigBoneOut& b : m.bones) out.bones.push_back(bone_pose(b));
  for (const RigIkOut& g : m.ik) out.ik.push_back(ik_goal(g));
  xy_pairs(m.vertices, out.vertices);
  xy_pairs(m.rest(), out.rest);
  out.triangles.assign(m.triangles().begin(), m.triangles().end());
  out.edges = m.lattice_edges();
  if (!opts.bone.empty()) out.weights = m.bone_weights(opts.bone);
  if (!opts.pin.empty()) pin_path(d, layer, opts.pin, m, out);
  return out;
}

api::RigPose DocRigQueries::rig_pose(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                     doc::ExprCache& cache, TextQueries* text, std::string_view layer, double seconds,
                                     const std::vector<api::Vec2>& points, std::optional<std::uint32_t> vertex, bool authoring) {
  const Resolved r = resolve(d, view, expr, cache, text, hooks_, layer, seconds, authoring);
  api::RigPose out;
  for (const api::Vec2& p : points) {
    std::array<double, 2> rest{p.x, p.y};
    if (r.model) rest = r.model->unskin(p.x, p.y);
    out.rest.push_back(api::Vec2{rest[0], rest[1]});
    const auto anchor = r.model ? r.model->rest_from_deformed(rest[0], rest[1]) : std::nullopt;
    out.anchors.push_back(anchor ? api::Vec2{(*anchor)[0], (*anchor)[1]} : api::Vec2{rest[0], rest[1]});
  }
  if (!r.model) return out;
  for (const RigBoneOut& b : r.model->bones) out.bones.push_back(bone_pose(b));
  for (const RigIkOut& g : r.model->ik) out.ik.push_back(ik_goal(g));
  out.vertex_count = static_cast<std::uint32_t>(r.model->rest().size() / 4);
  if (vertex) {
    for (auto& [bone, weight] : r.model->vertex_weights(*vertex)) out.weights.push_back(api::RigBoneWeight{bone, weight});
  }
  return out;
}

}  // namespace premation::scene
