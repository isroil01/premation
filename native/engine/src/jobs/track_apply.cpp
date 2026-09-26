#include "track_apply.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <variant>

#include "fail.hpp"
#include "fxstate.hpp"
#include "job_apply_util.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "time_conv.hpp"

namespace premation::jobs::trackapply {

using api::ErrorCode;
using doc::fail;

// ── Buckets ─────────────────────────────────────────────────────────────

Buckets::Buckets(const std::vector<std::string>& names) {
  for (const std::string& n : names) w_.push_back(Write{n, {}});
}

void Buckets::add(std::string_view track, double compTime, double value) {
  auto it = std::find_if(w_.begin(), w_.end(), [&](const Write& w) { return w.track == track; });
  if (it == w_.end()) {
    w_.push_back(Write{std::string(track), {}});
    it = std::prev(w_.end());
  }
  it->keys.emplace_back(compTime, value);
}

std::vector<Write> Buckets::writes() const {
  std::vector<Write> out;
  for (const Write& w : w_) {
    if (!w.keys.empty()) out.push_back(w);
  }
  return out;
}

double unwrap_deg(double delta, double prev) noexcept {
  while (delta - prev > 180) delta -= 360;
  while (delta - prev < -180) delta += 360;
  return delta;
}

// ── DocView ─────────────────────────────────────────────────────────────

DocView::DocView(const doc::Document& d, std::string_view comp) : d_(d), env_(d, view_, cache_) {
  view_.tabComp = std::string(comp);
  if (const doc::Json* c = d.comp(comp); c != nullptr) {
    if (c->at("width").is_number() && c->at("width").num() > 0) compW_ = c->at("width").num();
    if (c->at("height").is_number() && c->at("height").num() > 0) compH_ = c->at("height").num();
  }
}

std::optional<std::string> DocView::parent_of(std::string_view id) const {
  const doc::Node* n = d_.node(id);
  return n != nullptr ? n->parent : std::nullopt;
}

bool DocView::is_camera(std::string_view id) const {
  const doc::Node* n = d_.node(id);
  return n != nullptr && n->kind() == "camera";
}

std::optional<Geometry> DocView::geometry(std::string_view id) const {
  const doc::Node* n = d_.node(id);
  if (n == nullptr) return std::nullopt;
  const std::optional<motion::xf::Local2D> l = doc::read_geometry_local(*n);
  if (!l) return std::nullopt;
  Geometry g;
  g.local = *l;
  for (const doc::Component& c : n->components) {
    if (c.props.at("width").is_number()) g.width = c.props.at("width").num();
    if (c.props.at("height").is_number()) g.height = c.props.at("height").num();
  }
  return g;
}

std::optional<doc::LayerSpace> DocView::space(std::string_view id, double compTime) const {
  const doc::SpaceCtx c{d_, view_, env_, cache_};
  return doc::layer_space_at(c, id, compTime, compW_, compH_);
}

P2 DocView::to_comp(const doc::LayerSpace& s, P2 p) {
  const motion::xf::Vec2 q = std::visit([&](const auto& sp) { return sp.to_comp(motion::xf::Vec2{p.x, p.y}); }, s);
  return P2{q.x, q.y};
}

P2 DocView::from_comp(const doc::LayerSpace& s, P2 p) {
  const motion::xf::Vec2 q = std::visit([&](const auto& sp) { return sp.from_comp(motion::xf::Vec2{p.x, p.y}); }, s);
  return P2{q.x, q.y};
}

double DocView::key_time(std::string_view id, double compTime) const {
  return doc::comp_to_keyframe_time(d_, view_, id, compTime);
}

std::optional<double> DocView::sample(std::string_view id, std::string_view track, double keyTime) const {
  return doc::anim_sample(d_, env_, cache_, id, track, keyTime);
}

std::optional<P2> DocView::sample_to_comp(std::string_view video, double x, double y, double compTime, double sourceWidth,
                                          double sourceHeight, P2 boxFallback) const {
  if (sourceWidth <= 0 || sourceHeight <= 0) return std::nullopt;
  const std::optional<Geometry> g = geometry(video);
  if (!g) return std::nullopt;
  const std::optional<doc::LayerSpace> sp = space(video, compTime);
  if (!sp) return std::nullopt;
  const double gw = g->width.value_or(boxFallback.x);
  const double gh = g->height.value_or(boxFallback.y);
  const double lx = (x / sourceWidth - 0.5) * gw;
  const double ly = (y / sourceHeight - 0.5) * gh;
  return to_comp(*sp, P2{lx, ly});
}

double DocView::member_stored_at(std::string_view layer, std::string_view member, double compTime) const {
  if (d_.node(layer) == nullptr) return 0;
  if (doc::anim_is_animated(d_, layer, member)) {
    if (const std::optional<double> v = sample(layer, member, key_time(layer, compTime))) return *v;
  }
  return doc::read_static_property_value(d_, layer, member).value_or(0);
}

std::string DocView::first_effect_of_type(std::string_view layer, std::string_view type) const {
  for (const doc::Json& e : doc::get_node_effects(d_, layer)) {
    if (e.at("type").is_string() && e.at("type").str() == type && e.at("id").is_string()) return e.at("id").str();
  }
  return {};
}

std::string DocView::effect_type(std::string_view layer, std::string_view id) const {
  for (const doc::Json& e : doc::get_node_effects(d_, layer)) {
    if (e.at("id").is_string() && e.at("id").str() == id) return e.at("type").is_string() ? e.at("type").str() : std::string();
  }
  return {};
}

// ── send ────────────────────────────────────────────────────────────────

namespace {

struct Group {
  doc::PropBinding b;
  std::map<std::string, std::map<double, double>, std::less<>> byMember;
};

}  // namespace

void send_plan(JobApply& a, const Plan& plan) {
  if (plan.writes.empty()) return;
  const doc::Document& d = a.document();
  const std::optional<std::string> comp = doc::comp_of_layer(d, plan.layer);
  if (!comp) fail(ErrorCode::not_found, "no layer '" + plan.layer + "'", {.layer = plan.layer});

  // An effect plan keys the named effect, else the first of its type (added when there is none).
  std::string effectId = plan.effectId;
  if (!plan.effectType.empty() && effectId.empty()) {
    effectId = DocView(d, *comp).first_effect_of_type(plan.layer, plan.effectType);
    if (effectId.empty()) {
      api::AddEffect add;
      add.layers = {plan.layer};
      add.effect = plan.effectType;
      (void)a.run(command(std::move(add)));
      effectId = DocView(d, *comp).first_effect_of_type(plan.layer, plan.effectType);
      if (effectId.empty()) fail(ErrorCode::internal, "no " + plan.effectType + " effect to key");
    }
  }

  const DocView v(d, *comp);
  const doc::Catalog cat = doc::catalog_for(d, plan.layer);
  // planSplices: member tracks of one API property go out together.
  std::vector<Group> groups;
  for (const Write& w : plan.writes) {
    if (w.keys.empty()) continue;
    const std::string track = plan.effectType.empty() ? w.track : "effect." + effectId + "." + w.track;
    const doc::PropBinding* b = cat.by_member(track);
    if (b == nullptr) b = cat.find(track);
    if (b == nullptr || b->members.empty()) {
      fail(ErrorCode::not_found, "'" + track + "' cannot be keyed on this layer", {.layer = plan.layer});
    }
    auto g = std::find_if(groups.begin(), groups.end(), [&](const Group& x) { return x.b.path == b->path; });
    if (g == groups.end()) {
      groups.push_back(Group{*b, {}});
      g = std::prev(groups.end());
    }
    std::map<double, double>& m = g->byMember[track];
    for (const auto& [t, value] : w.keys) m.insert_or_assign(t, value);
  }

  // keySpliceEdits.ts spliceSteps: what is there now and which of it the span drops (read BEFORE the adds).
  const api::Time eps = doc::seconds_to_flicks(1e-6);
  std::vector<std::string> doomed;
  api::AddKeyframes add;
  for (const Group& g : groups) {
    std::set<double> times;
    for (const auto& [member, keys] : g.byMember) {
      for (const auto& kv : keys) times.insert(kv.first);
    }
    // uniqueKeys: one key per keyframe-axis time, the first (in time order) wins.
    std::set<double> seen;
    std::vector<api::Time> flicks;
    for (const double seconds : times) {
      const double kt = doc::comp_to_keyframe_time(d, doc::EditorView{*comp, 0}, plan.layer, seconds, g.b.lead());
      if (!seen.insert(kt).second) continue;
      std::vector<double> nums;
      nums.reserve(g.b.members.size());
      for (const std::string& member : g.b.members) {
        const auto m = g.byMember.find(member);
        std::optional<double> given;
        if (m != g.byMember.end()) {
          if (const auto k = m->second.find(seconds); k != m->second.end()) given = k->second;
        }
        const double stored = given ? *given : v.member_stored_at(plan.layer, member, seconds);
        nums.push_back(stored * doc::api_unit_factor(member));
      }
      api::KeyframeInsert k;
      k.prop = api::PropRef{plan.layer, g.b.path};
      k.time = doc::seconds_to_flicks(seconds);
      k.value = doc::vector_value(g.b.valueType, nums);
      k.easing = api::Easing::linear;
      flicks.push_back(k.time);
      add.keys.push_back(std::move(k));
    }
    if (flicks.empty()) continue;
    const api::Time lo = *std::min_element(flicks.begin(), flicks.end()) - eps;
    const api::Time hi = *std::max_element(flicks.begin(), flicks.end()) + eps;
    for (const doc::KeyAt& k : doc::read_keys(d, plan.layer, g.b)) {
      const api::Time t =
          doc::seconds_to_flicks(doc::keyframe_to_comp_time(d, doc::EditorView{*comp, 0}, plan.layer, k.t, g.b.lead()));
      if (t >= lo && t <= hi) doomed.push_back(k.id);
    }
  }
  if (add.keys.empty()) return;
  const std::optional<api::KeyframeIds> added = result_payload<api::KeyframeIds>(a.run(command(std::move(add))));
  const std::vector<std::string> kept = added ? added->ids : std::vector<std::string>{};
  api::DeleteKeyframes del;
  for (const std::string& id : doomed) {
    if (std::find(kept.begin(), kept.end(), id) == kept.end() &&
        std::find(del.ids.begin(), del.ids.end(), id) == del.ids.end()) {
      del.ids.push_back(id);
    }
  }
  if (!del.ids.empty()) (void)a.run(command(std::move(del)));
}

}  // namespace premation::jobs::trackapply
