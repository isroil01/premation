#include "content_aware_fill.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

#include "pixel_motion.hpp"
#include "stabilize.hpp"

namespace premation::jobs::caf {

namespace {

std::size_t at(int i) noexcept { return static_cast<std::size_t>(i); }

/// Deterministic 32-bit PRNG (mulberry32).
class Rng {
 public:
  explicit Rng(std::uint32_t seed) noexcept : state_(seed) {}
  std::uint32_t next() noexcept {
    state_ += 0x6d2b79f5u;
    std::uint32_t t = state_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return t ^ (t >> 14);
  }
  /// Uniform in [-r, r].
  int spread(int r) noexcept {
    if (r <= 0) return 0;
    const auto span = static_cast<std::uint32_t>(2 * r + 1);
    return static_cast<int>(next() % span) - r;
  }

 private:
  std::uint32_t state_;
};

std::uint8_t clamp8(float v) noexcept {
  const float r = std::round(v);
  return static_cast<std::uint8_t>(std::clamp(r, 0.0f, 255.0f));
}

bool any_set(std::span<const std::uint8_t> m) {
  return std::any_of(m.begin(), m.end(), [](std::uint8_t v) { return v != 0; });
}

int count_set(std::span<const std::uint8_t> m) {
  return static_cast<int>(std::count_if(m.begin(), m.end(), [](std::uint8_t v) { return v != 0; }));
}

// ── Membrane (harmonic) solver ────────────────────────────────────────────
//
// `state`: 0 = unknown (solve), 1 = known and used as a boundary value,
// 2 = known but ignored (no flux across it). Three float channels.

struct Plane3 {
  int w = 0;
  int h = 0;
  std::vector<float> v;  // w*h*3
  std::vector<std::uint8_t> state;
};

Plane3 downsample(const Plane3& in) {
  Plane3 out;
  out.w = std::max(1, (in.w + 1) / 2);
  out.h = std::max(1, (in.h + 1) / 2);
  out.v.assign(at(out.w * out.h * 3), 0.0f);
  out.state.assign(at(out.w * out.h), 2);
  for (int y = 0; y < out.h; ++y) {
    for (int x = 0; x < out.w; ++x) {
      float sum[3] = {0, 0, 0};
      int known = 0;
      bool unknown = false;
      for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
          const int fx = 2 * x + dx;
          const int fy = 2 * y + dy;
          if (fx >= in.w || fy >= in.h) continue;
          const int i = fy * in.w + fx;
          const std::uint8_t s = in.state[at(i)];
          if (s == 1) {
            for (int c = 0; c < 3; ++c) sum[c] += in.v[at(i * 3 + c)];
            ++known;
          } else if (s == 0) {
            unknown = true;
          }
        }
      }
      const int o = y * out.w + x;
      if (known > 0) {
        for (int c = 0; c < 3; ++c) out.v[at(o * 3 + c)] = sum[c] / static_cast<float>(known);
        out.state[at(o)] = 1;
      } else if (unknown) {
        out.state[at(o)] = 0;
      }
    }
  }
  return out;
}

/// Gauss–Seidel with over-relaxation on the unknown pixels, `iters` sweeps.
void relax(Plane3& p, int iters) {
  constexpr float kOmega = 1.85f;
  for (int it = 0; it < iters; ++it) {
    const bool reverse = (it % 2) == 1;
    for (int yy = 0; yy < p.h; ++yy) {
      const int y = reverse ? p.h - 1 - yy : yy;
      for (int xx = 0; xx < p.w; ++xx) {
        const int x = reverse ? p.w - 1 - xx : xx;
        const int i = y * p.w + x;
        if (p.state[at(i)] != 0) continue;
        float sum[3] = {0, 0, 0};
        int n = 0;
        const int nb[4][2] = {{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}};
        for (const auto& q : nb) {
          if (q[0] < 0 || q[1] < 0 || q[0] >= p.w || q[1] >= p.h) continue;
          const int j = q[1] * p.w + q[0];
          if (p.state[at(j)] == 2) continue;
          for (int c = 0; c < 3; ++c) sum[c] += p.v[at(j * 3 + c)];
          ++n;
        }
        if (n == 0) continue;
        for (int c = 0; c < 3; ++c) {
          float& v = p.v[at(i * 3 + c)];
          const float target = sum[c] / static_cast<float>(n);
          v += kOmega * (target - v);
        }
      }
    }
  }
}

