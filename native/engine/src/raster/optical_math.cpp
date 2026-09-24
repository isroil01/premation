#include "optical_math.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#include "text_unicode.hpp"

namespace premation::raster::optical {
namespace {

constexpr double kBandH = (kBandTopEm - kBandBottomEm) / kBandCount;
constexpr double kOpenCapEm = 0.08;
constexpr double kOpticalStrength = 0.6;
constexpr double kMaxTightenEm = 0.15;
constexpr double kMaxLoosenEm = 0.05;
constexpr double kMinInkGapEm = 0.02;
constexpr int kAlphaFloor = 8;
const double kNaN = std::numeric_limits<double>::quiet_NaN();

double band_centre(int i) { return kBandBottomEm + (i + 0.5) * kBandH; }

double band_weight(double yEm, double xHeight) {
  if (yEm < 0) return 0.3;
  if (yEm <= xHeight) return 1;
  if (yEm <= xHeight + 0.25) return 0.5;
  return 0.25;
}

}  // namespace

int band_of(double yEm) { return static_cast<int>(std::floor((yEm - kBandBottomEm) / kBandH)); }

InkProfile empty_profile(double advance) {
  return {advance, std::vector<double>(kBandCount, kNaN), std::vector<double>(kBandCount, kNaN), kNaN};
}

void widen(InkProfile& p, int band, double x) {
  if (band < 0 || band >= kBandCount) return;
  const auto b = static_cast<std::size_t>(band);
  if (std::isnan(p.left[b]) || x < p.left[b]) p.left[b] = x;
  if (std::isnan(p.right[b]) || x > p.right[b]) p.right[b] = x;
}

InkProfile profile_from_alpha(const std::vector<std::uint8_t>& rgba, std::uint32_t width, std::uint32_t height, double penX,
                              double baselineY, double emPx, double advancePx) {
  InkProfile p = empty_profile(advancePx / emPx);
  for (std::uint32_t row = 0; row < height; ++row) {
    const double yEm = (baselineY - (row + 0.5)) / emPx;
    const int band = band_of(yEm);
    if (band < 0 || band >= kBandCount) continue;
    const std::size_t base = static_cast<std::size_t>(row) * width;
    std::ptrdiff_t first = -1;
    for (std::uint32_t col = 0; col < width; ++col) {
      if (rgba[(base + col) * 4 + 3] >= kAlphaFloor) { first = col; break; }
    }
    if (first < 0) continue;
    std::ptrdiff_t last = first;
    for (auto col = static_cast<std::ptrdiff_t>(width) - 1; col > first; --col) {
      if (rgba[(base + static_cast<std::size_t>(col)) * 4 + 3] >= kAlphaFloor) { last = col; break; }
    }
    const double aL = rgba[(base + static_cast<std::size_t>(first)) * 4 + 3] / 255.0;
    const double aR = rgba[(base + static_cast<std::size_t>(last)) * 4 + 3] / 255.0;
    widen(p, band, (static_cast<double>(first) + 1 - aL - penX) / emPx);
    widen(p, band, (static_cast<double>(last) + aR - penX) / emPx);
    const double top = (baselineY - row) / emPx;
    if (std::isnan(p.top) || top > p.top) p.top = top;
  }
  return p;
}

InkProfile vertical_profile_from_alpha(const std::vector<std::uint8_t>& rgba, std::uint32_t width, std::uint32_t height,
                                       double emLeft, double emTop, double emPx) {
  InkProfile p = empty_profile(1);
  const auto alpha = [&](std::uint32_t row, std::uint32_t col) {
    return rgba[(static_cast<std::size_t>(row) * width + col) * 4 + 3];
  };
  for (std::uint32_t col = 0; col < width; ++col) {
    const double xEm = (col + 0.5 - emLeft) / emPx;
    if (xEm < 0 || xEm > 1) continue;
    const int band = band_of(xEm * kVerticalBandSpanEm);
    if (band < 0 || band >= kBandCount) continue;
    std::ptrdiff_t first = -1;
    for (std::uint32_t row = 0; row < height; ++row) {
      if (alpha(row, col) >= kAlphaFloor) { first = row; break; }
    }
    if (first < 0) continue;
    std::ptrdiff_t last = first;
    for (auto row = static_cast<std::ptrdiff_t>(height) - 1; row > first; --row) {
      if (alpha(static_cast<std::uint32_t>(row), col) >= kAlphaFloor) { last = row; break; }
    }
    const double aT = alpha(static_cast<std::uint32_t>(first), col) / 255.0;
    const double aB = alpha(static_cast<std::uint32_t>(last), col) / 255.0;
    widen(p, band, (static_cast<double>(first) + 1 - aT - emTop) / emPx);
    widen(p, band, (static_cast<double>(last) + aB - emTop) / emPx);
    const double bottom = (static_cast<double>(last) + aB - emTop) / emPx;
    if (std::isnan(p.top) || bottom > p.top) p.top = bottom;
  }
  return p;
}

std::optional<PairGap> measure_pair_gap(const InkProfile& a, double sizeA, const InkProfile& b, double sizeB, double xHeightEm) {
  const double penB = a.advance * sizeA;
  const double cap = kOpenCapEm * std::min(sizeA, sizeB);
  const auto facing = [&](int i) { return sizeA == sizeB ? i : band_of((band_centre(i) * sizeA) / sizeB); };
  const auto leftB = [&](int j) { return j >= 0 && j < kBandCount ? b.left[static_cast<std::size_t>(j)] : kNaN; };
  double dmin = std::numeric_limits<double>::infinity();
  bool anyA = false;
  bool anyB = false;
  std::vector<std::pair<double, double>> both;
  double openW = 0;
  for (int i = 0; i < kBandCount; ++i) {
    const double ra = a.right[static_cast<std::size_t>(i)];
    const int j = facing(i);
    const double lb = leftB(j);
    const bool hasA = !std::isnan(ra);
    const bool hasB = !std::isnan(lb);
    anyA = anyA || hasA;
    anyB = anyB || hasB;
    if (!hasA && !hasB) continue;
    const double w = band_weight(band_centre(i), xHeightEm);
    if (hasA && hasB) {
      const double d = penB + lb * sizeB - ra * sizeA;
      both.emplace_back(d, w);
      dmin = std::min(dmin, d);
    } else {
      openW += w;
    }
    if (hasA) {
      for (const int jj : {j - 1, j + 1}) {
        const double nb = leftB(jj);
        if (!std::isnan(nb)) dmin = std::min(dmin, penB + nb * sizeB - ra * sizeA);
      }
    }
  }
  if (!anyA || !anyB) return std::nullopt;
  if (both.empty()) {
    double maxRA = -std::numeric_limits<double>::infinity();
    double minLB = std::numeric_limits<double>::infinity();
    for (const double v : a.right) {
      if (!std::isnan(v)) maxRA = std::max(maxRA, v);
    }
    for (const double v : b.left) {
      if (!std::isnan(v)) minLB = std::min(minLB, v);
    }
    const double clear = penB + minLB * sizeB - maxRA * sizeA;
    const double d = std::isfinite(dmin) ? std::min(dmin, clear) : clear;
    return PairGap{d + cap, d};
  }
  double sum = 0;
  double wsum = 0;
  for (const auto& [d, w] : both) {
    sum += std::min(d, dmin + cap) * w;
    wsum += w;
  }
  sum += (dmin + cap) * openW;
  wsum += openW;
  return PairGap{sum / wsum, dmin};
}

double pair_adjustment(const PairGap& gap, double targetPx, double sizePx) {
  double k = (targetPx - gap.area) * kOpticalStrength;
  k = std::max(-kMaxTightenEm * sizePx, std::min(kMaxLoosenEm * sizePx, k));
  if (k < 0) k = std::max(k, std::min(0.0, kMinInkGapEm * sizePx - gap.dmin));
  return k;
}

bool is_proportional_cjk(const std::string& cluster) {
  const auto cps = code_points(cluster);
  const char32_t cp = cps.empty() ? 0 : cps.front();
  return (cp >= 0x3001 && cp <= 0x303f) || (cp >= 0x3041 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) ||
         (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff01 && cp <= 0xff0f) ||
         (cp >= 0xff1a && cp <= 0xff20) || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65);
}

