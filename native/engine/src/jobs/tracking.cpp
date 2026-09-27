#include "tracking.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <set>
#include <utility>

#include "jsmath.hpp"

namespace premation::jobs::tracking {
namespace {

using std::size_t;

double hypot2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

float at(const LumaPlane& p, int x, int y) noexcept {
  return p.data[static_cast<size_t>(y) * static_cast<size_t>(p.width) + static_cast<size_t>(x)];
}

/// patchMatch.ts `normalized`: zero-mean, unit-variance copy; empty for a flat patch.
std::vector<float> normalized(std::span<const float> p) {
  const size_t n = p.size();
  double mean = 0;
  for (size_t i = 0; i < n; ++i) mean += static_cast<double>(p[i]);
  mean /= static_cast<double>(n);
  double variance = 0;
  for (size_t i = 0; i < n; ++i) {
    const double d = static_cast<double>(p[i]) - mean;
    variance += d * d;
  }
  if (variance <= 1e-12) return {};
  const double inv = 1 / std::sqrt(variance / static_cast<double>(n));
  std::vector<float> out(n);
  for (size_t i = 0; i < n; ++i) out[i] = static_cast<float>((static_cast<double>(p[i]) - mean) * inv);
  return out;
}

/// patchMatch.ts `lkRefine`.
std::optional<Pt> lk_refine(std::span<const float> refPatch, int featureHalf, const LumaPlane& target, double startX,
                            double startY) {
  const int size = 2 * featureHalf + 1;
  const std::vector<float> ref = normalized(refPatch);
  if (ref.empty()) return std::nullopt;
  const size_t cells = static_cast<size_t>(size) * static_cast<size_t>(size);
  std::vector<float> gx(cells, 0.0F);
  std::vector<float> gy(cells, 0.0F);
  double hxx = 0;
  double hxy = 0;
  double hyy = 0;
  const size_t row = static_cast<size_t>(size);
  for (int r = 1; r < size - 1; ++r) {
    for (int c = 1; c < size - 1; ++c) {
      const size_t i = static_cast<size_t>(r) * row + static_cast<size_t>(c);
      const double dx = (static_cast<double>(ref[i + 1]) - static_cast<double>(ref[i - 1])) * 0.5;
      const double dy = (static_cast<double>(ref[i + row]) - static_cast<double>(ref[i - row])) * 0.5;
      gx[i] = static_cast<float>(dx);
      gy[i] = static_cast<float>(dy);
      hxx += dx * dx;
      hxy += dx * dy;
      hyy += dy * dy;
    }
  }
  const double det = hxx * hyy - hxy * hxy;
  if (det <= 1e-9) return std::nullopt;

  double x = startX;
  double y = startY;
  for (int iter = 0; iter < 12; ++iter) {
    const std::vector<float> candRaw = extract_patch(target, x, y, featureHalf);
    if (candRaw.empty()) return std::nullopt;
    const std::vector<float> cand = normalized(candRaw);
    if (cand.empty()) return std::nullopt;
    double bx = 0;
    double by = 0;
    for (int r = 1; r < size - 1; ++r) {
      for (int c = 1; c < size - 1; ++c) {
        const size_t i = static_cast<size_t>(r) * row + static_cast<size_t>(c);
        const double e = static_cast<double>(cand[i]) - static_cast<double>(ref[i]);
        bx += static_cast<double>(gx[i]) * e;
        by += static_cast<double>(gy[i]) * e;
      }
    }
    const double stepX = (hyy * bx - hxy * by) / det;
    const double stepY = (hxx * by - hxy * bx) / det;
    x -= stepX;
    y -= stepY;
    if (std::abs(x - startX) > 1 || std::abs(y - startY) > 1) return std::nullopt;
    if (std::abs(stepX) < 1e-3 && std::abs(stepY) < 1e-3) break;
  }
  return Pt{x, y};
}

/// patchMatch.ts `parabolicOffset`.
double parabolic_offset(double left, double centre, double right) noexcept {
  const double denom = left - 2 * centre + right;
  if (denom >= -1e-12) return 0;
  const double off = (0.5 * (left - right)) / denom;
  return std::max(-0.5, std::min(0.5, off));
}

/// tracker.ts PointTrack: one feature's whole life across the walk.
class PointTrack {
 public:
  PointTrack(const LumaPlane& first, std::int64_t startFrame, const PointSeed& seed, const TrackOptions& opts)
      : featureHalf_(seed.featureHalf),
        searchHalf_(seed.searchHalf),
        minConfidence_(opts.minConfidence),
        maxCoast_(opts.maxCoastFrames),
        x_(seed.x),
        y_(seed.y) {
    std::vector<float> ref = extract_patch(first, seed.x, seed.y, featureHalf_);
    if (ref.empty()) {
      // Off the frame — nothing to track. One honest sample, born dead.
      samples.push_back(TrackSample{startFrame, seed.x, seed.y, 0, true});
      dead = true;
      return;
    }
    anchorPatch_ = ref;
    refPatch_ = std::move(ref);
    samples.push_back(TrackSample{startFrame, seed.x, seed.y, 1, false});
  }