/// Solve the membrane coarse-to-fine: the coarse solution seeds the finer
/// unknowns, then a few sweeps settle them.
void solve_membrane(Plane3& p) {
  std::vector<Plane3> levels;
  levels.push_back(std::move(p));
  while (levels.back().w > 8 && levels.back().h > 8 && levels.size() < 12) {
    const Plane3& last = levels.back();
    if (std::none_of(last.state.begin(), last.state.end(), [](std::uint8_t s) { return s == 0; })) break;
    levels.push_back(downsample(last));
  }
  // Coarsest: unknowns start at the mean of the known values.
  {
    Plane3& c = levels.back();
    double mean[3] = {0, 0, 0};
    int k = 0;
    for (int i = 0; i < c.w * c.h; ++i) {
      if (c.state[at(i)] != 1) continue;
      for (int ch = 0; ch < 3; ++ch) mean[ch] += c.v[at(i * 3 + ch)];
      ++k;
    }
    for (int i = 0; i < c.w * c.h; ++i) {
      if (c.state[at(i)] != 0) continue;
      for (int ch = 0; ch < 3; ++ch) c.v[at(i * 3 + ch)] = k > 0 ? static_cast<float>(mean[ch] / k) : 0.0f;
    }
    relax(c, 200);
  }
  for (std::size_t l = levels.size() - 1; l > 0; --l) {
    const Plane3& coarse = levels[l];
    Plane3& fine = levels[l - 1];
    for (int y = 0; y < fine.h; ++y) {
      for (int x = 0; x < fine.w; ++x) {
        const int i = y * fine.w + x;
        if (fine.state[at(i)] != 0) continue;
        const int cx = std::min(coarse.w - 1, x / 2);
        const int cy = std::min(coarse.h - 1, y / 2);
        const int j = cy * coarse.w + cx;
        for (int c = 0; c < 3; ++c) fine.v[at(i * 3 + c)] = coarse.v[at(j * 3 + c)];
      }
    }
    relax(fine, l == 1 ? 60 : 30);
  }
  p = std::move(levels.front());
}

// ── Pictures as float planes for PatchMatch ──────────────────────────────

struct Level {
  int w = 0;
  int h = 0;
  std::vector<float> rgb;          // w*h*3, current estimate in the hole
  std::vector<std::uint8_t> hole;  // 1 = hole
};

Level level_down(const Level& in) {
  Level out;
  out.w = std::max(1, (in.w + 1) / 2);
  out.h = std::max(1, (in.h + 1) / 2);
  out.rgb.assign(at(out.w * out.h * 3), 0.0f);
  out.hole.assign(at(out.w * out.h), 0);
  for (int y = 0; y < out.h; ++y) {
    for (int x = 0; x < out.w; ++x) {
      float sum[3] = {0, 0, 0};
      int k = 0;
      bool anyHole = false;
      for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
          const int fx = 2 * x + dx;
          const int fy = 2 * y + dy;
          if (fx >= in.w || fy >= in.h) continue;
          const int i = fy * in.w + fx;
          if (in.hole[at(i)] != 0) {
            anyHole = true;
            continue;
          }
          for (int c = 0; c < 3; ++c) sum[c] += in.rgb[at(i * 3 + c)];
          ++k;
        }
      }
      const int o = y * out.w + x;
      // Conservative: a coarse pixel touching the hole is hole, so coarse
      // sources are entirely known.
      out.hole[at(o)] = anyHole ? 1 : 0;
      if (k > 0) {
        for (int c = 0; c < 3; ++c) out.rgb[at(o * 3 + c)] = sum[c] / static_cast<float>(k);
      }
    }
  }
  return out;
}

/// Fill a level's hole with the membrane of its edge (the coarsest level's first guess).
void membrane_guess(Level& lv) {
  Plane3 p;
  p.w = lv.w;
  p.h = lv.h;
  p.v = lv.rgb;
  p.state.resize(lv.hole.size());
  for (std::size_t i = 0; i < lv.hole.size(); ++i) p.state[i] = lv.hole[i] != 0 ? 0 : 1;
  solve_membrane(p);
  lv.rgb = std::move(p.v);
}

class PatchMatch {
 public:
  PatchMatch(Level& lv, int half, Rng& rng) : lv_(lv), half_(half), rng_(rng) { build_masks(); }

  [[nodiscard]] bool usable() const { return !sources_.empty() && !targets_.empty(); }

  /// Random field (coarsest level).
  void init_random() {
    nnx_.assign(at(lv_.w * lv_.h), -1);
    nny_.assign(at(lv_.w * lv_.h), -1);
    for (const int t : targets_) {
      const int s = sources_[at(static_cast<int>(rng_.next() % static_cast<std::uint32_t>(sources_.size())))];
      nnx_[at(t)] = s % lv_.w;
      nny_[at(t)] = s / lv_.w;
    }
    score_all();
  }

