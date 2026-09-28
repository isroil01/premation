// 3D IK on ordinary layers (B4 round 8) — a port of src/core/scene/boneIK3d.ts
// (solveCcdChain, planIk3DBake) and src/core/engine/handlers/dynamics.ts.
//
// CCD over a parent chain of 3D layers: every sweep walks the joints tip-ward
// to root, swinging each so the chain's tip (the last joint's origin) turns
// towards the target, clamped per step. The solver works in TOTAL euler degrees
// (rotation + orientation, which compose_node_3d sums) and writes back
// rotation = total − orientation. The writes go through setProperties /
// setKeyframes, so validation, key ids and undo are theirs.
#include "handlers_dynamics.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "handlers_properties.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "values.hpp"
#include "worldxf.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;

namespace xf = motion::xf;

constexpr double kDeg = 180.0 / 3.14159265358979323846;

struct Euler {
  double x = 0, y = 0, z = 0;
};

struct IkOpts {
  double iterations = 12;
  double tolerance = 0.5;
  double maxStepRad = 0.6;
};

IkOpts opts_of(const std::optional<api::IkOptions>& o) {
  IkOpts out;
  if (!o) return out;
  if (o->iterations) out.iterations = *o->iterations;
  if (o->tolerance) out.tolerance = *o->tolerance;
  if (o->max_step_rad) out.maxStepRad = *o->max_step_rad;
  return out;
}

/// boneIK3d.ts axisAngleMatrix: Rodrigues, column-major.
xf::Mat4 axis_angle(double ax, double ay, double az, double angle) {
  const double c = std::cos(angle), s = std::sin(angle), t = 1 - c;
  return {
      t * ax * ax + c,      t * ax * ay + s * az, t * ax * az - s * ay, 0,
      t * ax * ay - s * az, t * ay * ay + c,      t * ay * az + s * ax, 0,
      t * ax * az + s * ay, t * ay * az - s * ax, t * az * az + c,      0,
      0,                    0,                    0,                    1,
  };
}

/// boneIK3d.ts matrixToEulerDeg (R = Rz·Ry·Rx, scale normalised out).
Euler to_euler_deg(const xf::Mat4& m) {
  const double sx = std::hypot(m[0], m[1], m[2]);
  const double sy = std::hypot(m[4], m[5], m[6]);
  const double sz = std::hypot(m[8], m[9], m[10]);
  const double fx = sx != 0 ? sx : 1, fy = sy != 0 ? sy : 1, fz = sz != 0 ? sz : 1;
  const double r00 = m[0] / fx, r10 = m[1] / fx, r20 = m[2] / fx;
  const double r21 = m[6] / fy;
  const double r22 = m[10] / fz;
  const double r01 = m[4] / fy, r11 = m[5] / fy;
  const double syn = -r20;
  if (std::abs(syn) > 0.999999) return {0, syn > 0 ? 90.0 : -90.0, std::atan2(-r01, r11) * kDeg};
  return {std::atan2(r21, r22) * kDeg, std::asin(syn) * kDeg, std::atan2(r10, r00) * kDeg};
}

xf::Vec3 origin_of(const xf::Mat4& m) { return {m[12], m[13], m[14]}; }

