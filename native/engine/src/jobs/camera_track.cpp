#include "camera_track.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <map>
#include <numeric>
#include <utility>

#include "track_feature.hpp"

namespace premation::jobs::camtrack {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr M3 kI{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};

std::size_t uz(int v) noexcept { return static_cast<std::size_t>(v); }

M3 mul(const M3& a, const M3& b) {
  M3 o{};
  for (std::size_t r = 0; r < 3; ++r)
    for (std::size_t c = 0; c < 3; ++c) o[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
  return o;
}
M3 transpose(const M3& a) {
  M3 o{};
  for (std::size_t r = 0; r < 3; ++r)
    for (std::size_t c = 0; c < 3; ++c) o[r][c] = a[c][r];
  return o;
}
V3 mulv(const M3& a, const V3& v) {
  return V3{a[0][0] * v.x + a[0][1] * v.y + a[0][2] * v.z, a[1][0] * v.x + a[1][1] * v.y + a[1][2] * v.z,
            a[2][0] * v.x + a[2][1] * v.y + a[2][2] * v.z};
}
V3 sub(const V3& a, const V3& b) { return V3{a.x - b.x, a.y - b.y, a.z - b.z}; }
V3 scale(const V3& a, double s) { return V3{a.x * s, a.y * s, a.z * s}; }
double dot(const V3& a, const V3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
double norm(const V3& a) { return std::sqrt(dot(a, a)); }
double det3(const M3& m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
         m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/// Rodrigues: the rotation by |w| about w.
M3 rodrigues(const V3& w) {
  const double th = norm(w);
  if (th < 1e-12) return M3{{{1, -w.z, w.y}, {w.z, 1, -w.x}, {-w.y, w.x, 1}}};
  const V3 k = scale(w, 1 / th);
  const double c = std::cos(th);
  const double s = std::sin(th);
  const double v = 1 - c;
  return M3{{{c + k.x * k.x * v, k.x * k.y * v - k.z * s, k.x * k.z * v + k.y * s},
             {k.y * k.x * v + k.z * s, c + k.y * k.y * v, k.y * k.z * v - k.x * s},
             {k.z * k.x * v - k.y * s, k.z * k.y * v + k.x * s, c + k.z * k.z * v}}};
}

/// Symmetric eigen decomposition (cyclic Jacobi). Columns of `vecs` are the eigenvectors.
template <std::size_t N>
void jacobi_eigen(std::array<std::array<double, N>, N> a, std::array<double, N>& vals, std::array<std::array<double, N>, N>& vecs) {
  for (std::size_t i = 0; i < N; ++i)
    for (std::size_t j = 0; j < N; ++j) vecs[i][j] = i == j ? 1 : 0;
  for (int sweep = 0; sweep < 60; ++sweep) {
    double off = 0;
    for (std::size_t p = 0; p < N; ++p)
      for (std::size_t q = p + 1; q < N; ++q) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (std::size_t p = 0; p < N; ++p) {
      for (std::size_t q = p + 1; q < N; ++q) {
        if (std::abs(a[p][q]) < 1e-300) continue;
        const double theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const double t = (theta >= 0 ? 1.0 : -1.0) / (std::abs(theta) + std::sqrt(theta * theta + 1));
        const double c = 1 / std::sqrt(t * t + 1);
        const double s = t * c;
        for (std::size_t k = 0; k < N; ++k) {
          const double akp = a[k][p];
          const double akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (std::size_t k = 0; k < N; ++k) {
          const double apk = a[p][k];
          const double aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (std::size_t k = 0; k < N; ++k) {
          const double vkp = vecs[k][p];
          const double vkq = vecs[k][q];
          vecs[k][p] = c * vkp - s * vkq;
          vecs[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  for (std::size_t i = 0; i < N; ++i) vals[i] = a[i][i];
}

/// 3×3 SVD through the eigen decomposition of MᵀM: M = U·diag(s)·Vᵀ, s descending, U and V proper rotations up to sign.
void svd3(const M3& m, M3& U, std::array<double, 3>& s, M3& V) {
  const M3 mtm = mul(transpose(m), m);
  std::array<double, 3> ev{};
  M3 vecs{};
  jacobi_eigen<3>(mtm, ev, vecs);
  std::array<std::size_t, 3> order{0, 1, 2};
  std::sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return ev[a] > ev[b]; });
  for (std::size_t c = 0; c < 3; ++c) {
    for (std::size_t r = 0; r < 3; ++r) V[r][c] = vecs[r][order[c]];
    s[c] = std::sqrt(std::max(0.0, ev[order[c]]));
  }
  for (std::size_t c = 0; c < 2; ++c) {
    const V3 v{V[0][c], V[1][c], V[2][c]};
    V3 u = mulv(m, v);
    const double n = norm(u);
    u = n > 1e-12 ? scale(u, 1 / n) : V3{c == 0 ? 1.0 : 0.0, c == 1 ? 1.0 : 0.0, 0};
    U[0][c] = u.x;
    U[1][c] = u.y;
    U[2][c] = u.z;
  }
  // Third column: orthogonal to the first two.
  const V3 a{U[0][0], U[1][0], U[2][0]};
  const V3 b{U[0][1], U[1][1], U[2][1]};
  const V3 c3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
  U[0][2] = c3.x;
  U[1][2] = c3.y;
  U[2][2] = c3.z;
}

/// Solve a small dense SPD system in place (Gaussian elimination, partial pivot). False when singular.
template <std::size_t N>
bool solve_small(std::array<std::array<double, N>, N> A, std::array<double, N> b, std::array<double, N>& x) {
  for (std::size_t col = 0; col < N; ++col) {
    std::size_t piv = col;
    for (std::size_t r = col + 1; r < N; ++r)
      if (std::abs(A[r][col]) > std::abs(A[piv][col])) piv = r;
    if (std::abs(A[piv][col]) < 1e-14) return false;
    std::swap(A[piv], A[col]);
    std::swap(b[piv], b[col]);
    for (std::size_t r = col + 1; r < N; ++r) {
      const double f = A[r][col] / A[col][col];
      for (std::size_t c = col; c < N; ++c) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  for (std::size_t i = N; i-- > 0;) {
    double s = b[i];
    for (std::size_t c = i + 1; c < N; ++c) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return true;
}

class Rng {
 public:
  explicit Rng(std::uint32_t s) : state_(s) {}
  std::uint32_t next() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }

 private:
  std::uint32_t state_;
};

struct Cam {
  double f = 0;
  double cx = 0;
  double cy = 0;
};

std::optional<V2> project_cam(const Pose& p, const V3& X, const Cam& k) {
  const V3 c = mulv(p.R, sub(X, p.C));
  if (c.z <= 1e-9) return std::nullopt;
  return V2{k.f * c.x / c.z + k.cx, k.f * c.y / c.z + k.cy};
}

// ── two-view initialisation ──────────────────────────────────────────────

struct Pair {
  V2 a;  ///< normalised
  V2 b;
};

double sampson(const M3& E, const Pair& p) {
  const V3 x1{p.a.x, p.a.y, 1};
  const V3 x2{p.b.x, p.b.y, 1};
  const V3 Ex1 = mulv(E, x1);
  const V3 Etx2 = mulv(transpose(E), x2);
  const double num = dot(x2, Ex1);
  const double den = Ex1.x * Ex1.x + Ex1.y * Ex1.y + Etx2.x * Etx2.x + Etx2.y * Etx2.y;
  return den > 1e-18 ? num * num / den : std::numeric_limits<double>::infinity();
}

std::optional<M3> eight_point(const std::vector<Pair>& pts, const std::vector<std::size_t>& idx) {
  if (idx.size() < 8) return std::nullopt;
  std::array<std::array<double, 9>, 9> AtA{};
  for (const std::size_t i : idx) {
    const Pair& p = pts[i];
    const std::array<double, 9> row{p.b.x * p.a.x, p.b.x * p.a.y, p.b.x, p.b.y * p.a.x, p.b.y * p.a.y, p.b.y, p.a.x, p.a.y, 1};
    for (std::size_t r = 0; r < 9; ++r)
      for (std::size_t c = 0; c < 9; ++c) AtA[r][c] += row[r] * row[c];
  }
  std::array<double, 9> vals{};
  std::array<std::array<double, 9>, 9> vecs{};
  jacobi_eigen<9>(AtA, vals, vecs);
  std::size_t mn = 0;
  for (std::size_t i = 1; i < 9; ++i)
    if (vals[i] < vals[mn]) mn = i;
  M3 E{};
  for (std::size_t r = 0; r < 3; ++r)
    for (std::size_t c = 0; c < 3; ++c) E[r][c] = vecs[r * 3 + c][mn];
  // Closest essential matrix: singular values (1, 1, 0).
  M3 U{};
  M3 V{};
  std::array<double, 3> s{};
  svd3(E, U, s, V);
  const M3 S{{{1, 0, 0}, {0, 1, 0}, {0, 0, 0}}};
  return mul(mul(U, S), transpose(V));
}

/// Linear triangulation from normalised observations and poses; nullopt when degenerate or behind a camera.
std::optional<V3> triangulate(const std::vector<std::pair<const Pose*, V2>>& views) {
  if (views.size() < 2) return std::nullopt;
  std::array<std::array<double, 3>, 3> A{};
  std::array<double, 3> b{};
  for (const auto& [pose, x] : views) {
    // P = [R | −R C]; rows x·P3 − P1, y·P3 − P2.
    const M3& R = pose->R;
    const V3 t = scale(mulv(R, pose->C), -1);
    const std::array<double, 4> P1{R[0][0], R[0][1], R[0][2], t.x};
    const std::array<double, 4> P2{R[1][0], R[1][1], R[1][2], t.y};
    const std::array<double, 4> P3{R[2][0], R[2][1], R[2][2], t.z};
    for (int k = 0; k < 2; ++k) {
      std::array<double, 4> row{};
      for (std::size_t i = 0; i < 4; ++i) row[i] = (k == 0 ? x.x : x.y) * P3[i] - (k == 0 ? P1[i] : P2[i]);
      for (std::size_t r = 0; r < 3; ++r) {
        for (std::size_t c = 0; c < 3; ++c) A[r][c] += row[r] * row[c];
        b[r] -= row[r] * row[3];
      }
    }
  }
  std::array<double, 3> X{};
  if (!solve_small<3>(A, b, X)) return std::nullopt;
  const V3 P{X[0], X[1], X[2]};
  for (const auto& [pose, x] : views) {
    if (mulv(pose->R, sub(P, pose->C)).z <= 0) return std::nullopt;
  }
  return P;
}

struct InitResult {
  Pose b;
  std::vector<std::size_t> inliers;
};

std::optional<InitResult> init_pair(const std::vector<Pair>& pts, double f, std::uint32_t seed) {
  if (pts.size() < 12) return std::nullopt;
  Rng rng(seed);
  const double thr = (1.5 / f) * (1.5 / f);
  std::vector<std::size_t> best;
  for (int it = 0; it < 300; ++it) {
    std::vector<std::size_t> sample;
    while (sample.size() < 8) {
      const std::size_t i = rng.next() % pts.size();
      if (std::find(sample.begin(), sample.end(), i) == sample.end()) sample.push_back(i);
    }
    const std::optional<M3> E = eight_point(pts, sample);
    if (!E) continue;
    std::vector<std::size_t> in;
    for (std::size_t i = 0; i < pts.size(); ++i)
      if (sampson(*E, pts[i]) < thr) in.push_back(i);
    if (in.size() > best.size()) best = std::move(in);
  }
  if (best.size() < 10) return std::nullopt;
  const std::optional<M3> E = eight_point(pts, best);
  if (!E) return std::nullopt;
  std::vector<std::size_t> in;
  for (std::size_t i = 0; i < pts.size(); ++i)
    if (sampson(*E, pts[i]) < thr * 2) in.push_back(i);
  M3 U{};
  M3 V{};
  std::array<double, 3> s{};
  svd3(*E, U, s, V);
  if (det3(U) < 0)
    for (auto& row : U) row[2] = -row[2];
  if (det3(V) < 0)
    for (auto& row : V) row[2] = -row[2];
  const M3 W{{{0, -1, 0}, {1, 0, 0}, {0, 0, 1}}};
  const M3 Rs[2] = {mul(mul(U, W), transpose(V)), mul(mul(U, transpose(W)), transpose(V))};
  const V3 u3{U[0][2], U[1][2], U[2][2]};
  const Pose a{kI, V3{}};
  std::optional<InitResult> out;
  std::size_t bestFront = 0;
  for (const M3& R : Rs) {
    for (const double sign : {1.0, -1.0}) {
      const V3 t = scale(u3, sign);
      Pose b{R, scale(mulv(transpose(R), t), -1)};
      std::size_t front = 0;
      for (const std::size_t i : in) {
        if (triangulate({{&a, pts[i].a}, {&b, pts[i].b}})) ++front;
      }
      if (front > bestFront) {
        bestFront = front;
        out = InitResult{b, in};
      }
    }
  }
  if (!out || bestFront < 10) return std::nullopt;
  return out;
}

// ── refinement ───────────────────────────────────────────────────────────

/// Gauss–Newton (LM-damped, Huber) on one point given poses; observations in px.
bool refine_point(V3& X, const std::vector<std::pair<const Pose*, V2>>& views, const Cam& k) {
  double lambda = 1e-3;
  for (int it = 0; it < 8; ++it) {
    std::array<std::array<double, 3>, 3> H{};
    std::array<double, 3> g{};
    double cost = 0;
    for (const auto& [pose, obs] : views) {
      const V3 c = mulv(pose->R, sub(X, pose->C));
      if (c.z <= 1e-9) return false;
      const double u = k.f * c.x / c.z + k.cx;
      const double v = k.f * c.y / c.z + k.cy;
      const double ru = u - obs.x;
      const double rv = v - obs.y;
      const double e = std::hypot(ru, rv);
      const double w = e <= 2 ? 1 : 2 / e;
      cost += w * (ru * ru + rv * rv);
      // d(u,v)/dXc · R
      const double iz = 1 / c.z;
      const std::array<double, 3> du{k.f * iz, 0, -k.f * c.x * iz * iz};
      const std::array<double, 3> dv{0, k.f * iz, -k.f * c.y * iz * iz};
      std::array<double, 3> ju{};
      std::array<double, 3> jv{};
      for (std::size_t j = 0; j < 3; ++j) {
        ju[j] = du[0] * pose->R[0][j] + du[1] * pose->R[1][j] + du[2] * pose->R[2][j];
        jv[j] = dv[0] * pose->R[0][j] + dv[1] * pose->R[1][j] + dv[2] * pose->R[2][j];
      }
      for (std::size_t r = 0; r < 3; ++r) {
        g[r] += w * (ju[r] * ru + jv[r] * rv);
        for (std::size_t c2 = 0; c2 < 3; ++c2) H[r][c2] += w * (ju[r] * ju[c2] + jv[r] * jv[c2]);
      }
    }
    for (std::size_t r = 0; r < 3; ++r) H[r][r] *= 1 + lambda;
    std::array<double, 3> d{};
    if (!solve_small<3>(H, g, d)) return false;
    const V3 next{X.x - d[0], X.y - d[1], X.z - d[2]};
    double nextCost = 0;
    bool ok = true;
    for (const auto& [pose, obs] : views) {
      const std::optional<V2> p = project_cam(*pose, next, k);
      if (!p) {
        ok = false;
        break;
      }
      const double e = std::hypot(p->x - obs.x, p->y - obs.y);
      nextCost += e <= 2 ? e * e : 2 * e;
    }
    if (ok && nextCost <= cost) {
      X = next;
      lambda *= 0.3;
      if (std::abs(d[0]) + std::abs(d[1]) + std::abs(d[2]) < 1e-9) break;
    } else {
      lambda *= 10;
      if (lambda > 1e6) break;
    }
  }
  return true;
}

/// Gauss–Newton on one pose (rotation as a left increment, the centre) given points; observations in px.
/// Returns the robust RMS (px), or nullopt.
std::optional<double> refine_pose(Pose& P, const std::vector<std::pair<V3, V2>>& corr, const Cam& k, int iters = 10) {
  if (corr.size() < 6) return std::nullopt;
  double lambda = 1e-3;
  auto cost_of = [&](const Pose& q, int* n) {
    double c = 0;
    int m = 0;
    for (const auto& [X, obs] : corr) {
      const std::optional<V2> p = project_cam(q, X, k);
      if (!p) continue;
      const double e = std::hypot(p->x - obs.x, p->y - obs.y);
      c += e <= 2 ? e * e : 2 * e;
      ++m;
    }
    if (n) *n = m;
    return c;
  };
  for (int it = 0; it < iters; ++it) {
    std::array<std::array<double, 6>, 6> H{};
    std::array<double, 6> g{};
    double cost = 0;
    for (const auto& [X, obs] : corr) {
      const V3 c = mulv(P.R, sub(X, P.C));
      if (c.z <= 1e-9) continue;
      const double iz = 1 / c.z;
      const double ru = k.f * c.x * iz + k.cx - obs.x;
      const double rv = k.f * c.y * iz + k.cy - obs.y;
      const double e = std::hypot(ru, rv);
      const double w = e <= 2 ? 1 : 2 / e;
      cost += w * (ru * ru + rv * rv);
      const std::array<double, 3> du{k.f * iz, 0, -k.f * c.x * iz * iz};
      const std::array<double, 3> dv{0, k.f * iz, -k.f * c.y * iz * iz};
      // dXc/dw = −[Xc]×, dXc/dC = −R.
      const std::array<std::array<double, 3>, 3> dw{{{0, c.z, -c.y}, {-c.z, 0, c.x}, {c.y, -c.x, 0}}};
      std::array<double, 6> ju{};
      std::array<double, 6> jv{};
      for (std::size_t j = 0; j < 3; ++j) {
        ju[j] = du[0] * dw[0][j] + du[1] * dw[1][j] + du[2] * dw[2][j];
        jv[j] = dv[0] * dw[0][j] + dv[1] * dw[1][j] + dv[2] * dw[2][j];
        ju[3 + j] = -(du[0] * P.R[0][j] + du[1] * P.R[1][j] + du[2] * P.R[2][j]);
        jv[3 + j] = -(dv[0] * P.R[0][j] + dv[1] * P.R[1][j] + dv[2] * P.R[2][j]);
      }
      for (std::size_t r = 0; r < 6; ++r) {
        g[r] += w * (ju[r] * ru + jv[r] * rv);
        for (std::size_t c2 = 0; c2 < 6; ++c2) H[r][c2] += w * (ju[r] * ju[c2] + jv[r] * jv[c2]);
      }
    }
    for (std::size_t r = 0; r < 6; ++r) H[r][r] = H[r][r] * (1 + lambda) + 1e-9;
    std::array<double, 6> d{};
    if (!solve_small<6>(H, g, d)) break;
    Pose next{mul(rodrigues(V3{-d[0], -d[1], -d[2]}), P.R), V3{P.C.x - d[3], P.C.y - d[4], P.C.z - d[5]}};
    if (cost_of(next, nullptr) <= cost) {
      P = next;
      lambda *= 0.3;
      double step = 0;
      for (const double v : d) step += std::abs(v);
      if (step < 1e-10) break;
    } else {
      lambda *= 10;
      if (lambda > 1e6) break;
    }
  }
  int n = 0;
  const double c = cost_of(P, &n);
  if (n < 6) return std::nullopt;
  return std::sqrt(c / n);
}

double ray_angle(const Pose& a, const Pose& b, const V3& X) {
  const V3 da = sub(X, a.C);
  const V3 db = sub(X, b.C);
  const double na = norm(da);
  const double nb = norm(db);
  if (na < 1e-12 || nb < 1e-12) return 0;
  return std::acos(std::clamp(dot(da, db) / (na * nb), -1.0, 1.0));
}

/// A whole solve at one focal length.
std::optional<Solve> solve_fixed(const FeatureTracks& t, double f, const SolveOptions& opts) {
  const auto n = t.frames.size();
  if (n < 3 || t.points < 12) return std::nullopt;
  const Cam k{f, t.width / 2.0, t.height / 2.0};
  // Observations by track: frame → px.
  std::vector<std::map<std::size_t, V2>> obs(uz(t.points));
  for (std::size_t fi = 0; fi < n; ++fi)
    for (const Obs& o : t.frames[fi]) obs[uz(o.point)].emplace(fi, V2{o.x, o.y});
  auto norm2 = [&](const V2& p) { return V2{(p.x - k.cx) / f, (p.y - k.cy) / f}; };

  // The initial pair: frame 0 and the first frame whose common tracks moved
  // enough for parallax (else the one that moved most).
  std::size_t bFrame = 0;
  double bestMove = -1;
  for (std::size_t fi = 1; fi < n; ++fi) {
    std::vector<double> moves;
    for (const Obs& o : t.frames[fi]) {
      const auto it = obs[uz(o.point)].find(0);
      if (it != obs[uz(o.point)].end()) moves.push_back(std::hypot(o.x - it->second.x, o.y - it->second.y));
    }
    if (moves.size() < 20) break;
    std::nth_element(moves.begin(), moves.begin() + static_cast<std::ptrdiff_t>(moves.size() / 2), moves.end());
    const double med = moves[moves.size() / 2];
    if (med > bestMove) {
      bestMove = med;
      bFrame = fi;
    }
    if (med > 0.04 * std::max(t.width, t.height)) break;
  }
  if (bFrame == 0) return std::nullopt;
  std::vector<Pair> pairs;
  std::vector<int> pairTrack;
  for (int p = 0; p < t.points; ++p) {
    const auto a = obs[uz(p)].find(0);
    const auto b = obs[uz(p)].find(bFrame);
    if (a == obs[uz(p)].end() || b == obs[uz(p)].end()) continue;
    pairs.push_back(Pair{norm2(a->second), norm2(b->second)});
    pairTrack.push_back(p);
  }
  const std::optional<InitResult> init = init_pair(pairs, f, 0x2545f491u);
  if (!init) return std::nullopt;

  Solve s;
  s.focal = f;
  s.cx = k.cx;
  s.cy = k.cy;
  s.poses.assign(n, std::nullopt);
  s.points.assign(uz(t.points), std::nullopt);
  s.poses[0] = Pose{kI, V3{}};
  s.poses[bFrame] = init->b;
  auto views_of = [&](int p, bool px) {
    std::vector<std::pair<const Pose*, V2>> v;
    for (const auto& [fi, o] : obs[uz(p)]) {
      if (s.poses[fi]) v.emplace_back(&*s.poses[fi], px ? o : norm2(o));
    }
    return v;
  };
  auto try_triangulate = [&](int p) {
    if (s.points[uz(p)]) return;
    const auto vn = views_of(p, false);
    if (vn.size() < 2) return;
    // Enough baseline between the most separated views.
    double maxAngle = 0;
    const std::optional<V3> X0 = triangulate(vn);
    if (!X0) return;
    for (std::size_t i = 0; i < vn.size(); ++i)
      for (std::size_t j = i + 1; j < vn.size(); ++j) maxAngle = std::max(maxAngle, ray_angle(*vn[i].first, *vn[j].first, *X0));
    if (maxAngle < 1.0 * kPi / 180) return;
    V3 X = *X0;
    if (!refine_point(X, views_of(p, true), k)) return;
    s.points[uz(p)] = X;
  };
  for (const std::size_t i : init->inliers) try_triangulate(pairTrack[i]);

  auto resect = [&](std::size_t fi, const Pose& guess) -> bool {
    std::vector<std::pair<V3, V2>> corr;
    for (const Obs& o : t.frames[fi]) {
      if (s.points[uz(o.point)]) corr.emplace_back(*s.points[uz(o.point)], V2{o.x, o.y});
    }
    if (corr.size() < 8) return false;
    Pose P = guess;
    std::optional<double> rms = refine_pose(P, corr, k);
    if (!rms) return false;
    // Robust second pass without the gross outliers.
    std::vector<std::pair<V3, V2>> kept;
    for (const auto& c : corr) {
      const std::optional<V2> q = project_cam(P, c.first, k);
      if (q && std::hypot(q->x - c.second.x, q->y - c.second.y) < 4) kept.push_back(c);
    }
    if (kept.size() < 8) return false;
    rms = refine_pose(P, kept, k);
    if (!rms || *rms > 4) return false;
    s.poses[fi] = P;
    return true;
  };

  auto refine_all = [&](int rounds) {
    for (int r = 0; r < rounds; ++r) {
      for (int p = 0; p < t.points; ++p) {
        if (!s.points[uz(p)]) continue;
        V3 X = *s.points[uz(p)];
        if (refine_point(X, views_of(p, true), k)) s.points[uz(p)] = X;
      }
      for (std::size_t fi = 1; fi < n; ++fi) {
        if (!s.poses[fi]) continue;
        std::vector<std::pair<V3, V2>> corr;
        for (const Obs& o : t.frames[fi])
          if (s.points[uz(o.point)]) corr.emplace_back(*s.points[uz(o.point)], V2{o.x, o.y});
        Pose P = *s.poses[fi];
        if (refine_pose(P, corr, k, 4)) s.poses[fi] = P;
      }
    }
  };

  std::optional<Pose> last = s.poses[0];
  int sinceRefine = 0;
  for (std::size_t fi = 1; fi < n; ++fi) {
    if (!s.poses[fi]) {
      const Pose guess = last ? *last : *s.poses[0];
      if (!resect(fi, guess)) continue;
    }
    last = s.poses[fi];
    for (const Obs& o : t.frames[fi]) try_triangulate(o.point);
    if (++sinceRefine >= 15) {
      refine_all(1);
      sinceRefine = 0;
    }
  }
  refine_all(opts.refineRounds);

  // Drop points that do not fit, report the rest.
  s.pointError.assign(uz(t.points), 0);
  s.pointViews.assign(uz(t.points), 0);
  double sum = 0;
  int count = 0;
  for (int p = 0; p < t.points; ++p) {
    if (!s.points[uz(p)]) continue;
    double e = 0;
    int m = 0;
    for (const auto& [pose, o] : views_of(p, true)) {
      const std::optional<V2> q = project_cam(*pose, *s.points[uz(p)], k);
      if (!q) continue;
      e += std::hypot(q->x - o.x, q->y - o.y);
      ++m;
    }
    if (m < 2 || e / m > opts.maxPointError) {
      s.points[uz(p)].reset();
      continue;
    }
    s.pointError[uz(p)] = e / m;
    s.pointViews[uz(p)] = m;
    sum += e;
    count += m;
  }
  refine_all(1);
  s.solvedFrames = static_cast<int>(std::count_if(s.poses.begin(), s.poses.end(), [](const auto& p) { return p.has_value(); }));
  s.rmsPx = count > 0 ? sum / count : 1e9;
  return s;
}

/// Every `step`-th frame (ids kept), for the focal search.
FeatureTracks subsample(const FeatureTracks& t, std::size_t step) {
  FeatureTracks o;
  o.width = t.width;
  o.height = t.height;
  o.points = t.points;
  for (std::size_t i = 0; i < t.frames.size(); i += step) o.frames.push_back(t.frames[i]);
  return o;
}

}  // namespace

std::optional<V2> project(const Pose& p, const V3& X, double f, double cx, double cy) { return project_cam(p, X, Cam{f, cx, cy}); }

std::optional<Plane> fit_plane(const std::vector<V3>& pts) {
  if (pts.size() < 3) return std::nullopt;
  V3 c{};
  for (const V3& p : pts) c = V3{c.x + p.x, c.y + p.y, c.z + p.z};
  c = scale(c, 1.0 / static_cast<double>(pts.size()));
  std::array<std::array<double, 3>, 3> cov{};
  for (const V3& p : pts) {
    const V3 d = sub(p, c);
    const std::array<double, 3> v{d.x, d.y, d.z};
    for (std::size_t r = 0; r < 3; ++r)
      for (std::size_t q = 0; q < 3; ++q) cov[r][q] += v[r] * v[q];
  }
  std::array<double, 3> vals{};
  std::array<std::array<double, 3>, 3> vecs{};
  jacobi_eigen<3>(cov, vals, vecs);
  std::size_t mn = 0;
  for (std::size_t i = 1; i < 3; ++i)
    if (vals[i] < vals[mn]) mn = i;
  // Two points or a line give no plane.
  std::array<double, 3> sorted = vals;
  std::sort(sorted.begin(), sorted.end());
  if (sorted[1] < 1e-12) return std::nullopt;
  V3 n{vecs[0][mn], vecs[1][mn], vecs[2][mn]};
  n = scale(n, 1 / std::max(1e-12, norm(n)));
  double spread = 0;
  for (const V3& p : pts) spread = std::max(spread, norm(sub(p, c)));
  return Plane{c, n, spread};
}

M3 rotation_between(const V3& from, const V3& to) {
  const V3 axis{from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x};
  const double s = norm(axis);
  const double c = std::clamp(dot(from, to), -1.0, 1.0);
  if (s < 1e-12) {
    if (c > 0) return kI;
    // Opposite: half a turn about any axis perpendicular to `from`.
    const V3 perp = std::abs(from.x) < 0.9 ? V3{0, -from.z, from.y} : V3{from.z, 0, -from.x};
    return rodrigues(scale(perp, kPi / std::max(1e-12, norm(perp))));
  }
  return rodrigues(scale(axis, std::atan2(s, c) / s));
}

Ypr r_to_ypr(const M3& R) {
  // R = Rz(−roll)·Rx(−pitch)·Ry(−yaw): R[2][1] = sin(−pitch), R[2][0] = −cos(−pitch)·sin(−yaw), …
  const double p = std::asin(std::clamp(R[2][1], -1.0, 1.0));
  const double y = std::atan2(-R[2][0], R[2][2]);
  const double r = std::atan2(-R[0][1], R[1][1]);
  return Ypr{-y * 180 / kPi, -p * 180 / kPi, -r * 180 / kPi};
}

std::optional<FeatureTracks> track_features(const tracking::FrameAt& frameAt, std::int64_t from, std::int64_t to,
                                            const FeatureOptions& opts, const tracking::OnProgress& onProgress) {
  FeatureTracks out;
  tracking::LumaPlane prev = frameAt(from);
  out.width = prev.width;
  out.height = prev.height;
  const int half = std::max(3, opts.featureHalf);
  const int tile = std::max(24, std::min(prev.width, prev.height) / 10);
  struct Live {
    int id;
    double x;
    double y;
    double vx = 0;
    double vy = 0;
  };
  std::vector<Live> live;
  auto replenish = [&](const tracking::LumaPlane& plane) {
    const int want = opts.maxFeatures - static_cast<int>(live.size());
    if (want <= opts.maxFeatures / 4) return;
    for (const feature::Candidate& c : feature::pick_features(plane, want * 2, half + 8, tile)) {
      const bool near = std::any_of(live.begin(), live.end(), [&](const Live& l) { return std::hypot(l.x - c.x, l.y - c.y) < tile / 2.0; });
      if (near) continue;
      live.push_back(Live{out.points++, c.x, c.y});
      if (static_cast<int>(live.size()) >= opts.maxFeatures) break;
    }
  };
  replenish(prev);
  out.frames.emplace_back();
  for (const Live& l : live) out.frames.back().push_back(Obs{l.id, l.x, l.y});
  const std::int64_t total = to - from;
  for (std::int64_t f = from + 1; f <= to; ++f) {
    if (onProgress && !onProgress(f - from - 1, total)) return std::nullopt;
    const tracking::LumaPlane& plane = frameAt(f);
    std::vector<Live> next;
    for (const Live& l : live) {
      const std::vector<float> patch = tracking::extract_patch(prev, l.x, l.y, half);
      if (patch.empty()) continue;
      const auto m = tracking::match_patch(patch, half, plane, l.x + l.vx, l.y + l.vy, opts.searchHalf);
      if (!m || m->confidence < opts.minConfidence) continue;
      // Forward-backward: the match must lead back to where it started.
      const std::vector<float> back = tracking::extract_patch(plane, m->x, m->y, half);
      if (back.empty()) continue;
      const auto b = tracking::match_patch(back, half, prev, l.x, l.y, 3);
      if (!b || std::hypot(b->x - l.x, b->y - l.y) > 1.0) continue;
      if (m->x < half || m->y < half || m->x > plane.width - 1 - half || m->y > plane.height - 1 - half) continue;
      next.push_back(Live{l.id, m->x, m->y, m->x - l.x, m->y - l.y});
    }
    live = std::move(next);
    replenish(plane);
    out.frames.emplace_back();
    for (const Live& l : live) out.frames.back().push_back(Obs{l.id, l.x, l.y});
    prev = plane;
  }
  return out;
}

std::optional<Solve> solve(const FeatureTracks& t, const SolveOptions& opts) {
  if (opts.focal) return solve_fixed(t, *opts.focal, opts);
  // The focal length: the one whose solve reprojects best over a sparse
  // set of frames — a sweep from wide to long, then a golden-section search.
  const double side = std::max(t.width, t.height);
  const std::size_t step = std::max<std::size_t>(1, t.frames.size() / 40);
  const FeatureTracks sparse = subsample(t, step);
  SolveOptions quick = opts;
  quick.refineRounds = 2;
  auto cost = [&](double f) {
    const std::optional<Solve> s = solve_fixed(sparse, f, quick);
    if (!s) return 1e9;
    const double covered = static_cast<double>(s->solvedFrames) / static_cast<double>(sparse.frames.size());
    return s->rmsPx + (covered < 0.8 ? 10 * (0.8 - covered) : 0);
  };
  const std::array<double, 7> sweep{0.45, 0.6, 0.8, 1.05, 1.4, 1.9, 2.6};
  std::array<double, 7> costs{};
  std::size_t best = 0;
  for (std::size_t i = 0; i < sweep.size(); ++i) {
    costs[i] = cost(sweep[i] * side);
    if (costs[i] < costs[best]) best = i;
  }
  if (costs[best] >= 1e9) return std::nullopt;
  double lo = std::log(sweep[best == 0 ? 0 : best - 1] * side);
  double hi = std::log(sweep[std::min(best + 1, sweep.size() - 1)] * side);
  const double g = (std::sqrt(5.0) - 1) / 2;
  double a = hi - g * (hi - lo);
  double b = lo + g * (hi - lo);
  double ca = cost(std::exp(a));
  double cb = cost(std::exp(b));
  for (int it = 0; it < 6; ++it) {
    if (ca < cb) {
      hi = b;
      b = a;
      cb = ca;
      a = hi - g * (hi - lo);
      ca = cost(std::exp(a));
    } else {
      lo = a;
      a = b;
      ca = cb;
      b = lo + g * (hi - lo);
      cb = cost(std::exp(b));
    }
  }
  double fBest = std::exp(ca < cb ? a : b);
  if (std::min(ca, cb) > costs[best]) fBest = sweep[best] * side;
  return solve_fixed(t, fBest, opts);
}

}  // namespace premation::jobs::camtrack
