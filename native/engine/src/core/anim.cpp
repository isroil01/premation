#include "anim.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <utility>

#include "eval.hpp"
#include "jsmath.hpp"
#include "motion/motion_eval.h"

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

motion_keyframe to_motion(const Key& k) {
  motion_keyframe m{};
  m.t = k.t;
  m.value = k.value;
  m.easing = to_motion_easing(k.easing.value_or(api::Easing::linear));
  m.flags = k.spatial ? spatial_bits(*k.spatial) : 0U;
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

const NodeAnim* anim_of(const Document& d, std::string_view node) { return d.anim(node); }

void prune_anim(Document& d, std::string_view node) {
  const NodeAnim* a = d.anim(node);
  if (a != nullptr && a->empty()) d.set_anim(node, std::nullopt);
}

}  // namespace

std::size_t component_index_of(std::string_view prop) noexcept {
  if (prop == "y" || prop == "scaleY" || prop == "anchorY") return 1;
  if (prop == "z" || prop == "rotationZ") return 2;
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
  // Reused per thread: sampling runs on the document core thread only, so a
  // per-call allocation here would be the dominant cost of evaluating a comp.
  thread_local std::vector<motion_keyframe> scratch;
  scratch.resize(keys.size());
  for (std::size_t i = 0; i < keys.size(); ++i) scratch[i] = to_motion(keys[i]);
  return motion::eval::sample(motion::eval::StructSource{std::span<const motion_keyframe>(scratch)}, t);
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
  std::size_t i = 0;
  while (i + 1 < kfs.size() && kfs[i + 1].t <= t) ++i;
  const DataKey& a = kfs[i];
  const DataKey& b = kfs[i + 1];
  if (tr.kind == "text") return a.value;
  const double raw = (t - a.t) / (b.t - a.t);
  if (a.easing && (*a.easing == api::Easing::hold || *a.easing == api::Easing::step)) return a.value;
  const double u = ease_segment(a, raw);
  if (tr.kind == "number") return Json::number(lerp(a.value.num(), b.value.num(), u));
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

/// The Host of one evaluation: `exprContext(nodeId, prop, t, base, visited, depth)`.
class ContextHost final : public ex::Host {
 public:
  ContextHost(Sampler& s, std::string node, std::string prop, int depth) : s_(s), node_(std::move(node)), prop_(std::move(prop)), depth_(depth) {}

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

  double time = 0;

 private:
  Sampler& s_;
  std::string node_;
  std::string prop_;
  int depth_;
};

class Sampler {
 public:
  Sampler(const Document& d, const ExprEnv& env, ExprCache& cache) : d_(d), env_(env), cache_(cache) {}

  std::optional<double> track_at(std::string_view node, std::string_view prop, double t) const {
    const auto* keys = anim_track(d_, node, prop);
    return keys != nullptr ? sample_keys(*keys, t) : std::nullopt;
  }
  std::optional<double> base_of(std::string_view node, std::string_view prop) const { return env_.base_value(node, prop); }
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
        if (m.find(u"Cycle detected") != std::u16string::npos || m.find(u"Maximum cross-layer") != std::u16string::npos) {
          throw ex::HostError{m};
        }
      }
      if (r.kind == ex::Result::Kind::kVector) return r.vec.at(std::min(component_index_of(prop), r.size - 1));
      if (r.kind == ex::Result::Kind::kNumber) return r.number;
    }
    if (base) return base;
    return base_of(node, prop);
  }

  /// `compiled.run(exprContext(...))`.
  ex::Result run(const std::string& node, const std::string& prop, double t, std::optional<double> base, int depth,
                 const ex::Expression& compiled) {
    ContextHost host(*this, node, prop, depth);
    host.time = t;
    ex::Context c;
    c.time = t;
    const auto rest = [&]() { return base_of(node, prop).value_or(0); };
    c.value = base ? *base : rest();
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
  if (auto v = s_.track_at(node_, prop_, t)) return *v;
  return s_.base_of(node_, prop_).value_or(0);
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
  std::string target = node_;
  if (name != nullptr) {
    const auto r = s_.resolve(*name);
    if (!r) return std::nullopt;
    target = *r;
  }
  // Source Text expressions are evaluated elsewhere (E3); the pre-expression
  // text is what every read sees here.
  return s_.env_.source_text(target, t);
}

}  // namespace

std::optional<double> anim_sample(const Document& d, const ExprEnv& env, ExprCache& cache, std::string_view node,
                                  std::string_view prop, double t) {
  if (prop == "text.source") return std::nullopt;
  const ExprState* entry = anim_expr(d, node, prop);
  Sampler s(d, env, cache);
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