  /// Seed from the coarser level's field (coordinates doubled).
  void init_from(const std::vector<int>& cx, const std::vector<int>& cy, int cw, int ch) {
    nnx_.assign(at(lv_.w * lv_.h), -1);
    nny_.assign(at(lv_.w * lv_.h), -1);
    for (const int t : targets_) {
      const int x = t % lv_.w;
      const int y = t / lv_.w;
      const int ix = std::min(cw - 1, x / 2);
      const int iy = std::min(ch - 1, y / 2);
      const int ci = iy * cw + ix;
      int sx = -1;
      int sy = -1;
      if (cx[at(ci)] >= 0) {
        sx = cx[at(ci)] * 2 + (x % 2);
        sy = cy[at(ci)] * 2 + (y % 2);
      }
      if (sx < 0 || !valid_source(sx, sy)) {
        const int s = sources_[at(static_cast<int>(rng_.next() % static_cast<std::uint32_t>(sources_.size())))];
        sx = s % lv_.w;
        sy = s / lv_.w;
      }
      nnx_[at(t)] = sx;
      nny_[at(t)] = sy;
    }
    score_all();
  }

  void iterate(int iterations) {
    for (int it = 0; it < iterations; ++it) {
      const bool forward = (it % 2) == 0;
      const int n = static_cast<int>(targets_.size());
      for (int k = 0; k < n; ++k) {
        const int t = targets_[at(forward ? k : n - 1 - k)];
        const int x = t % lv_.w;
        const int y = t / lv_.w;
        const int step = forward ? -1 : 1;
        // Propagation from the already-visited neighbours.
        try_neighbour(t, x, y, x + step, y);
        try_neighbour(t, x, y, x, y + step);
        // Random search, halving radius.
        int r = std::max(lv_.w, lv_.h);
        while (r >= 1) {
          const int sx = nnx_[at(t)] + rng_.spread(r);
          const int sy = nny_[at(t)] + rng_.spread(r);
          try_candidate(t, x, y, sx, sy);
          r /= 2;
        }
      }
    }
  }

  /// Every hole pixel becomes the weighted mean of the source pixels the
  /// overlapping patches map it to (Wexler et al. voting).
  void vote() {
    // A robust scale: the median patch distance.
    std::vector<float> ds;
    ds.reserve(targets_.size());
    for (const int t : targets_) ds.push_back(dist_[at(t)]);
    float sigma2 = 1.0f;
    if (!ds.empty()) {
      auto mid = ds.begin() + static_cast<std::ptrdiff_t>(ds.size() / 2);
      std::nth_element(ds.begin(), mid, ds.end());
      sigma2 = std::max(1.0f, *mid);
    }
    std::vector<float> acc(at(lv_.w * lv_.h * 3), 0.0f);
    std::vector<float> wsum(at(lv_.w * lv_.h), 0.0f);
    for (const int t : targets_) {
      const int tx = t % lv_.w;
      const int ty = t / lv_.w;
      const int sx = nnx_[at(t)];
      const int sy = nny_[at(t)];
      if (sx < 0) continue;
      const float wgt = std::exp(-dist_[at(t)] / (2.0f * sigma2));
      for (int dy = -half_; dy <= half_; ++dy) {
        for (int dx = -half_; dx <= half_; ++dx) {
          const int px = tx + dx;
          const int py = ty + dy;
          const int qx = sx + dx;
          const int qy = sy + dy;
          if (px < 0 || py < 0 || px >= lv_.w || py >= lv_.h) continue;
          if (qx < 0 || qy < 0 || qx >= lv_.w || qy >= lv_.h) continue;
          const int p = py * lv_.w + px;
          if (lv_.hole[at(p)] == 0) continue;
          const int q = qy * lv_.w + qx;
          for (int c = 0; c < 3; ++c) acc[at(p * 3 + c)] += wgt * lv_.rgb[at(q * 3 + c)];
          wsum[at(p)] += wgt;
        }
      }
    }
    for (int p = 0; p < lv_.w * lv_.h; ++p) {
      if (lv_.hole[at(p)] == 0 || wsum[at(p)] <= 0) continue;
      for (int c = 0; c < 3; ++c) lv_.rgb[at(p * 3 + c)] = acc[at(p * 3 + c)] / wsum[at(p)];
    }
    score_all();
  }

  [[nodiscard]] const std::vector<int>& nnx() const { return nnx_; }
  [[nodiscard]] const std::vector<int>& nny() const { return nny_; }

