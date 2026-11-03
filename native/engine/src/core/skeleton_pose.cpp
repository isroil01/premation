#include "skeleton_pose.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <numbers>
#include <set>
#include <utility>

#include "jsmath.hpp"

namespace premation::scene::skel {
namespace {

namespace mjs = motion::js;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

// V8 Math helpers, as rig_mesh.cpp has them (NaN propagation and ±0 exactly as JavaScript).
double jmax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}
double jmin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}
double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return mjs::hypot(v);
}
double jn(const Json& v) { return v.is_number() ? v.num() : kNaN; }
std::optional<double> jopt(const Json& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }
std::string jkey(const Json& v) {
  if (v.is_string()) return v.str();
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_null()) return "null";
  if (v.is_bool()) return v.b() ? "true" : "false";
  return "undefined";
}
double finite_or(const std::optional<double>& v, double fallback) { return v.has_value() && std::isfinite(*v) ? *v : fallback; }

}  // namespace

// ═══════════════════════════════════════════════════════════════════════════
// Skeleton (skeleton.ts, mat2d.ts, ik.ts, rigDeform.ts, geodesicWeights.ts …)
// ═══════════════════════════════════════════════════════════════════════════


Mat2D from_trs(double x, double y, double rotation, double scaleX, double scaleY) {
  const double c = mjs::cos(rotation);
  const double s = mjs::sin(rotation);
  return {c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y};
}
Mat2D mul(const Mat2D& m1, const Mat2D& m2) {
  const auto [a1, b1, c1, d1, e1, f1] = m1;
  const auto [a2, b2, c2, d2, e2, f2] = m2;
  return {a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1};
}
V2 apply(const Mat2D& m, double x, double y) { return {m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]}; }
Mat2D invert(const Mat2D& m) {
  const auto [a, b, c, d, e, f] = m;
  const double det = a * d - b * c;
  if (std::abs(det) < 1e-12) return kIdentity;
  const double id = 1 / det;
  const double na = d * id;
  const double nb = -b * id;
  const double nc = -c * id;
  const double nd = a * id;
  return {na, nb, nc, nd, -(na * e + nc * f), -(nb * e + nd * f)};
}


Bone read_bone(const Json& b) {
  Bone o;
  o.id = jkey(b.at("id"));
  if (b.at("parentId").is_string()) o.parentId = b.at("parentId").str();
  o.length = jn(b.at("length"));
  o.x = jn(b.at("x"));
  o.y = jn(b.at("y"));
  o.rotation = jn(b.at("rotation"));
  o.scaleX = jopt(b.at("scaleX"));
  o.scaleY = jopt(b.at("scaleY"));
  o.influenceRadius = jopt(b.at("influenceRadius"));
  return o;
}


/// computeWorldTransforms: parent-first, memoised; a cycle resolves to identity.
WorldMap compute_world(const std::vector<Bone>& bones) {
  std::unordered_map<std::string, const Bone*> byId;
  for (const Bone& b : bones) byId[b.id] = &b;
  WorldMap world;
  std::set<std::string> visiting;
  const auto resolve = [&](const auto& self, const std::string& id) -> Mat2D {
    if (const auto it = world.find(id); it != world.end()) return it->second;
    const auto bit = byId.find(id);
    if (bit == byId.end() || visiting.contains(id)) return kIdentity;
    const Bone& b = *bit->second;
    visiting.insert(id);
    const Mat2D local = from_trs(b.x, b.y, b.rotation, b.scaleX.value_or(1), b.scaleY.value_or(1));
    const Mat2D m = !b.parentId.empty() ? mul(self(self, b.parentId), local) : local;
    visiting.erase(id);
    world[id] = m;
    return m;
  };
  for (const Bone& b : bones) (void)resolve(resolve, b.id);
  return world;
}

V2 bone_tip(const Mat2D& w, double length) { return apply(w, length, 0); }
V2 bone_root(const Mat2D& w) { return apply(w, 0, 0); }

// ── ik.ts ──

TwoBone solve_two_bone(V2 root, double l1, double l2, V2 target, bool bendPositive) {
  const double dx = target.x - root.x;
  const double dy = target.y - root.y;
  const double rawDist = hypot2(dx, dy);
  const double reach = l1 + l2;
  const double minReach = std::abs(l1 - l2);
  const double dist = jmax(minReach + 1e-6, jmin(rawDist, reach - 1e-6));
  const double targetAngle = mjs::atan2(dy, dx);
  const double cosA1 = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const double a1 = mjs::acos(jmax(-1, jmin(1, cosA1)));
  const double cosA2 = (l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2);
  const double a2 = mjs::acos(jmax(-1, jmin(1, cosA2)));
  const double sign = bendPositive ? 1 : -1;
  const double angle1 = targetAngle - sign * a1;
  const double angle2 = angle1 + sign * (std::numbers::pi - a2);
  return {angle1, angle2};
}