  void step(std::int64_t frame, const LumaPlane& plane) {
    if (dead) return;
    // Velocity ROUNDED so every candidate centre shares the reference's phase (tracker.ts).
    const double predictX = x_ + motion::js::round(vx_);
    const double predictY = y_ + motion::js::round(vy_);
    auto ok = [this](const std::optional<MatchResult>& m) { return m && m->confidence >= minConfidence_; };
    std::optional<MatchResult> match = match_patch(refPatch_, featureHalf_, plane, predictX, predictY, searchHalf_);

    // Recovery before coasting: 2x then 3x the window, then the anchor.
    if (!ok(match)) {
      for (const int scale : {2, 3}) {
        const std::optional<MatchResult> wide =
            match_patch(refPatch_, featureHalf_, plane, predictX, predictY, searchHalf_ * scale);
        if (ok(wide) && (!match || wide->confidence > match->confidence)) {
          match = wide;
          break;
        }
      }
    }
    if (!ok(match) && anchorPatch_) {
      const std::optional<MatchResult> reacquired =
          match_patch(*anchorPatch_, featureHalf_, plane, predictX, predictY, searchHalf_ * 2);
      if (ok(reacquired)) {
        match = reacquired;
        refPatch_ = *anchorPatch_;
      }
    }

    if (ok(match)) {
      double mx = match->x;
      double my = match->y;
      double conf = match->confidence;
      // Drift correction against the anchor, accepted only nearby and confident.
      if (anchorPatch_) {
        const std::optional<MatchResult> anchored = match_patch(*anchorPatch_, featureHalf_, plane, mx, my, 2);
        if (anchored && anchored->confidence >= minConfidence_ && hypot2(anchored->x - mx, anchored->y - my) <= 1.5) {
          mx = anchored->x;
          my = anchored->y;
          conf = anchored->confidence;
        } else {
          // Appearance changed: the current look becomes the new anchor.
          std::vector<float> a = extract_patch(plane, mx, my, featureHalf_);
          if (a.empty()) anchorPatch_.reset();
          else anchorPatch_ = std::move(a);
        }
      }
      vx_ = mx - x_;
      vy_ = my - y_;
      x_ = mx;
      y_ = my;
      coastRun_ = 0;
      samples.push_back(TrackSample{frame, mx, my, conf, false});
      // Chained reference: re-extract from the frame just matched.
      std::vector<float> next = extract_patch(plane, mx, my, featureHalf_);
      if (!next.empty()) refPatch_ = std::move(next);
    } else {
      // Coast on the last confident velocity, reference unchanged.
      coastRun_ += 1;
      x_ = predictX;
      y_ = predictY;
      samples.push_back(TrackSample{frame, predictX, predictY, match ? match->confidence : 0.0, true});
      if (coastRun_ > maxCoast_) dead = true;
    }
  }

  std::vector<TrackSample> samples;
  bool dead = false;

