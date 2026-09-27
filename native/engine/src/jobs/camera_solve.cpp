#include "camera_solve.hpp"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <span>
#include <utility>

#include "jsmath.hpp"
#include "tracking.hpp"

namespace premation::jobs::camsolve {

namespace mjs = motion::js;
using std::size_t;

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kRad2Deg = 180 / kPi;
constexpr double kDeg = kPi / 180;

double hyp(std::initializer_list<double> v) { return mjs::hypot(std::span<const double>(v.begin(), v.size())); }
double norm3(const V3& v) { return hyp({v.x, v.y, v.z}); }
V3 cross3(const V3& a, const V3& b) { return V3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
V3 scale3(const V3& v, double k) { return V3{v.x * k, v.y * k, v.z * k}; }
V3 add3(const V3& a, const V3& b) { return V3{a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 sub3(const V3& a, const V3& b) { return V3{a.x - b.x, a.y - b.y, a.z - b.z}; }
double dot3(const V3& a, const V3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
bool finite2(const V2& p) { return std::isfinite(p.x + p.y); }

const M3 kIdentity{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};

}  // namespace

// ── planarPose.ts ───────────────────────────────────────────────────────

std::optional<PlanarPose> solve_planar_pose(const std::vector<V2>& plane, const std::vector<V2>& image, double f, double cx,
                                            double cy) {
  if (plane.size() < 4 || image.size() != plane.size() || f <= 0) return std::nullopt;
  // Normalized image coordinates: the pinhole divide without K.
  std::vector<tracking::Pt> src;
  std::vector<tracking::Pt> dst;
  for (size_t i = 0; i < plane.size(); ++i) {
    src.push_back(tracking::Pt{plane[i].x, plane[i].y});
    dst.push_back(tracking::Pt{(image[i].x - cx) / f, (image[i].y - cy) / f});
  }
  const std::optional<tracking::Mat3> G = tracking::fit_homography(src, dst);
  if (!G) return std::nullopt;
  const auto g = [&](size_t i) { return static_cast<double>((*G)[i]); };
  // Columns of [[a,b,c],[d,e,f],[g,h,1]] — the column-major store.
  const V3 g1{g(0), g(1), g(2)};
  const V3 g2{g(3), g(4), g(5)};
  const V3 g3{g(6), g(7), g(8)};
  const double n1 = norm3(g1);
  const double n2 = norm3(g2);
  if (n1 < 1e-9 || n2 < 1e-9) return std::nullopt;
  // λ makes the rotation columns unit; its SIGN puts the plane in FRONT of the camera.
  double lambda = 2 / (n1 + n2);
  if (g3.z * lambda < 0) lambda = -lambda;
  V3 c1 = scale3(g1, lambda);
  const V3 c2raw = scale3(g2, lambda);
  const V3 t = scale3(g3, lambda);
  // Orthonormalize [c1 c2 c3]: Gram-Schmidt, then complete the basis.
  const double l1 = norm3(c1);
  if (l1 < 1e-9) return std::nullopt;
  c1 = scale3(c1, 1 / l1);
  const double dot12 = c1.x * c2raw.x + c1.y * c2raw.y + c1.z * c2raw.z;
  V3 c2{c2raw.x - dot12 * c1.x, c2raw.y - dot12 * c1.y, c2raw.z - dot12 * c1.z};
  const double l2 = norm3(c2);
  if (l2 < 1e-9) return std::nullopt;
  c2 = scale3(c2, 1 / l2);
  const V3 c3 = cross3(c1, c2);
  // M = world→camera rotation, columns c1 c2 c3.
  const M3 M{{{c1.x, c2.x, c3.x}, {c1.y, c2.y, c3.y}, {c1.z, c2.z, c3.z}}};
  // Eye: C = −Mᵀ t.
  PlanarPose out;
  out.position = V3{-(M[0][0] * t.x + M[1][0] * t.y + M[2][0] * t.z), -(M[0][1] * t.x + M[1][1] * t.y + M[2][1] * t.z),
                    -(M[0][2] * t.x + M[1][2] * t.y + M[2][2] * t.z)};
  // N = Mᵀ = Ry(yaw)·Rx(pitch)·Rz(roll): N[1][2] = −sin(pitch), N[0][2]/N[2][2] = tan(yaw), N[1][0]/N[1][1] = tan(roll).
  const double pitch = mjs::asin(std::max(-1.0, std::min(1.0, -M[2][1])));
  const double yaw = mjs::atan2(M[2][0], M[2][2]);
  const double roll = mjs::atan2(M[0][1], M[1][1]);
  // RMS reprojection through the recovered pose, in image px.
  double sq = 0;
  int count = 0;
  for (size_t i = 0; i < plane.size(); ++i) {
    const double px = plane[i].x - out.position.x;
    const double py = plane[i].y - out.position.y;
    const double pz = -out.position.z;
    const double camX = M[0][0] * px + M[0][1] * py + M[0][2] * pz;
    const double camY = M[1][0] * px + M[1][1] * py + M[1][2] * pz;
    const double camZ = M[2][0] * px + M[2][1] * py + M[2][2] * pz;
    if (camZ <= 1e-6) continue;
    const double u = cx + (f * camX) / camZ;
    const double v = cy + (f * camY) / camZ;
    sq += (u - image[i].x) * (u - image[i].x) + (v - image[i].y) * (v - image[i].y);
    count += 1;
  }
  if (count == 0) return std::nullopt;
  out.yawDeg = yaw * kRad2Deg;
  out.pitchDeg = pitch * kRad2Deg;
  out.rollDeg = roll * kRad2Deg;
  out.rmsPx = std::sqrt(sq / count);
  return out;
}

std::vector<double>& unwrap_degrees(std::vector<double>& series) {
  for (size_t i = 1; i < series.size(); ++i) {
    double d = series[i] - series[i - 1];
    while (d > 180) {
      series[i] -= 360;
      d -= 360;
    }
    while (d < -180) {
      series[i] += 360;
      d += 360;
    }
  }
  return series;
}

// ── triangulate.ts ──────────────────────────────────────────────────────

namespace {

V3 ray_dir(const M3& R, double xn, double yn) {
  return V3{R[0][0] * xn + R[1][0] * yn + R[2][0] * 1, R[0][1] * xn + R[1][1] * yn + R[2][1] * 1,
            R[0][2] * xn + R[1][2] * yn + R[2][2] * 1};
}

}  // namespace

std::optional<V3> triangulate_midpoint(const CameraRt& cam1, const CameraRt& cam2, V2 x1, V2 x2) {
  V3 d1 = ray_dir(cam1.R, x1.x, x1.y);
  V3 d2 = ray_dir(cam2.R, x2.x, x2.y);
  const double n1 = norm3(d1);
  const double n2 = norm3(d2);
  if (n1 < 1e-12 || n2 < 1e-12) return std::nullopt;
  d1 = scale3(d1, 1 / n1);
  d2 = scale3(d2, 1 / n2);
  const V3 r = sub3(cam1.C, cam2.C);
  const double a = dot3(d1, d1);
  const double b = dot3(d1, d2);
  const double c = dot3(d2, d2);
  const double d = dot3(d1, r);
  const double e = dot3(d2, r);
  const double denom = a * c - b * b;
  if (std::abs(denom) < 1e-12) return std::nullopt;
  const double s = (b * e - c * d) / denom;
  const double t = (a * e - b * d) / denom;
  if (s <= 0 || t <= 0) return std::nullopt;
  const V3 p1 = add3(cam1.C, scale3(d1, s));
  const V3 p2 = add3(cam2.C, scale3(d2, t));
  return scale3(add3(p1, p2), 0.5);
}

std::optional<UV> project_point(const M3& R, const V3& C, const V3& X, double f, double cx, double cy) {
  const double dx = X.x - C.x;
  const double dy = X.y - C.y;
  const double dz = X.z - C.z;
  const double xc = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz;
  const double yc = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz;
  const double zc = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz;
  if (!(zc > 1e-6)) return std::nullopt;
  return UV{cx + (f * xc) / zc, cy + (f * yc) / zc};
}

// ── bundleAdjust.ts ─────────────────────────────────────────────────────

namespace {

M3 mul3(const M3& A, const M3& B) {
  M3 out{};
  for (size_t i = 0; i < 3; ++i) {
    for (size_t j = 0; j < 3; ++j) out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  }
  return out;
}

double huber_weight(double r, double delta) {
  const double a = std::abs(r);
  return a <= delta ? 1 : delta / a;
}

std::vector<double> to_vector(const std::vector<BaCamera>& cams, const std::vector<V3>& pts) {
  std::vector<double> v;
  v.reserve((cams.empty() ? 0 : cams.size() - 1) * 6 + pts.size() * 3);
  for (size_t i = 1; i < cams.size(); ++i) {
    const BaCamera& c = cams[i];
    v.insert(v.end(), {c.C.x, c.C.y, c.C.z, c.yawDeg, c.pitchDeg, c.rollDeg});
  }
  for (const V3& p : pts) v.insert(v.end(), {p.x, p.y, p.z});
  return v;
}

void from_vector(const std::vector<double>& v, std::vector<BaCamera>& cams, std::vector<V3>& pts) {
  size_t k = 0;
  for (size_t i = 1; i < cams.size(); ++i) {
    cams[i].C = V3{v[k], v[k + 1], v[k + 2]};
    cams[i].yawDeg = v[k + 3];
    cams[i].pitchDeg = v[k + 4];
    cams[i].rollDeg = v[k + 5];
    k += 6;
  }
  for (V3& p : pts) {
    p = V3{v[k], v[k + 1], v[k + 2]};
    k += 3;
  }
}

struct Residuals {
  std::vector<double> r;
  double cost = 0;
  int nValid = 0;
};

Residuals residuals(const std::vector<BaObservation>& obs, const std::vector<BaCamera>& cams, const std::vector<V3>& pts,
                    double f, double cx, double cy, double huberDelta) {
  Residuals out;
  out.r.assign(obs.size() * 2, 0.0);
  // One rotation per camera (the TS rebuilds it per observation — the same numbers).
  std::vector<M3> rot;
  rot.reserve(cams.size());
  for (const BaCamera& c : cams) rot.push_back(ypr_to_r(c.yawDeg, c.pitchDeg, c.rollDeg));
  for (size_t i = 0; i < obs.size(); ++i) {
    const BaObservation& o = obs[i];
    if (o.frame < 0 || static_cast<size_t>(o.frame) >= cams.size() || o.pointId < 0 || static_cast<size_t>(o.pointId) >= pts.size()) {
      continue;
    }
    const BaCamera& cam = cams[static_cast<size_t>(o.frame)];
    const std::optional<UV> proj = project_point(rot[static_cast<size_t>(o.frame)], cam.C, pts[static_cast<size_t>(o.pointId)], f, cx, cy);
    if (!proj) {
      out.r[i * 2] = 100;
      out.r[i * 2 + 1] = 100;
      out.cost += 2 * 100 * 100;
      continue;
    }
    double dx = (proj->u - o.x) * o.weight;
    double dy = (proj->v - o.y) * o.weight;
    const double hw = huber_weight(hyp({dx, dy}), huberDelta);
    dx *= std::sqrt(hw);
    dy *= std::sqrt(hw);
    out.r[i * 2] = dx;
    out.r[i * 2 + 1] = dy;
    out.cost += dx * dx + dy * dy;
    out.nValid++;
  }
  return out;
}

/// `solveDense`: Gaussian elimination with partial pivoting; nullopt when singular.
std::optional<std::vector<double>> solve_dense(const std::vector<double>& JTJ, const std::vector<double>& JTr, size_t n) {
  const size_t w = n + 1;
  std::vector<double> A(n * w);
  for (size_t i = 0; i < n; ++i) {
    for (size_t j = 0; j < n; ++j) A[i * w + j] = JTJ[i * n + j];
    A[i * w + n] = JTr[i];
  }
  for (size_t col = 0; col < n; ++col) {
    size_t piv = col;
    double best = std::abs(A[col * w + col]);
    for (size_t r = col + 1; r < n; ++r) {
      const double v = std::abs(A[r * w + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-14) return std::nullopt;
    if (piv != col) {
      for (size_t j = col; j <= n; ++j) std::swap(A[col * w + j], A[piv * w + j]);
    }
    const double diag = A[col * w + col];
    for (size_t r = col + 1; r < n; ++r) {
      const double f = A[r * w + col] / diag;
      for (size_t j = col; j <= n; ++j) A[r * w + j] -= f * A[col * w + j];
    }
  }
  std::vector<double> x(n, 0.0);
  for (size_t ii = n; ii-- > 0;) {
    double s = A[ii * w + n];
    for (size_t j = ii + 1; j < n; ++j) s -= A[ii * w + j] * x[j];
    x[ii] = s / A[ii * w + ii];
  }
  return x;
}

}  // namespace

M3 ypr_to_r(double yawDeg, double pitchDeg, double rollDeg) {
  const double y = -yawDeg * kDeg;
  const double p = -pitchDeg * kDeg;
  const double r = -rollDeg * kDeg;
  const double cy = mjs::cos(y);
  const double sy = mjs::sin(y);
  const double cp = mjs::cos(p);
  const double sp = mjs::sin(p);
  const double cr = mjs::cos(r);
  const double sr = mjs::sin(r);
  const M3 Ry{{{cy, 0, sy}, {0, 1, 0}, {-sy, 0, cy}}};
  const M3 Rx{{{1, 0, 0}, {0, cp, -sp}, {0, sp, cp}}};
  const M3 Rz{{{cr, -sr, 0}, {sr, cr, 0}, {0, 0, 1}}};
  return mul3(Rz, mul3(Rx, Ry));
}

BaResult bundle_adjust(const std::vector<BaObservation>& obs, const std::vector<BaCamera>& cameras, const std::vector<V3>& points,
                       const BaOptions& opts) {
  double lambda = opts.lambda0;
  std::vector<BaCamera> cams = cameras;
  std::vector<V3> pts = points;
  const size_t n = (cams.empty() ? 0 : cams.size() - 1) * 6 + pts.size() * 3;
  const auto rms = [](double cost, int nValid) { return nValid > 0 ? std::sqrt(cost / (nValid * 2)) : 999.0; };
  if (n == 0 || obs.size() < 4) {
    const Residuals r = residuals(obs, cams, pts, opts.focal, opts.cx, opts.cy, opts.huberDelta);
    return BaResult{cams, pts, rms(r.cost, r.nValid), 0};
  }
  std::vector<double> v = to_vector(cams, pts);
  Residuals r0 = residuals(obs, cams, pts, opts.focal, opts.cx, opts.cy, opts.huberDelta);
  double bestCost = r0.cost;
  int nValid = r0.nValid;
  int iters = 0;
  constexpr double eps = 1e-4;
  for (; iters < opts.maxIters; ++iters) {
    // accumulateNormal: dense JᵀJ / Jᵀr by finite differences.
    const Residuals base = residuals(obs, cams, pts, opts.focal, opts.cx, opts.cy, opts.huberDelta);
    const size_t m = base.r.size();
    std::vector<std::vector<double>> cols(n);
    for (size_t j = 0; j < n; ++j) {
      std::vector<double> vp = v;
      vp[j] += eps;
      std::vector<BaCamera> cp = cams;
      std::vector<V3> pp = pts;
      from_vector(vp, cp, pp);
      const Residuals rp = residuals(obs, cp, pp, opts.focal, opts.cx, opts.cy, opts.huberDelta);
      std::vector<double> col(m);
      for (size_t i = 0; i < m; ++i) col[i] = (rp.r[i] - base.r[i]) / eps;
      cols[j] = std::move(col);
    }
    std::vector<double> JTJ(n * n, 0.0);
    std::vector<double> JTr(n, 0.0);
    for (size_t j = 0; j < n; ++j) {
      const std::vector<double>& cj = cols[j];
      double jtr = 0;
      for (size_t i = 0; i < m; ++i) jtr += cj[i] * base.r[i];
      JTr[j] = jtr;
      for (size_t k = 0; k <= j; ++k) {
        const std::vector<double>& ck = cols[k];
        double s = 0;
        for (size_t i = 0; i < m; ++i) s += cj[i] * ck[i];
        JTJ[j * n + k] = s;
        JTJ[k * n + j] = s;
      }
      JTJ[j * n + j] += lambda;
    }
    bestCost = base.cost;
    const std::optional<std::vector<double>> delta = solve_dense(JTJ, JTr, n);
    if (!delta) {
      lambda *= 10;
      continue;
    }
    std::vector<double> trial(n);
    for (size_t i = 0; i < n; ++i) trial[i] = v[i] - (*delta)[i];
    std::vector<BaCamera> tc = cams;
    std::vector<V3> tp = pts;
    from_vector(trial, tc, tp);
    const Residuals tr = residuals(obs, tc, tp, opts.focal, opts.cx, opts.cy, opts.huberDelta);
    nValid = tr.nValid;
    if (tr.cost < bestCost) {
      v = std::move(trial);
      cams = std::move(tc);
      pts = std::move(tp);
      bestCost = tr.cost;
      lambda = std::max(1e-8, lambda * 0.3);
    } else {
      lambda *= 8;
      if (lambda > 1e8) break;
    }
  }
  return BaResult{std::move(cams), std::move(pts), rms(bestCost, nValid), iters};
}

// ── sfmCamera.ts ────────────────────────────────────────────────────────

namespace {

using Row9 = std::array<double, 9>;
using Mat9 = std::array<Row9, 9>;

template <std::size_t N>
std::array<std::array<double, N>, N> mul_ata(const std::vector<std::array<double, N>>& A) {
  std::array<std::array<double, N>, N> out{};
  for (const auto& row : A) {
    for (size_t i = 0; i < N; ++i) {
      for (size_t j = 0; j < N; ++j) out[i][j] += row[i] * row[j];
    }
  }
  return out;
}

/// `nullspace9`: inverse-ish iteration on the near-zero eigenvalue.
std::optional<Row9> nullspace9(const Mat9& AtA) {
  Row9 v{};
  for (size_t i = 0; i < 9; ++i) v[i] = i == 8 ? 1 : 0.01 * static_cast<double>(i + 1);
  for (int it = 0; it < 64; ++it) {
    Row9 Av{};
    for (size_t i = 0; i < 9; ++i) {
      double s = 0;
      for (size_t j = 0; j < 9; ++j) s += AtA[i][j] * v[j];
      Av[i] = s;
    }
    Row9 w{};
    for (size_t i = 0; i < 9; ++i) w[i] = v[i] - Av[i] / (AtA[i][i] + 1e-6);
    const double nn = mjs::hypot(std::span<const double>(w.data(), w.size()));
    if (nn < 1e-12) return std::nullopt;
    for (size_t i = 0; i < 9; ++i) v[i] = w[i] / nn;
  }
  return v;
}

struct Decomposed {
  M3 R1{};
  M3 R2{};
  std::array<double, 3> t{};
};

Decomposed decompose_essential(const M3& E) {
  // The left-nullspace of E: the smallest eigenvector of E Eᵀ ≈ t.
  const std::vector<std::array<double, 3>> Et{{E[0][0], E[1][0], E[2][0]}, {E[0][1], E[1][1], E[2][1]}, {E[0][2], E[1][2], E[2][2]}};
  const auto EtE = mul_ata<3>(Et);
  std::array<double, 3> tv{1, 0.3, 0.1};
  for (int it = 0; it < 32; ++it) {
    std::array<double, 3> Av{};
    for (size_t i = 0; i < 3; ++i) Av[i] = EtE[i][0] * tv[0] + EtE[i][1] * tv[1] + EtE[i][2] * tv[2];
    std::array<double, 3> w{};
    for (size_t i = 0; i < 3; ++i) w[i] = tv[i] - Av[i] / (EtE[i][i] + 1e-6);
    double nn = hyp({w[0], w[1], w[2]});
    if (nn == 0 || std::isnan(nn)) nn = 1;
    tv = {w[0] / nn, w[1] / nn, w[2] / nn};
  }
  Decomposed out;
  out.t = tv;
  const M3 tx{{{0, -tv[2], tv[1]}, {tv[2], 0, -tv[0]}, {-tv[1], tv[0], 0}}};
  const auto rapprox = [&](double sign) {
    M3 o{};
    for (size_t i = 0; i < 3; ++i) {
      for (size_t j = 0; j < 3; ++j) {
        double s = 0;
        for (size_t k = 0; k < 3; ++k) s += sign * tx[k][i] * E[k][j];
        o[i][j] = s;
      }
    }
    // Orthonormalize the columns (Gram–Schmidt).
    std::array<double, 3> c0{o[0][0], o[1][0], o[2][0]};
    double n0 = hyp({c0[0], c0[1], c0[2]});
    if (n0 == 0 || std::isnan(n0)) n0 = 1;
    for (double& x : c0) x /= n0;
    std::array<double, 3> c1{o[0][1], o[1][1], o[2][1]};
    const double d = c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2];
    c1 = {c1[0] - d * c0[0], c1[1] - d * c0[1], c1[2] - d * c0[2]};
    double n1 = hyp({c1[0], c1[1], c1[2]});
    if (n1 == 0 || std::isnan(n1)) n1 = 1;
    for (double& x : c1) x /= n1;
    const std::array<double, 3> c2{c0[1] * c1[2] - c0[2] * c1[1], c0[2] * c1[0] - c0[0] * c1[2], c0[0] * c1[1] - c0[1] * c1[0]};
    return M3{{{c0[0], c1[0], c2[0]}, {c0[1], c1[1], c2[1]}, {c0[2], c1[2], c2[2]}}};
  };
  out.R1 = rapprox(1);
  out.R2 = rapprox(-1);
  return out;
}

struct Ypr {
  double yaw = 0;
  double pitch = 0;
  double roll = 0;
};

Ypr rot_to_ypr(const M3& R) {
  const double pitch = mjs::asin(std::max(-1.0, std::min(1.0, -R[2][0])));
  const double yaw = mjs::atan2(R[2][1], R[2][2]);
  const double roll = mjs::atan2(R[1][0], R[0][0]);
  return Ypr{(yaw * 180) / kPi, (pitch * 180) / kPi, (roll * 180) / kPi};
}

/// `refineWithBundleAdjust`: triangulate from frame 0 + a middle view, then LM.
std::optional<std::vector<SfmPose>> refine_with_bundle_adjust(const std::vector<std::vector<V2>>& frames,
                                                               const std::vector<SfmPose>& poses, double f, double cx, double cy) {
  if (frames.size() < 2 || poses.size() < 2) return std::nullopt;
  const size_t nPts = frames[0].size();
  if (nPts < 4) return std::nullopt;
  std::vector<BaCamera> cams;
  for (const SfmPose& p : poses) cams.push_back(BaCamera{V3{p.x, p.y, p.z}, p.yawDeg, p.pitchDeg, p.rollDeg});
  const auto camRt = [&](size_t i) { return CameraRt{ypr_to_r(cams[i].yawDeg, cams[i].pitchDeg, cams[i].rollDeg), cams[i].C}; };
  std::vector<V3> points;
  std::vector<int> pointIdOf(nPts, -1);
  const size_t second = std::min(poses.size() - 1, std::max<size_t>(1, poses.size() / 2));
  for (size_t pi = 0; pi < nPts; ++pi) {
    if (pi >= frames[second].size()) continue;
    const V2 p0 = frames[0][pi];
    const V2 p1 = frames[second][pi];
    if (!std::isfinite(p0.x + p0.y + p1.x + p1.y)) continue;
    const std::optional<V3> X = triangulate_midpoint(camRt(0), camRt(second), V2{(p0.x - cx) / f, (p0.y - cy) / f},
                                                     V2{(p1.x - cx) / f, (p1.y - cy) / f});
    if (!X) continue;
    pointIdOf[pi] = static_cast<int>(points.size());
    points.push_back(*X);
  }
  if (points.size() < 4) return std::nullopt;
  std::vector<BaObservation> obs;
  for (size_t fi = 0; fi < frames.size(); ++fi) {
    for (size_t pi = 0; pi < nPts; ++pi) {
      const int id = pointIdOf[pi];
      if (id < 0 || pi >= frames[fi].size()) continue;
      const V2 p = frames[fi][pi];
      if (!finite2(p)) continue;
      obs.push_back(BaObservation{static_cast<int>(fi), id, p.x, p.y, 1});
    }
  }
  if (obs.size() < 8) return std::nullopt;
  // Cap BA size for interactivity (dense grids).
  constexpr size_t kMaxObs = 4000;
  std::vector<BaObservation> used;
  if (obs.size() > kMaxObs) {
    const size_t stride = (obs.size() + kMaxObs - 1) / kMaxObs;
    for (size_t i = 0; i < obs.size(); ++i) {
      if (i % stride == 0) used.push_back(obs[i]);
    }
  } else {
    used = std::move(obs);
  }
  BaOptions o;
  o.focal = f;
  o.cx = cx;
  o.cy = cy;
  o.maxIters = 10;
  o.huberDelta = 4;
  const BaResult ba = bundle_adjust(used, cams, points, o);
  std::vector<SfmPose> out;
  for (const BaCamera& c : ba.cameras) out.push_back(SfmPose{c.C.x, c.C.y, c.C.z, c.yawDeg, c.pitchDeg, c.rollDeg, ba.rmsPx});
  return out;
}

}  // namespace

std::optional<RelativePose> essential_pose(const std::vector<V2>& a, const std::vector<V2>& b, double f, double cx, double cy) {
  std::vector<std::pair<V2, V2>> pairs;
  for (size_t i = 0; i < std::min(a.size(), b.size()); ++i) {
    const V2 p = a[i];
    const V2 q = b[i];
    if (!std::isfinite(p.x + p.y + q.x + q.y)) continue;
    pairs.emplace_back(V2{(p.x - cx) / f, (p.y - cy) / f}, V2{(q.x - cx) / f, (q.y - cy) / f});
  }
  if (pairs.size() < 8) return std::nullopt;
  const size_t used = std::min<size_t>(pairs.size(), 24);
  std::vector<Row9> A;
  for (size_t i = 0; i < used; ++i) {
    const V2& p = pairs[i].first;
    const V2& q = pairs[i].second;
    A.push_back(Row9{q.x * p.x, q.x * p.y, q.x, q.y * p.x, q.y * p.y, q.y, p.x, p.y, 1});
  }
  const std::optional<Row9> e = nullspace9(mul_ata<9>(A));
  if (!e) return std::nullopt;
  const M3 E{{{(*e)[0], (*e)[1], (*e)[2]}, {(*e)[3], (*e)[4], (*e)[5]}, {(*e)[6], (*e)[7], (*e)[8]}}};
  const Decomposed dec = decompose_essential(E);
  const std::array<double, 3> neg{-dec.t[0], -dec.t[1], -dec.t[2]};
  const std::array<RelativePose, 4> cands{RelativePose{dec.R1, dec.t}, RelativePose{dec.R2, dec.t}, RelativePose{dec.R1, neg},
                                          RelativePose{dec.R2, neg}};
  const RelativePose* best = cands.data();
  int bestScore = -1;
  for (const RelativePose& c : cands) {
    int score = 0;
    const CameraRt cam1{kIdentity, V3{}};
    const M3& Rt = c.R;
    const V3 C2{-(Rt[0][0] * c.t[0] + Rt[1][0] * c.t[1] + Rt[2][0] * c.t[2]),
                -(Rt[0][1] * c.t[0] + Rt[1][1] * c.t[1] + Rt[2][1] * c.t[2]),
                -(Rt[0][2] * c.t[0] + Rt[1][2] * c.t[1] + Rt[2][2] * c.t[2])};
    const CameraRt cam2{Rt, C2};
    for (size_t i = 0; i < used; ++i) {
      const std::optional<V3> X = triangulate_midpoint(cam1, cam2, pairs[i].first, pairs[i].second);
      if (!X) continue;
      const double z1 = X->z;
      const double dx = X->x - C2.x;
      const double dy = X->y - C2.y;
      const double dz = X->z - C2.z;
      const double z2 = Rt[2][0] * dx + Rt[2][1] * dy + Rt[2][2] * dz;
      if (z1 > 0 && z2 > 0) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = &c;
    }
  }
  if (bestScore < 4) return std::nullopt;
  return *best;
}

std::vector<SfmPose> solve_sfm_camera_path(const std::vector<std::vector<V2>>& frames, double focalLength, double width,
                                           double height) {
  std::vector<SfmPose> out;
  if (frames.empty()) return out;
  const double f = focalLength;
  const double cx = width / 2;
  const double cy = height / 2;
  const std::vector<V2>& ref = frames[0];
  const bool usePlanar = ref.size() >= 4 && std::all_of(ref.begin(), ref.begin() + 4, finite2);

  if (usePlanar) {
    const std::vector<V2> plane{V2{0, 0}, V2{width, 0}, V2{width, height}, V2{0, height}};
    const PlanarPose fallback{V3{0, 0, -f}, 0, 0, 0, 999};
    std::vector<PlanarPose> poses;
    for (const std::vector<V2>& fr : frames) {
      const std::vector<V2> img(fr.begin(), fr.begin() + static_cast<std::ptrdiff_t>(std::min<size_t>(4, fr.size())));
      const PlanarPose& last = poses.empty() ? fallback : poses.back();
      if (img.size() < 4 || !std::all_of(img.begin(), img.end(), finite2)) {
        poses.push_back(last);
        continue;
      }
      const std::optional<PlanarPose> pose = solve_planar_pose(plane, img, f, cx, cy);
      poses.push_back(pose ? *pose : last);
    }
    std::vector<double> yaws;
    std::vector<double> pitches;
    std::vector<double> rolls;
    for (const PlanarPose& p : poses) {
      yaws.push_back(p.yawDeg);
      pitches.push_back(p.pitchDeg);
      rolls.push_back(p.rollDeg);
    }
    unwrap_degrees(yaws);
    unwrap_degrees(pitches);
    unwrap_degrees(rolls);
    for (size_t i = 0; i < poses.size(); ++i) {
      const PlanarPose& p = poses[i];
      out.push_back(SfmPose{p.position.x, p.position.y, p.position.z, yaws[i], pitches[i], rolls[i], p.rmsPx});
    }
    return out;
  }

  // Incremental essential-matrix path → triangulate → BA.
  out.push_back(SfmPose{0, 0, -f, 0, 0, 0, 0});
  M3 accR = kIdentity;
  std::array<double, 3> accT{0, 0, -f};
  for (size_t i = 1; i < frames.size(); ++i) {
    std::optional<RelativePose> rel = essential_pose(frames[0], frames[i], f, cx, cy);
    if (!rel) rel = essential_pose(frames[i - 1], frames[i], f, cx, cy);
    if (!rel) {
      SfmPose p = out.back();
      p.error = 999;
      out.push_back(p);
      continue;
    }
    // Chain: R_i = R_rel R_{i−1}, t_i = R_rel t_{i−1} + t_rel · scale.
    double scale = hyp({accT[0], accT[1], accT[2]});
    if (scale == 0 || std::isnan(scale)) scale = f;
    M3 R{};
    for (size_t r = 0; r < 3; ++r) {
      for (size_t c = 0; c < 3; ++c) R[r][c] = rel->R[r][0] * accR[0][c] + rel->R[r][1] * accR[1][c] + rel->R[r][2] * accR[2][c];
    }
    std::array<double, 3> t{};
    for (size_t r = 0; r < 3; ++r) {
      t[r] = rel->R[r][0] * accT[0] + rel->R[r][1] * accT[1] + rel->R[r][2] * accT[2] + rel->t[r] * scale * 0.05;
    }
    accR = R;
    accT = t;
    const Ypr ypr = rot_to_ypr(R);
    out.push_back(SfmPose{t[0], t[1], t[2], ypr.yaw, ypr.pitch, ypr.roll, 0});
  }
  std::vector<double> yaws;
  std::vector<double> pitches;
  std::vector<double> rolls;
  for (const SfmPose& p : out) {
    yaws.push_back(p.yawDeg);
    pitches.push_back(p.pitchDeg);
    rolls.push_back(p.rollDeg);
  }
  unwrap_degrees(yaws);
  unwrap_degrees(pitches);
  unwrap_degrees(rolls);
  for (size_t i = 0; i < out.size(); ++i) {
    out[i].yawDeg = yaws[i];
    out[i].pitchDeg = pitches[i];
    out[i].rollDeg = rolls[i];
  }
  // Bundle-adjust when there are enough multi-view tracks.
  std::optional<std::vector<SfmPose>> refined = refine_with_bundle_adjust(frames, out, f, cx, cy);
  return refined ? std::move(*refined) : out;
}

}  // namespace premation::jobs::camsolve
