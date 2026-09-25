#include "cloner_port.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <numbers>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "jsmath.hpp"
#include "merge_paths.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

using doc::Node;
namespace xf = motion::xf;

constexpr int kMaxClones = 500;  // MAX_CLONES

struct Step {
  double x = 0, y = 0, rotation = 0, scale = 0, opacity = 0, time = 0;
};
struct Random {
  double seed = 1, position = 0, rotation = 0, scale = 0;
};
struct Falloff {
  std::string shape = "none", source = "order";
  double position = 0.5, width = 0.5;
  std::string layerId;
  double radius = 300, push = 0;
  bool invert = false;
};
struct Config {
  bool enabled = false;
  std::string mode = "linear";
  double count = 5, countX = 3, countY = 3, offsetX = 120, offsetY = 0, radius = 200, startAngle = -90, arc = 360;
  bool alignToRadius = false;
  std::string pathLayerId;
  Step step;
  Random random;
  Falloff falloff;
};

/// `{...DEFAULT, ...raw}` for one field: a stored value wins (JSON null reads as
/// the number 0 the arithmetic would coerce it to).
void num(const Json& o, std::string_view k, double& out) {
  const Json& v = o.at(k);
  if (v.is_number()) out = v.num();
  else if (v.is_null()) out = 0;
}
void str(const Json& o, std::string_view k, std::string& out) {
  if (o.at(k).is_string()) out = o.at(k).str();
}
void flag(const Json& o, std::string_view k, bool& out) {
  const Json& v = o.at(k);
  if (v.is_bool()) out = v.b();
  else if (v.is_number()) out = v.num() != 0 && !std::isnan(v.num());
  else if (v.is_string()) out = !v.str().empty();
  else if (v.is_null()) out = false;
  else if (v.is_array() || v.is_object()) out = true;
}

/// readNodeCloner: the first component carrying `__cloner` (an object), merged
/// over DEFAULT_CLONER; null when disabled.
std::optional<Config> read_cloner(const Node& n) {
  for (const doc::Component& c : n.components) {
    const Json& raw = c.props.at("__cloner");
    if (!raw.is_object()) continue;
    Config cfg;
    flag(raw, "enabled", cfg.enabled);
    str(raw, "mode", cfg.mode);
    num(raw, "count", cfg.count);
    num(raw, "countX", cfg.countX);
    num(raw, "countY", cfg.countY);
    num(raw, "offsetX", cfg.offsetX);
    num(raw, "offsetY", cfg.offsetY);
    num(raw, "radius", cfg.radius);
    num(raw, "startAngle", cfg.startAngle);
    num(raw, "arc", cfg.arc);
    flag(raw, "alignToRadius", cfg.alignToRadius);
    str(raw, "pathLayerId", cfg.pathLayerId);
    if (const Json& s = raw.at("step"); s.is_object()) {
      num(s, "x", cfg.step.x);
      num(s, "y", cfg.step.y);
      num(s, "rotation", cfg.step.rotation);
      num(s, "scale", cfg.step.scale);
      num(s, "opacity", cfg.step.opacity);
      num(s, "time", cfg.step.time);
    }
    if (const Json& r = raw.at("random"); r.is_object()) {
      num(r, "seed", cfg.random.seed);
      num(r, "position", cfg.random.position);
      num(r, "rotation", cfg.random.rotation);
      num(r, "scale", cfg.random.scale);
    }
    if (const Json& f = raw.at("falloff"); f.is_object()) {
      str(f, "shape", cfg.falloff.shape);
      str(f, "source", cfg.falloff.source);
      num(f, "position", cfg.falloff.position);
      num(f, "width", cfg.falloff.width);
      str(f, "layerId", cfg.falloff.layerId);
      num(f, "radius", cfg.falloff.radius);
      num(f, "push", cfg.falloff.push);
      flag(f, "invert", cfg.falloff.invert);
    }
    if (!cfg.enabled) return std::nullopt;
    return cfg;
  }
  return std::nullopt;
}