// ── VerticalKerner (opticalKernVerticalPx) ──────────────────────────────────

const InkProfile* VerticalKerner::profile(const std::string& css, const std::string& cluster) {
  const std::string key = "v " + css + " " + cluster;
  auto it = profiles_.find(key);
  if (it == profiles_.end()) it = profiles_.emplace(key, raster_ ? raster_(css, cluster) : std::nullopt).first;
  return it->second ? &*it->second : nullptr;
}

double VerticalKerner::target(const std::string& css) {
  const auto hit = targets_.find(css);
  if (hit != targets_.end()) return hit->second;
  // The face's own vertical white between two full-em ideographs.
  double sum = 0;
  int n = 0;
  for (const char* c : {"\xE5\x9B\xBD", "\xE5\x8F\xA3"}) {  // 国 口
    const InkProfile* p = profile(css, c);
    const auto gap = p != nullptr ? measure_pair_gap(*p, 1, *p, 1, kVerticalBandSpanEm) : std::nullopt;
    if (gap) {
      sum += gap->area;
      ++n;
    }
  }
  const double t = n > 0 ? sum / n : kDefaultTargetEm;
  targets_.emplace(css, t);
  return t;
}

double VerticalKerner::kern_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB,
                               const std::string& b, double sizeB) {
  if (!(sizeA > 0) || !(sizeB > 0) || is_js_blank(a) || is_js_blank(b)) return 0;
  if (!is_proportional_cjk(a) && !is_proportional_cjk(b)) return 0;
  const double ratio = sizeB / sizeA;
  std::string key = "v " + cssA + " " + a + " " + cssB + " " + b + " r";
  key.append(reinterpret_cast<const char*>(&ratio), sizeof ratio);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): exact bits as the key
  const auto hit = pairs_.find(key);
  if (hit != pairs_.end()) return hit->second * sizeA;
  const InkProfile* pa = profile(cssA, a);
  const InkProfile* pb = profile(cssB, b);
  double em = 0;
  if (pa != nullptr && pb != nullptr) {
    const auto gap = measure_pair_gap(*pa, 1, *pb, ratio, kVerticalBandSpanEm);
    if (gap) em = std::min(0.0, pair_adjustment(*gap, target(cssA), std::min(1.0, ratio)));
  }
  pairs_.emplace(std::move(key), em);
  return em * sizeA;
}

}  // namespace premation::raster::optical