 private:
  void build_masks() {
    const int w = lv_.w;
    const int h = lv_.h;
    // Integral image of the hole, to test "patch free of hole" in O(1).
    std::vector<int> integ(at((w + 1) * (h + 1)), 0);
    for (int y = 0; y < h; ++y) {
      int row = 0;
      for (int x = 0; x < w; ++x) {
        row += lv_.hole[at(y * w + x)] != 0 ? 1 : 0;
        integ[at((y + 1) * (w + 1) + x + 1)] = integ[at(y * (w + 1) + x + 1)] + row;
      }
    }
    auto holes_in = [&](int x0, int y0, int x1, int y1) {
      x0 = std::max(0, x0);
      y0 = std::max(0, y0);
      x1 = std::min(w - 1, x1);
      y1 = std::min(h - 1, y1);
      if (x1 < x0 || y1 < y0) return 0;
      return integ[at((y1 + 1) * (w + 1) + x1 + 1)] - integ[at(y0 * (w + 1) + x1 + 1)] - integ[at((y1 + 1) * (w + 1) + x0)] +
             integ[at(y0 * (w + 1) + x0)];
    };
    sourceOk_.assign(at(w * h), 0);
    for (int y = half_; y < h - half_; ++y) {
      for (int x = half_; x < w - half_; ++x) {
        if (holes_in(x - half_, y - half_, x + half_, y + half_) == 0) {
          sourceOk_[at(y * w + x)] = 1;
          sources_.push_back(y * w + x);
        }
      }
    }
    if (sources_.empty()) {
      // A hole too big for whole clean patches: any known centre will do.
      for (int i = 0; i < w * h; ++i) {
        if (lv_.hole[at(i)] == 0) {
          sourceOk_[at(i)] = 1;
          sources_.push_back(i);
        }
      }
    }
    // Targets: every patch centre whose patch touches the hole.
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < w; ++x) {
        if (holes_in(x - half_, y - half_, x + half_, y + half_) > 0) targets_.push_back(y * w + x);
      }
    }
    dist_.assign(at(w * h), std::numeric_limits<float>::max());
  }

  [[nodiscard]] bool valid_source(int x, int y) const {
    return x >= 0 && y >= 0 && x < lv_.w && y < lv_.h && sourceOk_[at(y * lv_.w + x)] != 0;
  }

  [[nodiscard]] float distance(int tx, int ty, int sx, int sy, float cap) const {
    float sum = 0;
    int n = 0;
    for (int dy = -half_; dy <= half_; ++dy) {
      const int py = ty + dy;
      const int qy = sy + dy;
      if (py < 0 || py >= lv_.h || qy < 0 || qy >= lv_.h) continue;
      for (int dx = -half_; dx <= half_; ++dx) {
        const int px = tx + dx;
        const int qx = sx + dx;
        if (px < 0 || px >= lv_.w || qx < 0 || qx >= lv_.w) continue;
        const std::size_t p = at((py * lv_.w + px) * 3);
        const std::size_t q = at((qy * lv_.w + qx) * 3);
        const float dr = lv_.rgb[p] - lv_.rgb[q];
        const float dg = lv_.rgb[p + 1] - lv_.rgb[q + 1];
        const float db = lv_.rgb[p + 2] - lv_.rgb[q + 2];
        sum += dr * dr + dg * dg + db * db;
        ++n;
      }
      // Early out once the running mean (over a full patch) cannot win.
      const int full = (2 * half_ + 1) * (2 * half_ + 1);
      if (n > 0 && sum / static_cast<float>(full) > cap) return std::numeric_limits<float>::max();
    }
    return n > 0 ? sum / static_cast<float>(n) : std::numeric_limits<float>::max();
  }

  void score_all() {
    for (const int t : targets_) {
      const int sx = nnx_[at(t)];
      if (sx < 0) continue;
      dist_[at(t)] = distance(t % lv_.w, t / lv_.w, sx, nny_[at(t)], std::numeric_limits<float>::max());
    }
  }

  void try_candidate(int t, int x, int y, int sx, int sy) {
    if (!valid_source(sx, sy)) return;
    // A patch matching itself teaches nothing.
    if (sx == x && sy == y) return;
    const float d = distance(x, y, sx, sy, dist_[at(t)]);
    if (d < dist_[at(t)]) {
      dist_[at(t)] = d;
      nnx_[at(t)] = sx;
      nny_[at(t)] = sy;
    }
  }

  void try_neighbour(int t, int x, int y, int nx, int ny) {
    if (nx < 0 || ny < 0 || nx >= lv_.w || ny >= lv_.h) return;
    const int n = ny * lv_.w + nx;
    if (nnx_[at(n)] < 0) return;
    try_candidate(t, x, y, nnx_[at(n)] + (x - nx), nny_[at(n)] + (y - ny));
  }

  Level& lv_;
  int half_;
  Rng& rng_;
  std::vector<int> sources_;
  std::vector<int> targets_;
  std::vector<std::uint8_t> sourceOk_;
  std::vector<int> nnx_;
  std::vector<int> nny_;
  std::vector<float> dist_;
};

}  // namespace

double lighting_strength(Lighting l) noexcept {
  switch (l) {
    case Lighting::off: return 0;
    case Lighting::subtle: return 0.35;
    case Lighting::moderate: return 0.7;
    case Lighting::strong: return 1.0;
  }
  return 0;
}

