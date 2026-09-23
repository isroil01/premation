#include "handlers_properties.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>

#include "docexpr.hpp"
#include "fxstate.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

// ── binding ─────────────────────────────────────────────────────────────

struct Bound {
  std::string layer;
  PropBinding b;
};

/// properties.ts `bind(prop)`.
Bound bind(const HCtx& x, const api::PropRef& prop) {
  (void)require_layer(x.d, prop.layer);
  const Catalog cat = catalog_for(x.d, prop.layer);
  return Bound{prop.layer, require_binding(cat, prop.path)};
}

bool is_special(const PropBinding& b) { return b.special != Special::none; }

/// `String.prototype.trim() === ''` (JS WhiteSpace + LineTerminator).
bool js_blank(std::string_view s) {
  for (const char16_t c : to_u16(s)) {
    const bool ws = c == u'\t' || c == u'\n' || c == 0x0B || c == 0x0C || c == u'\r' || c == u' ' || c == 0xA0 ||
                    c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F ||
                    c == 0x205F || c == 0x3000 || c == 0xFEFF;
    if (!ws) return false;
  }
  return true;
}

/// `JSON.stringify({ expected: want })`.
std::string expected_detail(api::ValueType t) {
  Json o = Json::object();
  o.set("expected", Json::string(std::string(value_type_name(t))));
  return js::stringify(o);
}

/// properties.ts `checkValue(b, v)`: type-check a value WITHOUT writing it.
void check_value(const PropBinding& b, const api::Value& v) {
  if (b.special == Special::sourceText) {
    if (v.kind() != VK::text_document && v.kind() != VK::string) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a textDocument", {.path = b.path});
    }
    return;
  }
  if (is_special(b) || b.dataTrack) {
    const std::string_view want = value_type_name(b.valueType);
    if (kind_name(v.kind()) != want) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a " + std::string(want) + ", got " + std::string(kind_name(v.kind())),
           {.path = b.path, .detail = expected_detail(b.valueType)});
    }
    return;
  }
  (void)numbers_of(b, v);
}

/// `newKeyId(b, ctx)`: mask-shape keys are per-mask views of one entry.
std::string new_key_id(const PropBinding& b, HCtx& x) {
  std::string id = x.mint_key_id();
  if (b.special == Special::maskPath) return id + "@" + b.maskId.value_or("undefined");
  return id;
}

const KeyAt* key_at_time(const std::vector<KeyAt>& keys, double t) {
  for (const KeyAt& k : keys) {
    if (k.t == t) return &k;
  }
  return nullptr;
}

// ── planWrite ───────────────────────────────────────────────────────────

struct PlannedWrite {
  std::string layer;
  PropBinding b;
  api::Value value;
  bool keyed = false;
  double t = 0;
  std::string id;
};

/// `planWrite(layer, b, value, time, ctx)`: validate + mint now, write later.
PlannedWrite plan_write(HCtx& x, const std::string& layer, const PropBinding& b, const api::Value& value,
                        std::optional<api::Time> time) {
  check_value(b, value);
  if (time) check_time(*time);
  PlannedWrite p{layer, b, value, false, 0, {}};
  const bool animated = is_animated(x.d, layer, b);
  if (!animated) {
    if (b.separated && std::any_of(b.members.begin(), b.members.end(),
                                   [&](const std::string& m) { return anim_is_animated(x.d, layer, m); })) {
      fail(ErrorCode::animated, "'" + b.path + "' has separated, animated dimensions; write them one by one",
           {.layer = layer, .path = b.path});
    }
    return p;
  }
  if (!time) fail(ErrorCode::animated, "'" + b.path + "' is animated: give a time to key it", {.layer = layer, .path = b.path});
  const PCtx pc = x.pc();
  p.keyed = true;
  p.t = flicks_to_key_time(pc, layer, b, *time);
  const std::vector<KeyAt> keys = read_keys(x.d, layer, b);
  const KeyAt* existing = key_at_time(keys, p.t);
  p.id = existing == nullptr || existing->id.starts_with("@") ? new_key_id(b, x) : existing->id;
  return p;
}

std::optional<std::string> apply_write(HCtx& x, const PlannedWrite& p) {
  if (!p.keyed) {
    write_static(x.d, p.layer, p.b, p.value);
    return std::nullopt;
  }
  KeyWrite w;
  w.t = p.t;
  w.id = p.id;
  w.value = p.value;
  put_keys(x.pc(), p.layer, p.b, {w});
  return p.id;
}