/// boneIK3d.ts solveCcdChain: TOTAL euler degrees per joint (the tip unchanged).
std::vector<Euler> solve_ccd(const std::vector<xf::Node3DTransform>& locals, const std::optional<xf::Mat4>& rootParent,
                             const xf::Vec3& target, const IkOpts& o) {
  const std::size_t n = locals.size();
  std::vector<Euler> totals;
  totals.reserve(n);
  for (const auto& l : locals) {
    totals.push_back({l.rotation_x + l.orientation_x, l.rotation_y + l.orientation_y, l.rotation_z + l.orientation_z});
  }
  if (n < 2) return totals;
  std::vector<xf::Mat4> worlds(n);
  auto compose_at = [&](std::size_t i) {
    xf::Node3DTransform v = locals[i];
    v.rotation_x = totals[i].x;
    v.rotation_y = totals[i].y;
    v.rotation_z = totals[i].z;
    v.orientation_x = v.orientation_y = v.orientation_z = 0;
    return xf::compose_node_3d(v);
  };
  auto rebuild = [&](std::size_t from) {
    for (std::size_t i = from; i < n; ++i) {
      const xf::Mat4 own = compose_at(i);
      if (i == 0) worlds[i] = rootParent ? xf::multiply(*rootParent, own) : own;
      else worlds[i] = xf::multiply(worlds[i - 1], own);
    }
  };
  rebuild(0);
  for (double iter = 0; iter < o.iterations; iter += 1) {
    for (std::size_t k = n - 1; k-- > 0;) {
      const std::size_t i = k;
      const xf::Vec3 jp = origin_of(worlds[i]);
      const xf::Vec3 tip = origin_of(worlds[n - 1]);
      const xf::Vec3 v1{tip.x - jp.x, tip.y - jp.y, tip.z - jp.z};
      const xf::Vec3 v2{target.x - jp.x, target.y - jp.y, target.z - jp.z};
      const double l1 = std::hypot(v1.x, v1.y, v1.z);
      const double l2 = std::hypot(v2.x, v2.y, v2.z);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const double dot = std::clamp((v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (l1 * l2), -1.0, 1.0);
      double angle = std::acos(dot);
      if (angle < 1e-4) continue;
      angle = std::min(angle, o.maxStepRad);
      double ax = v1.y * v2.z - v1.z * v2.y;
      double ay = v1.z * v2.x - v1.x * v2.z;
      double az = v1.x * v2.y - v1.y * v2.x;
      const double al = std::hypot(ax, ay, az);
      if (al < 1e-9) continue;
      ax /= al;
      ay /= al;
      az /= al;
      const xf::Mat4 R = axis_angle(ax, ay, az, angle);
      const xf::Mat4& w = worlds[i];
      xf::Mat4 shifted = w;
      shifted[12] = w[12] - jp.x;
      shifted[13] = w[13] - jp.y;
      shifted[14] = w[14] - jp.z;
      xf::Mat4 rw = xf::multiply(R, shifted);
      rw[12] += jp.x;
      rw[13] += jp.y;
      rw[14] += jp.z;
      xf::Mat4 newLocal = rw;
      const std::optional<xf::Mat4> P = i == 0 ? rootParent : std::optional<xf::Mat4>(worlds[i - 1]);
      if (P) {
        const auto pInv = xf::invert(*P);
        if (!pInv) continue;
        newLocal = xf::multiply(*pInv, rw);
      }
      totals[i] = to_euler_deg(newLocal);
      rebuild(i);
    }
    const xf::Vec3 tip = origin_of(worlds[n - 1]);
    if (std::hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z) <= o.tolerance) break;
  }
  return totals;
}

void require_chain(const Document& d, const std::vector<std::string>& chain, const std::string& target) {
  if (chain.size() < 2) fail(ErrorCode::invalid_argument, "an IK chain needs at least two joints");
  for (const std::string& id : chain) {
    const Node* n = d.node(id);
    if (n == nullptr || !comp_of_layer(d, id)) fail(ErrorCode::not_found, "no layer '" + id + "'", {.layer = id});
    if (!is_3d_enabled(*n)) fail(ErrorCode::invalid_argument, "joint '" + id + "' is not a 3D layer", {.layer = id});
  }
  if (d.node(target) == nullptr || !comp_of_layer(d, target)) {
    fail(ErrorCode::not_found, "no layer '" + target + "'", {.layer = target});
  }
}

/// The chain's locals at `seconds`, with total-euler overrides where given (planIk3DBake's chainLocals).
std::optional<std::vector<xf::Node3DTransform>> chain_locals(const SpaceCtx& sc, const std::vector<std::string>& chain,
                                                             double seconds, const std::vector<Euler>* totals) {
  std::vector<xf::Node3DTransform> out;
  for (std::size_t i = 0; i < chain.size(); ++i) {
    const Node* n = sc.d.node(chain[i]);
    auto t = n != nullptr ? local_3d_at(sc, *n, seconds) : std::nullopt;
    if (!t) return std::nullopt;
    if (totals != nullptr && i < totals->size()) {
      t->rotation_x = (*totals)[i].x - t->orientation_x;
      t->rotation_y = (*totals)[i].y - t->orientation_y;
      t->rotation_z = (*totals)[i].z - t->orientation_z;
    }
    out.push_back(*t);
  }
  return out;
}

struct JointKeys {
  std::string id;
  std::vector<double> t, rx, ry, rz;
};