std::vector<std::pair<double, double>> flatten_path(const HolePath& path, int samplesPerSegment) {
  std::vector<std::pair<double, double>> out;
  const std::size_t n = path.points.size();
  if (n < 2) return out;
  // mask.ts expandMaskPoints: anchors and handles move along the averaged normal.
  std::vector<BezierPt> pts = path.points;
  if (path.expansion != 0 && n >= 3) {
    auto len_or_1 = [](double v) { return v > 1e-9 ? v : 1.0; };
    for (std::size_t i = 0; i < n; ++i) {
      const BezierPt& prev = path.points[(i + n - 1) % n];
      const BezierPt& curr = path.points[i];
      const BezierPt& next = path.points[(i + 1) % n];
      const double vx1 = curr.x - prev.x;
      const double vy1 = curr.y - prev.y;
      const double l1 = len_or_1(std::hypot(vx1, vy1));
      const double vx2 = next.x - curr.x;
      const double vy2 = next.y - curr.y;
      const double l2 = len_or_1(std::hypot(vx2, vy2));
      const double nx = (vy1 / l1 + vy2 / l2) / 2;
      const double ny = (-vx1 / l1 - vx2 / l2) / 2;
      const double nl = len_or_1(std::hypot(nx, ny));
      const double f = path.expansion / std::max(0.2, nl);
      pts[i] = {curr.x + nx * f, curr.y + ny * f, curr.inX + nx * f, curr.inY + ny * f, curr.outX + nx * f, curr.outY + ny * f};
    }
    // Clockwise vs counter-clockwise: the normal above points outward for a
    // clockwise (screen, y down) loop; flip it for the other winding.
    double area = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const BezierPt& a = path.points[i];
      const BezierPt& b = path.points[(i + 1) % n];
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) {
      for (std::size_t i = 0; i < n; ++i) {
        const BezierPt& c = path.points[i];
        const double dx = pts[i].x - c.x;
        const double dy = pts[i].y - c.y;
        pts[i] = {c.x - dx, c.y - dy, c.inX - dx, c.inY - dy, c.outX - dx, c.outY - dy};
      }
    }
  }
  const int samples = std::max(1, samplesPerSegment);
  const std::size_t last = path.closed ? n : n - 1;
  out.reserve(1 + last * static_cast<std::size_t>(samples));
  out.emplace_back(pts[0].x, pts[0].y);
  for (std::size_t i = 0; i < last; ++i) {
    const BezierPt& a = pts[i];
    const BezierPt& b = pts[(i + 1) % n];
    for (int s = 1; s <= samples; ++s) {
      const double t = static_cast<double>(s) / samples;
      const double u = 1 - t;
      out.emplace_back(u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
                       u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y);
    }
  }
  return out;
}

namespace {

/// Even-odd scanline fill of a polyline into `m` (1 = inside).
void scan_fill(std::vector<std::uint8_t>& m, int width, int height, const std::vector<std::pair<double, double>>& poly) {
  const std::size_t n = poly.size();
  if (n < 3) return;
  std::vector<double> xs;
  for (int y = 0; y < height; ++y) {
    const double sy = static_cast<double>(y) + 0.5;
    xs.clear();
    for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
      const double yi = poly[i].second;
      const double yj = poly[j].second;
      if ((yi > sy) != (yj > sy)) {
        xs.push_back(poly[i].first + (sy - yi) * (poly[j].first - poly[i].first) / (yj - yi));
      }
    }
    std::sort(xs.begin(), xs.end());
    for (std::size_t k = 0; k + 1 < xs.size(); k += 2) {
      // Pixel centres x + 0.5 in [xs[k], xs[k+1]).
      const int x0 = std::max(0, static_cast<int>(std::ceil(xs[k] - 0.5)));
      const int x1 = std::min(width - 1, static_cast<int>(std::ceil(xs[k + 1] - 0.5)) - 1);
      for (int x = x0; x <= x1; ++x) m[at(y * width + x)] = 1;
    }
  }
}

}  // namespace

int raster_hole_paths(std::span<std::uint8_t> hole, int width, int height, std::span<const HolePath> paths) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(hole.size()) < n) return 0;
  std::fill(hole.begin(), hole.begin() + n, static_cast<std::uint8_t>(0));
  std::vector<std::uint8_t> m(at(n));
  // Added paths first, then subtracted ones (AE's mask modes, in the order
  // that matters for a hole: union of adds, minus subtracts).
  for (const int pass : {0, 1}) {
    for (const HolePath& p : paths) {
      if (p.subtract != (pass == 1)) continue;
      if (p.points.size() < 3 && !p.inverted) continue;
      std::fill(m.begin(), m.end(), static_cast<std::uint8_t>(0));
      scan_fill(m, width, height, flatten_path(p));
      for (int i = 0; i < n; ++i) {
        const bool inside = (m[at(i)] != 0) != p.inverted;
        if (!inside) continue;
        hole[at(i)] = pass == 0 ? 255 : 0;
      }
    }
  }
  return count_set(hole.first(at(n)));
}