V2 constrain(V2 point, V2 anchor, double len) {
  const double dx = point.x - anchor.x;
  const double dy = point.y - anchor.y;
  double d = hypot2(dx, dy);
  if (d == 0 || std::isnan(d)) d = 1e-9;  // `|| 1e-9`
  const double s = len / d;
  return {anchor.x + dx * s, anchor.y + dy * s};
}

std::vector<V2> solve_fabrik(const std::vector<V2>& joints, const std::vector<double>& lengths, V2 target) {
  constexpr int kIterations = 12;
  constexpr double kTolerance = 0.25;
  const std::size_t n = joints.size();
  std::vector<V2> p = joints;
  if (n < 2) return p;
  const V2 root = p[0];
  double total = 0;
  for (const double l : lengths) total = total + l;
  const double rootToTarget = hypot2(target.x - root.x, target.y - root.y);
  if (rootToTarget > total) {
    for (std::size_t i = 0; i + 1 < n; ++i) p[i + 1] = constrain(target, p[i], lengths[i]);
    return p;
  }
  for (int iter = 0; iter < kIterations; ++iter) {
    p[n - 1] = target;
    for (std::size_t i = n - 1; i-- > 0;) p[i] = constrain(p[i], p[i + 1], lengths[i]);
    p[0] = root;
    for (std::size_t i = 1; i < n; ++i) p[i] = constrain(p[i], p[i - 1], lengths[i - 1]);
    const V2 end = p[n - 1];
    if (hypot2(end.x - target.x, end.y - target.y) < kTolerance) break;
  }
  return p;
}

std::vector<double> angles_from_joints(const std::vector<V2>& joints) {
  std::vector<double> out;
  for (std::size_t i = 0; i + 1 < joints.size(); ++i) {
    out.push_back(mjs::atan2(joints[i + 1].y - joints[i].y, joints[i + 1].x - joints[i].x));
  }
  return out;
}


/// ikChainIds: the target bone and its ancestors, root-first. Indices into `bones` (last id wins).
std::vector<std::size_t> ik_chain(const std::vector<Bone>& bones, const std::string& targetBoneId, double chainLength) {
  std::unordered_map<std::string, std::size_t> byId;
  for (std::size_t i = 0; i < bones.size(); ++i) byId[bones[i].id] = i;
  const double maxD = jmax(1, jmin(8, std::floor(chainLength)));
  std::vector<std::size_t> chain;
  std::set<std::string> seen;
  auto cur = byId.find(targetBoneId);
  while (cur != byId.end() && static_cast<double>(chain.size()) < maxD && !seen.contains(bones[cur->second].id)) {
    const Bone& b = bones[cur->second];
    seen.insert(b.id);
    chain.insert(chain.begin(), cur->second);
    cur = !b.parentId.empty() ? byId.find(b.parentId) : byId.end();
  }
  return chain;
}

namespace {

/// Where a two-bone limb aims and how much it stretches (character rig, Tier 1).
struct LimbReach {
  V2 aim;
  double stretch = 1;
};

/// The goal as the limb can take it. `maxStretch` > 1 lets the limb lengthen up to that ratio to reach a goal past
/// its length; `softness` (px) eases the last stretch of the reach (soft IK: the effector approaches full extension
/// along 1 − e^(−x) instead of snapping the joint straight). 0 / 1 = off, the goal as it is.
LimbReach limb_reach(V2 root, double length, V2 target, double maxStretch, double softness) {
  const double dx = target.x - root.x;
  const double dy = target.y - root.y;
  const double dist = hypot2(dx, dy);
  LimbReach r{target, 1};
  if (!(dist > 1e-9) || !(length > 0)) return r;
  if (maxStretch > 1 && dist > length) r.stretch = jmin(dist / length, maxStretch);
  const double reach = length * r.stretch;
  const double soft = jmin(jmax(0, softness), reach);
  double d = dist;
  if (soft > 0 && d > reach - soft) d = reach - soft + soft * (1 - std::exp(-(d - (reach - soft)) / soft));
  if (d != dist) r.aim = V2{root.x + dx / dist * d, root.y + dy / dist * d};
  return r;
}

/// Lengthens a solved chain by `s`: each chain bone's length, the next bone's offset along it, and the children
/// hanging off the end bone (a hand at the forearm's tip) — rotations untouched.
void stretch_chain(std::vector<Bone>& bones, const std::vector<std::size_t>& chain, double s) {
  for (const std::size_t ci : chain) {
    bones[ci].length *= s;
    bones[ci].stretch *= s;
  }
  for (std::size_t i = 1; i < chain.size(); ++i) {
    bones[chain[i]].x *= s;
    bones[chain[i]].y *= s;
  }
  const std::string& end = bones[chain.back()].id;
  for (Bone& b : bones) {
    if (b.parentId == end) {
      b.x *= s;
      b.y *= s;
    }
  }
}

}  // namespace