// ── retime (keeps every per-dimension field and id) ─────────────────────

/// A JS `Map<number, number>` (insertion order, `set` replaces in place).
struct TimeMap {
  std::vector<std::pair<double, double>> e;
  void set(double from, double to) {
    for (auto& [f, t] : e) {
      if (f == from) {
        t = to;
        return;
      }
    }
    e.emplace_back(from, to);
  }
  [[nodiscard]] const double* get(double from) const {
    for (const auto& [f, t] : e) {
      if (f == from) return &t;
    }
    return nullptr;
  }
  [[nodiscard]] bool empty() const { return e.empty(); }
};

template <class K, class GetT, class SetT>
std::vector<K> move_list(const std::vector<K>& list, const TimeMap& map, GetT get_t, SetT set_t) {
  std::vector<double> landing;
  for (const auto& [from, to] : map.e) {
    if (std::any_of(list.begin(), list.end(), [&](const K& k) { return get_t(k) == from; })) landing.push_back(to);
  }
  const auto landed = [&](double t) { return std::find(landing.begin(), landing.end(), t) != landing.end(); };
  std::vector<K> out;
  for (const K& k : list) {
    if (map.get(get_t(k)) == nullptr && !landed(get_t(k))) out.push_back(k);
  }
  for (const K& k : list) {
    if (const double* to = map.get(get_t(k))) {
      K m = k;
      set_t(m, *to);
      out.push_back(std::move(m));
    }
  }
  std::stable_sort(out.begin(), out.end(), [&](const K& a, const K& b) { return get_t(a) < get_t(b); });
  return out;
}

void retime(HCtx& x, const std::string& layer, const PropBinding& b, const TimeMap& map) {
  if (map.empty()) return;
  Document& d = x.d;
  if (b.special == Special::maskPath) {
    const Node* n = d.node(layer);
    const std::vector<Json> anim = n != nullptr ? read_node_mask_anim(*n) : std::vector<Json>{};
    set_mask_anim(d, layer,
                  move_list(anim, map, [](const Json& k) { return k.at("t").num(); },
                            [](Json& k, double t) { k.set("t", Json::number(t)); }));
    return;
  }
  if (b.dataTrack) {
    const DataTrack* track = anim_data_track(d, layer, *b.dataTrack);
    if (track == nullptr) return;
    DataTrack next = *track;
    next.keys = move_list(track->keys, map, [](const DataKey& k) { return k.t; }, [](DataKey& k, double t) { k.t = t; });
    anim_set_data_track(d, layer, *b.dataTrack, std::move(next));
    return;
  }
  for (const std::string& m : b.members) {
    const auto* kfs = anim_track(d, layer, m);
    if (kfs == nullptr) continue;
    anim_set_track(d, layer, m, move_list(*kfs, map, [](const Key& k) { return k.t; }, [](Key& k, double t) { k.t = t; }));
  }
}

// ── locating keys ───────────────────────────────────────────────────────

struct Located {
  std::string layer;
  PropBinding b;
  double t = 0;
  std::string id;
};

Located locate(HCtx& x, const std::string& id) {
  const std::optional<KeyLoc> loc = x.keys.resolve(x.d, id);
  if (!loc) fail(ErrorCode::not_found, "no keyframe '" + id + "'", {.detail = "{\"keyframe\":" + js::stringify(Json::string(id)) + "}"});
  const Catalog cat = catalog_for(x.d, loc->layer);
  const PropBinding* b = loc->kind == KeyLoc::Kind::mask ? cat.find("masks/" + loc->maskId.value_or("undefined") + "/path")
                                                         : cat.by_member(loc->member);
  if (b == nullptr) fail(ErrorCode::not_found, "keyframe '" + id + "' belongs to no property of layer '" + loc->layer + "'", {.layer = loc->layer});
  return Located{loc->layer, *b, loc->t, id};
}

struct KeyGroup {
  std::string layer;
  PropBinding b;
  std::vector<Located> keys;
};

