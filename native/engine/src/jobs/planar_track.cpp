#include "planar_track.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <optional>
#include <utility>

#include "track_feature.hpp"

namespace premation::jobs::planar {

namespace {

using tracking::LumaPlane;
using tracking::Mat3;
using tracking::Pt;

/// Column-major Mat3 inverse (nullopt when singular).
std::optional<Mat3> invert(const Mat3& m) {
  // m = [a d g; b e h; c f i] stored column-major as {a,d,g, b,e,h, c,f,i}?
  // Homography.ts stores [a,d,g, b,e,h, c,f,i] for the matrix
  // | a b c |
  // | d e f |
  // | g h i |   (x' = (a x + b y + c) / (g x + h y + i)).
  const double a = m[0];
  const double d = m[1];
  const double g = m[2];
  const double b = m[3];
  const double e = m[4];
  const double h = m[5];
  const double c = m[6];
  const double f = m[7];
  const double i = m[8];
  const double A = e * i - f * h;
  const double B = -(d * i - f * g);
  const double C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (std::abs(det) < 1e-12) return std::nullopt;
  const double inv = 1 / det;
  // Inverse = adj / det; adj = cofactor matrix transposed.
  const double ra = A * inv;
  const double rb = -(b * i - c * h) * inv;
  const double rc = (b * f - c * e) * inv;
  const double rd = B * inv;
  const double re = (a * i - c * g) * inv;
  const double rf = -(a * f - c * d) * inv;
  const double rg = C * inv;
  const double rh = -(a * h - b * g) * inv;
  const double ri = (a * e - b * d) * inv;
  return Mat3{static_cast<float>(ra), static_cast<float>(rd), static_cast<float>(rg), static_cast<float>(rb), static_cast<float>(re),
              static_cast<float>(rh), static_cast<float>(rc), static_cast<float>(rf), static_cast<float>(ri)};
}

bool excluded(Pt p, const Polys& ex) {
  return std::any_of(ex.begin(), ex.end(), [&](const Poly& poly) { return point_in_poly(p, poly); });
}

double edge_distance(Pt p, std::span<const Pt> poly) {
  double best = 1e300;
  for (std::size_t k = 0; k < poly.size(); ++k) {
    const Pt a = poly[k];
    const Pt b = poly[(k + 1) % poly.size()];
    const double vx = b.x - a.x;
    const double vy = b.y - a.y;
    const double len2 = vx * vx + vy * vy;
    double t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
    t = std::clamp(t, 0.0, 1.0);
    best = std::min(best, std::hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
  }
  return best;
}

bool in_plane(const LumaPlane& p, Pt q, int margin) {
  return q.x >= margin && q.y >= margin && q.x <= p.width - 1 - margin && q.y <= p.height - 1 - margin;
}

struct Feature {
  Pt ref;                    ///< origin-frame position
  Pt at;                     ///< position in the previous frame
  std::vector<float> anchor; ///< its patch where it was found
};

}  // namespace

Mat3 identity() noexcept { return Mat3{1, 0, 0, 0, 1, 0, 0, 0, 1}; }

bool point_in_poly(Pt p, std::span<const Pt> poly) noexcept {
  bool inside = false;
  const std::size_t n = poly.size();
  if (n < 3) return false;
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const Pt& a = poly[i];
    const Pt& b = poly[j];
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y + 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

std::vector<Pt> region_features(const LumaPlane& plane, std::span<const Pt> quad, const Polys& exclude, int count, int half) {
  if (quad.size() < 3 || count <= 0) return {};
  double x0 = 1e300;
  double y0 = 1e300;
  double x1 = -1e300;
  double y1 = -1e300;
  for (const Pt& q : quad) {
    x0 = std::min(x0, q.x);
    y0 = std::min(y0, q.y);
    x1 = std::max(x1, q.x);
    y1 = std::max(y1, q.y);
  }
  const double side = std::max(8.0, std::sqrt(std::max(1.0, (x1 - x0) * (y1 - y0)) / std::max(1, count)));
  const auto tile = static_cast<int>(std::clamp(side, 12.0, 256.0));
  const feature::Region within{static_cast<int>(std::floor(x0)), static_cast<int>(std::floor(y0)), static_cast<int>(std::ceil(x1)),
                               static_cast<int>(std::ceil(y1))};
  // Over-ask: the bounding box holds area outside the quad.
  const std::vector<feature::Candidate> cands = feature::pick_features(plane, count * 3, half + 2, tile, within);
  std::vector<Pt> out;
  for (const feature::Candidate& c : cands) {
    const Pt p{c.x, c.y};
    if (!point_in_poly(p, quad) || edge_distance(p, quad) < half || excluded(p, exclude)) continue;
    out.push_back(p);
    if (static_cast<int>(out.size()) >= count) break;
  }
  return out;
}

Result track_planar(const tracking::FrameAt& frameAt, std::int64_t from, std::int64_t to, const Spec& spec,
                    const ExcludeAt& excludeAt, const tracking::OnProgress& onProgress) {
  Result out;
  const std::int64_t step = to >= from ? 1 : -1;
  const std::int64_t total = to >= from ? to - from : from - to;
  LumaPlane prev = frameAt(from);
  const int half = std::max(2, spec.featureHalf);
  const int search = std::max(half + 2, spec.searchHalf);
  const auto exclusionAt = [&](std::int64_t f) { return excludeAt ? excludeAt(f) : Polys{}; };

  std::vector<Feature> feats;
  auto add_features = [&](const LumaPlane& plane, std::span<const Pt> quadHere, const Polys& ex, const Mat3& H, int want) {
    const std::optional<Mat3> inv = invert(H);
    if (!inv) return;
    for (const Pt& p : region_features(plane, quadHere, ex, want, half)) {
      // Not on top of a live feature.
      const bool crowded = std::any_of(feats.begin(), feats.end(), [&](const Feature& f) { return std::hypot(f.at.x - p.x, f.at.y - p.y) < 2.0 * half; });
      if (crowded) continue;
      const std::optional<Pt> ref = tracking::project_homography(*inv, p);
      if (!ref) continue;
      std::vector<float> patch = tracking::extract_patch(plane, p.x, p.y, half);
      if (patch.empty()) continue;
      feats.push_back(Feature{*ref, p, std::move(patch)});
    }
  };

  Mat3 H = identity();
  add_features(prev, spec.region, exclusionAt(from), H, spec.maxFeatures);
  if (feats.size() < 8) {
    out.status = tracking::TrackStatus::lost;
    return out;
  }
  out.frames.push_back(FrameH{from, H, static_cast<int>(feats.size()), static_cast<int>(feats.size())});

  Mat3 velocity = identity();  // H_t · H_{t−1}⁻¹: the last step, for the prediction
  std::int64_t done = 0;
  for (std::int64_t f = from + step; step > 0 ? f <= to : f >= to; f += step) {
    if (onProgress && !onProgress(done, total)) {
      out.status = tracking::TrackStatus::cancelled;
      return out;
    }
    ++done;
    const LumaPlane& plane = frameAt(f);
    const Polys ex = exclusionAt(f);
    std::vector<Pt> src;
    std::vector<Pt> dst;
    std::vector<std::size_t> which;
    for (std::size_t k = 0; k < feats.size(); ++k) {
      Feature& ft = feats[k];
      // Predict through the last step's motion.
      const Pt guess = tracking::project_homography(velocity, ft.at).value_or(ft.at);
      const std::vector<float> chained = tracking::extract_patch(prev, ft.at.x, ft.at.y, half);
      if (chained.empty()) continue;
      const auto m = tracking::match_patch(chained, half, plane, guess.x, guess.y, search);
      if (!m || m->confidence < 0.6) continue;
      Pt hit{m->x, m->y};
      // Anchor: the feature's own first patch near the chained match pulls
      // the walk back onto it (no drift while it still looks like itself).
      if (const auto a = tracking::match_patch(ft.anchor, half, plane, hit.x, hit.y, 3); a && a->confidence >= 0.85) hit = Pt{a->x, a->y};
      if (!in_plane(plane, hit, half) || excluded(hit, ex)) continue;
      src.push_back(ft.ref);
      dst.push_back(hit);
      which.push_back(k);
    }
    if (src.size() < 8) {
      out.status = tracking::TrackStatus::lost;
      break;
    }
    tracking::RansacOptions ro;
    ro.inlierPx = spec.inlierPx;
    ro.iterations = 128;
    ro.seed = static_cast<std::uint32_t>(0x9e3779b9u ^ static_cast<std::uint32_t>(f));
    const std::optional<tracking::RansacFit> fit = tracking::fit_homography_ransac(src, dst, ro);
    const double ratio = fit ? static_cast<double>(fit->inlierCount) / static_cast<double>(feats.size()) : 0;
    if (!fit || fit->inlierCount < 8 || ratio < spec.minInlierRatio) {
      out.status = tracking::TrackStatus::lost;
      break;
    }
    std::vector<Pt> is;
    std::vector<Pt> id;
    for (std::size_t k = 0; k < src.size(); ++k) {
      if (!fit->inliers[k]) continue;
      is.push_back(src[k]);
      id.push_back(dst[k]);
    }
    const Mat3 Hnext = tracking::fit_homography(is, id).value_or(fit->H);
    if (const std::optional<Mat3> inv = invert(H)) {
      // velocity = Hnext · H⁻¹ (row-major maths on the column-major store).
      const auto at = [](const Mat3& m, int r, int c) { return static_cast<double>(m[static_cast<std::size_t>(c * 3 + r)]); };
      Mat3 v{};
      for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
          double s = 0;
          for (int k = 0; k < 3; ++k) s += at(Hnext, r, k) * at(*inv, k, c);
          v[static_cast<std::size_t>(c * 3 + r)] = static_cast<float>(s);
        }
      }
      velocity = v;
    }
    H = Hnext;
    // Inliers move to where they were matched; everything else to where the plane says.
    std::vector<bool> live(feats.size(), false);
    for (std::size_t k = 0; k < which.size(); ++k) {
      if (!fit->inliers[k]) continue;
      feats[which[k]].at = dst[k];
      live[which[k]] = true;
    }
    std::vector<Feature> kept;
    kept.reserve(feats.size());
    for (std::size_t k = 0; k < feats.size(); ++k) {
      Feature& ft = feats[k];
      if (!live[k]) {
        const std::optional<Pt> p = tracking::project_homography(H, ft.ref);
        if (!p || !in_plane(plane, *p, half)) continue;  // left the frame
        ft.at = *p;
      }
      kept.push_back(std::move(ft));
    }
    feats = std::move(kept);
    // Replenish inside the region where it is now.
    if (fit->inlierCount < std::max(16, spec.maxFeatures / 3)) {
      std::array<Pt, 4> quadHere{};
      bool ok = true;
      for (std::size_t c = 0; c < 4; ++c) {
        const std::optional<Pt> p = tracking::project_homography(H, spec.region[c]);
        if (!p) ok = false;
        else quadHere[c] = *p;
      }
      if (ok) add_features(plane, quadHere, ex, H, spec.maxFeatures - static_cast<int>(feats.size()));
    }
    out.frames.push_back(FrameH{f, H, fit->inlierCount, static_cast<int>(feats.size())});
    prev = plane;
  }
  return out;
}

}  // namespace premation::jobs::planar
