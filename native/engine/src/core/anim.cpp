#include "anim.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <unordered_map>
#include <limits>
#include <set>
#include <span>
#include <string>
#include <utility>

#include "eval.hpp"
#include "expr.hpp"  // SDK 1.4 (E2): plugin interpolators
#include "jsmath.hpp"
#include "motion/motion_eval.h"
#include "ptree.hpp"
#include "sourcetext.hpp"

namespace premation::doc {
namespace ex = motion::expr;

namespace {

std::int32_t to_motion_easing(api::Easing e) noexcept {
  switch (e) {
    case api::Easing::linear: return MOTION_EASING_LINEAR;
    case api::Easing::hold: return MOTION_EASING_HOLD;
    case api::Easing::bezier: return MOTION_EASING_BEZIER;
    case api::Easing::ease: return MOTION_EASING_EASE;
    case api::Easing::ease_in: return MOTION_EASING_EASE_IN;
    case api::Easing::ease_out: return MOTION_EASING_EASE_OUT;
    case api::Easing::ease_in_out: return MOTION_EASING_EASE_IN_OUT;
    case api::Easing::step: return MOTION_EASING_STEP;
    case api::Easing::auto_bezier: return MOTION_EASING_AUTO_BEZIER;
    case api::Easing::continuous_bezier: return MOTION_EASING_CONTINUOUS_BEZIER;
  }
  return MOTION_EASING_LINEAR;
}

std::uint32_t spatial_bits(api::SpatialInterp s) {
  return (static_cast<std::uint32_t>(s) << MOTION_KF_SPATIAL_SHIFT) & MOTION_KF_SPATIAL_MASK;
}

motion_keyframe to_motion(const Key& k) noexcept {
  motion_keyframe m{};
  m.t = k.t;
  m.value = k.value;
  m.easing = to_motion_easing(k.easing.value_or(api::Easing::linear));
  m.flags = k.spatial ? spatial_bits(*k.spatial) : 0U;
  if (k.roving.value_or(false)) m.flags |= MOTION_KF_ROVING;
  if (k.bezier) {
    m.flags |= MOTION_KF_HAS_BEZIER;
    m.c0 = (*k.bezier)[0];
    m.c1 = (*k.bezier)[1];
    m.c2 = (*k.bezier)[2];
    m.c3 = (*k.bezier)[3];
  }
  if (k.si) {
    m.flags |= MOTION_KF_HAS_SI;
    m.si = *k.si;
  }
  if (k.so) {
    m.flags |= MOTION_KF_HAS_SO;
    m.so = *k.so;
  }
  return m;
}

/// motion_eval's KeyframeSource over a document track: a key is converted
/// (`to_motion`) when the sampler reads it, so one sample touches the
/// O(log n) keys it needs instead of copying the track. Same conversion,
/// same sampler, same bits as converting the whole track first.
struct KeySource {
  std::span<const Key> keys;

