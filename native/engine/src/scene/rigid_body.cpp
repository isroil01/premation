#include "rigid_body.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <list>
#include <mutex>
#include <numbers>
#include <span>
#include <unordered_map>

#include "jsmath.hpp"

namespace premation::scene::physics {
namespace {

namespace mjs = motion::js;

struct Body {
  std::string id;
  bool dynamic = true;
  bool circle = false;
  double halfW = 0, halfH = 0;
  double x = 0, y = 0, vx = 0, vy = 0;
  double angle = 0, omega = 0;
  double invMass = 0, invInertia = 0;
  double restitution = 0, friction = 0, damping = 0;
};

using State = std::vector<Body>;

struct P {
  double x = 0, y = 0;
};

struct Contact {
  double nx = 0, ny = 0, depth = 0;
  std::vector<double> px, py;
};

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return mjs::hypot(v);
}

double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

double cross(double ax, double ay, double bx, double by) { return ax * by - ay * bx; }

std::array<P, 4> corners(const Body& b) {
  if (b.angle == 0) {
    return {P{b.x - b.halfW, b.y - b.halfH}, P{b.x + b.halfW, b.y - b.halfH}, P{b.x + b.halfW, b.y + b.halfH},
            P{b.x - b.halfW, b.y + b.halfH}};
  }
  const double c = mjs::cos(b.angle);
  const double s = mjs::sin(b.angle);
  const std::array<P, 4> local{P{-b.halfW, -b.halfH}, P{b.halfW, -b.halfH}, P{b.halfW, b.halfH}, P{-b.halfW, b.halfH}};
  std::array<P, 4> out{};
  for (std::size_t i = 0; i < 4; ++i) out[i] = P{b.x + local[i].x * c - local[i].y * s, b.y + local[i].x * s + local[i].y * c};
  return out;
}

std::optional<Contact> circle_circle(const Body& a, const Body& b) {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double r = a.halfW + b.halfW;
  const double dist = hypot2(dx, dy);
  if (dist >= r) return std::nullopt;
  const double nx = dist < 1e-9 ? 1 : dx / dist;
  const double ny = dist < 1e-9 ? 0 : dy / dist;
  Contact c;
  c.nx = nx;
  c.ny = ny;
  c.depth = r - dist;
  c.px = {a.x + nx * a.halfW};
  c.py = {a.y + ny * a.halfW};
  return c;
}

std::optional<Contact> circle_box(const Body& circle, const Body& box) {
  const double c = mjs::cos(-box.angle);
  const double s = mjs::sin(-box.angle);
  const double dx = circle.x - box.x;
  const double dy = circle.y - box.y;
  const double lx = dx * c - dy * s;
  const double ly = dx * s + dy * c;
  const double qx = std::max(-box.halfW, std::min(box.halfW, lx));
  const double qy = std::max(-box.halfH, std::min(box.halfH, ly));
  double nxL = 0, nyL = 0, depth = 0;
  if (qx == lx && qy == ly) {
    const double px = box.halfW - std::abs(lx);
    const double py = box.halfH - std::abs(ly);
    if (px < py) {
      nxL = lx < 0 ? -1 : 1;
      nyL = 0;
      depth = px + circle.halfW;
    } else {
      nxL = 0;
      nyL = ly < 0 ? -1 : 1;
      depth = py + circle.halfW;
    }
  } else {
    const double ddx = lx - qx;
    const double ddy = ly - qy;
    const double d = hypot2(ddx, ddy);
    if (d >= circle.halfW) return std::nullopt;
    nxL = d < 1e-9 ? 1 : ddx / d;
    nyL = d < 1e-9 ? 0 : ddy / d;
    depth = circle.halfW - d;
  }
  const double cw = mjs::cos(box.angle);
  const double sw = mjs::sin(box.angle);
  const double nx = nxL * cw - nyL * sw;
  const double ny = nxL * sw + nyL * cw;
  Contact out;
  out.nx = nx;
  out.ny = ny;
  out.depth = depth;
  out.px = {circle.x - nx * circle.halfW};
  out.py = {circle.y - ny * circle.halfW};
  return out;
}

struct Axis {
  double x = 0, y = 0, extent = 0;
};

std::array<Axis, 2> axes_of(const Body& o) {
  const double c = mjs::cos(o.angle);
  const double s = mjs::sin(o.angle);
  return {Axis{c, s, o.halfW}, Axis{-s, c, o.halfH}};
}

double projected_radius(const Body& o, double axX, double axY) {
  const auto [u, v] = axes_of(o);
  return o.halfW * std::abs(u.x * axX + u.y * axY) + o.halfH * std::abs(v.x * axX + v.y * axY);
}

std::optional<Contact> box_box(const Body& a, const Body& b) {
  const double tx = b.x - a.x;
  const double ty = b.y - a.y;
  struct Best {
    double depth, nx, ny;
    const Body* ref;
    const Body* inc;
  };
  std::optional<Best> best;
  const std::array<std::pair<const Body*, const Body*>, 2> pairs{std::pair{&a, &b}, std::pair{&b, &a}};
  for (const auto& [owner, other] : pairs) {
    for (const Axis& axis : axes_of(*owner)) {
      const double dist = std::abs(tx * axis.x + ty * axis.y);
      const double overlap = axis.extent + projected_radius(*other, axis.x, axis.y) - dist;
      if (overlap <= 0) return std::nullopt;
      if (!best || overlap < best->depth) {
        const double toward = tx * axis.x + ty * axis.y >= 0 ? 1 : -1;
        best = Best{overlap, axis.x * toward, axis.y * toward, owner, other};
      }
    }
  }
  if (!best) return std::nullopt;
  const Body& ref = *best->ref;
  const double refNx = best->ref == &a ? best->nx : -best->nx;
  const double refNy = best->ref == &a ? best->ny : -best->ny;
  const std::array<P, 4> incCorners = corners(*best->inc);
  const double refExtent = projected_radius(ref, refNx, refNy);
  const auto depthOf = [&](const P& p) { return refExtent - ((p.x - ref.x) * refNx + (p.y - ref.y) * refNy); };
  // [...incCorners].sort((p, q) => depthOf(q) - depthOf(p)): V8's sort is stable (TimSort).
  std::array<P, 4> sorted = incCorners;
  std::ranges::stable_sort(sorted, [&](const P& p, const P& q) { return depthOf(q) - depthOf(p) < 0; });
  const std::array<P, 2> edge{sorted[0], sorted[1]};
  const double rc = mjs::cos(ref.angle);
  const double rs = mjs::sin(ref.angle);
  const std::array<Axis, 2> axes{Axis{rc, rs, ref.halfW}, Axis{-rs, rc, ref.halfH}};
  const Axis side = std::abs(axes[0].x * refNx + axes[0].y * refNy) < std::abs(axes[1].x * refNx + axes[1].y * refNy) ? axes[0] : axes[1];
  const auto clip = [&](const P& p) {
    const double along = (p.x - ref.x) * side.x + (p.y - ref.y) * side.y;
    const double clamped = std::max(-side.extent, std::min(side.extent, along));
    return P{p.x + (clamped - along) * side.x, p.y + (clamped - along) * side.y};
  };
  Contact out;
  for (const P& p : edge) {
    if (depthOf(p) > -0.05) {
      const P q = clip(p);
      out.px.push_back(q.x);
      out.py.push_back(q.y);
    }
  }
  if (out.px.empty()) {
    const P q = clip(edge[0]);
    out.px.push_back(q.x);
    out.py.push_back(q.y);
  }
  out.nx = best->nx;
  out.ny = best->ny;
  out.depth = best->depth;
  return out;
}

std::optional<Contact> collide(const Body& a, const Body& b) {
  if (a.invMass == 0 && b.invMass == 0) return std::nullopt;
  if (a.circle && b.circle) return circle_circle(a, b);
  if (a.circle) {
    auto c = circle_box(a, b);
    if (c) {
      c->nx = -c->nx;
      c->ny = -c->ny;
    }
    return c;
  }
  if (b.circle) return circle_box(b, a);
  return box_box(a, b);
}

constexpr double kSlop = 0.05;
constexpr double kPercent = 0.8;

void resolve_contact(Body& a, Body& b, const Contact& c) {
  const double invSum = a.invMass + b.invMass;
  if (invSum <= 0) return;
  const bool rotating = a.invInertia != 0 || b.invInertia != 0;
  const double corr = rotating ? (std::max(c.depth - kSlop, 0.0) * kPercent) / invSum : c.depth / invSum;
  a.x -= c.nx * corr * a.invMass;
  a.y -= c.ny * corr * a.invMass;
  b.x += c.nx * corr * b.invMass;
  b.y += c.ny * corr * b.invMass;
  const std::size_t n = c.px.size();
  const auto nd = static_cast<double>(n);
  struct G {
    double rax, ray, rbx, rby;
  };
  std::vector<G> geom(n);
  for (std::size_t i = 0; i < n; ++i) geom[i] = G{c.px[i] - a.x, c.py[i] - a.y, c.px[i] - b.x, c.py[i] - b.y};
  std::vector<double> jns(n, 0.0);
  const double e = std::min(a.restitution, b.restitution);
  for (std::size_t i = 0; i < n; ++i) {
    const G& g = geom[i];
    const double relVx = b.vx - b.omega * g.rby - (a.vx - a.omega * g.ray);
    const double relVy = b.vy + b.omega * g.rbx - (a.vy + a.omega * g.rax);
    const double vn = relVx * c.nx + relVy * c.ny;
    if (vn > 0) continue;
    const double raCrossN = cross(g.rax, g.ray, c.nx, c.ny);
    const double rbCrossN = cross(g.rbx, g.rby, c.nx, c.ny);
    const double effMass = invSum + raCrossN * raCrossN * a.invInertia + rbCrossN * rbCrossN * b.invInertia;
    if (effMass <= 0) continue;
    jns[i] = (-(1 + e) * vn) / effMass / nd;
  }
  for (std::size_t i = 0; i < n; ++i) {
    const double jn = jns[i];
    if (jn == 0) continue;
    const G& g = geom[i];
    const double raCrossN = cross(g.rax, g.ray, c.nx, c.ny);
    const double rbCrossN = cross(g.rbx, g.rby, c.nx, c.ny);
    a.vx -= jn * c.nx * a.invMass;
    a.vy -= jn * c.ny * a.invMass;
    a.omega -= raCrossN * jn * a.invInertia;
    b.vx += jn * c.nx * b.invMass;
    b.vy += jn * c.ny * b.invMass;
    b.omega += rbCrossN * jn * b.invInertia;
  }
  const double f = std::max(a.friction, b.friction);
  if (f <= 0) return;
  const double tx = -c.ny;
  const double ty = c.nx;
  std::vector<double> jts(n, 0.0);
  for (std::size_t i = 0; i < n; ++i) {
    if (jns[i] == 0) continue;
    const G& g = geom[i];
    const double relVx = b.vx - b.omega * g.rby - (a.vx - a.omega * g.ray);
    const double relVy = b.vy + b.omega * g.rbx - (a.vy + a.omega * g.rax);
    const double vt = relVx * tx + relVy * ty;
    const double raCrossT = cross(g.rax, g.ray, tx, ty);
    const double rbCrossT = cross(g.rbx, g.rby, tx, ty);
    const double effMassT = invSum + raCrossT * raCrossT * a.invInertia + rbCrossT * rbCrossT * b.invInertia;
    if (effMassT <= 0) continue;
    const double maxT = std::abs(jns[i]) * f;
    jts[i] = std::max(-maxT, std::min(maxT, -vt / effMassT / nd));
  }
  for (std::size_t i = 0; i < n; ++i) {
    const double jt = jts[i];
    if (jt == 0) continue;
    const G& g = geom[i];
    const double raCrossT = cross(g.rax, g.ray, tx, ty);
    const double rbCrossT = cross(g.rbx, g.rby, tx, ty);
    a.vx -= jt * tx * a.invMass;
    a.vy -= jt * ty * a.invMass;
    a.omega -= raCrossT * jt * a.invInertia;
    b.vx += jt * tx * b.invMass;
    b.vy += jt * ty * b.invMass;
    b.omega += rbCrossT * jt * b.invInertia;
  }
}

struct Hit {
  double depth = 0, px = 0, py = 0;
};

/// deepestAgainst: `sign` +1 = overshoot is `coord - wall`, −1 = `wall - coord`.
std::optional<Hit> deepest_against(const Body& b, double outX, double outY, double wall, double sign) {
  const auto overshoot = [&](double coord) { return sign > 0 ? coord - wall : wall - coord; };
  if (b.circle) {
    const double px = b.x + outX * b.halfW;
    const double py = b.y + outY * b.halfW;
    const double depth = overshoot(outX != 0 ? px : py);
    if (depth > 0) return Hit{depth, px, py};
    return std::nullopt;
  }
  const std::array<P, 4> pts = corners(b);
  double maxDepth = 0;
  for (const P& p : pts) {
    const double d = overshoot(outX != 0 ? p.x : p.y);
    if (d > maxDepth) maxDepth = d;
  }
  if (maxDepth <= 0) return std::nullopt;
  double sx = 0, sy = 0, count = 0;
  for (const P& p : pts) {
    const double d = overshoot(outX != 0 ? p.x : p.y);
    if (d > 0 && d >= maxDepth - 1.0) {
      sx += p.x;
      sy += p.y;
      count += 1;
    }
  }
  return Hit{maxDepth, sx / count, sy / count};
}

void resolve_bounds(Body& b, const Bounds& bounds) {
  if (b.invMass == 0) return;
  struct Wall {
    double nx, ny, outX, outY, at, sign;
  };
  const std::array<Wall, 4> walls{Wall{1, 0, -1, 0, bounds.left, -1}, Wall{-1, 0, 1, 0, bounds.right, 1},
                                  Wall{0, 1, 0, -1, bounds.top, -1}, Wall{0, -1, 0, 1, bounds.bottom, 1}};
  for (const Wall& wall : walls) {
    const std::optional<Hit> hit = deepest_against(b, wall.outX, wall.outY, wall.at, wall.sign);
    if (!hit) continue;
    const double corr = b.invInertia == 0 ? hit->depth : std::max(hit->depth - kSlop, 0.0) * kPercent;
    b.x += wall.nx * corr;
    b.y += wall.ny * corr;
    const double rx = hit->px + wall.nx * hit->depth - b.x;
    const double ry = hit->py + wall.ny * hit->depth - b.y;
    const double relVx = b.vx - b.omega * ry;
    const double relVy = b.vy + b.omega * rx;
    const double vn = relVx * wall.nx + relVy * wall.ny;
    if (vn >= 0) continue;
    const double rCrossN = cross(rx, ry, wall.nx, wall.ny);
    const double effMass = b.invMass + rCrossN * rCrossN * b.invInertia;
    const double jn = (-(1 + b.restitution) * vn) / effMass;
    b.vx += jn * wall.nx * b.invMass;
    b.vy += jn * wall.ny * b.invMass;
    b.omega += rCrossN * jn * b.invInertia;
    if (b.friction <= 0) continue;
    const double tx = -wall.ny;
    const double ty = wall.nx;
    const double relVx2 = b.vx - b.omega * ry;
    const double relVy2 = b.vy + b.omega * rx;
    const double vt = relVx2 * tx + relVy2 * ty;
    const double rCrossT = cross(rx, ry, tx, ty);
    const double effMassT = b.invMass + rCrossT * rCrossT * b.invInertia;
    double jt = -vt / effMassT;
    const double maxT = std::abs(jn) * b.friction;
    jt = std::max(-maxT, std::min(maxT, jt));
    b.vx += jt * tx * b.invMass;
    b.vy += jt * ty * b.invMass;
    b.omega += rCrossT * jt * b.invInertia;
  }
}

State init_state(const std::vector<BodySeed>& seeds) {
  std::vector<const BodySeed*> ordered;
  ordered.reserve(seeds.size());
  for (const BodySeed& s : seeds) ordered.push_back(&s);
  // (a.id < b.id ? -1 : …): UTF-16 code-unit order; for the ids the editor mints
  // (ASCII) byte order is the same. Stable, as V8's sort.
  std::ranges::stable_sort(ordered, [](const BodySeed* a, const BodySeed* b) { return a->id < b->id; });
  constexpr double kDeg = std::numbers::pi / 180;
  State st;
  st.reserve(ordered.size());
  for (const BodySeed* s : ordered) {
    Body b;
    b.id = s->id;
    b.dynamic = s->cfg.kind == "dynamic";
    const double mass = s->cfg.mass > 0 ? s->cfg.mass : 1;
    b.circle = s->cfg.shape == "circle";
    b.halfW = b.circle ? std::max(0.5, std::min(s->width, s->height) / 2) : std::max(0.5, s->width / 2);
    b.halfH = b.circle ? b.halfW : std::max(0.5, s->height / 2);
    const double inertia = b.circle ? 0.5 * mass * b.halfW * b.halfW
                                    : (mass * (mjs::pow(b.halfW * 2, 2) + mjs::pow(b.halfH * 2, 2))) / 12;
    b.x = s->x;
    b.y = s->y;
    b.angle = s->rotation * kDeg;
    b.invMass = b.dynamic ? 1 / mass : 0;
    b.invInertia = b.dynamic && s->cfg.rotate ? 1 / inertia : 0;
    b.restitution = clamp01(s->cfg.restitution);
    b.friction = clamp01(s->cfg.friction);
    b.damping = clamp01(s->cfg.damping);
    st.push_back(std::move(b));
  }
  return st;
}

void step(State& bodies, const World& world, double dt) {
  for (Body& b : bodies) {
    if (b.invMass == 0) continue;
    b.vx += world.gravityX * dt;
    b.vy += world.gravityY * dt;
    const double d = mjs::pow(b.damping, dt);
    b.vx *= d;
    b.vy *= d;
    b.omega *= d;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.angle += b.omega * dt;
  }
  const double passes = std::max(1.0, std::floor(world.iterations));
  for (double it = 0; it < passes; ++it) {
    for (std::size_t i = 0; i < bodies.size(); ++i) {
      for (std::size_t j = i + 1; j < bodies.size(); ++j) {
        if (const auto c = collide(bodies[i], bodies[j])) resolve_contact(bodies[i], bodies[j], *c);
      }
    }
    if (world.bounds) {
      for (Body& b : bodies) resolve_bounds(b, *world.bounds);
    }
  }
}

// ── SimulationCache (snapshots every 30 frames, frame 0 pinned, 64 kept) ──

constexpr int kInterval = 30;
constexpr std::size_t kMaxSnapshots = 64;
constexpr int kMaxPreRoll = 100000;

struct History {
  std::map<int, State> snaps;
  std::list<int> recency;
};

std::string num(double v) { return js::number_to_string(v); }

std::string signature_of(const std::vector<BodySeed>& seeds, const World& w, double fps) {
  std::string s = num(fps) + "|" + num(w.gravityX) + "," + num(w.gravityY) + "|";
  if (w.bounds) s += num(w.bounds->left) + "," + num(w.bounds->top) + "," + num(w.bounds->right) + "," + num(w.bounds->bottom);
  s += "|" + num(w.iterations);
  for (const BodySeed& b : seeds) {
    s += "|" + b.id + "\x1f" + num(b.x) + "," + num(b.y) + "," + num(b.rotation) + "," + num(b.width) + "," + num(b.height) + "," +
         b.cfg.kind + "," + b.cfg.shape + "," + num(b.cfg.mass) + "," + num(b.cfg.restitution) + "," + num(b.cfg.friction) + "," +
         num(b.cfg.damping) + (b.cfg.rotate ? ",r" : ",-");
  }
  return s;
}

std::mutex gM;
std::unordered_map<std::string, History> gHistories;  // under gM
std::list<std::string> gOrder;                        // LRU of signatures, under gM
constexpr std::size_t kMaxHistories = 16;

}  // namespace

