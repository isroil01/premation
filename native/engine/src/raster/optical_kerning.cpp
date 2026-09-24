#include "optical_kerning.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "fonts.hpp"
#include "paint_common.hpp"
#include "text_unicode.hpp"

namespace premation::raster {
namespace {

using namespace optical;
using Profile = OpticalKerner::InkProfile;

constexpr double kBandH = (kBandTopEm - kBandBottomEm) / kBandCount;

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

bool is_upper(const std::string& c) { return c != to_lower(c) && c == to_upper(c); }

}  // namespace

OpticalKerner::OpticalKerner(const CanvasOptions& opts, Source source)
    : opts_(opts),
      canvas_(Canvas2D::make(static_cast<std::uint32_t>(kRefEmPx * 4), static_cast<std::uint32_t>(kRefEmPx * 2), opts)),
      source_(source),
      vertical_([this](const std::string& css, const std::string& cluster) { return vertical_raster(css, cluster); }) {}

OpticalKerner::~OpticalKerner() = default;

const OpticalKerner::InkProfile* OpticalKerner::profile(const std::string& css, const std::string& cluster) {
  const std::string key = css + std::string(1, '\0') + cluster;
  const auto hit = profiles_.find(key);
  if (hit != profiles_.end()) return hit->second ? &*hit->second : nullptr;
  if (source_ == Source::outline && opts_.fonts != nullptr) {
    if (const auto font = css::parse_font(css)) {
      if (const auto outline = opts_.fonts->glyph_outline(cluster, *font)) {
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

/// opticalKerning.ts defaultVerticalRasterizer: a 2 em square canvas, the
/// cluster centred on a 'middle' baseline, profiled from its alpha.
std::optional<OpticalKerner::InkProfile> OpticalKerner::vertical_raster(const std::string& css, const std::string& cluster) {
  const auto side = static_cast<std::uint32_t>(kRefEmPx * 2);
  if (!verticalCanvas_) verticalCanvas_ = Canvas2D::make(side, side, opts_);
  Canvas2D& g = *verticalCanvas_;
  const double cx = side / 2.0;
  const double cy = side / 2.0;
  g.setTransform({});
  g.clearRect(0, 0, side, side);
  (void)g.setFont(css);
  g.setTextAlign(TextAlign::center);
  g.setTextBaseline(TextBaseline::middle);
  g.setFillStyle(Style{});  // default: opaque black ('#000')
  g.fillText(cluster, cx, cy);
  return vertical_profile_from_alpha(g.pixels(), side, side, cx - kRefEmPx / 2, cy - kRefEmPx / 2, kRefEmPx);
}

double OpticalKerner::kern_vertical_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB,
                                       const std::string& b, double sizeB) {
  return vertical_.kern_px(cssA, a, sizeA, cssB, b, sizeB);
}

}  // namespace premation::raster