  [[nodiscard]] std::size_t size() const noexcept { return keys.size(); }
  [[nodiscard]] motion_keyframe get(std::size_t i) const noexcept { return to_motion(keys[i]); }
};

const NodeAnim* anim_of(const Document& d, std::string_view node) { return d.anim(node); }

void prune_anim(Document& d, std::string_view node) {
  const NodeAnim* a = d.anim(node);
  if (a != nullptr && a->empty()) d.set_anim(node, std::nullopt);
}

}  // namespace

std::size_t component_index_of(std::string_view prop) noexcept {
  // Camera program D6: Orientation and Point of Interest are AE vectors too,
  // so lookAt(...) / [x, y, z] land by axis on their X / Y / Z tracks.
  if (prop == "y" || prop == "scaleY" || prop == "anchorY" || prop == "orientationY" || prop == "poiY") return 1;
  if (prop == "z" || prop == "rotationZ" || prop == "orientationZ" || prop == "poiZ") return 2;
  return 0;
}

// ── tracks ───────────────────────────────────────────────────────────────

const std::vector<Key>* anim_track(const Document& d, std::string_view node, std::string_view prop) {
  const NodeAnim* a = anim_of(d, node);
  return a != nullptr ? a->tracks.find(prop) : nullptr;
}

bool anim_is_animated(const Document& d, std::string_view node, std::string_view prop) {
  const auto* t = anim_track(d, node, prop);
  return t != nullptr && !t->empty();
}

void anim_set_track(Document& d, std::string_view node, std::string_view prop, std::vector<Key> keys) {
  if (keys.empty()) {
    anim_remove_track(d, node, prop);
    return;
  }
  d.anim_mut(node).tracks.set(prop, std::move(keys));
}

void anim_remove_track(Document& d, std::string_view node, std::string_view prop) {
  if (anim_track(d, node, prop) == nullptr) return;
  d.anim_mut(node).tracks.erase(prop);
  prune_anim(d, node);
}

void anim_set_keyframes(Document& d, std::string_view node, std::string_view prop, const std::vector<Key>& keys) {
  if (keys.empty()) {
    anim_remove_track(d, node, prop);
    return;
  }
  std::vector<Key> byTime;
  for (const Key& k : keys) {
    const auto it = std::find_if(byTime.begin(), byTime.end(), [&k](const Key& x) { return x.t == k.t; });
    if (it != byTime.end()) *it = k;  // Map.set keeps the first position
    else byTime.push_back(k);
  }
  std::stable_sort(byTime.begin(), byTime.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
  d.anim_mut(node).tracks.set(prop, std::move(byTime));
}

std::vector<Key> upsert_key(std::vector<Key> keys, Key k) {
  std::erase_if(keys, [&k](const Key& x) { return x.t == k.t; });
  keys.push_back(std::move(k));
  std::stable_sort(keys.begin(), keys.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
  return keys;
}

void anim_set_keyframe(Document& d, std::string_view node, std::string_view prop, double t, double value,
                       std::optional<api::Easing> easing) {
  const auto* cur = anim_track(d, node, prop);
  std::vector<Key> keys = cur != nullptr ? *cur : std::vector<Key>{};
  Key next;
  const auto it = std::find_if(keys.begin(), keys.end(), [t](const Key& k) { return k.t == t; });
  if (it != keys.end()) {
    next = *it;
    next.value = value;
    if (easing) next.easing = easing;
  } else {
    next.t = t;
    next.value = value;
    next.easing = easing;
  }
  d.anim_mut(node).tracks.set(prop, upsert_key(std::move(keys), std::move(next)));
}

std::optional<TimeSpan> anim_time_span(const Document& d, std::string_view node) {
  const NodeAnim* a = anim_of(d, node);
  if (a == nullptr) return std::nullopt;
  double start = std::numeric_limits<double>::infinity();
  double end = -std::numeric_limits<double>::infinity();
  for (const auto& [prop, keys] : a->tracks) {
    if (keys.empty()) continue;
    start = std::min(start, keys.front().t);
    end = std::max(end, keys.back().t);
  }
  if (!std::isfinite(start)) return std::nullopt;
  return TimeSpan{start, end};
}

std::optional<double> sample_keys(const std::vector<Key>& keys, double t) {
  if (keys.empty()) return std::nullopt;
  // SDK 1.4 (E2): a segment whose first key names a plugin interpolator ("<pluginId>:<name>") is
  // eased by it — (t 0..1 through the segment, v0, v1) → value. A failed call eases as usual.
  if (keys.size() > 1 && t > keys.front().t && t < keys.back().t) {
    const auto next = std::ranges::upper_bound(keys, t, {}, &Key::t);
    const Key& a = *std::prev(next);
    if (a.interp && next != keys.end() && next->t > a.t) {
      const std::size_t colon = a.interp->rfind(':');
      if (colon != std::string::npos) {
        const std::array<double, 3> args{(t - a.t) / (next->t - a.t), a.value, next->value};
        std::vector<double> out;
        std::string error;
        if (motion::expr::call_plugin_function(std::string_view(*a.interp).substr(0, colon), std::string_view(*a.interp).substr(colon + 1),
                                               args, out, error) &&
            out.size() == 1 && std::isfinite(out[0])) {
          return out[0];
        }
      }
    }
  }
  // No copy and no allocation: the sampler reads keys through KeySource.
  return motion::eval::sample(KeySource{std::span<const Key>(keys)}, t);
}

std::optional<double> anim_sample_keys(const std::vector<Key>& keys, double t) { return sample_keys(keys, t); }

// ── spatial members: arc-length timing ───────────────────────────────────

namespace {

/// The axes of a spatial property, in order, and which one `prop` is.
struct SpatialGroup {
  std::array<std::string_view, motion::eval::kSpatialAxes> members{};
  std::size_t axes = 0;
  std::size_t own = 0;
};

std::optional<SpatialGroup> spatial_group_of(std::string_view prop) noexcept {
  static constexpr std::array<std::array<std::string_view, 3>, 3> kGroups{{
      {"x", "y", "z"},
      {"anchorX", "anchorY", ""},
      {"poiX", "poiY", "poiZ"},
  }};
  for (const auto& g : kGroups) {
    const std::span<const std::string_view> members(g);
    for (std::size_t i = 0; i < members.size(); ++i) {
      if (!members[i].empty() && members[i] == prop) {
        SpatialGroup out;
        out.members = g;
        out.axes = g.back().empty() ? 2 : 3;
        out.own = i;
        return out;
      }
    }
  }
  return std::nullopt;
}

/// Arc-length tables by segment control values. A table is a pure function of
/// its controls, so a hit and a miss answer the same bits; the cache only saves
/// the 64 cubic evaluations. Direct-mapped, fixed size, thread-local: no
/// allocation on the sampling path (CLAUDE.md performance discipline).
struct ArcCacheEntry {
  std::array<std::uint64_t, motion::eval::kSpatialAxes * 4> key{};
  std::uint64_t axes = ~std::uint64_t{0};  ///< never a valid count: an empty slot
  motion::eval::ArcTable table;
};
constexpr std::size_t kArcCacheSlots = 256;

const motion::eval::ArcTable& cached_arc_table(const motion::eval::SpatialSegment& seg) {
  thread_local std::array<ArcCacheEntry, kArcCacheSlots> cacheStore;
  const std::span<ArcCacheEntry> cache(cacheStore);
  std::array<std::uint64_t, motion::eval::kSpatialAxes * 4> key{};
  const std::span<std::uint64_t> keyv(key);
  const std::span<const std::array<double, 4>> ctrl(seg.ctrl);
  auto h = static_cast<std::uint64_t>(seg.axes);
  for (std::size_t a = 0; a < seg.axes; ++a) {
    const std::span<const double, 4> axis(ctrl[a]);
    for (std::size_t c = 0; c < 4; ++c) {
      const auto bits = std::bit_cast<std::uint64_t>(axis[c]);
      keyv[a * 4 + c] = bits;
      h ^= bits + 0x9e3779b97f4a7c15ULL + (h << 6U) + (h >> 2U);
    }
  }
  ArcCacheEntry& e = cache[static_cast<std::size_t>(h % kArcCacheSlots)];
  if (e.axes != static_cast<std::uint64_t>(seg.axes) || e.key != key) {
    e.axes = static_cast<std::uint64_t>(seg.axes);
    e.key = key;
    motion::eval::arc_table(seg, e.table);
  }
  return e.table;
}

}  // namespace

std::optional<double> anim_sample_member_keys(const Document& d, std::string_view node, std::string_view prop,
                                             const std::vector<Key>& keys, double t) {
  const auto group = spatial_group_of(prop);
  if (!group || keys.size() < 2) return sample_keys(keys, t);
  if (!(t > keys.front().t && t < keys.back().t)) return sample_keys(keys, t);
  const std::span<const std::string_view> members(group->members);
  const KeySource own{std::span<const Key>(keys)};
  const std::size_t i = motion::eval::segment_index_for(own, t);
  const motion_keyframe a = own.get(i);
  const motion_keyframe b = own.get(i + 1);
  if (a.easing == motion::eval::kEasingHold || a.easing == motion::eval::kEasingStep) return sample_keys(keys, t);
  if (!(b.t > a.t)) return sample_keys(keys, t);

  motion::eval::SpatialSegment seg;
  seg.axes = group->axes;
  const std::span<std::array<double, 4>> ctrl(seg.ctrl);
  bool anyTangent = false;
  for (std::size_t axis = 0; axis < group->axes; ++axis) {
    motion::eval::SegmentControls c;
    if (axis == group->own) {
      c = motion::eval::segment_controls(own, i);
    } else {
      const std::vector<Key>* sib = anim_track(d, node, members[axis]);
      if (sib == nullptr || sib->empty()) continue;  // a constant axis: no length
      // The sibling must be keyed on the SAME segment (keys at a.t and b.t,
      // none between); otherwise the axes trace no shared curve and each
      // samples on its own, as before. Tracks are sorted by time, so the
      // last key at a.t is one step before upper_bound(a.t).
      const std::span<const Key> sk(*sib);
      const auto ub = std::upper_bound(sk.begin(), sk.end(), a.t, [](double tt, const Key& key) { return tt < key.t; });
      if (ub == sk.begin()) return sample_keys(keys, t);
      const auto ia = static_cast<std::size_t>(std::distance(sk.begin(), ub)) - 1;
      if (sk[ia].t != a.t || ia + 1 >= sk.size() || sk[ia + 1].t != b.t) return sample_keys(keys, t);
      c = motion::eval::segment_controls(KeySource{sk}, ia);
    }
    ctrl[axis] = {c.v0, c.c1, c.c2, c.v3};
    anyTangent = anyTangent || c.has_tangent;
  }
  // Every axis linear in u: the path is the straight line and u IS the arc fraction.
  if (!anyTangent) return sample_keys(keys, t);

  const double local = (t - a.t) / (b.t - a.t);
  const double eased = motion::eval::segment_eased(own, i, local);
  const double u = motion::eval::arc_param(seg, cached_arc_table(seg), eased);
  const std::span<const double, 4> c(ctrl[group->own]);
  return motion::eval::cubic_value_at(c[0], c[1], c[2], c[3], u);
}

std::pair<std::optional<double>, std::optional<double>> effective_spatial_tangents_of(const std::vector<Key>& keys, std::size_t i) {
  if (i >= keys.size()) return {};
  const auto tg = motion::eval::effective_spatial_tangents(KeySource{std::span<const Key>(keys)}, i);
  return {tg.has_si ? std::optional<double>(tg.si) : std::nullopt, tg.has_so ? std::optional<double>(tg.so) : std::nullopt};
}

// ── data tracks ──────────────────────────────────────────────────────────

const DataTrack* anim_data_track(const Document& d, std::string_view node, std::string_view prop) {
  const NodeAnim* a = anim_of(d, node);
  return a != nullptr ? a->data.find(prop) : nullptr;
}

bool anim_is_data_animated(const Document& d, std::string_view node, std::string_view prop) {
  const DataTrack* t = anim_data_track(d, node, prop);
  return t != nullptr && !t->keys.empty();
}

void anim_set_data_track(Document& d, std::string_view node, std::string_view prop, std::optional<DataTrack> t) {
  if (!t || t->keys.empty()) {
    if (anim_data_track(d, node, prop) == nullptr) return;
    d.anim_mut(node).data.erase(prop);
    prune_anim(d, node);
    return;
  }
  d.anim_mut(node).data.set(prop, std::move(*t));
}

namespace {

double lerp(double a, double b, double u) { return a + (b - a) * u; }

std::array<double, 4> parse_color_data(const std::string& c0) {
  std::string_view s = c0;
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r')) s.remove_suffix(1);
  const auto hexv = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  };
  const auto pair = [&](char a, char b) -> double {
    const int x = hexv(a);
    const int y = hexv(b);
    if (x < 0) return std::nan("");
    if (y < 0) return static_cast<double>(x);  // parseInt stops at the first bad digit
    return static_cast<double>(x * 16 + y);
  };
  if (!s.empty() && s.front() == '#') {
    const std::string_view hex = s.substr(1);
    if (hex.size() == 3 || hex.size() == 4) {
      const double a = hex.size() == 4 ? pair(hex[3], hex[3]) / 255 : 1;
      return {pair(hex[0], hex[0]), pair(hex[1], hex[1]), pair(hex[2], hex[2]), a};
    }
    if (hex.size() == 6 || hex.size() == 8) {
      return {pair(hex[0], hex[1]), pair(hex[2], hex[3]), pair(hex[4], hex[5]),
              hex.size() == 8 ? pair(hex[6], hex[7]) / 255 : 1};
    }
    return {0, 0, 0, 1};
  }
  return {0, 0, 0, 1};  // rgba() colours in gradient stops: not produced by the engine
}

std::string to_color_data(const std::array<double, 4>& c) {
  static constexpr char kHex[] = "0123456789abcdef";
  const auto h = [](double v) {
    const double r = motion::js::round(std::max(0.0, std::min(255.0, v)));
    const auto n = static_cast<unsigned>(std::isfinite(r) ? r : 0);
    std::string s;
    s.push_back(kHex[(n >> 4U) & 0xFU]);
    s.push_back(kHex[n & 0xFU]);
    return s;
  };
  std::string base = "#" + h(c[0]) + h(c[1]) + h(c[2]);
  if (c[3] >= 1) return base;
  return base + h(c[3] * 255);
}

double ease_segment(const DataKey& a, double u) {
  if (!a.easing || *a.easing == api::Easing::linear) return u;
  if (*a.easing == api::Easing::bezier && a.bezier) {
    return motion::eval::cubic_bezier_ease((*a.bezier)[0], (*a.bezier)[1], (*a.bezier)[2], (*a.bezier)[3], u);
  }
  return motion::eval::ease(to_motion_easing(*a.easing), u);
}

Json lerp_points(Json a, Json b, double u, const Json* so, const Json* si) {
  const auto& A = a.arr();
  const auto& B = b.arr();
  if (A.size() != B.size()) return u < 1 ? a : b;  // outline growth: not produced by engine commands
  Json out = Json::array();
  for (std::size_t i = 0; i < A.size(); ++i) {
    const Json& p = A[i];
    const Json& q = B[i];
    const Json* tOut = so != nullptr && i < so->arr().size() && so->arr()[i].is_object() ? &so->arr()[i] : nullptr;
    const Json* tIn = si != nullptr && i < si->arr().size() && si->arr()[i].is_object() ? &si->arr()[i] : nullptr;
    Json o = Json::object();
    const double px = p.at("x").num();
    const double py = p.at("y").num();
    const double qx = q.at("x").num();
    const double qy = q.at("y").num();
    if (tOut != nullptr || tIn != nullptr) {
      const double ox = tOut != nullptr ? tOut->at("x").num() : 0;
      const double oy = tOut != nullptr ? tOut->at("y").num() : 0;
      const double ix = tIn != nullptr ? tIn->at("x").num() : 0;
      const double iy = tIn != nullptr ? tIn->at("y").num() : 0;
      o.set("x", Json::number(motion::eval::cubic_value_at(px, px + ox, qx + ix, qx, u)));
      o.set("y", Json::number(motion::eval::cubic_value_at(py, py + oy, qy + iy, qy, u)));
    } else {
      o.set("x", Json::number(lerp(px, qx, u)));
      o.set("y", Json::number(lerp(py, qy, u)));
    }
    for (const char* key : {"inX", "inY", "outX", "outY"}) {
      const auto ka = p.number_at(key);
      const auto kb = q.number_at(key);
      std::optional<double> v;
      if (ka && kb) v = lerp(*ka, *kb, u);
      else v = u < 1 ? ka : kb;
      if (v) o.set(key, Json::number(*v));
    }
    out.arr_mut().push_back(std::move(o));
  }
  return out;
}

// SDK 1.4 (E3): nested arrays of numbers (a plugin curve's points, a gradient's stops).
bool same_shape(const Json& a, const Json& b) {
  if (a.is_number() && b.is_number()) return true;
  if (!a.is_array() || !b.is_array() || a.arr().size() != b.arr().size()) return false;
  for (std::size_t i = 0; i < a.arr().size(); ++i) {
    if (!same_shape(a.arr()[i], b.arr()[i])) return false;
  }
  return true;
}

void flatten_numbers(const Json& j, std::vector<double>& out) {
  if (j.is_number()) {
    out.push_back(j.num());
  } else if (j.is_array()) {
    for (const Json& e : j.arr()) flatten_numbers(e, out);
  }
}

Json refill_numbers(const Json& shape, std::span<const double> v, std::size_t& i) {
  if (shape.is_number()) return Json::number(i < v.size() ? v[i++] : shape.num());
  Json out = Json::array();
  for (const Json& e : shape.arr()) out.arr_mut().push_back(refill_numbers(e, v, i));
  return out;
}

Json blend_numbers(const DataKey& a, const DataKey& b, double raw, double u) {
  if (!same_shape(a.value, b.value)) return u < 1 ? a.value : b.value;
  std::vector<double> fa;
  std::vector<double> fb;
  flatten_numbers(a.value, fa);
  flatten_numbers(b.value, fb);
  std::vector<double> mixed(fa.size());
  bool done = false;
  if (a.interp) {
    // The plugin blends the whole value: (t, a..., b...) -> the value's numbers. A failed call blends as usual.
    const std::size_t colon = a.interp->rfind(':');
    std::vector<double> args;
    args.reserve(1 + (fa.size() * 2));
    args.push_back(raw);
    args.insert(args.end(), fa.begin(), fa.end());
    args.insert(args.end(), fb.begin(), fb.end());
    std::vector<double> out(fa.size());
    std::string error;
    if (colon != std::string::npos &&
        motion::expr::call_plugin_function(std::string_view(*a.interp).substr(0, colon), std::string_view(*a.interp).substr(colon + 1),
                                           args, out, error) &&
        out.size() == fa.size() && std::ranges::all_of(out, [](double x) { return std::isfinite(x); })) {
      mixed = std::move(out);
      done = true;
    }
  }
  if (!done) {
    for (std::size_t i = 0; i < fa.size(); ++i) mixed[i] = lerp(fa[i], fb[i], u);
  }
  std::size_t at = 0;
  return refill_numbers(a.value, mixed, at);
}

Json lerp_stops(const Json& a, const Json& b, double u) {
  const auto& A = a.arr();
  const auto& B = b.arr();
  if (A.size() != B.size()) return u < 1 ? a : b;
  Json out = Json::array();
  for (std::size_t i = 0; i < A.size(); ++i) {
    Json s = Json::object();
    s.set("pos", Json::number(lerp(A[i].at("pos").num(), B[i].at("pos").num(), u)));
    const auto ca = parse_color_data(A[i].at("color").str());
    const auto cb = parse_color_data(B[i].at("color").str());
    s.set("color", Json::string(to_color_data({lerp(ca[0], cb[0], u), lerp(ca[1], cb[1], u), lerp(ca[2], cb[2], u),
                                               lerp(ca[3], cb[3], u)})));
    out.arr_mut().push_back(std::move(s));
  }
  return out;
}

}  // namespace

std::optional<Json> sample_data_track(const DataTrack& tr, double t) {
  const auto& kfs = tr.keys;
  if (kfs.empty()) return std::nullopt;
  if (t <= kfs.front().t) return kfs.front().value;
  if (t >= kfs.back().t) return kfs.back().value;
  // Keys are sorted by time and front.t < t < back.t, so the segment starts at
  // the last key at or before t: the smallest i with kfs[i + 1].t > t.
  const std::span<const DataKey> ks(kfs);
  const auto ub = std::upper_bound(ks.begin(), ks.end(), t, [](double tt, const DataKey& key) { return tt < key.t; });
  const std::size_t i = static_cast<std::size_t>(std::distance(ks.begin(), ub)) - 1;
  const DataKey& a = kfs[i];
  const DataKey& b = kfs[i + 1];
  if (tr.kind == "text") return a.value;
  const double raw = (t - a.t) / (b.t - a.t);
  if (a.easing && (*a.easing == api::Easing::hold || *a.easing == api::Easing::step)) return a.value;
  const double u = ease_segment(a, raw);
  if (tr.kind == "number") return Json::number(lerp(a.value.num(), b.value.num(), u));
  if (tr.kind == "numbers") return blend_numbers(a, b, raw, u);
  if (tr.kind == "points") {
    return lerp_points(a.value, b.value, u, a.so ? &*a.so : nullptr, b.si ? &*b.si : nullptr);
  }
  return lerp_stops(a.value, b.value, u);
}

// ── expressions (storage) ────────────────────────────────────────────────

const ExprState* anim_expr(const Document& d, std::string_view node, std::string_view prop) {
  const NodeAnim* a = anim_of(d, node);
  return a != nullptr ? a->exprs.find(prop) : nullptr;
}

namespace {
bool blank(std::string_view s) {
  for (const char c : s) {
    if (!(c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v')) return false;
  }
  return true;
}
}  // namespace

void anim_set_expr_state(Document& d, std::string_view node, std::string_view prop, std::optional<ExprState> st) {
  if (!st || blank(st->src)) {
    if (anim_expr(d, node, prop) == nullptr) return;
    d.anim_mut(node).exprs.erase(prop);
    prune_anim(d, node);
    return;
  }
  d.anim_mut(node).exprs.set(prop, std::move(*st));
}

void anim_set_expr_enabled(Document& d, std::string_view node, std::string_view prop, bool on) {
  const ExprState* e = anim_expr(d, node, prop);
  if (e == nullptr || e->enabled == on) return;
  d.anim_mut(node).exprs.find(prop)->enabled = on;
}

bool anim_has_expr(const Document& d, std::string_view node, std::string_view prop) {
  return anim_expr(d, node, prop) != nullptr;
}

bool anim_expr_enabled(const Document& d, std::string_view node, std::string_view prop) {
  const ExprState* e = anim_expr(d, node, prop);
  return e != nullptr && e->enabled;
}

const ex::Expression& ExprCache::get(const std::string& src) {
  auto it = cache_.find(src);
  if (it == cache_.end()) {
    const std::u16string u = ex::utf8_to_utf16(src);
    it = cache_.emplace(src, std::make_unique<ex::Expression>(ex::Expression::compile(u))).first;
  }
  return *it->second;
}

void ExprCache::note_runtime_error(std::string_view node, std::string_view prop, const std::u16string& message,
                                   std::uint32_t line, std::uint32_t column) {
  if (captureDepth_ == 0) return;
  for (const ExprRuntimeError& e : errors_) {
    if (e.node == node && e.prop == prop) return;  // one entry per property (motion blur samples it again)
  }
  errors_.push_back({std::string(node), std::string(prop), ex::utf16_to_utf8(message), line, column});
}

std::optional<ExprDiagnostic> anim_expr_diagnostic(const Document& d, ExprCache& cache, std::string_view node,
                                                   std::string_view prop) {
  const ExprState* e = anim_expr(d, node, prop);
  if (e == nullptr) return std::nullopt;
  const ex::Expression& x = cache.get(e->src);
  if (!x.compile_error()) return std::nullopt;
  return ExprDiagnostic{ex::utf16_to_utf8(*x.compile_error()), x.compile_error_line(), x.compile_error_column()};
}

std::optional<std::string> anim_expr_error(const Document& d, ExprCache& cache, std::string_view node,
                                           std::string_view prop) {
  const ExprState* e = anim_expr(d, node, prop);
  if (e == nullptr) return std::nullopt;
  const auto& err = cache.get(e->src).compile_error();
  if (!err) return std::nullopt;
  return ex::utf16_to_utf8(*err);
}

// ── expressions (evaluation) — sample / sampleInternal / exprContext ───────

namespace {

class Sampler;

/// What an expression sees of a member, in After Effects' units: the
/// document keeps transform scale as a multiplier (1 = 100 %), AE and the API
/// in percent. `value`, keyframe reads and the result cross this factor, so
/// `thisComp.layer("A").transform.scale` (percent) on another layer's scale
/// means the same thing as that layer's own `value`.
double expr_unit_factor(std::string_view prop) noexcept {
  return (prop == "scale" || prop == "scaleX" || prop == "scaleY" || prop == "scaleZ") ? 100.0 : 1.0;
}

/// The Host of one evaluation: `exprContext(nodeId, prop, t, base, visited, depth)`.
class ContextHost final : public ex::Host {
 public:
  ContextHost(Sampler& s, std::string node, std::string prop, int depth)
      : s_(s), node_(std::move(node)), prop_(std::move(prop)), depth_(depth), factor_(expr_unit_factor(prop_)) {}

  [[nodiscard]] bool has_ctrl() const override { return true; }
  double ctrl(std::u16string_view name) override;
  [[nodiscard]] bool has_self_at() const override { return true; }
  double self_at(double t) override;
  [[nodiscard]] bool has_layer_at() const override { return true; }
  std::optional<double> layer_at(std::u16string_view name, std::u16string_view prop, double t) override;
  [[nodiscard]] bool has_source_rect_at() const override { return true; }
  std::optional<ex::SourceRect> source_rect_at(double t, bool extents) override;
  [[nodiscard]] bool has_space_at() const override { return true; }
  bool space_exists(const std::u16string* name, double t) override;
  std::array<double, 3> space_convert(const std::u16string* name, double t, ex::SpaceOp op,
                                      std::array<double, 3> p) override;
  [[nodiscard]] bool has_markers_at() const override { return true; }
  std::vector<ex::MarkerData> markers_at(ex::MarkerScope scope) override;
  [[nodiscard]] bool has_source_text_at() const override { return true; }
  std::optional<ex::SourceTextSample> source_text_at(const std::u16string* name, double t) override;
  std::optional<double> layer_prop_at(const std::u16string* name, std::u16string_view prop, double t) override;
  std::optional<std::array<double, 4>> layer_color_at(const std::u16string* name, std::u16string_view prop,
                                                      double t) override;
  std::optional<std::u16string> active_camera_at(double t) override;
  // AE-style rigs
  std::optional<ex::LayerFacts> layer_facts_at(const std::u16string* name, double t) override;
  std::optional<std::u16string> layer_ref_by_index(double index) override;
  [[nodiscard]] bool has_effects() const override { return true; }
  bool effect_exists(const std::u16string* layer, std::u16string_view effect) override;
  std::optional<ex::EffectParam> effect_param_at(const std::u16string* layer, std::u16string_view effect,
                                                 const std::u16string* param, double index, double t) override;
  // AE property objects (2026-10-21)
  bool effect_active(const std::u16string* layer, std::u16string_view effect) override;
  std::vector<double> layer_key_times(const std::u16string* name, std::u16string_view prop) override;
  std::vector<double> effect_param_key_times(const std::u16string* layer, std::u16string_view effect,
                                             const std::u16string* param, double index) override;
  std::optional<ex::CompFacts> comp_facts(const std::u16string* name) override;
  std::optional<ex::Host::FootageText> footage_text(std::u16string_view name) override;
  std::optional<std::u16string> comp_layer_ref(const std::u16string& comp, const std::u16string* name,
                                               double index) override;
  // AE path properties (2026-10-29)
  std::optional<ImageSample> sample_image(const std::u16string* layer, std::array<double, 2> point,
                                          std::array<double, 2> radius, bool postEffect, double t) override;
  std::optional<ex::PathSample> path_at(const std::u16string* layer, bool mask, const std::u16string* name,
                                        double t) override;

  double time = 0;

 private:
  [[nodiscard]] std::optional<std::string> target_of(const std::u16string* name) const;
  Sampler& s_;
  std::string node_;
  std::string prop_;
  int depth_;
  double factor_;  // expr_unit_factor(prop_)
};

class Sampler {
 public:
  Sampler(const Document& d, const ExprEnv& env, ExprCache& cache) : d_(d), env_(env), cache_(cache) {}

  std::optional<double> track_at(std::string_view node, std::string_view prop, double t) const {
    const auto* keys = anim_track(d_, node, prop);
    return keys != nullptr ? anim_sample_member_keys(d_, node, prop, *keys, t) : std::nullopt;
  }
  /// The property's own static value. A component prop first; else the document's
  /// static reader — an effect parameter (`effect.<id>.<key>`) lives in its
  /// instance, defaults merged, so `value` on an untouched Blurriness is its 10 px,
  /// not 0 (2026-10-21 QA).
  std::optional<double> base_of(std::string_view node, std::string_view prop) const {
    if (auto v = env_.base_value(node, prop)) return v;
    return env_.static_value(node, prop);
  }
  std::optional<double> plain(std::string_view node, std::string_view prop, double t) const {
    if (auto v = track_at(node, prop, t)) return v;
    return base_of(node, prop);
  }

  std::optional<std::string> resolve(std::u16string_view ref) const {
    if (!ref.empty() && ref[0] == u'#') {
      if (ref.size() == 1) return std::nullopt;
      return ex::utf16_to_utf8(ref.substr(1));
    }
    return env_.resolve_layer(ref);
  }

  struct TextEval {
    std::optional<ex::SourceTextSample> sample;
    std::optional<ex::SourceTextResult> result;
  };

  /// `sourceTextInternal`: the post-expression sample, and the result when an
  /// enabled Source Text expression ran. Throws HostError on a cycle or depth
  /// overflow. An expression error falls back to the pre-expression sample.
  TextEval source_text_internal(const std::string& node, double t, int depth) {
    const std::optional<ex::SourceTextSample> base = env_.source_text(node, t);
    if (!base) return {};
    const ExprState* entry = anim_expr(d_, node, std::string(kSourceTextProp));
    if (entry == nullptr || !entry->enabled) return {*base, std::nullopt};
    const std::string key = node + ":" + std::string(kSourceTextProp);
    if (visited_.contains(key)) {
      throw ex::HostError{u"Cycle detected across expression evaluation (" + ex::utf8_to_utf16(key) + u")"};
    }
    if (depth > 16) {
      throw ex::HostError{u"Maximum cross-layer evaluation depth (16) exceeded (" + ex::utf8_to_utf16(key) + u")"};
    }
    visited_.insert(key);
    struct Erase {
      std::set<std::string>& v;
      const std::string& k;
      ~Erase() { v.erase(k); }
    } const erase{visited_, key};
    ContextHost host(*this, node, std::string(kSourceTextProp), depth);
    host.time = t;
    ex::Context c;
    c.time = t;
    c.value = 0;
    c.audio = env_.audio_level();
    c.comp = env_.comp_info();
    c.layer_info = env_.layer_info(node);
    c.prop_seed = ex::string_seed(ex::utf8_to_utf16(key));
    c.text_value = &*base;
    c.host = &host;
    const ex::TextResult tr = cache_.get(entry->src).run_text(c);
    if (tr.error) {
      const std::u16string& m = *tr.error;
      cache_.note_runtime_error(node, kSourceTextProp, m, tr.line, tr.column);
      if (m.find(u"Cycle detected") != std::u16string::npos || m.find(u"Maximum cross-layer") != std::u16string::npos) {
        throw ex::HostError{m};
      }
      return {*base, std::nullopt};
    }
    if (!tr.result) return {*base, std::nullopt};
    ex::SourceTextSample after = *base;
    after.text = tr.result->text;
    after.style = ex::detail::resolve_style(base->style, tr.result->style);
    return {std::move(after), tr.result};
  }

  /// A path property's post-expression path (`base` is the pre-expression one),
  /// and whether an expression produced it. Same cycle / depth rules as
  /// `internal`; an expression error keeps `base` (and is noted).
  std::pair<ex::PathSample, bool> path_internal(const std::string& node, const std::string& prop,
                                                const ex::PathSample& base, double t, int depth) {
    const ExprState* entry = anim_expr(d_, node, prop);
    if (entry == nullptr || !entry->enabled) return {base, false};
    const std::string key = node + ":" + prop;
    if (visited_.contains(key)) {
      throw ex::HostError{u"Cycle detected across expression evaluation (" + ex::utf8_to_utf16(key) + u")"};
    }
    if (depth > 16) {
      throw ex::HostError{u"Maximum cross-layer evaluation depth (16) exceeded (" + ex::utf8_to_utf16(key) + u")"};
    }
    visited_.insert(key);
    struct Erase {
      std::set<std::string>& v;
      const std::string& k;
      ~Erase() { v.erase(k); }
    } const erase{visited_, key};
    cache_.count_run();
    ContextHost host(*this, node, prop, depth);
    host.time = t;
    ex::Context c;
    c.time = t;
    c.audio = env_.audio_level();
    c.comp = env_.comp_info();
    c.layer_info = env_.layer_info(node);
    c.prop_seed = ex::string_seed(ex::utf8_to_utf16(key));
    c.path_value = &base;
    c.host = &host;
    ex::PathResult r = cache_.get(entry->src).run_path(c);
    if (r.error) {
      const std::u16string& m = *r.error;
      cache_.note_runtime_error(node, prop, m, r.line, r.column);
      if (m.find(u"Cycle detected") != std::u16string::npos || m.find(u"Maximum cross-layer") != std::u16string::npos) {
        throw ex::HostError{m};
      }
      return {base, false};
    }
    if (!r.result) return {base, false};
    return {std::move(*r.result), true};
  }

  /// `sourceTextFor`: own Source Text on the Source Text property is the
  /// pre-expression text; every other read is post-expression.
  std::optional<ex::SourceTextSample> source_text_for(const std::string& self, const std::string& prop,
                                                      const std::u16string* name, double t, int depth) {
    std::string target = self;
    if (name != nullptr) {
      const auto r = resolve(*name);
      if (!r) return std::nullopt;
      target = *r;
    }
    if (target == self && prop == kSourceTextProp) return env_.source_text(target, t);
    return source_text_internal(target, t, depth).sample;
  }

  /// `sampleInternal` — throws ex::HostError for a cycle or depth overflow.
  std::optional<double> internal(const std::string& node, const std::string& prop, double t, int depth) {
    if (prop == "text.source") return std::nullopt;
    const std::string key = node + ":" + prop;
    if (visited_.contains(key)) {
      throw ex::HostError{u"Cycle detected across expression evaluation (" + ex::utf8_to_utf16(key) + u")"};
    }
    if (depth > 16) {
      throw ex::HostError{u"Maximum cross-layer evaluation depth (16) exceeded (" + ex::utf8_to_utf16(key) + u")"};
    }
    // One evaluation (ExprEvalScope): each (property, time) is read once — an
    // expression's program runs once, a keyed or stored value is looked up
    // once. A value is kept only when it came out clean (an expression error
    // is not kept: it stays reported where it happens).
    std::string memoKey;
    if (cache_.scoped()) {
      memoKey.reserve(key.size() + 1 + sizeof(double));
      memoKey.append(key).push_back('\x1f');
      const auto bits = std::bit_cast<std::uint64_t>(t);
      for (std::size_t i = 0; i < sizeof(bits); ++i) memoKey.push_back(static_cast<char>((bits >> (8 * i)) & 0xffU));
      const auto& values = cache_.memo(env_).values;
      if (const auto it = values.find(memoKey); it != values.end()) return it->second;
    }
    const auto keep = [&](std::optional<double> v) {
      if (!memoKey.empty()) cache_.memo(env_).values.emplace(std::move(memoKey), v);
      return v;
    };
    visited_.insert(key);
    struct Erase {
      std::set<std::string>& v;
      const std::string& k;
      Erase(std::set<std::string>& vv, const std::string& kk) : v(vv), k(kk) {}
      Erase(const Erase&) = delete;
      Erase& operator=(const Erase&) = delete;
      Erase(Erase&&) = delete;
      Erase& operator=(Erase&&) = delete;
      ~Erase() { v.erase(k); }
    } const erase{visited_, key};
    const std::optional<double> base = track_at(node, prop, t);
    const ExprState* entry = anim_expr(d_, node, prop);
    if (entry != nullptr && entry->enabled) {
      const ex::Result r = run(node, prop, t, base, depth + 1, cache_.get(entry->src));
      if (r.error) {
        const std::u16string& m = *r.error;
        // A frame build reports it (layerErrors, stage `expression`); the
        // property falls back to its pre-expression value either way.
        cache_.note_runtime_error(node, prop, m, r.line, r.column);
        if (m.find(u"Cycle detected") != std::u16string::npos || m.find(u"Maximum cross-layer") != std::u16string::npos) {
          throw ex::HostError{m};
        }
        memoKey.clear();
      }
      // The result is in AE units (expr_unit_factor); the document's back.
      const double factor = expr_unit_factor(prop);
      if (r.kind == ex::Result::Kind::kVector) return keep(r.vec.at(std::min(component_index_of(prop), r.size - 1)) / factor);
      if (r.kind == ex::Result::Kind::kNumber) return keep(r.number / factor);
    }
    if (base) return keep(base);
    return keep(base_of(node, prop));
  }

  /// `compiled.run(exprContext(...))`.
  /// `previewSourceTextExpression`: the draft run against the layer's own
  /// (pre-expression) Source Text, its key marked visited, at depth 1.
  ex::TextResult preview_source_text(const std::string& node, const std::string& src, double t) {
    const std::optional<ex::SourceTextSample> base = env_.source_text(node, t);
    if (!base) {
      ex::TextResult r;
      r.error = u"This layer has no Source Text.";
      return r;
    }
    const std::string key = node + ":" + std::string(kSourceTextProp);
    visited_.insert(key);
    ContextHost host(*this, node, std::string(kSourceTextProp), 1);
    host.time = t;
    ex::Context c;
    c.time = t;
    c.value = 0;
    c.audio = env_.audio_level();
    c.comp = env_.comp_info();
    c.layer_info = env_.layer_info(node);
    c.prop_seed = ex::string_seed(ex::utf8_to_utf16(key));
    c.text_value = &*base;
    c.host = &host;
    return cache_.get(src).run_text(c);
  }

  ex::Result run(const std::string& node, const std::string& prop, double t, std::optional<double> base, int depth,
                 const ex::Expression& compiled) {
    cache_.count_run();
    ContextHost host(*this, node, prop, depth);
    host.time = t;
    ex::Context c;
    c.time = t;
    const auto rest = [&]() { return base_of(node, prop).value_or(0); };
    c.value = (base ? *base : rest()) * expr_unit_factor(prop);
    c.audio = env_.audio_level();
    std::vector<double> keyTimes;
    if (const auto* keys = anim_track(d_, node, prop)) {
      keyTimes.reserve(keys->size());
      for (const Key& k : *keys) keyTimes.push_back(k.t);
      if (!keys->empty()) c.self_span = ex::KeySpan{keys->front().t, keys->back().t};
    }
    c.key_times = keyTimes;
    c.comp = env_.comp_info();
    c.layer_info = env_.layer_info(node);
    c.prop_seed = ex::string_seed(ex::utf8_to_utf16(node + ":" + prop));
    c.host = &host;
    return compiled.run(c);
  }

  const Document& d_;
  const ExprEnv& env_;
  ExprCache& cache_;
  std::set<std::string> visited_;
};

double ContextHost::ctrl(std::u16string_view name) { return s_.env_.ctrl(name, time); }
double ContextHost::self_at(double t) {
  if (auto v = s_.track_at(node_, prop_, t)) return *v * factor_;
  return s_.base_of(node_, prop_).value_or(0) * factor_;
}
std::optional<double> ContextHost::layer_at(std::u16string_view name, std::u16string_view prop, double t) {
  const auto target = s_.resolve(name);
  if (!target) return std::nullopt;
  return s_.internal(*target, ex::utf16_to_utf8(prop), t, depth_);
}
std::optional<ex::SourceRect> ContextHost::source_rect_at(double t, bool extents) {
  return s_.env_.source_rect(node_, t, extents);
}
bool ContextHost::space_exists(const std::u16string* name, double t) { return s_.env_.space_exists(node_, name, t); }
std::array<double, 3> ContextHost::space_convert(const std::u16string* name, double t, ex::SpaceOp op,
                                                 std::array<double, 3> p) {
  return s_.env_.space_convert(node_, name, t, op, p);
}
std::vector<ex::MarkerData> ContextHost::markers_at(ex::MarkerScope scope) { return s_.env_.markers(node_, scope); }
std::optional<ex::SourceTextSample> ContextHost::source_text_at(const std::u16string* name, double t) {
  return s_.source_text_for(node_, prop_, name, t, depth_);
}
// Camera program D6: a layer's camera / light option, position or point of
// interest — keyed, expressed or stored, else the engine's effective default.
std::optional<double> ContextHost::layer_prop_at(const std::u16string* name, std::u16string_view prop, double t) {
  const std::optional<std::string> target = name != nullptr ? s_.resolve(*name) : std::optional<std::string>(node_);
  if (!target) return std::nullopt;
  const std::string p = ex::utf16_to_utf8(prop);
  if (auto v = s_.internal(*target, p, t, depth_)) return v;
  // Focus Distance defaults to the Zoom (camera3d.ts readNodeDof).
  if (p == "focusDistance") return layer_prop_at(name, u"focalLength", t);
  return s_.env_.prop_default(*target, p);
}
std::optional<std::array<double, 4>> ContextHost::layer_color_at(const std::u16string* name, std::u16string_view prop,
                                                                 double t) {
  const std::optional<std::string> target = name != nullptr ? s_.resolve(*name) : std::optional<std::string>(node_);
  if (!target) return std::nullopt;
  return s_.env_.color_at(*target, ex::utf16_to_utf8(prop), t);
}
std::optional<std::u16string> ContextHost::active_camera_at(double t) {
  const std::optional<std::string> id = s_.env_.active_camera(t);
  if (!id) return std::nullopt;
  return u"#" + ex::utf8_to_utf16(*id);
}

// AE-style rigs (docs/EXPRESSION_LANGUAGE.md): the facts and effect parameters
// of a layer. A parameter's members are sampled through `internal`, so a
// keyed or expressed slider evaluates with the usual cycle and depth guards.
std::optional<ex::LayerFacts> ContextHost::layer_facts_at(const std::u16string* name, double t) {
  const std::optional<std::string> target = name != nullptr ? s_.resolve(*name) : std::optional<std::string>(node_);
  if (!target) return std::nullopt;
  std::optional<ex::LayerFacts> f = s_.env_.layer_facts(*target, t);
  if (f && f->parent) f->parent = u"#" + *f->parent;  // the env answers an id; the language wants a reference
  return f;
}
std::optional<std::u16string> ContextHost::layer_ref_by_index(double index) {
  const std::optional<std::string> id = s_.env_.layer_by_index(node_, index);
  if (!id) return std::nullopt;
  return u"#" + ex::utf8_to_utf16(*id);
}
bool ContextHost::effect_exists(const std::u16string* layer, std::u16string_view effect) {
  const std::optional<std::string> target = layer != nullptr ? s_.resolve(*layer) : std::optional<std::string>(node_);
  return target && s_.env_.effect_exists(*target, ex::utf16_to_utf8(effect));
}
std::optional<ex::EffectParam> ContextHost::effect_param_at(const std::u16string* layer, std::u16string_view effect,
                                                            const std::u16string* param, double index, double t) {
  const std::optional<std::string> target = layer != nullptr ? s_.resolve(*layer) : std::optional<std::string>(node_);
  if (!target) return std::nullopt;
  std::optional<std::string> pname;
  if (param != nullptr) pname = ex::utf16_to_utf8(*param);
  const auto members = s_.env_.effect_param_members(*target, ex::utf16_to_utf8(effect), pname ? &*pname : nullptr, index);
  if (!members || members->empty()) return std::nullopt;
  ex::EffectParam out;
  out.size = std::min<std::size_t>(members->size(), out.v.size());
  for (std::size_t i = 0; i < out.size; ++i) {
    const ExprEnv::EffectMember& m = (*members)[i];
    if (m.key.empty()) {  // a constant member (a control colour's alpha)
      out.v.at(i) = m.offset;
      continue;
    }
    std::optional<double> v = s_.internal(*target, m.key, t, depth_);
    if (!v) v = s_.env_.static_value(*target, m.key);
    out.v.at(i) = v.value_or(0) * m.scale + m.offset;
  }
  return out;
}

// AE property objects (2026-10-21): key times for `.numKeys` / `.key(n)`,
// an effect's switch, other compositions.
std::optional<std::string> ContextHost::target_of(const std::u16string* name) const {
  return name != nullptr ? s_.resolve(*name) : std::optional<std::string>(node_);
}
bool ContextHost::effect_active(const std::u16string* layer, std::u16string_view effect) {
  const std::optional<std::string> target = target_of(layer);
  return !target || s_.env_.effect_enabled(*target, ex::utf16_to_utf8(effect));
}
std::vector<double> ContextHost::layer_key_times(const std::u16string* name, std::u16string_view prop) {
  std::vector<double> out;
  const std::optional<std::string> target = target_of(name);
  if (!target) return out;
  if (const auto* keys = anim_track(s_.d_, *target, ex::utf16_to_utf8(prop))) {
    out.reserve(keys->size());
    for (const Key& k : *keys) out.push_back(k.t);
  }
  return out;
}
std::vector<double> ContextHost::effect_param_key_times(const std::u16string* layer, std::u16string_view effect,
                                                        const std::u16string* param, double index) {
  std::vector<double> out;
  const std::optional<std::string> target = target_of(layer);
  if (!target) return out;
  std::optional<std::string> pname;
  if (param != nullptr) pname = ex::utf16_to_utf8(*param);
  const auto members = s_.env_.effect_param_members(*target, ex::utf16_to_utf8(effect), pname ? &*pname : nullptr, index);
  if (!members) return out;
  for (const ExprEnv::EffectMember& m : *members) {
    if (m.key.empty()) continue;
    if (const auto* keys = anim_track(s_.d_, *target, m.key)) {
      out.reserve(keys->size());
      for (const Key& k : *keys) out.push_back(k.t);
      break;
    }
  }
  return out;
}
namespace {

/// A data footage file's text, re-read only when its size or time changes:
/// expressions ask on every evaluation of every frame. Shared across the
/// evaluation threads; files past 64 MB are refused rather than held.
std::optional<std::string> data_file_text(const std::string& path) {
  struct Entry {
    std::uintmax_t size = 0;
    std::filesystem::file_time_type time{};
    std::string text;
  };
  static std::mutex mutex;
  static std::unordered_map<std::string, Entry> cache;
  const std::filesystem::path p(std::u8string(path.begin(), path.end()));
  std::error_code ec;
  const std::uintmax_t size = std::filesystem::file_size(p, ec);
  if (ec || size > (64ULL << 20)) return std::nullopt;
  const auto time = std::filesystem::last_write_time(p, ec);
  if (ec) return std::nullopt;
  const std::scoped_lock lock(mutex);
  if (const auto it = cache.find(path); it != cache.end() && it->second.size == size && it->second.time == time) {
    return it->second.text;
  }
  std::ifstream in(p, std::ios::binary);
  if (!in) return std::nullopt;
  std::string text(static_cast<std::size_t>(size), '\0');
  in.read(text.data(), static_cast<std::streamsize>(size));
  text.resize(static_cast<std::size_t>(in.gcount()));
  cache.insert_or_assign(path, Entry{size, time, text});
  return text;
}

bool same_name(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const auto lo = [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; };
    if (lo(a[i]) != lo(b[i])) return false;
  }
  return true;
}

}  // namespace

std::optional<ex::Host::FootageText> ContextHost::footage_text(std::u16string_view name) {
  // AE's footage("name"): the project item's name (its file name), exact first, then ignoring case.
  const std::string want = ex::utf16_to_utf8(name);
  const Json* hit = nullptr;
  for (int pass = 0; pass < 2 && hit == nullptr; ++pass) {
    for (const Json& a : s_.d_.items().assets) {
      if (!(a.at("type").is_string() && a.at("type").str() == "data") || !a.at("name").is_string()) continue;
      if (pass == 0 ? a.at("name").str() == want : same_name(a.at("name").str(), want)) {
        hit = &a;
        break;
      }
    }
  }
  if (hit == nullptr || !hit->at("path").is_string()) return std::nullopt;
  auto text = data_file_text(hit->at("path").str());
  if (!text) return std::nullopt;
  return ex::Host::FootageText{ex::utf8_to_utf16(hit->at("name").str()), std::move(*text)};
}

std::optional<ex::CompFacts> ContextHost::comp_facts(const std::u16string* name) {
  if (name == nullptr) return s_.env_.comp_facts(node_, nullptr);
  const std::string n = ex::utf16_to_utf8(*name);
  return s_.env_.comp_facts(node_, &n);
}
std::optional<std::u16string> ContextHost::comp_layer_ref(const std::u16string& comp, const std::u16string* name,
                                                          double index) {
  std::optional<std::string> n;
  if (name != nullptr) n = ex::utf16_to_utf8(*name);
  const std::optional<std::string> id = s_.env_.comp_layer(ex::utf16_to_utf8(comp), n ? &*n : nullptr, index);
  if (!id) return std::nullopt;
  return u"#" + ex::utf8_to_utf16(*id);
}

std::optional<ex::Host::ImageSample> ContextHost::sample_image(const std::u16string* layer, std::array<double, 2> point,
                                                              std::array<double, 2> radius, bool postEffect, double t) {
  std::string target = node_;
  if (layer != nullptr) {
    const auto r = s_.resolve(*layer);
    if (!r) return std::nullopt;
    target = *r;
  }
  std::string error;
  const std::shared_ptr<const LayerPixels> px = s_.env_.layer_pixels(target, t, postEffect, error);
  if (!px) return ImageSample{{}, ex::utf8_to_utf16(error)};
  // The point is in the layer space toComp / fromComp use: the anchor at the
  // origin. The box's corner sits at −(box / 2 + anchor) there (frame_build's
  // tOrigin), the anchor as it is at `t`.
  const double k = px->scale > 0 ? px->scale : 1.0;
  const double boxW = px->boxWidth > 0 ? px->boxWidth : px->width / k;
  const double boxH = px->boxHeight > 0 ? px->boxHeight : px->height / k;
  const double ax = s_.internal(target, "anchorX", t, depth_).value_or(0);
  const double ay = s_.internal(target, "anchorY", t, depth_).value_or(0);
  return ImageSample{average_layer_pixels(*px, {point[0] + boxW / 2 + ax, point[1] + boxH / 2 + ay}, radius), {}};
}

std::optional<ex::PathSample> ContextHost::path_at(const std::u16string* layer, bool mask, const std::u16string* name,
                                                   double t) {
  std::string target = node_;
  if (layer != nullptr) {
    const auto r = s_.resolve(*layer);
    if (!r) return std::nullopt;
    target = *r;
  }
  std::optional<std::string> n;
  if (name != nullptr) n = ex::utf16_to_utf8(*name);
  const std::optional<PathAt> at = s_.env_.path(target, mask, n ? &*n : nullptr, t);
  if (!at) return std::nullopt;
  // Its own path, read from inside its own expression, is the pre-expression one (as `value` is).
  if (target == node_ && at->prop == prop_) return at->sample;
  return s_.path_internal(target, at->prop, at->sample, t, depth_ + 1).first;
}

}  // namespace

std::array<double, 4> average_layer_pixels(const LayerPixels& px, std::array<double, 2> point,
                                           std::array<double, 2> radius) {
  std::array<double, 4> out{};
  if (px.width == 0 || px.height == 0 || px.rgba.size() < std::size_t{px.width} * px.height * 4) return out;
  const double k = px.scale > 0 ? px.scale : 1.0;
  const double cx = point[0] * k;
  const double cy = point[1] * k;
  const auto read = [&](std::int64_t x, std::int64_t y, double w, std::array<double, 4>& sum) {
    if (x < 0 || y < 0 || x >= std::int64_t{px.width} || y >= std::int64_t{px.height}) return;
    const std::size_t i = (static_cast<std::size_t>(y) * px.width + static_cast<std::size_t>(x)) * 4;
    for (std::size_t c = 0; c < 4; ++c) sum[c] += w * static_cast<double>(px.rgba[i + c]);
  };
  std::array<double, 4> sum{};
  double area = 0;
  if (radius[0] <= 0 && radius[1] <= 0) {
    // The pixel under the point (pixel i spans [i, i + 1)).
    read(static_cast<std::int64_t>(std::floor(cx)), static_cast<std::int64_t>(std::floor(cy)), 1.0, sum);
    area = 1;
  } else {
    // A degenerate side is one pixel thick, centred on the point.
    const double rx = std::max(radius[0] * k, 0.5);
    const double ry = std::max(radius[1] * k, 0.5);
    const double x0 = cx - rx;
    const double x1 = cx + rx;
    const double y0 = cy - ry;
    const double y1 = cy + ry;
    area = (x1 - x0) * (y1 - y0);
    // Only pixels inside the layer add colour; the rest of the area is transparent.
    const auto first = [](double v, std::uint32_t n) { return std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor(v)), 0, n); };
    const auto last = [](double v, std::uint32_t n) { return std::clamp<std::int64_t>(static_cast<std::int64_t>(std::ceil(v)), 0, n); };
    const std::int64_t ix0 = first(x0, px.width);
    const std::int64_t ix1 = last(x1, px.width);
    const std::int64_t iy0 = first(y0, px.height);
    const std::int64_t iy1 = last(y1, px.height);
    for (std::int64_t y = iy0; y < iy1; ++y) {
      const double wy = std::min(y1, static_cast<double>(y + 1)) - std::max(y0, static_cast<double>(y));
      if (wy <= 0) continue;
      for (std::int64_t x = ix0; x < ix1; ++x) {
        const double wx = std::min(x1, static_cast<double>(x + 1)) - std::max(x0, static_cast<double>(x));
        if (wx > 0) read(x, y, wx * wy, sum);
      }
    }
  }
  if (area <= 0 || sum[3] <= 0) return out;
  out[0] = sum[0] / sum[3];
  out[1] = sum[1] / sum[3];
  out[2] = sum[2] / sum[3];
  out[3] = sum[3] / area;
  return out;
}

std::optional<double> anim_sample(const Document& d, const ExprEnv& env, ExprCache& cache, std::string_view node,
                                  std::string_view prop, double t) {
  if (prop == "text.source") return std::nullopt;
  const ExprState* entry = anim_expr(d, node, prop);
  Sampler s(d, env, cache);
  // A path's expression returns a path: anim_evaluate_path runs it, never as a number.
  if (is_path_expr_prop(prop)) return s.plain(node, prop, t);
  if (entry == nullptr || !entry->enabled) return s.plain(node, prop, t);
  try {
    return s.internal(std::string(node), std::string(prop), t, 0);
  } catch (const ex::HostError&) {
    return s.plain(node, prop, t);
  }
}

ex::Result anim_preview_expression(const Document& d, const ExprEnv& env, ExprCache& cache, std::string_view node,
                                   std::string_view prop, const std::string& src, double t) {
  Sampler s(d, env, cache);
  const std::optional<double> base = s.track_at(node, prop, t);
  s.visited_.insert(std::string(node) + ":" + std::string(prop));
  try {
    return s.run(std::string(node), std::string(prop), t, base, 1, cache.get(src));
  } catch (const ex::HostError& e) {
    ex::Result r;
    r.error = e.message;
    return r;
  }
}

std::optional<ex::SourceTextResult> anim_evaluate_source_text(const Document& d, const ExprEnv& env, ExprCache& cache,
                                                                std::string_view node, double t) {
  try {
    Sampler s(d, env, cache);
    return s.source_text_internal(std::string(node), t, 0).result;
  } catch (const ex::HostError&) {
    return std::nullopt;
  }
}

std::optional<ex::PathSample> anim_evaluate_path(const Document& d, const ExprEnv& env, ExprCache& cache,
                                                 std::string_view node, std::string_view prop,
                                                 const ex::PathSample& base, double t) {
  const ExprState* entry = anim_expr(d, node, prop);
  if (entry == nullptr || !entry->enabled) return std::nullopt;
  try {
    Sampler s(d, env, cache);
    auto [path, ran] = s.path_internal(std::string(node), std::string(prop), base, t, 0);
    if (!ran) return std::nullopt;
    return std::move(path);
  } catch (const ex::HostError&) {
    return std::nullopt;
  }
}

bool is_path_expr_prop(std::string_view prop) noexcept {
  if (prop == "path.points") return true;
  return prop.starts_with("mask.") && prop.ends_with(".path");
}

ex::PathSample path_sample_of_points(const Json& points, bool closed) {
  ex::PathSample s;
  s.closed = closed;
  if (!points.is_array()) return s;
  const auto num = [](const Json& v, double fallback) { return v.is_number() ? v.num() : fallback; };
  for (const Json& p : points.arr()) {
    const double x = num(p.at("x"), 0);
    const double y = num(p.at("y"), 0);
    s.points.push_back({x, y});
    s.in_tangents.push_back({num(p.at("inX"), x) - x, num(p.at("inY"), y) - y});
    s.out_tangents.push_back({num(p.at("outX"), x) - x, num(p.at("outY"), y) - y});
  }
  return s;
}

Json points_of_path_sample(const ex::PathSample& s, const Json* prev) {
  const bool keep = prev != nullptr && prev->is_array() && prev->arr().size() == s.points.size();
  Json out = Json::array();
  for (std::size_t i = 0; i < s.points.size(); ++i) {
    Json q = keep && prev->arr()[i].is_object() ? prev->arr()[i] : Json::object();
    const auto [x, y] = s.points[i];
    const std::array<double, 2> in = i < s.in_tangents.size() ? s.in_tangents[i] : std::array<double, 2>{0, 0};
    const std::array<double, 2> o = i < s.out_tangents.size() ? s.out_tangents[i] : std::array<double, 2>{0, 0};
    q.set("x", Json::number(x));
    q.set("y", Json::number(y));
    q.set("inX", Json::number(x + in[0]));
    q.set("inY", Json::number(y + in[1]));
    q.set("outX", Json::number(x + o[0]));
    q.set("outY", Json::number(y + o[1]));
    out.arr_mut().push_back(std::move(q));
  }
  return out;
}

ex::TextResult anim_preview_source_text(const Document& d, const ExprEnv& env, ExprCache& cache, std::string_view node,
                                        const std::string& src, double t) {
  try {
    Sampler s(d, env, cache);
    return s.preview_source_text(std::string(node), src, t);
  } catch (const ex::HostError& e) {
    ex::TextResult r;
    r.error = e.message;
    return r;
  }
}

std::vector<std::pair<std::string, double>> anim_evaluate_node(const Document& d, const ExprEnv& env,
                                                                ExprCache& cache, std::string_view node, double t) {
  std::vector<std::pair<std::string, double>> out;
  const NodeAnim* a = d.anim(node);
  if (a == nullptr) return out;
  for (const auto& [prop, keys] : a->tracks) {
    if (auto v = anim_sample(d, env, cache, node, prop, t)) out.emplace_back(prop, *v);
  }
  for (const auto& [prop, st] : a->exprs) {
    if (a->tracks.contains(prop)) continue;
    if (auto v = anim_sample(d, env, cache, node, prop, t)) out.emplace_back(prop, *v);
  }
  return out;
}

}  // namespace premation::doc