/// planIk3DBake over [t0, t1] (comp seconds): one solve per frame, seeded by the last.
std::vector<JointKeys> plan_bake(HCtx& x, const std::vector<std::string>& chain, const std::string& target, double t0,
                                 double t1, double fps, const IkOpts& o, std::uint32_t& frames) {
  const SpaceCtx sc{x.d, x.view, x.expr, x.cache};
  const Node* targetNode = x.d.node(target);
  const auto count = static_cast<std::uint32_t>(std::max(1.0, std::round((t1 - t0) * fps) + 1));
  std::vector<JointKeys> joints(chain.size() - 1);
  for (std::size_t i = 0; i + 1 < chain.size(); ++i) joints[i].id = chain[i];
  std::vector<Euler> prev;
  for (std::uint32_t f = 0; f < count; ++f) {
    const double t = t0 + f / fps;
    const auto targetM = node_world_3d_at(sc, *targetNode, t);
    const auto locals = chain_locals(sc, chain, t, prev.empty() ? nullptr : &prev);
    if (!targetM || !locals) fail(ErrorCode::invalid_argument, "the chain or the target could not resolve");
    const auto totals = solve_ccd(*locals, parent_world_at(sc, chain[0], t), origin_of(*targetM), o);
    prev = totals;
    for (std::size_t i = 0; i + 1 < chain.size(); ++i) {
      joints[i].t.push_back(t);
      joints[i].rx.push_back(totals[i].x - (*locals)[i].orientation_x);
      joints[i].ry.push_back(totals[i].y - (*locals)[i].orientation_y);
      joints[i].rz.push_back(totals[i].z - (*locals)[i].orientation_z);
    }
  }
  frames = count;
  return joints;
}

/// The API property of a joint's rotation track (`rotationX` / `rotationY` / `rotation`).
api::PropRef rotation_ref(const Document& d, const std::string& layer, std::string_view track) {
  const Catalog cat = catalog_for(d, layer);
  const PropBinding* b = cat.by_member(track);
  if (b == nullptr) fail(ErrorCode::not_found, "layer '" + layer + "' has no " + std::string(track), {.layer = layer});
  return api::PropRef{layer, b->path};
}

double fps_of(const Document& d, const std::string& layer) {
  const double fps = comp_fps(d, comp_of_layer(d, layer).value_or(""));
  return fps > 0 ? fps : 30;
}

}  // namespace

ResultOf<api::PoseIk3D> handle(const api::PoseIk3D& c, HCtx& x) {
  require_chain(x.d, c.chain, c.target);
  const double t = flicks_to_seconds(c.time);
  std::uint32_t frames = 0;
  const auto joints = plan_bake(x, c.chain, c.target, t, t, fps_of(x.d, c.chain[0]), opts_of(c.options), frames);
  api::SetProperties writes;
  for (const JointKeys& j : joints) {
    const std::pair<std::string_view, double> tracks[] = {{"rotationX", j.rx[0]}, {"rotationY", j.ry[0]}, {"rotation", j.rz[0]}};
    for (const auto& [track, value] : tracks) {
      writes.writes.push_back(api::PropertyWrite{rotation_ref(x.d, j.id, track), v_scalar(value), c.time});
    }
  }
  (void)handle(writes, x);
  x.label = "Pose 3D IK";
  return api::IkResult{1};
}

ResultOf<api::BakeIk3D> handle(const api::BakeIk3D& c, HCtx& x) {
  require_chain(x.d, c.chain, c.target);
  const double t0 = flicks_to_seconds(c.range.start);
  const double t1 = flicks_to_seconds(c.range.start + c.range.duration);
  std::uint32_t frames = 0;
  const auto joints = plan_bake(x, c.chain, c.target, t0, t1, fps_of(x.d, c.chain[0]), opts_of(c.options), frames);
  for (const JointKeys& j : joints) {
    const std::pair<std::string_view, const std::vector<double>*> tracks[] = {{"rotationX", &j.rx}, {"rotationY", &j.ry}, {"rotation", &j.rz}};
    for (const auto& [track, values] : tracks) {
      api::SetKeyframes set;
      set.prop = rotation_ref(x.d, j.id, track);
      for (std::size_t k = 0; k < values->size(); ++k) {
        api::Keyframe key;
        key.time = seconds_to_flicks(j.t[k]);
        key.value = v_scalar((*values)[k]);
        key.easing = api::Easing::linear;
        set.keys.push_back(std::move(key));
      }
      (void)handle(set, x);
    }
  }
  x.label = "Bake 3D IK";
  return api::IkResult{frames};
}

}  // namespace premation::doc