std::vector<Bone> apply_ik(const std::vector<Bone>& bones, const std::vector<IkTarget>& targets) {
  std::vector<Bone> out = bones;
  if (targets.empty() || out.empty()) return out;
  std::unordered_map<std::string, std::size_t> byId;
  for (std::size_t i = 0; i < out.size(); ++i) byId[out[i].id] = i;
  for (const IkTarget& t : targets) {
    const auto endIt = byId.find(t.boneId);
    if (endIt == byId.end()) continue;
    if (!(t.blend > 0)) continue;
    const std::vector<std::size_t> chain = ik_chain(out, t.boneId, t.chainLength.value_or(2));
    if (chain.empty()) continue;
    const Bone& end = out[endIt->second];
    const WorldMap world = compute_world(out);
    std::vector<V2> joints;
    joints.reserve(chain.size() + 1);
    for (const std::size_t ci : chain) joints.push_back(bone_root(world.at(out[ci].id)));
    joints.push_back(bone_tip(world.at(end.id), end.length));
    std::vector<double> lengths;
    bool degenerate = false;
    for (std::size_t i = 0; i + 1 < joints.size(); ++i) {
      const double l = hypot2(joints[i + 1].x - joints[i].x, joints[i + 1].y - joints[i].y);
      if (l < 1e-6) degenerate = true;
      lengths.push_back(l);
    }
    if (degenerate) continue;
    const V2 target{t.x, t.y};
    const std::vector<double> currentAngles = angles_from_joints(joints);
    std::vector<double> solved;
    double stretch = 1;
    if (chain.size() == 1) {
      solved = {mjs::atan2(target.y - joints[0].y, target.x - joints[0].x)};
    } else if (chain.size() == 2) {
      const V2 j0 = joints[0];
      const V2 j1 = joints[1];
      const V2 j2 = joints[2];
      bool bendPositive = false;
      if (const V2* pole = t.pole_point()) {
        // The elbow lands on the pole's side of the root→target line.
        // solve_two_bone's bendPositive puts the middle joint where
        // cross(j1 − j0, target − j0) ≥ 0 (the no-pole branch below keeps the
        // current bend by the same product), so the pole is measured with the
        // SAME orientation: cross(pole − j0, target − j0).
        const double ax = target.x - j0.x;
        const double ay = target.y - j0.y;
        bendPositive = (pole->x - j0.x) * ay - (pole->y - j0.y) * ax >= 0;
      } else {
        bendPositive = (j1.x - j0.x) * (j2.y - j1.y) - (j1.y - j0.y) * (j2.x - j1.x) >= 0;
      }
      const LimbReach r = limb_reach(j0, lengths[0] + lengths[1], target, t.stretch, t.softness);
      stretch = r.stretch;
      const TwoBone sol = solve_two_bone(j0, lengths[0] * stretch, lengths[1] * stretch, r.aim, bendPositive);
      solved = {sol.angle1, sol.angle2};
    } else {
      solved = angles_from_joints(solve_fabrik(joints, lengths, target));
    }
    // The full IK deltas (relative to the chain above), applied at the blend:
    // FK + blend · (IK − FK) per local rotation.
    const double blend = jmin(1, t.blend);
    double cumulative = 0;
    for (std::size_t i = 0; i < chain.size(); ++i) {
      const double delta = solved[i] - (currentAngles[i] + cumulative);
      out[chain[i]].rotation += blend == 1 ? delta : delta * blend;
      cumulative += delta;
    }
    if (stretch != 1) stretch_chain(out, chain, 1 + (stretch - 1) * blend);
  }
  return out;
}

Skeleton read_skeleton(const Json& skel) {
  Skeleton s;
  for (const Json& b : skel.at("bones").arr()) s.bones.push_back(read_bone(b));
  // bindPoseBones: structure from the live bone, pose channels from the stored bind.
  const Json& bind = skel.at("bindPose");
  if (bind.is_array() && !bind.arr().empty()) {
    std::unordered_map<std::string, const Json*> byId;
    for (const Json& b : bind.arr()) byId[jkey(b.at("id"))] = &b;
    for (const Bone& b : s.bones) {
      Bone o = b;
      if (const auto it = byId.find(b.id); it != byId.end()) {
        const Json& r = *it->second;
        o.x = jn(r.at("x"));
        o.y = jn(r.at("y"));
        o.rotation = jn(r.at("rotation"));
        if (!r.at("scaleX").is_undefined()) o.scaleX = jopt(r.at("scaleX"));
        if (!r.at("scaleY").is_undefined()) o.scaleY = jopt(r.at("scaleY"));
      }
      s.bind.push_back(std::move(o));
    }
  } else {
    s.bind = s.bones;
  }
  if (skel.at("weightPaint").is_object()) s.weightPaint = &skel.at("weightPaint");
  s.dualQuaternion = skel.at("preserveVolume").is_string() && skel.at("preserveVolume").str() == "on";
  return s;
}