void dilate_hole(std::span<std::uint8_t> hole, int width, int height, int radius) {
  if (radius <= 0 || width <= 0 || height <= 0) return;
  const int n = width * height;
  std::vector<std::uint8_t> tmp(at(n), 0);
  // Separable max: rows then columns.
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      std::uint8_t v = 0;
      for (int d = -radius; d <= radius && v == 0; ++d) {
        const int xx = x + d;
        if (xx >= 0 && xx < width && hole[at(y * width + xx)] != 0) v = 255;
      }
      tmp[at(y * width + x)] = v;
    }
  }
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      std::uint8_t v = 0;
      for (int d = -radius; d <= radius && v == 0; ++d) {
        const int yy = y + d;
        if (yy >= 0 && yy < height && tmp[at(yy * width + x)] != 0) v = 255;
      }
      hole[at(y * width + x)] = v;
    }
  }
}

int inpaint_multiscale(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole,
                       const MultiscaleOptions& opts) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(rgba.size()) < n * 4 || static_cast<int>(hole.size()) < n) return 0;
  const int holes = count_set(hole.first(at(n)));
  if (holes == 0 || holes == n) return 0;

  std::vector<Level> pyr(1);
  pyr[0].w = width;
  pyr[0].h = height;
  pyr[0].rgb.resize(at(n * 3));
  pyr[0].hole.resize(at(n));
  for (int i = 0; i < n; ++i) {
    for (int c = 0; c < 3; ++c) pyr[0].rgb[at(i * 3 + c)] = rgba[at(i * 4 + c)];
    pyr[0].hole[at(i)] = hole[at(i)] != 0 ? 1 : 0;
  }
  const int half = std::max(1, opts.patchHalf);
  while (std::min(pyr.back().w, pyr.back().h) / 2 >= std::max(opts.minSide, 4 * half + 2) && pyr.size() < 10) {
    Level next = level_down(pyr.back());
    // Keep a level only while it still has something to copy from.
    if (std::all_of(next.hole.begin(), next.hole.end(), [](std::uint8_t v) { return v != 0; })) break;
    pyr.push_back(std::move(next));
  }

  Rng rng(opts.seed ^ static_cast<std::uint32_t>(holes));
  std::vector<int> prevX;
  std::vector<int> prevY;
  int prevW = 0;
  int prevH = 0;
  for (std::size_t li = pyr.size(); li-- > 0;) {
    Level& lv = pyr[li];
    if (li == pyr.size() - 1) {
      membrane_guess(lv);
    } else {
      // The coarser level's result is the first estimate here.
      const Level& coarse = pyr[li + 1];
      for (int y = 0; y < lv.h; ++y) {
        for (int x = 0; x < lv.w; ++x) {
          const int i = y * lv.w + x;
          if (lv.hole[at(i)] == 0) continue;
          const int j = std::min(coarse.h - 1, y / 2) * coarse.w + std::min(coarse.w - 1, x / 2);
          for (int c = 0; c < 3; ++c) lv.rgb[at(i * 3 + c)] = coarse.rgb[at(j * 3 + c)];
        }
      }
    }
    PatchMatch pm(lv, half, rng);
    if (!pm.usable()) {
      membrane_guess(lv);
      prevX.clear();
      continue;
    }
    if (prevX.empty()) pm.init_random();
    else pm.init_from(prevX, prevY, prevW, prevH);
    const int em = li == pyr.size() - 1 ? 3 : 2;
    for (int e = 0; e < em; ++e) {
      pm.iterate(li == pyr.size() - 1 ? opts.coarseIterations : opts.fineIterations);
      pm.vote();
    }
    prevX = pm.nnx();
    prevY = pm.nny();
    prevW = lv.w;
    prevH = lv.h;
  }

  const Level& fine = pyr[0];
  for (int i = 0; i < n; ++i) {
    if (hole[at(i)] == 0) continue;
    for (int c = 0; c < 3; ++c) rgba[at(i * 4 + c)] = clamp8(fine.rgb[at(i * 3 + c)]);
    rgba[at(i * 4 + 3)] = 255;
  }
  return holes;
}