/// `groupKeys(ids, keys)`: by (layer, property), in first-seen order.
std::vector<KeyGroup> group_keys(HCtx& x, const std::vector<std::string>& ids) {
  std::vector<std::pair<std::string, KeyGroup>> out;
  for (const std::string& id : ids) {
    Located l = locate(x, id);
    const std::string key = l.layer + "|" + l.b.path;
    auto it = std::find_if(out.begin(), out.end(), [&](const auto& e) { return e.first == key; });
    if (it == out.end()) {
      out.emplace_back(key, KeyGroup{l.layer, l.b, {}});
      it = std::prev(out.end());
    }
    KeyGroup& g = it->second;
    if (std::none_of(g.keys.begin(), g.keys.end(), [&](const Located& k) { return k.t == l.t; })) g.keys.push_back(std::move(l));
  }
  std::vector<KeyGroup> groups;
  groups.reserve(out.size());
  for (auto& [k, g] : out) groups.push_back(std::move(g));
  return groups;
}

std::optional<std::array<double, 4>> to_bezier(const std::optional<api::CubicBezier>& b) {
  if (!b) return std::nullopt;
  return std::array<double, 4>{b->x1, b->y1, b->x2, b->y2};
}

/// `exprMembers(b)`: expressions live per member track.
std::vector<std::string> expr_members(const PropBinding& b) {
  if (!b.members.empty()) return b.members;
  if (b.dataTrack) return {*b.dataTrack};
  fail(ErrorCode::not_animatable, "'" + b.path + "' cannot carry an expression", {.path = b.path});
}

}  // namespace

// ── Properties ──────────────────────────────────────────────────────────

ResultOf<api::SetProperty> handle(const api::SetProperty& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  const PlannedWrite p = plan_write(x, c.prop.layer, bd.b, c.value, c.time);
  x.label = "Set " + bd.b.name;
  api::PropertyWriteResult r;
  r.keyframe = apply_write(x, p);
  return r;
}

ResultOf<api::SetProperties> handle(const api::SetProperties& c, HCtx& x) {
  if (c.writes.empty()) fail(ErrorCode::invalid_argument, "no writes given");
  std::vector<PlannedWrite> runs;
  for (const api::PropertyWrite& w : c.writes) {
    const Bound bd = bind(x, w.prop);
    runs.push_back(plan_write(x, w.prop.layer, bd.b, w.value, w.time));
  }
  x.label = "Set " + plural(c.writes.size(), "Property");
  for (const PlannedWrite& p : runs) (void)apply_write(x, p);
  return {};
}

ResultOf<api::ResetProperty> handle(const api::ResetProperty& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  if (!bd.b.defaultValue) fail(ErrorCode::unsupported, "'" + bd.b.path + "' has no default value in this engine", {.path = bd.b.path});
  const PlannedWrite p = plan_write(x, c.prop.layer, bd.b, *bd.b.defaultValue, c.time);
  x.label = "Reset " + bd.b.name;
  (void)apply_write(x, p);
  return {};
}

ResultOf<api::SetAnimated> handle(const api::SetAnimated& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  const PropBinding& b = bd.b;
  check_time(c.time);
  if (!b.animatable) fail(ErrorCode::not_animatable, "'" + b.path + "' cannot be animated", {.path = b.path});
  const std::string& layer = c.prop.layer;
  const PCtx pc = x.pc();
  const bool animated = is_animated(x.d, layer, b);
  const double t = flicks_to_key_time(pc, layer, b, c.time);
  const std::string id = new_key_id(b, x);
  x.label = c.animated ? "Animate " + b.name : "Stop Animating " + b.name;
  api::PropertyWriteResult r;
  if (c.animated) {
    if (animated) return r;
    KeyWrite w;
    w.t = t;
    w.id = id;
    api::Value stat = read_static(x.d, layer, b);
    if (stat.kind() != VK::none) w.value = std::move(stat);
    put_keys(pc, layer, b, {w});
    r.keyframe = id;
    return r;
  }
  if (!animated) return r;
  const std::optional<api::Value> value = value_at(pc, layer, b, t);
  std::vector<double> times;
  for (const KeyAt& k : read_keys(x.d, layer, b)) times.push_back(k.t);
  drop_keys(pc, layer, b, times);
  if (value && !b.dataTrack && b.special != Special::maskPath) write_static(x.d, layer, b, *value);
  return r;
}

