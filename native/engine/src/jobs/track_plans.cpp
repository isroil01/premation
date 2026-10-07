#include "track_plans.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>

#include "jsmath.hpp"
#include "scene.hpp"
#include "tracking.hpp"

namespace premation::jobs::trackapply {

namespace tr = tracking;
namespace st = stabilize;

namespace {

double atan2_deg(double y, double x) { return (motion::js::atan2(y, x) * 180) / 3.141592653589793; }

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

/// `s.coasted || s.confidence < 0.2 ? 0 : s.confidence` — a prediction or a weak match does not vote.
double vote_weight(const CompSample& s) { return s.coasted || s.confidence < 0.2 ? 0.0 : s.confidence; }

bool is_tracked_null_name(std::string_view n) {
  constexpr std::string_view kBase = "Tracked Null";
  if (!n.starts_with(kBase)) return false;
  std::string_view rest = n.substr(kBase.size());
  if (rest.empty()) return true;
  if (rest.front() != ' ' || rest.size() < 2) return false;
  rest.remove_prefix(1);
  return std::all_of(rest.begin(), rest.end(), [](char c) { return c >= '0' && c <= '9'; });
}

}  // namespace

std::optional<P2> Planner::to_comp(double x, double y, double compTime) const {
  return v_.sample_to_comp(s_.video, x, y, compTime, s_.width, s_.height, s_.box);
}

std::optional<P2> Planner::to_parent(const std::string& target, P2 c, double compTime) const {
  const std::optional<std::string> parent = v_.parent_of(target);
  if (!parent) return c;
  const std::optional<doc::LayerSpace> ps = v_.space(*parent, compTime);
  if (!ps) return std::nullopt;
  return DocView::from_comp(*ps, c);
}

std::optional<Plan> Planner::follow(const std::string& target, const Track& samples, bool camera) const {
  if (v_.node(target) == nullptr || samples.empty()) return std::nullopt;
  if (camera && !v_.is_camera(target)) return std::nullopt;
  Buckets b(camera ? std::vector<std::string>{"x", "y", "poiX", "poiY"} : std::vector<std::string>{"x", "y"});
  std::size_t n = 0;
  for (const CompSample& s : samples) {
    const std::optional<P2> cp = to_comp(s.x, s.y, s.compTime);
    if (!cp) continue;
    const std::optional<P2> p = to_parent(target, *cp, s.compTime);
    if (!p) continue;
    b.add("x", s.compTime, p->x);
    b.add("y", s.compTime, p->y);
    if (camera) {
      // Look-at the tracked point in the same parent / comp space.
      b.add("poiX", s.compTime, p->x);
      b.add("poiY", s.compTime, p->y);
    }
    ++n;
  }
  if (n == 0) return std::nullopt;
  return Plan{camera ? "Apply Camera Track" : "Apply Motion Track", target, b.writes(), {}, {}, n};
}

std::optional<Plan> Planner::stabilize(const Track& samples) const {
  const std::string& video = s_.video;
  if (v_.node(video) == nullptr || samples.empty()) return std::nullopt;
  const std::optional<Geometry> g = v_.geometry(video);
  if (!g) return std::nullopt;
  const std::optional<std::string> parent = v_.parent_of(video);
  const CompSample& first = samples.front();
  const std::optional<P2> p0 = to_comp(first.x, first.y, first.compTime);
  if (!p0) return std::nullopt;
  Buckets b({"x", "y"});
  std::size_t n = 0;
  for (const CompSample& s : samples) {
    const std::optional<P2> p = to_comp(s.x, s.y, s.compTime);
    if (!p) continue;
    double dx = p0->x - p->x;
    double dy = p0->y - p->y;
    if (parent) {
      const std::optional<doc::LayerSpace> ps = v_.space(*parent, s.compTime);
      if (!ps) continue;
      const P2 a = DocView::from_comp(*ps, *p0);
      const P2 q = DocView::from_comp(*ps, *p);
      dx = a.x - q.x;
      dy = a.y - q.y;
    }
    const double t = v_.key_time(video, s.compTime);
    b.add("x", s.compTime, v_.sample(video, "x", t).value_or(g->local.x) + dx);
    b.add("y", s.compTime, v_.sample(video, "y", t).value_or(g->local.y) + dy);
    ++n;
  }
  if (n == 0) return std::nullopt;
  return Plan{"Stabilize Motion", video, b.writes(), {}, {}, n};
}

std::optional<Plan> Planner::stabilize_transform(const std::vector<Track>& tracks, bool wantScale) const {
  const std::string& video = s_.video;
  if (v_.node(video) == nullptr || tracks.size() < 2) return std::nullopt;
  const std::optional<Geometry> g = v_.geometry(video);
  if (!g) return std::nullopt;
  const std::optional<std::string> parent = v_.parent_of(video);
  std::map<double, const CompSample*> refByTime;
  for (const CompSample& s : tracks[1]) refByTime.insert_or_assign(s.compTime, &s);
  Buckets bk({"x", "y", "rotation", "scaleX", "scaleY"});
  std::optional<P2> a0;
  std::optional<double> baseAngle;
  std::optional<double> baseLength;
  double prevAngleDelta = 0;
  std::size_t n = 0;
  for (const CompSample& a : tracks[0]) {
    const auto it = refByTime.find(a.compTime);
    if (it == refByTime.end()) continue;
    const std::optional<P2> ca = to_comp(a.x, a.y, a.compTime);
    const std::optional<P2> cb = to_comp(it->second->x, it->second->y, a.compTime);
    if (!ca || !cb) continue;
    const double vx = cb->x - ca->x;
    const double vy = cb->y - ca->y;
    const double len = hypot2(vx, vy);
    if (len < 1e-6) continue;
    const double angle = atan2_deg(vy, vx);
    if (!a0) {
      a0 = *ca;
      baseAngle = angle;
      baseLength = len;
    }
    const double dTheta = unwrap_deg(angle - *baseAngle, prevAngleDelta);
    prevAngleDelta = dTheta;
    const double s = wantScale ? len / *baseLength : 1.0;
    const double t = v_.key_time(video, a.compTime);
    // Where the layer's position sits in the comp now.
    P2 pos{v_.sample(video, "x", t).value_or(g->local.x), v_.sample(video, "y", t).value_or(g->local.y)};
    std::optional<doc::LayerSpace> ps;
    if (parent) {
      ps = v_.space(*parent, a.compTime);
      if (!ps) continue;
      pos = DocView::to_comp(*ps, pos);
    }
    // The similarity taking the feature pair at t back to frame 0: rotate by
    // −dθ and scale by 1/s about the feature, then move it onto a0.
    const double r = -dTheta * 3.14159265358979323846 / 180;
    const double c = std::cos(r) / s;
    const double sn = std::sin(r) / s;
    const double dx = pos.x - ca->x;
    const double dy = pos.y - ca->y;
    P2 moved{a0->x + c * dx - sn * dy, a0->y + sn * dx + c * dy};
    if (ps) moved = DocView::from_comp(*ps, moved);
    bk.add("x", a.compTime, moved.x);
    bk.add("y", a.compTime, moved.y);
    bk.add("rotation", a.compTime, v_.sample(video, "rotation", t).value_or(g->local.rotation) - dTheta);
    if (wantScale) {
      bk.add("scaleX", a.compTime, v_.sample(video, "scaleX", t).value_or(g->local.scale_x) / s);
      bk.add("scaleY", a.compTime, v_.sample(video, "scaleY", t).value_or(g->local.scale_y) / s);
    }
    ++n;
  }
  if (n == 0) return std::nullopt;
  return Plan{wantScale ? "Stabilize Motion (rotation & scale)" : "Stabilize Motion (rotation)", video, bk.writes(), {}, {}, n};
}

std::optional<Plan> Planner::effect_point(const std::string& target, const std::string& effectId, const std::string& effectType,
                                          const std::string& param, const Track& samples) const {
  if (v_.node(target) == nullptr || samples.empty() || effectId.empty()) return std::nullopt;
  const std::string kx = param + "X";
  const std::string ky = param + "Y";
  Buckets bk({kx, ky});
  std::size_t n = 0;
  for (const CompSample& s : samples) {
    const std::optional<P2> cp = to_comp(s.x, s.y, s.compTime);
    if (!cp) continue;
    const std::optional<doc::LayerSpace> space = v_.space(target, s.compTime);
    if (!space) continue;
    // Effect points are layer px measured from the layer's centre (the
    // catalog's default 0 is the centre), as Corner Pin's are from its corners.
    const P2 l = DocView::from_comp(*space, *cp);
    bk.add(kx, s.compTime, l.x);
    bk.add(ky, s.compTime, l.y);
    ++n;
  }
  if (n == 0) return std::nullopt;
  return Plan{"Apply Motion Track to Effect Point", target, bk.writes(), effectType, effectId, n};
}

std::optional<Plan> Planner::transform(const std::string& target, const std::vector<Track>& tracks, bool wantScale) const {
  if (v_.node(target) == nullptr || tracks.size() != 2) return std::nullopt;
  const std::optional<Geometry> g = v_.geometry(target);
  if (!g) return std::nullopt;
  std::map<double, const CompSample*> refByTime;
  for (const CompSample& s : tracks[1]) refByTime.insert_or_assign(s.compTime, &s);
  Buckets bk({"x", "y", "rotation", "scaleX", "scaleY"});
  std::size_t n = 0;
  std::optional<double> baseAngle;
  std::optional<double> baseLength;
  double prevAngleDelta = 0;
  for (const CompSample& a : tracks[0]) {
    const auto it = refByTime.find(a.compTime);
    if (it == refByTime.end()) continue;
    const CompSample& b = *it->second;
    const std::optional<P2> ca = to_comp(a.x, a.y, a.compTime);
    const std::optional<P2> pa = ca ? to_parent(target, *ca, a.compTime) : std::nullopt;
    const std::optional<P2> cb = to_comp(b.x, b.y, a.compTime);
    const std::optional<P2> pb = cb ? to_parent(target, *cb, a.compTime) : std::nullopt;
    if (!pa || !pb) continue;
    const double vx = pb->x - pa->x;
    const double vy = pb->y - pa->y;
    const double len = hypot2(vx, vy);
    if (len < 1e-6) continue;  // coincident points measure nothing
    const double angle = atan2_deg(vy, vx);
    if (!baseAngle || !baseLength) {
      baseAngle = angle;
      baseLength = len;
    }
    const double angleDelta = unwrap_deg(angle - *baseAngle, prevAngleDelta);
    prevAngleDelta = angleDelta;
    const double scaleRatio = len / *baseLength;
    const double t = v_.key_time(target, a.compTime);
    bk.add("x", a.compTime, pa->x);
    bk.add("y", a.compTime, pa->y);
    ++n;
    bk.add("rotation", a.compTime, v_.sample(target, "rotation", t).value_or(g->local.rotation) + angleDelta);
    if (wantScale) {
      bk.add("scaleX", a.compTime, v_.sample(target, "scaleX", t).value_or(g->local.scale_x) * scaleRatio);
      bk.add("scaleY", a.compTime, v_.sample(target, "scaleY", t).value_or(g->local.scale_y) * scaleRatio);
    }
  }
  if (n == 0) return std::nullopt;
  return Plan{"Apply Motion Track (rotation & scale)", target, bk.writes(), {}, {}, n};
}

std::optional<Plan> Planner::camera_track(const std::string& target, const std::vector<Track>& tracks) const {
  if (tracks.size() < 2 || !v_.is_camera(target)) return std::nullopt;
  std::optional<Plan> out = follow(target, tracks[0], true);
  if (!out) return std::nullopt;
  std::map<double, const CompSample*> refByTime;
  for (const CompSample& s : tracks[1]) refByTime.insert_or_assign(s.compTime, &s);
  Write ori{"orientationZ", {}};
  std::optional<double> baseAngle;
  double prevDelta = 0;
  for (const CompSample& a : tracks[0]) {
    const auto it = refByTime.find(a.compTime);
    if (it == refByTime.end()) continue;
    const double angle = atan2_deg(it->second->y - a.y, it->second->x - a.x);
    if (!baseAngle) baseAngle = angle;
    const double delta = unwrap_deg(angle - *baseAngle, prevDelta);
    prevDelta = delta;
    ori.keys.emplace_back(a.compTime, delta);
  }
  out->label = "Apply Camera Solve";
  out->count += ori.keys.size();
  if (!ori.keys.empty()) out->writes.push_back(std::move(ori));
  return out;
}

std::optional<Plan> Planner::corner(const std::string& target, const std::vector<Track>& tracks, const std::string& effectId) const {
  if (v_.node(target) == nullptr || tracks.size() < 4) return std::nullopt;
  const std::optional<Geometry> g = v_.geometry(target);
  if (!g || !g->width || !g->height) return std::nullopt;
  const double gw = *g->width;
  const double gh = *g->height;
  struct CornerKey {
    const char* x;
    const char* y;
    double rx;
    double ry;
  };
  const std::array<CornerKey, 4> keys{CornerKey{"topLeftX", "topLeftY", 0, 0}, CornerKey{"topRightX", "topRightY", gw, 0},
                                      CornerKey{"bottomRightX", "bottomRightY", gw, gh},
                                      CornerKey{"bottomLeftX", "bottomLeftY", 0, gh}};
  Buckets bk({"topLeftX", "topLeftY", "topRightX", "topRightY", "bottomRightX", "bottomRightY", "bottomLeftX", "bottomLeftY"});
  std::size_t nFrames = tracks[0].size();
  for (const Track& t : tracks) nFrames = std::min(nFrames, t.size());
  if (nFrames == 0) return std::nullopt;
  std::size_t planned = 0;
  auto writeCorner = [&](std::size_t c, double sx, double sy, double compTime) {
    const CornerKey& k = keys[c];
    const std::optional<P2> cp = to_comp(sx, sy, compTime);
    if (!cp) return;
    const std::optional<doc::LayerSpace> space = v_.space(target, compTime);
    if (!space) return;
    const P2 l = DocView::from_comp(*space, *cp);
    bk.add(k.x, compTime, l.x + gw / 2 - k.rx);
    bk.add(k.y, compTime, l.y + gh / 2 - k.ry);
    planned += 1;
  };
  if (tracks.size() == 4) {
    for (std::size_t c = 0; c < 4; ++c) {
      for (const CompSample& s : tracks[c]) writeCorner(c, s.x, s.y, s.compTime);
    }
  } else {
    // RANSAC over every feature (coasted / weak samples weigh 0), then a temporal smooth of H.
    std::vector<tr::Pt> seeds;
    for (const Track& t : tracks) seeds.push_back(tr::Pt{t[0].x, t[0].y});
    std::vector<std::optional<tr::Mat3>> hs;
    for (std::size_t i = 0; i < nFrames; ++i) {
      std::vector<tr::Pt> dst;
      tr::RansacOptions ro;
      ro.inlierPx = 3;
      ro.seed = static_cast<std::uint32_t>(i + 1);
      for (const Track& t : tracks) {
        dst.push_back(tr::Pt{t[i].x, t[i].y});
        ro.weights.push_back(vote_weight(t[i]));
      }
      const std::optional<tr::RansacFit> fit = tr::fit_homography_ransac(seeds, dst, ro);
      hs.push_back(fit ? std::optional<tr::Mat3>(fit->H) : tr::fit_homography(seeds, dst));
    }
    const std::vector<std::optional<tr::Mat3>> smoothed = tr::smooth_homography_sequence(hs, 1);
    for (std::size_t i = 0; i < nFrames; ++i) {
      const double compTime = tracks[0][i].compTime;
      if (!smoothed[i]) {
        for (std::size_t c = 0; c < 4; ++c) writeCorner(c, tracks[c][i].x, tracks[c][i].y, compTime);
        continue;
      }
      for (std::size_t c = 0; c < 4; ++c) {
        const std::optional<tr::Pt> p = tr::project_homography(*smoothed[i], seeds[c]);
        if (!p) continue;
        writeCorner(c, p->x, p->y, compTime);
      }
    }
  }
  if (planned == 0) return std::nullopt;
  return Plan{"Apply Corner Pin Track", target, bk.writes(), "corner-pin", effectId, planned};
}

std::optional<Plan> Planner::mesh_warp(const std::string& target, const std::vector<Track>& tracks) const {
  if (v_.node(target) == nullptr || tracks.size() < 4) return std::nullopt;
  const std::optional<Geometry> g = v_.geometry(target);
  if (!g) return std::nullopt;
  // readGeometry always reports a box in the TS; a kind without one keys against 0.
  const double gw = g->width.value_or(0);
  const double gh = g->height.value_or(0);
  std::size_t nFrames = tracks[0].size();
  for (std::size_t i = 1; i < 4; ++i) nFrames = std::min(nFrames, tracks[i].size());
  if (nFrames == 0) return std::nullopt;
  const bool dense = tracks.size() > 4;
  std::size_t denseFrames = nFrames;
  if (dense) {
    denseFrames = tracks[0].size();
    for (const Track& t : tracks) denseFrames = std::min(denseFrames, t.size());
  }
  std::vector<tr::Pt> seeds;
  for (const Track& t : tracks) seeds.push_back(tr::Pt{t[0].x, t[0].y});
  // Lattice seed positions: bilinear over the SEED quad in source px — the
  // rest pose of the 16 mesh vertices on the tracked surface.
  std::vector<tr::Pt> latticeSeeds;
  for (int row = 0; row < 4; ++row) {
    const double v = row / 3.0;
    for (int col = 0; col < 4; ++col) {
      const double u = col / 3.0;
      const tr::Pt top{seeds[0].x + (seeds[1].x - seeds[0].x) * u, seeds[0].y + (seeds[1].y - seeds[0].y) * u};
      const tr::Pt bot{seeds[3].x + (seeds[2].x - seeds[3].x) * u, seeds[3].y + (seeds[2].y - seeds[3].y) * u};
      latticeSeeds.push_back(tr::Pt{top.x + (bot.x - top.x) * v, top.y + (bot.y - top.y) * v});
    }
  }
  std::vector<std::string> names;
  for (int i = 0; i < 16; ++i) {
    names.push_back("v" + std::to_string(i) + "X");
    names.push_back("v" + std::to_string(i) + "Y");
  }
  Buckets bk(names);
  const std::array<P2, 4> cornerRest{P2{0, 0}, P2{gw, 0}, P2{gw, gh}, P2{0, gh}};
  std::size_t planned = 0;
  for (std::size_t fi = 0; fi < nFrames; ++fi) {
    const double compTime = tracks[0][fi].compTime;
    const std::optional<doc::LayerSpace> space = v_.space(target, compTime);
    if (!space) continue;
    // Dense path: one robust plane per frame at all 16 lattice seeds; the
    // bilinear corner path when the fit fails.
    if (dense && fi < denseFrames) {
      std::vector<tr::Pt> dst;
      tr::RansacOptions ro;
      ro.inlierPx = 3;
      ro.seed = static_cast<std::uint32_t>(fi + 1);
      for (const Track& t : tracks) {
        dst.push_back(tr::Pt{t[fi].x, t[fi].y});
        ro.weights.push_back(vote_weight(t[fi]));
      }
      if (const std::optional<tr::RansacFit> fit = tr::fit_homography_ransac(seeds, dst, ro)) {
        std::size_t wrote = 0;
        for (std::size_t idx = 0; idx < 16; ++idx) {
          const std::optional<tr::Pt> p = tr::project_homography(fit->H, latticeSeeds[idx]);
          if (!p) continue;
          const std::optional<P2> cp = to_comp(p->x, p->y, compTime);
          if (!cp) continue;
          const P2 l = DocView::from_comp(*space, *cp);
          const double restX = (static_cast<double>(idx % 4) / 3) * gw;
          const double restY = (std::floor(static_cast<double>(idx) / 4) / 3) * gh;
          bk.add("v" + std::to_string(idx) + "X", compTime, l.x + gw / 2 - restX);
          bk.add("v" + std::to_string(idx) + "Y", compTime, l.y + gh / 2 - restY);
          wrote += 1;
        }
        if (wrote > 0) {
          planned += wrote;
          continue;
        }
      }
    }
    std::array<std::optional<P2>, 4> corners;
    for (std::size_t c = 0; c < 4; ++c) {
      const CompSample& s = tracks[c][fi];
      const std::optional<P2> cp = to_comp(s.x, s.y, compTime);
      if (!cp) continue;
      const P2 l = DocView::from_comp(*space, *cp);
      corners[c] = P2{l.x + gw / 2 - cornerRest[c].x, l.y + gh / 2 - cornerRest[c].y};
    }
    if (std::any_of(corners.begin(), corners.end(), [](const std::optional<P2>& c) { return !c; })) continue;
    const P2 tl = *corners[0];
    const P2 trc = *corners[1];
    const P2 br = *corners[2];
    const P2 bl = *corners[3];
    for (int row = 0; row < 4; ++row) {
      const double v = row / 3.0;
      for (int col = 0; col < 4; ++col) {
        const double u = col / 3.0;
        const P2 top{tl.x + (trc.x - tl.x) * u, tl.y + (trc.y - tl.y) * u};
        const P2 bot{bl.x + (br.x - bl.x) * u, bl.y + (br.y - bl.y) * u};
        const int idx = row * 4 + col;
        bk.add("v" + std::to_string(idx) + "X", compTime, top.x + (bot.x - top.x) * v);
        bk.add("v" + std::to_string(idx) + "Y", compTime, top.y + (bot.y - top.y) * v);
        planned += 1;
      }
    }
  }
  if (planned == 0) return std::nullopt;
  return Plan{"Apply Mesh Warp Track", target, bk.writes(), "mesh-warp", {}, planned};
}

std::optional<NullSeed> Planner::null_seed(NullMode mode, const Track& samples, const std::vector<Track>& tracks) const {
  const doc::Node* video = v_.node(s_.video);
  if (video == nullptr) return std::nullopt;
  static const Track kNone;
  const Track& usable = mode == NullMode::corner ? (tracks.empty() ? kNone : tracks[0]) : samples;
  if (usable.empty()) return std::nullopt;
  NullSeed out;
  // createNullCommand: beside the video — its LAYER parent (a top-level video's parent is its composition).
  const std::optional<std::string> parent = v_.parent_of(s_.video);
  const std::optional<std::string> comp = doc::comp_of_layer(v_.doc(), s_.video);
  if (parent && (!comp || *parent != *comp)) out.parent = parent;
  const CompSample& first = usable.front();
  if (const std::optional<P2> cp = to_comp(first.x, first.y, first.compTime)) {
    // The seed in that parent's space (the composition's own space at the top).
    const std::optional<doc::LayerSpace> ps = parent ? v_.space(*parent, first.compTime) : std::nullopt;
    const P2 p = ps ? DocView::from_comp(*ps, *cp) : *cp;
    out.x = p.x;
    out.y = p.y;
  }
  return out;
}

std::optional<Plan> Planner::onto_null(const std::string& nullId, NullMode mode, const Track& samples,
                                       const std::vector<Track>& tracks) const {
  switch (mode) {
    case NullMode::follow: return follow(nullId, samples, false);
    case NullMode::transform: return transform(nullId, tracks, true);
    case NullMode::corner: return corner(nullId, tracks, {});
  }
  return std::nullopt;
}

P2 sample_subspace(const std::vector<SubspaceCell>& cells, int rows, int cols, double x, double y, double fieldW,
                   double fieldH) {
  if (rows < 1 || cols < 1 || cells.size() != static_cast<std::size_t>(rows) * static_cast<std::size_t>(cols)) return P2{x, y};
  const double u = std::max(0.0, std::min(1.0, x / std::max(1e-6, fieldW)));
  const double v = std::max(0.0, std::min(1.0, y / std::max(1e-6, fieldH)));
  const double fx = u * (cols - 1);
  const double fy = v * (rows - 1);
  const int c0 = static_cast<int>(std::floor(fx));
  const int r0 = static_cast<int>(std::floor(fy));
  const int c1 = std::min(cols - 1, c0 + 1);
  const int r1 = std::min(rows - 1, r0 + 1);
  const double tx = fx - c0;
  const double ty = fy - r0;
  const auto at = [&](int r, int c) -> const st::Sim& {
    return cells[static_cast<std::size_t>(r) * static_cast<std::size_t>(cols) + static_cast<std::size_t>(c)].sim;
  };
  const st::XY p00 = st::apply_sim(at(r0, c0), x, y);
  const st::XY p10 = st::apply_sim(at(r0, c1), x, y);
  const st::XY p01 = st::apply_sim(at(r1, c0), x, y);
  const st::XY p11 = st::apply_sim(at(r1, c1), x, y);
  const double topX = p00.x + (p10.x - p00.x) * tx;
  const double topY = p00.y + (p10.y - p00.y) * tx;
  const double botX = p01.x + (p11.x - p01.x) * tx;
  const double botY = p01.y + (p11.y - p01.y) * tx;
  return P2{topX + (botX - topX) * ty, topY + (botY - topY) * ty};
}

std::optional<Plan> plan_subspace_mesh(const std::string& layer, const std::vector<MeshFrame>& frames, int rows, int cols,
                                       double fieldW, double fieldH, double layerW, double layerH) {
  if (frames.empty()) return std::nullopt;
  std::vector<std::string> names;
  for (int i = 0; i < 16; ++i) {
    names.push_back("v" + std::to_string(i) + "X");
    names.push_back("v" + std::to_string(i) + "Y");
  }
  Buckets bk(names);
  for (const MeshFrame& fr : frames) {
    for (int i = 0; i < 16; ++i) {
      const double u = (i % 4) / 3.0;
      const double v = std::floor(i / 4.0) / 3;
      const double x = u * fieldW;
      const double y = v * fieldH;
      const P2 w = sample_subspace(fr.cells, rows, cols, x, y, fieldW, fieldH);
      bk.add("v" + std::to_string(i) + "X", fr.compTime, (w.x - x) * (layerW / std::max(1e-6, fieldW)));
      bk.add("v" + std::to_string(i) + "Y", fr.compTime, (w.y - y) * (layerH / std::max(1e-6, fieldH)));
    }
  }
  return Plan{"Apply Subspace Mesh Path", layer, bk.writes(), "mesh-warp", {}, frames.size() * 32};
}

std::string next_tracked_null_name(const doc::Document& d) {
  std::size_t prior = 0;
  for (const auto& [id, n] : d.nodes()) {
    if (n && n->parent && is_tracked_null_name(n->name)) ++prior;
  }
  return prior == 0 ? "Tracked Null" : "Tracked Null " + std::to_string(prior + 1);
}

}  // namespace premation::jobs::trackapply