int edge_blend_fill(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(rgba.size()) < n * 4 || static_cast<int>(hole.size()) < n) return 0;
  const int holes = count_set(hole.first(at(n)));
  if (holes == 0 || holes == n) return 0;
  Plane3 p;
  p.w = width;
  p.h = height;
  p.v.resize(at(n * 3));
  p.state.resize(at(n));
  for (int i = 0; i < n; ++i) {
    for (int c = 0; c < 3; ++c) p.v[at(i * 3 + c)] = rgba[at(i * 4 + c)];
    p.state[at(i)] = hole[at(i)] != 0 ? 0 : 1;
  }
  solve_membrane(p);
  for (int i = 0; i < n; ++i) {
    if (hole[at(i)] == 0) continue;
    for (int c = 0; c < 3; ++c) rgba[at(i * 4 + c)] = clamp8(p.v[at(i * 3 + c)]);
    rgba[at(i * 4 + 3)] = 255;
  }
  return holes;
}

void correct_lighting(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole, double strength) {
  if (!(strength > 0) || width <= 0 || height <= 0) return;
  const int n = width * height;
  if (static_cast<int>(rgba.size()) < n * 4 || static_cast<int>(hole.size()) < n) return;
  if (!any_set(hole.first(at(n)))) return;
  Plane3 p;
  p.w = width;
  p.h = height;
  p.v.assign(at(n * 3), 0.0f);
  p.state.assign(at(n), 2);
  int ring = 0;
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int i = y * width + x;
      if (hole[at(i)] != 0) {
        p.state[at(i)] = 0;
        continue;
      }
      // A known pixel on the edge: frame minus the mean of its filled neighbours.
      float sum[3] = {0, 0, 0};
      int k = 0;
      const int nb[4][2] = {{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}};
      for (const auto& q : nb) {
        if (q[0] < 0 || q[1] < 0 || q[0] >= width || q[1] >= height) continue;
        const int j = q[1] * width + q[0];
        if (hole[at(j)] == 0) continue;
        for (int c = 0; c < 3; ++c) sum[c] += rgba[at(j * 4 + c)];
        ++k;
      }
      if (k == 0) continue;
      for (int c = 0; c < 3; ++c) {
        p.v[at(i * 3 + c)] = static_cast<float>(rgba[at(i * 4 + c)]) - sum[c] / static_cast<float>(k);
      }
      p.state[at(i)] = 1;
      ++ring;
    }
  }
  if (ring == 0) return;
  solve_membrane(p);
  const auto s = static_cast<float>(std::min(1.0, strength));
  for (int i = 0; i < n; ++i) {
    if (hole[at(i)] == 0) continue;
    for (int c = 0; c < 3; ++c) {
      rgba[at(i * 4 + c)] = clamp8(static_cast<float>(rgba[at(i * 4 + c)]) + s * p.v[at(i * 3 + c)]);
    }
  }
}

int warp_into_hole(std::span<const std::uint8_t> from, std::span<std::uint8_t> to, int width, int height,
                   std::span<std::uint8_t> hole) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(from.size()) < n * 4 || static_cast<int>(to.size()) < n * 4 || static_cast<int>(hole.size()) < n) return 0;
  if (!any_set(hole.first(at(n)))) return 0;
  const stabilize::FloatLuma a = stabilize::luma_255_of(from, width, height);
  const stabilize::FloatLuma b = stabilize::luma_255_of(to, width, height);
  scene::pixmo::FlowOptions flowOpts;
  flowOpts.step = 4;
  const scene::pixmo::FlowField flow = stabilize::compute_flow_f32(a, b, flowOpts);

  // The flow inside the hole follows whatever is being removed, not the
  // background behind it. Use the flow measured on a ring around the hole
  // (outside the hole grown by a margin, inside it grown by more) and carry
  // it smoothly across the hole.
  std::vector<std::uint8_t> inner(hole.begin(), hole.begin() + n);
  // Blocks of the flow search (step 4, radius 3) that overlap the hole see
  // the object: keep the ring clear of them.
  dilate_hole(inner, width, height, 8);
  std::vector<std::uint8_t> outer = inner;
  dilate_hole(outer, width, height, 12);
  Plane3 f;
  f.w = width;
  f.h = height;
  f.v.assign(at(n * 3), 0.0f);
  f.state.assign(at(n), 2);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int i = y * width + x;
      if (inner[at(i)] != 0) {
        f.state[at(i)] = 0;
      } else if (outer[at(i)] != 0) {
        const stabilize::XY d = stabilize::sample_flow(flow, x, y);
        f.v[at(i * 3)] = static_cast<float>(d.x);
        f.v[at(i * 3 + 1)] = static_cast<float>(d.y);
        f.state[at(i)] = 1;
      }
    }
  }
  solve_membrane(f);

  int wrote = 0;
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int i = y * width + x;
      if (hole[at(i)] == 0) continue;
      const double sx = static_cast<double>(x) - static_cast<double>(f.v[at(i * 3)]);
      const double sy = static_cast<double>(y) - static_cast<double>(f.v[at(i * 3 + 1)]);
      if (!(sx >= 0) || !(sy >= 0) || sx >= static_cast<double>(width - 1) || sy >= static_cast<double>(height - 1)) continue;
      const int x0 = static_cast<int>(sx);
      const int y0 = static_cast<int>(sy);
      const double fx = sx - x0;
      const double fy = sy - y0;
      for (int c = 0; c < 3; ++c) {
        auto s = [&](int xx, int yy) { return static_cast<double>(from[at((yy * width + xx) * 4 + c)]); };
        const double v = s(x0, y0) * (1 - fx) * (1 - fy) + s(x0 + 1, y0) * fx * (1 - fy) + s(x0, y0 + 1) * (1 - fx) * fy +
                         s(x0 + 1, y0 + 1) * fx * fy;
        to[at(i * 4 + c)] = scene::pixmo::to_uint8_clamp(v);
      }
      to[at(i * 4 + 3)] = 255;
      hole[at(i)] = 0;
      ++wrote;
    }
  }
  return wrote;
}