/// The IK/FK blend of a goal at `t`: the `ikMode.<bone>` track clamped to 0..1
/// when it is keyed, else the stored mode ('fk' = 0; anything else = 1).
double ik_blend_of(const Json& stored, const std::string& boneId, double t, const RigSampler& anim) {
  const auto sampled = anim.sample("ikMode." + boneId, t);
  if (sampled && std::isfinite(*sampled)) return jmax(0, jmin(1, *sampled));
  if (stored.at("ikMode").is_string()) return stored.at("ikMode").str() == "fk" ? 0 : 1;
  return 1;
}

/// Every stored IK goal with resolveIkTargets' sampling and its blend (enabled or not).
std::vector<RigIkOut> resolve_ik_goals(const Json& skel, double t, const RigSampler& anim) {
  std::vector<RigIkOut> out;
  const Json& list = skel.at("ikTargets");
  if (!list.is_array()) return out;
  const auto num = [](const std::optional<double>& v) { return v && std::isfinite(*v); };
  for (const Json& tg : list.arr()) {
    const std::string boneId = jkey(tg.at("boneId"));
    const auto liveX = anim.sample("ikTarget." + boneId + ".x", t);
    const auto liveY = anim.sample("ikTarget." + boneId + ".y", t);
    const auto poleX = anim.sample("ikPole." + boneId + ".x", t);
    const auto poleY = anim.sample("ikPole." + boneId + ".y", t);
    RigIkOut r;
    r.bone = boneId;
    r.enabled = !(tg.at("enabled").is_bool() && !tg.at("enabled").b());
    r.x = finite_or(liveX, jn(tg.at("x")));
    r.y = finite_or(liveY, jn(tg.at("y")));
    r.chainLength = jopt(tg.at("chainLength"));
    const Json& storedPole = tg.at("pole");
    if (num(poleX) || num(poleY)) {
      r.pole = std::array<double, 2>{finite_or(poleX, storedPole.at("x").is_number() ? storedPole.at("x").num() : 0),
                                     finite_or(poleY, storedPole.at("y").is_number() ? storedPole.at("y").num() : 0)};
    } else if (storedPole.is_object()) {
      r.pole = std::array<double, 2>{jn(storedPole.at("x")), jn(storedPole.at("y"))};
    }
    r.blend = ik_blend_of(tg, boneId, t, anim);
    r.stretch = finite_or(jopt(tg.at("stretch")), 0);
    r.softness = finite_or(jopt(tg.at("softness")), 0);
    r.mode = r.blend >= 0.5 ? "ik" : "fk";
    out.push_back(std::move(r));
  }
  return out;
}

/// resolveActiveIkTargets: the enabled goals with any IK share, as solver targets.
std::vector<IkTarget> active_ik_targets(const std::vector<RigIkOut>& goals) {
  std::vector<IkTarget> out;
  for (const RigIkOut& g : goals) {
    if (!g.enabled || !(g.blend > 0)) continue;
    IkTarget t;
    t.boneId = g.bone;
    t.x = g.x;
    t.y = g.y;
    t.chainLength = g.chainLength;
    if (g.pole) t.pole = V2{(*g.pole)[0], (*g.pole)[1]};
    t.blend = g.blend;
    t.stretch = g.stretch;
    t.softness = g.softness;
    out.push_back(std::move(t));
  }
  return out;
}

/// resolveLiveBones.
std::vector<Bone> resolve_live_bones(const std::vector<Bone>& bones, double t, const RigSampler& anim) {
  std::vector<Bone> out;
  out.reserve(bones.size());
  for (const Bone& b : bones) {
    const auto numberOr = [&](const char* ch, double fb) {
      const auto v = anim.sample("bone." + b.id + "." + ch, t);
      return v && std::isfinite(*v) ? *v : fb;
    };
    Bone o = b;
    o.rotation = numberOr("rotation", b.rotation);
    o.x = numberOr("x", b.x);
    o.y = numberOr("y", b.y);
    o.scaleX = numberOr("scaleX", b.scaleX.value_or(1));
    o.scaleY = numberOr("scaleY", b.scaleY.value_or(1));
    out.push_back(std::move(o));
  }
  return out;
}

}  // namespace premation::scene::skel
