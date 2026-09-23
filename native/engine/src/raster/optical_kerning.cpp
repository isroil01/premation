#include "optical_kerning.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "fonts.hpp"
#include "paint_common.hpp"
#include "text_unicode.hpp"

namespace premation::raster {
namespace {

constexpr int kBandCount = 30;
constexpr double kBandBottomEm = -0.25;
constexpr double kBandTopEm = 0.95;
constexpr double kBandH = (kBandTopEm - kBandBottomEm) / kBandCount;
constexpr double kOpenCapEm = 0.08;
constexpr double kOpticalStrength = 0.6;
constexpr double kMaxTightenEm = 0.15;
constexpr double kMaxLoosenEm = 0.05;
constexpr double kMinInkGapEm = 0.02;
constexpr double kDefaultXHeightEm = 0.52;
constexpr double kDefaultTargetEm = 0.1;
constexpr int kAlphaFloor = 8;
const double kNaN = std::numeric_limits<double>::quiet_NaN();

using Profile = OpticalKerner::InkProfile;

int band_of(double yEm) { return static_cast<int>(std::floor((yEm - kBandBottomEm) / kBandH)); }
double band_centre(int i) { return kBandBottomEm + (i + 0.5) * kBandH; }

Profile empty_profile(double advance) {
  return {advance, std::vector<double>(kBandCount, kNaN), std::vector<double>(kBandCount, kNaN), kNaN};
}

void widen(Profile& p, int band, double x) {
  if (band < 0 || band >= kBandCount) return;
  const auto b = static_cast<std::size_t>(band);
  if (std::isnan(p.left[b]) || x < p.left[b]) p.left[b] = x;
  if (std::isnan(p.right[b]) || x > p.right[b]) p.right[b] = x;
}

/// profileFromAlpha.
Profile profile_from_alpha(const std::vector<std::uint8_t>& rgba, std::uint32_t width, std::uint32_t height, double penX,
                           double baselineY, double emPx, double advancePx) {
  Profile p = empty_profile(advancePx / emPx);
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

/// addEdge: one straight edge (em) widens every band it crosses.
void add_edge(Profile& p, double x0, double y0, double x1, double y1) {
  const double yLo = std::min(y0, y1);
  const double yHi = std::max(y0, y1);
  if (yHi < kBandBottomEm || yLo >= kBandTopEm) return;
  const int first = std::max(0, band_of(yLo));
  const int last = std::min(kBandCount - 1, band_of(yHi));
  for (int b = first; b <= last; ++b) {
    const double bLo = kBandBottomEm + b * kBandH;
    const double bHi = bLo + kBandH;
    if (y1 == y0) {
      widen(p, b, x0);
      widen(p, b, x1);
      continue;
    }
    const double ta = (std::max(yLo, bLo) - y0) / (y1 - y0);
    const double tb = (std::min(yHi, bHi) - y0) / (y1 - y0);
    widen(p, b, x0 + (x1 - x0) * ta);
    widen(p, b, x0 + (x1 - x0) * tb);
  }
}

constexpr int kCurveSteps = 12;

/// profileFromContours: every segment flattened into CURVE_STEPS edges.
Profile profile_from_outline(const GlyphOutlineUnits& g) {
  const double s = 1 / (g.unitsPerEm != 0 ? g.unitsPerEm : 1000);
  Profile p = empty_profile(g.advance * s);
  const auto raise = [&p](double y) {
    if (std::isnan(p.top) || y > p.top) p.top = y;
  };
  for (const auto& contour : g.contours) {
    for (const auto& c : contour) {
      double px = c.x0 * s;
      double py = c.y0 * s;
      for (int k = 1; k <= kCurveSteps; ++k) {
        const double t = static_cast<double>(k) / kCurveSteps;
        const double u = 1 - t;
        const double x = (u * u * u * c.x0 + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x1) * s;
        const double y = (u * u * u * c.y0 + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y1) * s;
        add_edge(p, px, py, x, y);
        raise(y);
        px = x;
        py = y;
      }
      raise(c.y0 * s);
    }
  }
  return p;
}

double band_weight(double yEm, double xHeight) {
  if (yEm < 0) return 0.3;
  if (yEm <= xHeight) return 1;
  if (yEm <= xHeight + 0.25) return 0.5;
  return 0.25;
}

struct PairGap {
  double area, dmin;
};

std::optional<PairGap> measure_pair_gap(const Profile& a, double sizeA, const Profile& b, double sizeB, double xHeightEm) {
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

bool is_upper(const std::string& c) { return c != to_lower(c) && c == to_upper(c); }

}  // namespace

OpticalKerner::OpticalKerner(const CanvasOptions& opts, Source source)
    : canvas_(Canvas2D::make(static_cast<std::uint32_t>(kRefEmPx * 4), static_cast<std::uint32_t>(kRefEmPx * 2), opts)),
      source_(source) {}

OpticalKerner::~OpticalKerner() = default;

const OpticalKerner::InkProfile* OpticalKerner::profile(const std::string& css, const std::string& cluster) {
  const std::string key = css + std::string(1, '\0') + cluster;
  const auto hit = profiles_.find(key);
  if (hit != profiles_.end()) return hit->second ? &*hit->second : nullptr;
  if (source_ == Source::outline && canvas_->options().fonts != nullptr) {
    if (const auto font = css::parse_font(css)) {
      if (const auto outline = canvas_->options().fonts->glyph_outline(cluster, *font)) {
        auto& slot = profiles_[key];
        slot = profile_from_outline(*outline);
        return &*slot;
      }
    }
  }
  // defaultRasterizer: the glyph at the reference size, pen (1.5 em, 1.3 em).
  Canvas2D& g = *canvas_;
  const double penX = kRefEmPx * 1.5;
  const double baselineY = kRefEmPx * 1.3;
  g.setTransform({});
  g.clearRect(0, 0, g.width(), g.height());
  (void)g.setFont(css);
  g.setFontKerning(false);
  g.setLetterSpacing(0);
  g.setTextAlign(TextAlign::left);
  g.setTextBaseline(TextBaseline::alphabetic);
  g.setFillStyle(Style{});  // default: opaque black ('#000')
  g.fillText(cluster, penX, baselineY);
  const double advance = g.measureText(cluster).width;
  const auto rgba = g.pixels();
  auto& slot = profiles_[key];
  slot = profile_from_alpha(rgba, g.width(), g.height(), penX, baselineY, kRefEmPx, advance);
  return &*slot;
}

const OpticalKerner::Metrics& OpticalKerner::metrics(const std::string& css) {
  const auto hit = metrics_.find(css);
  if (hit != metrics_.end()) return hit->second;
  const Profile* x = profile(css, "x");
  const double xHeight = x != nullptr && std::isfinite(x->top) ? std::max(0.3, std::min(0.8, x->top)) : kDefaultXHeightEm;
  const auto selfWhite = [&](std::initializer_list<const char*> chars) {
    double sum = 0;
    int n = 0;
    for (const char* c : chars) {
      const Profile* p = profile(css, c);
      const auto gap = p != nullptr ? measure_pair_gap(*p, 1, *p, 1, xHeight) : std::nullopt;
      if (gap) {
        sum += gap->area;
        ++n;
      }
    }
    return n > 0 ? sum / n : kDefaultTargetEm;
  };
  const Metrics m{xHeight, selfWhite({"n", "o"}), selfWhite({"H", "O"})};
  return metrics_.emplace(css, m).first->second;
}

double OpticalKerner::kern_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB,
                              const std::string& b, double sizeB) {
  if (!(sizeA > 0) || !(sizeB > 0) || is_js_blank(a) || is_js_blank(b)) return 0;
  const double ratio = sizeB / sizeA;
  const std::string key = cssA + '\0' + a + '\0' + cssB + '\0' + b + '\0' + std::to_string(ratio);
  const auto hit = pairs_.find(key);
  if (hit != pairs_.end()) return hit->second * sizeA;
  const bool upper = is_upper(a) && is_upper(b);
  const Profile* pa = profile(cssA, a);
  const Profile* pb = profile(cssB, b);
  double em = 0;
  if (pa != nullptr && pb != nullptr) {
    const Metrics& m = metrics(cssA);
    const auto gap = measure_pair_gap(*pa, 1, *pb, ratio, m.xHeight);
    if (gap) em = pair_adjustment(*gap, upper ? m.upper : m.lower, std::min(1.0, ratio));
  }
  pairs_[key] = em;
  return em * sizeA;
}

}  // namespace premation::raster