/// cloner.ts hash01 — JavaScript's double arithmetic and ToInt32 / ToUint32, step for step.
double hash01(double i, double salt, double seed) {
  using motion::js::to_int32;
  using motion::js::to_uint32;
  double n = static_cast<double>(to_int32(i)) * 374761393 + static_cast<double>(to_int32(salt)) * 668265263 +
             static_cast<double>(to_int32(seed)) * 2246822519.0;
  n = static_cast<double>(std::bit_cast<std::int32_t>(to_uint32(n) ^ (to_uint32(n) >> 13U))) * 1274126177;
  n = static_cast<double>(std::bit_cast<std::int32_t>(to_uint32(n) ^ (to_uint32(n) >> 16U)));
  return static_cast<double>(to_uint32(n)) / 4294967296.0;
}
double hash11(double i, double salt, double seed) { return hash01(i, salt, seed) * 2 - 1; }

int clone_count(const Config& cfg) {
  if (!cfg.enabled) return 0;
  const double n = cfg.mode == "grid" ? std::max(0.0, std::floor(cfg.countX)) * std::max(0.0, std::floor(cfg.countY))
                                      : std::max(0.0, std::floor(cfg.count));
  return static_cast<int>(std::min(static_cast<double>(kMaxClones), n));
}

double shoulder(double d, double w, const Falloff& f) {
  double weight = 0;
  if (w <= 0) weight = d < 1e-6 ? 1 : 0;
  else if (f.shape == "linear") weight = std::max(0.0, 1 - d / w);
  else {
    const double k = std::max(0.0, std::min(1.0, 1 - d / w));
    weight = 0.5 - 0.5 * motion::js::cos(k * std::numbers::pi);
  }
  return f.invert ? 1 - weight : weight;
}

double falloff_weight(int i, int total, const Falloff& f) {
  if (f.shape == "none" || f.source != "order") return 1;
  const double t = total <= 1 ? 0 : static_cast<double>(i) / (total - 1);
  return shoulder(std::abs(t - f.position), std::max(0.0, std::min(1.0, f.width)), f);
}

double field_weight(double x, double y, const Falloff& f, const std::optional<xf::Vec2>& center) {
  if (f.shape == "none" || f.source != "layer") return 1;
  if (!center) return 1;
  return shoulder(hypot2(x - center->x, y - center->y), std::max(0.0, f.radius), f);
}

struct BasePos {
  double x = 0, y = 0, rot = 0;
};
/// trimPath.ts ArcTable over the driving path, in the cloner's local frame.
struct ArcTable {
  std::vector<std::array<double, 2>> pts;
  bool closed = true;
  std::vector<double> cum{0};
  double total = 0;
};

ArcTable arc_table(std::vector<std::array<double, 2>> pts, bool closed) {
  ArcTable t;
  t.pts = std::move(pts);
  t.closed = closed;
  const std::size_t n = t.pts.size();
  const std::size_t count = closed ? n : n - 1;
  for (std::size_t i = 0; i < count; ++i) {
    const auto& a = t.pts[i];
    const auto& b = t.pts[(i + 1) % n];
    const double d = hypot2(b[0] - a[0], b[1] - a[1]);
    t.total += d;
    t.cum.push_back(t.cum.back() + d);
  }
  return t;
}