 private:
  int featureHalf_;
  int searchHalf_;
  double minConfidence_;
  int maxCoast_;
  std::vector<float> refPatch_;
  std::optional<std::vector<float>> anchorPatch_;
  double x_;
  double y_;
  double vx_ = 0;
  double vy_ = 0;
  int coastRun_ = 0;
};

/// planarFit.ts `xorshift32`, including JavaScript's signed `>>` in the middle step.
class Xorshift32 {
 public:
  explicit Xorshift32(std::uint32_t seed) : s_(seed != 0 ? seed : 0x9e3779b9U) {}
  double next() noexcept {
    s_ ^= s_ << 13U;
    s_ ^= static_cast<std::uint32_t>(static_cast<std::int32_t>(s_) >> 17);
    s_ ^= s_ << 5U;
    return static_cast<double>(s_) / 4294967295.0;
  }

 private:
  std::uint32_t s_;
};

double reproj_error(const Mat3& H, Pt s, Pt d) {
  const std::optional<Pt> p = project_homography(H, s);
  if (!p) return INFINITY;
  return hypot2(p->x - d.x, p->y - d.y);
}

/// Homography.ts `solveSymmetric8`: Gaussian elimination with partial pivoting.
std::optional<std::array<double, 8>> solve8(const std::array<double, 64>& A, const std::array<double, 8>& b) {
  std::array<double, 72> M{};
  for (size_t i = 0; i < 8; ++i) {
    for (size_t j = 0; j < 8; ++j) M[i * 9 + j] = A[i * 8 + j];
    M[i * 9 + 8] = b[i];
  }
  for (size_t col = 0; col < 8; ++col) {
    size_t pivot = col;
    double best = std::abs(M[col * 9 + col]);
    for (size_t r = col + 1; r < 8; ++r) {
      const double v = std::abs(M[r * 9 + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-14) return std::nullopt;
    if (pivot != col) {
      for (size_t j = col; j < 9; ++j) std::swap(M[col * 9 + j], M[pivot * 9 + j]);
    }
    const double diag = M[col * 9 + col];
    for (size_t j = col; j < 9; ++j) M[col * 9 + j] /= diag;
    for (size_t r = 0; r < 8; ++r) {
      if (r == col) continue;
      const double f = M[r * 9 + col];
      if (f == 0) continue;
      for (size_t j = col; j < 9; ++j) M[r * 9 + j] -= f * M[col * 9 + j];
    }
  }
  std::array<double, 8> x{};
  for (size_t i = 0; i < 8; ++i) x[i] = M[i * 9 + 8];
  return x;
}

}  // namespace

LumaPlane luma_from_rgba(std::span<const std::uint8_t> rgba, int width, int height) {
  LumaPlane out;
  out.width = width;
  out.height = height;
  const size_t n = static_cast<size_t>(std::max(0, width)) * static_cast<size_t>(std::max(0, height));
  out.data.resize(n);
  for (size_t i = 0, p = 0; i < n && p + 2 < rgba.size(); ++i, p += 4) {
    out.data[i] = static_cast<float>(
        (0.299 * static_cast<double>(rgba[p]) + 0.587 * static_cast<double>(rgba[p + 1]) + 0.114 * static_cast<double>(rgba[p + 2])) /
        255);
  }
  return out;
}

double sample_bilinear(const LumaPlane& plane, double x, double y) noexcept {
  const int w = plane.width;
  const int h = plane.height;
  const double cx = std::min(std::max(x, 0.0), static_cast<double>(w - 1));
  const double cy = std::min(std::max(y, 0.0), static_cast<double>(h - 1));
  const double fx0 = std::floor(cx);
  const double fy0 = std::floor(cy);
  const int x0 = static_cast<int>(fx0);
  const int y0 = static_cast<int>(fy0);
  const int x1 = std::min(x0 + 1, w - 1);
  const int y1 = std::min(y0 + 1, h - 1);
  const double fx = cx - fx0;
  const double fy = cy - fy0;
  const double top = static_cast<double>(at(plane, x0, y0)) * (1 - fx) + static_cast<double>(at(plane, x1, y0)) * fx;
  const double bot = static_cast<double>(at(plane, x0, y1)) * (1 - fx) + static_cast<double>(at(plane, x1, y1)) * fx;
  return top * (1 - fy) + bot * fy;
}

std::vector<float> extract_patch(const LumaPlane& plane, double cx, double cy, int half) {
  if (cx < 0 || cy < 0 || cx > plane.width - 1 || cy > plane.height - 1) return {};
  const int size = 2 * half + 1;
  std::vector<float> out(static_cast<size_t>(size) * static_cast<size_t>(size));
  size_t i = 0;
  for (int dy = -half; dy <= half; ++dy) {
    for (int dx = -half; dx <= half; ++dx) out[i++] = static_cast<float>(sample_bilinear(plane, cx + dx, cy + dy));
  }
  return out;
}

double ncc(std::span<const float> a, std::span<const float> b) noexcept {
  const size_t n = std::min(a.size(), b.size());
  if (n == 0) return 0;
  double meanA = 0;
  double meanB = 0;
  for (size_t i = 0; i < n; ++i) {
    meanA += static_cast<double>(a[i]);
    meanB += static_cast<double>(b[i]);
  }
  meanA /= static_cast<double>(n);
  meanB /= static_cast<double>(n);
  double cross = 0;
  double varA = 0;
  double varB = 0;
  for (size_t i = 0; i < n; ++i) {
    const double da = static_cast<double>(a[i]) - meanA;
    const double db = static_cast<double>(b[i]) - meanB;
    cross += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 1e-12 || varB <= 1e-12) return 0;
  return cross / std::sqrt(varA * varB);
}

std::optional<MatchResult> match_patch(std::span<const float> refPatch, int featureHalf, const LumaPlane& target,
                                       double predictX, double predictY, int searchHalf) {
  const int featureSize = 2 * featureHalf + 1;
  const size_t fs = static_cast<size_t>(featureSize);
  const double n = static_cast<double>(featureSize * featureSize);
  if (refPatch.size() < fs * fs || target.width <= 0 || target.height <= 0) return std::nullopt;
  const int reach = searchHalf + featureHalf;
  const int regionSize = 2 * reach + 1;
  const size_t rs = static_cast<size_t>(regionSize);

  // One bilinear pass over the search region, at the prediction's phase (Float32 store).
  std::vector<float> region(rs * rs);
  {
    size_t i = 0;
    for (int dy = -reach; dy <= reach; ++dy) {
      for (int dx = -reach; dx <= reach; ++dx) region[i++] = static_cast<float>(sample_bilinear(target, predictX + dx, predictY + dy));
    }
  }
  // Integral images (Float64), one extra row/col of zeros.
  const size_t iw = rs + 1;
  std::vector<double> integ(iw * iw, 0.0);
  std::vector<double> integSq(iw * iw, 0.0);
  for (size_t y = 0; y < rs; ++y) {
    double rowSum = 0;
    double rowSumSq = 0;
    for (size_t x = 0; x < rs; ++x) {
      const double v = static_cast<double>(region[y * rs + x]);
      rowSum += v;
      rowSumSq += v * v;
      integ[(y + 1) * iw + (x + 1)] = integ[y * iw + (x + 1)] + rowSum;
      integSq[(y + 1) * iw + (x + 1)] = integSq[y * iw + (x + 1)] + rowSumSq;
    }
  }
  double sumT = 0;
  double sumT2 = 0;
  for (size_t i = 0; i < fs * fs; ++i) {
    const double v = static_cast<double>(refPatch[i]);
    sumT += v;
    sumT2 += v * v;
  }
  const double varT = sumT2 - (sumT * sumT) / n;

  const int size = 2 * searchHalf + 1;
  // The Float32 memo (-3 = not evaluated): a first evaluation returns the
  // double score, a memo hit the float it was stored as — as the TypeScript.
  std::vector<float> scores(static_cast<size_t>(size) * static_cast<size_t>(size), -3.0F);
  auto score = [&](int dx, int dy) -> double {
    if (std::abs(dx) > searchHalf || std::abs(dy) > searchHalf) return -2;
    const size_t slot = static_cast<size_t>(dy + searchHalf) * static_cast<size_t>(size) + static_cast<size_t>(dx + searchHalf);
    const float memo = scores[slot];
    if (memo > -3.0F) return static_cast<double>(memo);
    const double cx = predictX + dx;
    const double cy = predictY + dy;
    if (cx < 0 || cy < 0 || cx > target.width - 1 || cy > target.height - 1) {
      scores[slot] = -2.0F;
      return -2;
    }
    const size_t x0 = static_cast<size_t>(dx + searchHalf);
    const size_t y0 = static_cast<size_t>(dy + searchHalf);
    const size_t x1 = x0 + fs;
    const size_t y1 = y0 + fs;
    const double sumW = integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0] + integ[y0 * iw + x0];
    const double sumW2 = integSq[y1 * iw + x1] - integSq[y0 * iw + x1] - integSq[y1 * iw + x0] + integSq[y0 * iw + x0];
    const double varW = sumW2 - (sumW * sumW) / n;
    if (varT <= 1e-12 || varW <= 1e-12) {
      scores[slot] = 0.0F;
      return 0;
    }
    double cross = 0;
    size_t k = 0;
    for (size_t r = 0; r < fs; ++r) {
      size_t ri = (y0 + r) * rs + x0;
      for (size_t c = 0; c < fs; ++c, ++k, ++ri) cross += static_cast<double>(refPatch[k]) * static_cast<double>(region[ri]);
    }
    const double s = (cross - (sumT * sumW) / n) / std::sqrt(varT * varW);
    scores[slot] = static_cast<float>(s);
    return s;
  };

  double bestScore = -2;
  int bestDx = 0;
  int bestDy = 0;
  auto consider = [&](int dx, int dy) {
    const double s = score(dx, dy);
    if (s > bestScore) {
      bestScore = s;
      bestDx = dx;
      bestDy = dy;
    }
  };
  if (searchHalf <= 6) {
    for (int dy = -searchHalf; dy <= searchHalf; ++dy) {
      for (int dx = -searchHalf; dx <= searchHalf; ++dx) consider(dx, dy);
    }
  } else {
    for (int dy = -searchHalf; dy <= searchHalf; dy += 2) {
      for (int dx = -searchHalf; dx <= searchHalf; dx += 2) consider(dx, dy);
    }
    if (searchHalf % 2 == 1) {
      for (int d = -searchHalf; d <= searchHalf; d += 2) {
        consider(d, searchHalf);
        consider(d, -searchHalf);
        consider(searchHalf, d);
        consider(-searchHalf, d);
      }
    }
    const int cDx = bestDx;
    const int cDy = bestDy;
    for (int dy = std::max(-searchHalf, cDy - 2); dy <= std::min(searchHalf, cDy + 2); ++dy) {
      for (int dx = std::max(-searchHalf, cDx - 2); dx <= std::min(searchHalf, cDx + 2); ++dx) consider(dx, dy);
    }
  }
  if (bestScore <= -2) return std::nullopt;

  if (const std::optional<Pt> refined = lk_refine(refPatch.first(fs * fs), featureHalf, target, predictX + bestDx, predictY + bestDy)) {
    return MatchResult{refined->x, refined->y, bestScore};
  }
  auto neighbour = [&](int dx, int dy) -> std::optional<double> {
    if (std::abs(dx) > searchHalf || std::abs(dy) > searchHalf) return std::nullopt;
    const double s = score(dx, dy);
    return s <= -2 ? std::nullopt : std::optional<double>(s);
  };
  const std::optional<double> l = neighbour(bestDx - 1, bestDy);
  const std::optional<double> r = neighbour(bestDx + 1, bestDy);
  const std::optional<double> t = neighbour(bestDx, bestDy - 1);
  const std::optional<double> b = neighbour(bestDx, bestDy + 1);
  const double offX = l && r ? parabolic_offset(*l, bestScore, *r) : 0;
  const double offY = t && b ? parabolic_offset(*t, bestScore, *b) : 0;
  return MatchResult{predictX + bestDx + offX, predictY + bestDy + offY, bestScore};
}

MultiTrackResult track_points(const FrameAt& frameAt, std::int64_t fromFrame, std::int64_t toFrame,
                              std::span<const PointSeed> points, const TrackOptions& opts, const OnProgress& onProgress) {
  const std::int64_t step = toFrame >= fromFrame ? 1 : -1;
  const std::int64_t total = (toFrame >= fromFrame ? toFrame - fromFrame : fromFrame - toFrame) + 1;
  std::vector<PointTrack> tracks;
  tracks.reserve(points.size());
  {
    const LumaPlane& first = frameAt(fromFrame);
    for (const PointSeed& p : points) tracks.emplace_back(first, fromFrame, p, opts);
  }
  auto collect = [&tracks](TrackStatus status) {
    MultiTrackResult r;
    r.status = status;
    r.tracks.reserve(tracks.size());
    for (PointTrack& t : tracks) r.tracks.push_back(std::move(t.samples));
    return r;
  };
  auto allDead = [&tracks] { return std::all_of(tracks.begin(), tracks.end(), [](const PointTrack& t) { return t.dead; }); };
  if (allDead()) return collect(TrackStatus::lost);
  std::int64_t done = 1;
  for (std::int64_t frame = fromFrame + step; frame != toFrame + step; frame += step, ++done) {
    if (onProgress && !onProgress(done, total)) return collect(TrackStatus::cancelled);
    const LumaPlane& plane = frameAt(frame);
    for (PointTrack& t : tracks) t.step(frame, plane);
    if (allDead()) return collect(TrackStatus::lost);
  }
  return collect(TrackStatus::completed);
}

std::vector<TrackSample> merge_bidirectional(std::span<const TrackSample> backward, std::span<const TrackSample> forward) {
  std::set<std::int64_t> seen;
  std::vector<TrackSample> merged;
  for (auto it = backward.rbegin(); it != backward.rend(); ++it) {
    if (!seen.insert(it->frame).second) continue;
    merged.push_back(*it);
  }
  for (const TrackSample& s : forward) {
    if (!seen.insert(s.frame).second) continue;
    merged.push_back(s);
  }
  std::stable_sort(merged.begin(), merged.end(), [](const TrackSample& p, const TrackSample& q) { return p.frame < q.frame; });
  return merged;
}

// ── planar fit ──────────────────────────────────────────────────────────

std::optional<Mat3> fit_homography(std::span<const Pt> src, std::span<const Pt> dst) {
  const size_t n = src.size();
  if (n < 4 || dst.size() != n) return std::nullopt;
  std::array<double, 64> AtA{};
  std::array<double, 8> Atb{};
  auto addRow = [&](const std::array<double, 8>& row, double rhs) {
    for (size_t i = 0; i < 8; ++i) {
      Atb[i] += row[i] * rhs;
      for (size_t j = 0; j < 8; ++j) AtA[i * 8 + j] += row[i] * row[j];
    }
  };
  for (size_t k = 0; k < n; ++k) {
    const double x = src[k].x;
    const double y = src[k].y;
    const double u = dst[k].x;
    const double v = dst[k].y;
    std::array<double, 8> r1{};
    r1[0] = x;
    r1[1] = y;
    r1[2] = 1;
    r1[6] = -x * u;
    r1[7] = -y * u;
    addRow(r1, u);
    std::array<double, 8> r2{};
    r2[3] = x;
    r2[4] = y;
    r2[5] = 1;
    r2[6] = -x * v;
    r2[7] = -y * v;
    addRow(r2, v);
  }
  const std::optional<std::array<double, 8>> h = solve8(AtA, Atb);
  if (!h) return std::nullopt;
  const std::array<double, 8>& s = *h;
  return Mat3{static_cast<float>(s[0]), static_cast<float>(s[3]), static_cast<float>(s[6]),
              static_cast<float>(s[1]), static_cast<float>(s[4]), static_cast<float>(s[7]),
              static_cast<float>(s[2]), static_cast<float>(s[5]), 1.0F};
}

std::optional<Pt> project_homography(const Mat3& m, Pt p) noexcept {
  const double w = static_cast<double>(m[2]) * p.x + static_cast<double>(m[5]) * p.y + static_cast<double>(m[8]);
  if (std::abs(w) < 1e-9) return std::nullopt;
  const double inv = 1 / w;
  return Pt{(static_cast<double>(m[0]) * p.x + static_cast<double>(m[3]) * p.y + static_cast<double>(m[6])) * inv,
            (static_cast<double>(m[1]) * p.x + static_cast<double>(m[4]) * p.y + static_cast<double>(m[7])) * inv};
}

std::optional<RansacFit> fit_homography_ransac(std::span<const Pt> src, std::span<const Pt> dst, const RansacOptions& opts) {
  const double inlierPx = opts.inlierPx;
  const size_t n = std::min(src.size(), dst.size());
  std::vector<size_t> usable;
  for (size_t i = 0; i < n; ++i) {
    const double w = i < opts.weights.size() ? opts.weights[i] : 1.0;
    if (w > 0) usable.push_back(i);
  }
  if (usable.size() < 4) return std::nullopt;

  auto finish = [&](const Mat3& H) {
    RansacFit f;
    f.H = H;
    f.inliers.assign(n, false);
    double sq = 0;
    for (const size_t i : usable) {
      const double e = reproj_error(H, src[i], dst[i]);
      if (e <= inlierPx) {
        f.inliers[i] = true;
        f.inlierCount += 1;
        sq += e * e;
      }
    }
    f.rms = f.inlierCount > 0 ? std::sqrt(sq / f.inlierCount) : INFINITY;
    return f;
  };
  auto fit_of = [&](const std::vector<size_t>& idx) {
    std::vector<Pt> s;
    std::vector<Pt> d;
    for (const size_t i : idx) {
      s.push_back(src[i]);
      d.push_back(dst[i]);
    }
    return fit_homography(s, d);
  };

  if (usable.size() == 4) {
    const std::optional<Mat3> H = fit_of(usable);
    return H ? std::optional<RansacFit>(finish(*H)) : std::nullopt;
  }

  Xorshift32 rand(opts.seed);
  struct Best {
    std::vector<size_t> idx;
    int count = 0;
    double rms = 0;
  };
  std::optional<Best> best;
  for (int it = 0; it < opts.iterations; ++it) {
    std::vector<size_t> pick;
    while (pick.size() < 4) {
      // Math.floor(rand() * n): rand() reaches 1 only at 0xffffffff, clamped here to the last index.
      const size_t k = std::min(usable.size() - 1,
                                static_cast<size_t>(std::floor(rand.next() * static_cast<double>(usable.size()))));
      const size_t i = usable[k];
      if (std::find(pick.begin(), pick.end(), i) == pick.end()) pick.push_back(i);
    }
    const std::optional<Mat3> H = fit_of(pick);
    if (!H) continue;
    int count = 0;
    double sq = 0;
    std::vector<size_t> idx;
    for (const size_t i : usable) {
      const double e = reproj_error(*H, src[i], dst[i]);
      if (e <= inlierPx) {
        count += 1;
        sq += e * e;
        idx.push_back(i);
      }
    }
    const double rms = count > 0 ? std::sqrt(sq / count) : INFINITY;
    if (count >= 4 && (!best || count > best->count || (count == best->count && rms < best->rms))) {
      best = Best{std::move(idx), count, rms};
    }
  }
  if (!best) return std::nullopt;
  const std::optional<Mat3> H = fit_of(best->idx);
  return H ? std::optional<RansacFit>(finish(*H)) : std::nullopt;
}

std::vector<std::optional<Mat3>> smooth_homography_sequence(std::span<const std::optional<Mat3>> hs, int radius) {
  const int r = std::max(0, radius);
  if (r == 0 || hs.empty()) return {hs.begin(), hs.end()};
  const int len = static_cast<int>(hs.size());
  std::vector<std::optional<Mat3>> out(hs.size());
  for (int i = 0; i < len; ++i) {
    if (!hs[static_cast<size_t>(i)]) continue;
    std::array<float, 9> acc{};
    int count = 0;
    for (int j = i - r; j <= i + r; ++j) {
      if (j < 0 || j >= len || !hs[static_cast<size_t>(j)]) continue;
      count += 1;
      const Mat3& H = *hs[static_cast<size_t>(j)];
      for (size_t k = 0; k < 9; ++k) acc[k] = static_cast<float>(static_cast<double>(acc[k]) + static_cast<double>(H[k]));
    }
    if (count == 0) continue;
    Mat3 H{};
    for (size_t k = 0; k < 9; ++k) H[k] = static_cast<float>(static_cast<double>(acc[k]) / count);
    const double s = static_cast<double>(H[8]);
    if (std::abs(s) > 1e-12) {
      for (size_t k = 0; k < 9; ++k) H[k] = static_cast<float>(static_cast<double>(H[k]) / s);
    }
    out[static_cast<size_t>(i)] = H;
  }
  return out;
}

}  // namespace premation::jobs::tracking