SequenceStats fill_sequence(std::vector<SequenceFrame>& frames, int width, int height, const SequenceOptions& opts) {
  SequenceStats st;
  if (width <= 0 || height <= 0 || frames.empty()) return st;
  const auto n = frames.size();
  const auto px = at(width * height);
  std::vector<std::vector<std::uint8_t>> original(n);
  for (std::size_t i = 0; i < n; ++i) {
    SequenceFrame& f = frames[i];
    if (f.rgba.size() < px * 4 || f.hole.size() < px) {
      f.hole.assign(px, 0);
      continue;
    }
    if (f.anchor) std::fill(f.hole.begin(), f.hole.end(), static_cast<std::uint8_t>(0));
    original[i] = f.hole;
    if (!f.anchor && f.reference.size() >= px * 4) {
      for (std::size_t p = 0; p < px; ++p) {
        if (f.hole[p] == 0) continue;
        for (std::size_t c = 0; c < 4; ++c) f.rgba[p * 4 + c] = f.reference[p * 4 + c];
        f.rgba[p * 4 + 3] = 255;
        f.hole[p] = 0;
        ++st.fromReference;
      }
      original[i].assign(px, 0);  // a painted plate is taken as it is
    }
  }
  auto has_hole = [&](std::size_t i) { return any_set(frames[i].hole); };
  auto residual = [&](std::size_t i) {
    SequenceFrame& f = frames[i];
    if (!has_hole(i)) return;
    if (opts.mode == FillMode::object) {
      const int k = inpaint_multiscale(f.rgba, width, height, f.hole, opts.synthesis);
      st.synthesized += k;
      if (k == 0) st.blended += edge_blend_fill(f.rgba, width, height, f.hole);
    } else {
      st.blended += edge_blend_fill(f.rgba, width, height, f.hole);
    }
    std::fill(f.hole.begin(), f.hole.end(), static_cast<std::uint8_t>(0));
  };

  if (opts.mode == FillMode::edgeBlend) {
    for (std::size_t i = 0; i < n; ++i) residual(i);
  } else {
    bool anyComplete = false;
    for (std::size_t i = 0; i < n; ++i) anyComplete = anyComplete || !has_hole(i);
    if (!anyComplete) residual(0);
    // Forward, then backward: a complete frame carries its fill to the next.
    for (std::size_t i = 1; i < n; ++i) {
      if (has_hole(i) && !has_hole(i - 1)) {
        st.propagated += warp_into_hole(frames[i - 1].rgba, frames[i].rgba, width, height, frames[i].hole);
      }
    }
    for (std::size_t i = n - 1; i-- > 0;) {
      if (has_hole(i) && !has_hole(i + 1)) {
        st.propagated += warp_into_hole(frames[i + 1].rgba, frames[i].rgba, width, height, frames[i].hole);
      }
    }
    // What flow could not reach (the picture's edge, new areas): fill it and
    // let the next frame inherit it.
    for (std::size_t i = 0; i < n; ++i) {
      if (!has_hole(i)) continue;
      if (i > 0 && !has_hole(i - 1)) {
        st.propagated += warp_into_hole(frames[i - 1].rgba, frames[i].rgba, width, height, frames[i].hole);
      }
      residual(i);
    }
  }

  const double strength = lighting_strength(opts.lighting);
  if (strength > 0 && opts.mode != FillMode::edgeBlend) {
    for (std::size_t i = 0; i < n; ++i) {
      if (frames[i].anchor || original[i].empty() || !any_set(original[i])) continue;
      correct_lighting(frames[i].rgba, width, height, original[i], strength);
    }
  }
  return st;
}

}  // namespace premation::jobs::caf