std::optional<BodyConfig> read_physics(const js::Json& raw) {
  if (!raw.is_object()) return std::nullopt;
  BodyConfig c;
  const bool enabled = raw.at("enabled").is_bool() && raw.at("enabled").b();
  if (!enabled) return std::nullopt;
  if (raw.at("kind").is_string()) c.kind = raw.at("kind").str();
  if (raw.at("shape").is_string()) c.shape = raw.at("shape").str();
  if (raw.at("mass").is_number()) c.mass = raw.at("mass").num();
  if (raw.at("restitution").is_number()) c.restitution = raw.at("restitution").num();
  if (raw.at("friction").is_number()) c.friction = raw.at("friction").num();
  if (raw.at("damping").is_number()) c.damping = raw.at("damping").num();
  if (raw.at("rotate").is_bool()) c.rotate = raw.at("rotate").b();
  return c;
}

std::map<std::string, Pose> poses_at(const std::vector<BodySeed>& seeds, const World& world, double fps, double frame) {
  std::map<std::string, Pose> out;
  if (seeds.empty()) return out;
  const double dt = fps > 0 ? 1 / fps : 1.0 / 60;
  const int target = static_cast<int>(std::max(0.0, std::floor(frame)));
  const std::string sig = signature_of(seeds, world, fps);
  State state;
  {
    const std::scoped_lock lock(gM);
    auto it = gHistories.find(sig);
    if (it == gHistories.end()) {
      if (gHistories.size() >= kMaxHistories && !gOrder.empty()) {
        gHistories.erase(gOrder.back());
        gOrder.pop_back();
      }
      it = gHistories.emplace(sig, History{}).first;
      it->second.snaps.emplace(0, init_state(seeds));
      gOrder.push_front(sig);
    } else {
      gOrder.remove(sig);
      gOrder.push_front(sig);
    }
    History& h = it->second;
    // nearestSnapshotAt: the largest snapshotted frame ≤ target (0 is pinned).
    auto at = h.snaps.upper_bound(target);
    --at;
    const int base = at->first;
    state = at->second;
    if (target - base > kMaxPreRoll) return out;  // SimulationPreRollLimit: nothing simulated
    for (int f = base + 1; f <= target; ++f) {
      step(state, world, dt);
      if (f % kInterval == 0 && !h.snaps.contains(f)) {
        h.snaps.emplace(f, state);
        h.recency.push_back(f);
        while (h.recency.size() > kMaxSnapshots) {
          h.snaps.erase(h.recency.front());
          h.recency.pop_front();
        }
      }
    }
  }
  for (const Body& b : state) {
    if (b.invMass == 0) continue;
    Pose p;
    p.x = b.x;
    p.y = b.y;
    if (b.invInertia != 0) p.rotation = (b.angle * 180) / std::numbers::pi;
    out.emplace(b.id, p);
  }
  return out;
}

}  // namespace premation::scene::physics