/// pointAndTangentAtLength (angle in radians). `t.pts` has at least 2 points.
BasePos point_and_tangent(const ArcTable& t, double len) {
  const auto& pts = t.pts;
  const std::size_t n = pts.size();
  if (t.total <= 0) return {pts[0][0], pts[0][1], 0};
  const std::size_t count = t.closed ? n : n - 1;
  const double target = t.closed ? std::fmod(std::fmod(len, t.total) + t.total, t.total) : len;
  const auto seg = [&](std::size_t i) { return t.cum[i + 1] - t.cum[i]; };
  const auto at = [&](std::size_t i, double u) {
    const auto& a = pts[i];
    const auto& b = pts[(i + 1) % n];
    return BasePos{a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, motion::js::atan2(b[1] - a[1], b[0] - a[0])};
  };
  if (!t.closed && target < 0) return at(0, target / (seg(0) != 0 ? seg(0) : 1));
  if (!t.closed && target > t.total) {
    const std::size_t i = count - 1;
    return at(i, 1 + (target - t.total) / (seg(i) != 0 ? seg(i) : 1));
  }
  std::size_t lo = 0;
  std::size_t hi = count - 1;
  while (lo < hi) {
    const std::size_t mid = (lo + hi + 1) >> 1U;
    if (t.cum[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const double d = seg(lo);
  return at(lo, d > 0 ? (target - t.cum[lo]) / d : 0);
}

BasePos base_position(int i, const Config& cfg, int total, const std::optional<ArcTable>& path) {
  if (cfg.mode == "path" && path && path->pts.size() >= 2) {
    // A closed loop divides by n (the last clone must not land on the first), an open run by n − 1.
    const double denom = path->closed ? total : std::max(1.0, static_cast<double>(total - 1));
    BasePos at = point_and_tangent(*path, (path->total * i) / denom);
    at.rot = cfg.alignToRadius ? (at.rot * 180) / std::numbers::pi : 0;
    return at;
  }
  if (cfg.mode == "grid") {
    const double cols = std::max(1.0, std::floor(cfg.countX));
    const double rows = std::max(1.0, std::floor(cfg.countY));
    const double cx = std::fmod(static_cast<double>(i), cols);
    const double cy = std::floor(i / cols);
    return {(cx - (cols - 1) / 2) * cfg.offsetX, (cy - (rows - 1) / 2) * cfg.offsetY, 0};
  }
  if (cfg.mode == "radial") {
    const bool wraps = std::abs(cfg.arc) >= 360 - 1e-6;
    const double denom = wraps ? total : std::max(1.0, static_cast<double>(total - 1));
    const double deg = cfg.startAngle + (cfg.arc * i) / denom;
    const double rad = deg * kDeg;
    return {motion::js::cos(rad) * cfg.radius, motion::js::sin(rad) * cfg.radius, cfg.alignToRadius ? deg + 90 : 0};
  }
  const double mid = (total - 1) / 2.0;
  return {(i - mid) * cfg.offsetX, (i - mid) * cfg.offsetY, 0};
}

/// clonerPlan.
std::vector<CloneOffset> cloner_plan(const Config& cfg, const std::optional<xf::Vec2>& field, const std::optional<ArcTable>& path) {
  const int total = clone_count(cfg);
  std::vector<CloneOffset> out;
  if (total == 0) return out;
  const auto seed = static_cast<double>(motion::js::to_int32(cfg.random.seed));
  for (int i = 0; i < total; ++i) {
    const BasePos base = base_position(i, cfg, total, path);
    const double w = falloff_weight(i, total, cfg.falloff) * field_weight(base.x, base.y, cfg.falloff, field);
    const double t = total <= 1 ? 0 : static_cast<double>(i) / (total - 1);
    const double rx = hash11(i, 1, seed) * cfg.random.position;
    const double ry = hash11(i, 2, seed) * cfg.random.position;
    const double rr = hash11(i, 3, seed) * cfg.random.rotation;
    const double rs = hash11(i, 4, seed) * cfg.random.scale;
    double pushX = 0;
    double pushY = 0;
    if (field && cfg.falloff.source == "layer" && cfg.falloff.push != 0) {
      const double dx = base.x - field->x;
      const double dy = base.y - field->y;
      const double dist = hypot2(dx, dy);
      if (dist > 1e-9) {
        const double fw = field_weight(base.x, base.y, cfg.falloff, field);
        pushX = (dx / dist) * cfg.falloff.push * fw;
        pushY = (dy / dist) * cfg.falloff.push * fw;
      }
    }
    const double scale = 1 + (cfg.step.scale * t + rs) * w;
    CloneOffset c;
    c.index = i;
    c.x = base.x + (cfg.step.x * t + rx) * w + pushX;
    c.y = base.y + (cfg.step.y * t + ry) * w + pushY;
    c.rotation = base.rot + (cfg.step.rotation * t + rr) * w;
    c.scaleX = std::max(0.0, scale);
    c.scaleY = std::max(0.0, scale);
    c.opacity = std::max(0.0, std::min(100.0, 100 + cfg.step.opacity * t * w));
    c.timeOffset = cfg.step.time * t * w;
    out.push_back(c);
  }
  return out;
}

/// subtreeOf: the root and everything under it, in list order.
std::vector<const Node*> subtree_of(const std::vector<const Node*>& nodes, const std::string& rootId) {
  std::unordered_set<std::string> ids{rootId};
  std::vector<const Node*> out;
  for (const Node* n : nodes) {
    if (n->id == rootId || (n->parent && ids.contains(*n->parent))) {
      ids.insert(n->id);
      out.push_back(n);
    }
  }
  return out;
}

}  // namespace

void expand_cloners(WalkNodes& w, RawWorld& raw) {
  std::vector<const Node*> cloners;
  for (const Node* n : w.nodes) {
    if (read_cloner(*n)) cloners.push_back(n);
  }
  if (cloners.empty()) return;
  // A cloner inside another cloner's subtree is skipped (its layers are already multiplied).
  std::unordered_set<std::string> consumed;
  for (const Node* c : cloners) {
    for (const Node* n : subtree_of(w.nodes, c->id)) {
      if (n->id != c->id) consumed.insert(n->id);
    }
  }
  std::unordered_set<std::string> activeIds;
  std::unordered_map<std::string, std::vector<const Node*>> subtrees;
  std::unordered_set<std::string> dropped;
  for (const Node* c : cloners) {
    if (consumed.contains(c->id)) continue;
    activeIds.insert(c->id);
    std::vector<const Node*> sub = subtree_of(w.nodes, c->id);
    for (const Node* n : sub) dropped.insert(n->id);
    subtrees.emplace(c->id, std::move(sub));
  }
  if (activeIds.empty()) return;
  std::vector<const Node*> out;
  for (const Node* node : w.nodes) {
    if (!activeIds.contains(node->id)) {
      if (!dropped.contains(node->id)) out.push_back(node);
      continue;
    }
    const std::optional<Config> cfgOpt = read_cloner(*node);
    if (!cfgOpt) continue;
    const Config& cfg = *cfgOpt;
    // fieldOf: the driving layer's position in the cloner's local frame (raw graph).
    std::optional<xf::Vec2> field;
    if (cfg.falloff.source == "layer" && !cfg.falloff.layerId.empty() && raw.document().node(cfg.falloff.layerId) != nullptr &&
        raw.document().node(node->id) != nullptr) {
      const xf::Local2D rel = xf::local_under_parent(raw.world_matrix(cfg.falloff.layerId), raw.world_matrix(node->id));
      field = xf::Vec2{rel.x, rel.y};
    }
    // pathOf: the driving layer's outline (raw graph) in the cloner's local frame.
    std::optional<ArcTable> path;
    if (cfg.mode == "path" && !cfg.pathLayerId.empty()) {
      const doc::Node* pn = raw.document().node(cfg.pathLayerId);
      if (pn != nullptr && raw.document().node(node->id) != nullptr) {
        std::unordered_map<std::string, Values> vals;
        OperandReader reader;
        reader.node = [&raw](const std::string& id) { return raw.document().node(id); };
        reader.world = [&raw](const std::string& id) { return xf::matrix_to_local(raw.world_matrix(id)); };
        reader.values = [&raw, &vals](const std::string& id) -> const Values& {
          auto it = vals.find(id);
          if (it == vals.end()) it = vals.emplace(id, Values(raw.values(id))).first;
          return it->second;
        };
        reader.pathPoints = [&raw](const std::string& id) { return raw.path_points(id); };
        if (const std::optional<WorldOutline> o = node_world_outline(*pn, cfg.pathLayerId, reader)) {
          const xf::Mat2D inv = xf::invert(raw.world_matrix(node->id));
          std::vector<std::array<double, 2>> local;
          local.reserve(o->points.size());
          for (const auto& q : o->points) {
            const xf::Vec2 v = xf::transform_point(inv, {q[0], q[1]});
            local.push_back({v.x, v.y});
          }
          path = arc_table(std::move(local), o->closed);
        }
      }
    }
    const std::vector<CloneOffset> plan = cloner_plan(cfg, field, path);
    const std::vector<const Node*>& sub = subtrees.at(node->id);
    for (const CloneOffset& clone : plan) {
      const std::string prefix = node->id + "~c" + std::to_string(clone.index) + "::";
      for (const Node* orig : sub) {
        const bool isRoot = orig->id == node->id;
        auto c = std::make_unique<Node>();
        c->id = isRoot ? prefix + "root" : prefix + orig->id;
        c->name = orig->name;
        c->parent = isRoot ? orig->parent
                           : (orig->parent == node->id ? std::optional<std::string>(prefix + "root")
                                                       : std::optional<std::string>(prefix + orig->parent.value_or("")));
        c->visible = orig->visible;
        c->locked = orig->locked;
        c->solo = false;
        c->components = orig->components;
        w.source.insert_or_assign(c->id, orig->id);  // animation routes to the ORIGINAL's tracks
        if (isRoot) w.cloneOffsets.insert_or_assign(c->id, clone);
        out.push_back(c.get());
        w.owned.push_back(std::move(c));
      }
    }
  }
  w.nodes = std::move(out);
}

}  // namespace premation::scene