ResultOf<api::SetDimensionsSeparated> handle(const api::SetDimensionsSeparated& c, HCtx& x) {
  Document& d = x.d;
  const Node& node = require_layer(d, c.layer);
  if (c.path != "transform/position") fail(ErrorCode::unsupported, "only Position can be separated in this engine", {.path = c.path});
  if (node.comp_with_number("x") == nullptr) fail(ErrorCode::not_found, "this layer has no position", {.layer = c.layer});
  x.label = c.separated ? "Separate Dimensions" : "Merge Dimensions";
  sg_set_separate_dimensions(d, c.layer, c.separated);
  if (!c.separated) {
    // AE: merging keys every dimension at the union of the dimensions' key times.
    std::vector<std::string> dims;
    for (const char* m : {"x", "y", "z"}) {
      if (anim_track(d, c.layer, m) != nullptr || std::string_view(m) != "z") dims.emplace_back(m);
    }
    std::vector<std::vector<Key>> tracks;
    for (const auto& m : dims) {
      const auto* kfs = anim_track(d, c.layer, m);
      tracks.push_back(kfs != nullptr ? *kfs : std::vector<Key>{});
    }
    std::vector<double> times;  // a JS Set: insertion order
    for (const auto& tr : tracks) {
      for (const Key& k : tr) {
        if (std::find(times.begin(), times.end(), k.t) == times.end()) times.push_back(k.t);
      }
    }
    if (!times.empty()) {
      for (std::size_t i = 0; i < dims.size(); ++i) {
        const std::string& m = dims[i];
        std::vector<Key> list = tracks[i];
        const double base = read_static_property_value(d, c.layer, m).value_or(0);
        for (const double tt : times) {
          if (std::any_of(list.begin(), list.end(), [&](const Key& k) { return k.t == tt; })) continue;
          const double v = !list.empty() ? anim_sample(d, x.expr, x.cache, c.layer, m, tt).value_or(base) : base;
          Key k;
          k.t = tt;
          k.value = v;
          list.push_back(std::move(k));
        }
        std::stable_sort(list.begin(), list.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
        anim_set_track(d, c.layer, m, std::move(list));
      }
    }
  }
  return {};
}

ResultOf<api::SetExpression> handle(const api::SetExpression& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  const std::vector<std::string> members = expr_members(bd.b);
  const bool blank = js_blank(c.source);
  x.label = blank ? "Remove Expression" : "Set Expression";
  const std::string& layer = c.prop.layer;
  api::ExpressionResult r;
  if (blank) {
    for (const auto& m : members) anim_set_expr_state(x.d, layer, m, std::nullopt);
    r.ok = true;
    return r;
  }
  for (const auto& m : members) anim_set_expr_state(x.d, layer, m, ExprState{c.source, c.enabled});
  if (const auto err = anim_expr_error(x.d, x.cache, layer, members[0])) {
    // AE: a failing expression is stored, disabled.
    for (const auto& m : members) anim_set_expr_enabled(x.d, layer, m, false);
    r.ok = false;
    r.diagnostics.push_back(api::ExpressionDiagnostic{*err, 0, 0});
    return r;
  }
  r.ok = true;
  return r;
}

ResultOf<api::SetExpressionEnabled> handle(const api::SetExpressionEnabled& c, HCtx& x) {
  if (c.props.empty()) fail(ErrorCode::invalid_argument, "no properties given");
  std::vector<std::pair<std::string, std::vector<std::string>>> plans;
  for (const api::PropRef& p : c.props) {
    const Bound bd = bind(x, p);
    std::vector<std::string> members = expr_members(bd.b);
    if (std::none_of(members.begin(), members.end(), [&](const std::string& m) { return anim_has_expr(x.d, p.layer, m); })) {
      fail(ErrorCode::not_found, "'" + bd.b.path + "' has no expression", {.layer = p.layer, .path = bd.b.path});
    }
    plans.emplace_back(p.layer, std::move(members));
  }
  x.label = c.enabled ? "Enable Expression" : "Disable Expression";
  for (const auto& [layer, members] : plans) {
    for (const auto& m : members) anim_set_expr_enabled(x.d, layer, m, c.enabled);
  }
  return {};
}

ResultOf<api::ConvertExpressionToKeyframes> handle(const api::ConvertExpressionToKeyframes& c, HCtx& x) {
  Document& d = x.d;
  const Bound bd = bind(x, c.prop);
  const PropBinding& b = bd.b;
  const std::string& layer = c.prop.layer;
  if (b.members.empty()) fail(ErrorCode::unsupported, "'" + b.path + "' cannot be baked in this engine", {.path = b.path});
  if (std::none_of(b.members.begin(), b.members.end(), [&](const std::string& m) { return anim_expr_enabled(d, layer, m); })) {
    fail(ErrorCode::invalid_argument, "'" + b.path + "' has no enabled expression", {.path = b.path});
  }
  check_time(c.step, "step");
  const std::string comp = comp_of_layer(d, layer).value_or("");
  const double fps = comp_fps(d, comp);
  const api::LayerTiming timing = layer_timing(d, layer);
  const api::TimeRange range = c.range ? *c.range : api::TimeRange{timing.in_point, timing.out_point - timing.in_point};
  const double stepFrames = c.step > 0 ? std::max(1.0, flicks_to_frames(c.step, fps)) : 1.0;
  const double f0 = flicks_to_frames(range.start, fps);
  const double f1 = std::min(flicks_to_frames(range.start + range.duration, fps), comp_duration_frames(d, comp));
  if (f1 <= f0) fail(ErrorCode::out_of_range, "the bake range is empty");
  std::vector<double> frames;
  for (double f = f0; f < f1; f += stepFrames) frames.push_back(f);
  std::vector<std::string> ids;
  ids.reserve(frames.size());
  for (std::size_t i = 0; i < frames.size(); ++i) ids.push_back(x.mint_key_id());
  x.label = "Convert Expression to Keyframes";
  const PCtx pc = x.pc();
  struct Sample {
    double t;
    std::vector<double> nums;
  };
  std::vector<Sample> samples;
  samples.reserve(frames.size());
  for (const double f : frames) {
    const double t = flicks_to_key_time(pc, layer, b, frames_to_flicks(f, fps));
    Sample s{t, {}};
    for (const auto& m : b.members) s.nums.push_back(anim_sample(d, x.expr, x.cache, layer, m, t).value_or(0));
    samples.push_back(std::move(s));
  }
  for (const auto& m : b.members) anim_set_expr_state(d, layer, m, std::nullopt);
  for (std::size_t i = 0; i < b.members.size(); ++i) {
    std::vector<Key> keys;
    keys.reserve(samples.size());
    for (std::size_t j = 0; j < samples.size(); ++j) {
      Key k;
      k.id = ids[j];
      k.t = samples[j].t;
      k.value = samples[j].nums[i];
      k.easing = api::Easing::linear;
      keys.push_back(std::move(k));
    }
    anim_set_track(d, layer, b.members[i], std::move(keys));
  }
  api::KeyframeIds r;
  r.ids = std::move(ids);
  return r;
}

ResultOf<api::LinkProperty> handle(const api::LinkProperty& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  const Bound target = bind(x, c.target);
  const PropBinding& b = bd.b;
  if (b.members.empty() || target.b.members.empty()) {
    fail(ErrorCode::unsupported, "only numeric properties can be pick-whipped in this engine", {.path = b.path});
  }
  if (target.b.members.size() < b.members.size()) {
    fail(ErrorCode::type_mismatch, "'" + target.b.path + "' has fewer dimensions than '" + b.path + "'", {.path = b.path});
  }
  x.label = "Link Property";
  for (std::size_t i = 0; i < b.members.size(); ++i) {
    const std::string src = "layer('#" + c.target.layer + "', '" + target.b.members[i] + "')";
    anim_set_expr_state(x.d, c.prop.layer, b.members[i], ExprState{src, true});
  }
  return {};
}

// ── Keyframes ───────────────────────────────────────────────────────────

ResultOf<api::AddKeyframes> handle(const api::AddKeyframes& c, HCtx& x) {
  if (c.keys.empty()) fail(ErrorCode::invalid_argument, "no keyframes given");
  struct Plan {
    std::string layer;
    PropBinding b;
    KeyWrite w;
  };
  std::vector<Plan> plans;
  const PCtx pc = x.pc();
  for (const api::KeyframeInsert& k : c.keys) {
    const Bound bd = bind(x, k.prop);
    const PropBinding& b = bd.b;
    if (!b.animatable) fail(ErrorCode::not_animatable, "'" + b.path + "' cannot take keyframes", {.layer = k.prop.layer, .path = b.path});
    check_time(k.time);
    if (k.value) check_value(b, *k.value);
    const double t = flicks_to_key_time(pc, k.prop.layer, b, k.time);
    const std::vector<KeyAt> keys = read_keys(x.d, k.prop.layer, b);
    const KeyAt* existing = key_at_time(keys, t);
    KeyWrite w;
    w.t = t;
    w.id = existing != nullptr && !existing->id.starts_with("@") ? existing->id : new_key_id(b, x);
    if (k.value) w.value = *k.value;
    if (k.easing) w.easing = *k.easing;
    if (k.bezier) w.bezier.emplace(to_bezier(k.bezier));
    if (k.roving) w.roving = *k.roving;
    if (k.spatial_interp) w.spatialInterp = *k.spatial_interp;
    if (!k.spatial_in.empty()) w.spatialIn.emplace(k.spatial_in);
    if (!k.spatial_out.empty()) w.spatialOut.emplace(k.spatial_out);
    plans.push_back(Plan{k.prop.layer, b, std::move(w)});
  }
  x.label = "Add " + plural(plans.size(), "Keyframe");
  for (Plan& p : plans) {
    if (!p.w.value) {
      // Absent value: the property's evaluated value at that time.
      if (auto v = value_at(pc, p.layer, p.b, p.w.t)) p.w.value = std::move(*v);
    }
    put_keys(pc, p.layer, p.b, {p.w});
  }
  api::KeyframeIds r;
  for (const Plan& p : plans) r.ids.push_back(p.w.id);
  return r;
}

ResultOf<api::DeleteKeyframes> handle(const api::DeleteKeyframes& c, HCtx& x) {
  if (c.ids.empty()) fail(ErrorCode::invalid_argument, "no keyframes given");
  const std::vector<KeyGroup> groups = group_keys(x, c.ids);
  x.label = "Delete " + plural(c.ids.size(), "Keyframe");
  const PCtx pc = x.pc();
  for (const KeyGroup& g : groups) {
    std::vector<double> times;
    for (const Located& k : g.keys) times.push_back(k.t);
    drop_keys(pc, g.layer, g.b, times);
  }
  return {};
}

ResultOf<api::MoveKeyframes> handle(const api::MoveKeyframes& c, HCtx& x) {
  check_time(c.delta, "delta");
  const std::vector<KeyGroup> groups = group_keys(x, c.ids);
  x.label = "Move " + plural(c.ids.size(), "Keyframe");
  const PCtx pc = x.pc();
  for (const KeyGroup& g : groups) {
    TimeMap map;
    for (const Located& k : g.keys) map.set(k.t, flicks_to_key_time(pc, g.layer, g.b, key_time_to_flicks(pc, g.layer, g.b, k.t) + c.delta));
    retime(x, g.layer, g.b, map);
  }
  return {};
}

ResultOf<api::ScaleKeyframes> handle(const api::ScaleKeyframes& c, HCtx& x) {
  check_time(c.pivot, "pivot");
  if (!(c.factor > 0) || !std::isfinite(c.factor)) fail(ErrorCode::out_of_range, "factor must be positive");
  const std::vector<KeyGroup> groups = group_keys(x, c.ids);
  x.label = "Scale Keyframes";
  const PCtx pc = x.pc();
  for (const KeyGroup& g : groups) {
    TimeMap map;
    for (const Located& k : g.keys) {
      const api::Time ct = key_time_to_flicks(pc, g.layer, g.b, k.t);
      const double scaled = motion::js::round(static_cast<double>(c.pivot) + static_cast<double>(ct - c.pivot) * c.factor);
      map.set(k.t, flicks_to_key_time(pc, g.layer, g.b, static_cast<api::Time>(scaled)));
    }
    retime(x, g.layer, g.b, map);
  }
  return {};
}

ResultOf<api::ReverseKeyframes> handle(const api::ReverseKeyframes& c, HCtx& x) {
  const std::vector<KeyGroup> groups = group_keys(x, c.ids);
  x.label = "Time-Reverse Keyframes";
  const PCtx pc = x.pc();
  for (const KeyGroup& g : groups) {
    std::vector<api::Time> times;
    for (const Located& k : g.keys) times.push_back(key_time_to_flicks(pc, g.layer, g.b, k.t));
    const api::Time lo = *std::min_element(times.begin(), times.end());
    const api::Time hi = *std::max_element(times.begin(), times.end());
    TimeMap map;
    for (std::size_t i = 0; i < g.keys.size(); ++i) map.set(g.keys[i].t, flicks_to_key_time(pc, g.layer, g.b, lo + hi - times[i]));
    retime(x, g.layer, g.b, map);
  }
  return {};
}

ResultOf<api::UpdateKeyframes> handle(const api::UpdateKeyframes& c, HCtx& x) {
  if (c.patches.empty()) fail(ErrorCode::invalid_argument, "no patches given");
  std::vector<std::pair<Located, const api::KeyframePatch*>> plans;
  for (const api::KeyframePatch& p : c.patches) {
    Located l = locate(x, p.id);
    if (p.value) check_value(l.b, *p.value);
    if (p.time) check_time(*p.time);
    plans.emplace_back(std::move(l), &p);
  }
  x.label = "Edit " + plural(plans.size(), "Keyframe");
  const PCtx pc = x.pc();
  for (const auto& [l, pp] : plans) {
    const api::KeyframePatch& p = *pp;
    KeyWrite w;
    w.t = l.t;
    w.id = l.id;
    if (p.value) w.value = *p.value;
    if (p.easing) w.easing = *p.easing;
    if (p.clear_bezier.value_or(false)) w.bezier.emplace();
    else if (p.bezier) w.bezier.emplace(to_bezier(p.bezier));
    if (p.continuous) w.continuous = *p.continuous;
    if (p.roving) w.roving = *p.roving;
    if (p.spatial_interp) w.spatialInterp = *p.spatial_interp;
    if (p.clear_spatial.value_or(false)) {
      w.spatialIn.emplace();
      w.spatialOut.emplace();
    }
    if (!p.spatial_in.empty()) w.spatialIn.emplace(p.spatial_in);
    if (!p.spatial_out.empty()) w.spatialOut.emplace(p.spatial_out);
    if (p.label) w.label = static_cast<double>(*p.label);
    if (l.b.special == Special::maskPath || l.b.dataTrack || !l.b.members.empty()) put_keys(pc, l.layer, l.b, {w});
    if (p.time) {
      TimeMap map;
      map.set(l.t, flicks_to_key_time(pc, l.layer, l.b, *p.time));
      retime(x, l.layer, l.b, map);
    }
  }
  return {};
}

ResultOf<api::PasteKeyframes> handle(const api::PasteKeyframes& c, HCtx& x) {
  const Bound bd = bind(x, c.prop);
  const PropBinding& b = bd.b;
  if (!b.animatable) fail(ErrorCode::not_animatable, "'" + b.path + "' cannot take keyframes", {.path = b.path});
  check_time(c.time);
  if (c.keys.empty()) fail(ErrorCode::invalid_argument, "no keyframes given");
  for (const api::Keyframe& k : c.keys) check_value(b, k.value);
  api::Time t0 = std::numeric_limits<api::Time>::max();
  for (const api::Keyframe& k : c.keys) t0 = std::min(t0, k.time);
  const std::string& layer = c.prop.layer;
  const PCtx pc = x.pc();
  std::vector<KeyWrite> writes;
  for (const api::Keyframe& k : c.keys) {
    const double t = flicks_to_key_time(pc, layer, b, c.time + (k.time - t0));
    const std::vector<KeyAt> keys = read_keys(x.d, layer, b);
    const KeyAt* existing = key_at_time(keys, t);
    KeyWrite w;
    w.t = t;
    w.id = existing != nullptr && !existing->id.starts_with("@") ? existing->id : new_key_id(b, x);
    w.value = k.value;
    w.easing = k.easing;
    w.bezier.emplace(to_bezier(k.bezier));
    w.continuous = k.continuous;
    w.roving = k.roving;
    w.spatialInterp = k.spatial_interp;
    w.spatialIn.emplace(k.spatial_in.empty() ? std::optional<std::vector<double>>{} : std::optional<std::vector<double>>{k.spatial_in});
    w.spatialOut.emplace(k.spatial_out.empty() ? std::optional<std::vector<double>>{} : std::optional<std::vector<double>>{k.spatial_out});
    w.label = static_cast<double>(k.label);
    writes.push_back(std::move(w));
  }
  x.label = "Paste " + plural(writes.size(), "Keyframe");
  put_keys(pc, layer, b, writes);
  api::KeyframeIds r;
  for (const KeyWrite& w : writes) r.ids.push_back(w.id);
  return r;
}

}  // namespace premation::doc
