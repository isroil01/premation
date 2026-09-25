#include "aces_ops.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace premation::rg::color::aces {
namespace {

constexpr float kNoiseLimit = 1e-2F;

/// FixedFunctionOpCPU CalcHueWeight: a quadratic B-spline window over the hue
/// angle, centred on red.
float hue_weight(float red, float grn, float blu, float invWidth) noexcept {
  const float a = 2.F * red - (grn + blu);
  constexpr float kSqrt3 = 1.7320508075688772F;
  const float b = kSqrt3 * (grn - blu);
  const float hue = std::atan2(b, a);
  const float knotCoord = hue * invWidth + 2.F;
  const int j = static_cast<int>(knotCoord);  // truncation, as OCIO's (int) cast
  static constexpr std::array<std::array<float, 4>, 4> kM = {{
      {0.25F, 0.00F, 0.00F, 0.00F},
      {-0.75F, 0.75F, 0.75F, 0.25F},
      {0.75F, -1.50F, 0.00F, 1.00F},
      {-0.25F, 0.75F, -0.75F, 0.25F},
  }};
  if (j < 0 || j >= 4) return 0.F;
  const float t = knotCoord - static_cast<float>(j);
  const auto& coefs = kM.at(static_cast<std::size_t>(j));
  return coefs[3] + t * (coefs[2] + t * (coefs[1] + t * coefs[0]));
}

/// CalcSatWeight.
float sat_weight(float red, float grn, float blu) noexcept {
  const float minVal = std::min(red, std::min(grn, blu));
  const float maxVal = std::max(red, std::max(grn, blu));
  return (std::max(1e-10F, maxVal) - std::max(1e-10F, minVal)) / std::max(kNoiseLimit, maxVal);
}

}  // namespace

void red_mod_03(Rgb& c) noexcept {
  constexpr float kOneMinusScale = 1.F - 0.85F;
  constexpr float kPivot = 0.03F;
  constexpr float kInvWidth = 1.9098593171027443F;
  float red = c[0];
  float grn = c[1];
  float blu = c[2];
  const float fH = hue_weight(red, grn, blu, kInvWidth);
  if (fH > 0.F) {
    const float fS = sat_weight(red, grn, blu);
    const float newRed = red + fH * fS * (kPivot - red) * kOneMinusScale;
    // Restore hue.
    if (grn >= blu) {
      const float hueFac = (grn - blu) / std::max(1e-10F, red - blu);
      grn = hueFac * (newRed - blu) + blu;
    } else {
      const float hueFac = (blu - grn) / std::max(1e-10F, red - grn);
      blu = hueFac * (newRed - grn) + grn;
    }
    red = newRed;
  }
  c = {red, grn, blu};
}

void red_mod_10(Rgb& c) noexcept {
  constexpr float kOneMinusScale = 1.F - 0.82F;
  constexpr float kPivot = 0.03F;
  constexpr float kInvWidth = 1.6976527263135504F;
  const float red = c[0];
  const float fH = hue_weight(red, c[1], c[2], kInvWidth);
  if (fH > 0.F) {
    const float fS = sat_weight(red, c[1], c[2]);
    c[0] = red + fH * fS * (kPivot - red) * kOneMinusScale;
  }
}

void glow(Rgb& c, float gain, float mid) noexcept {
  const float red = c[0];
  const float grn = c[1];
  const float blu = c[2];
  // rgbToYC
  constexpr float kYCRadiusWeight = 1.75F;
  const float chroma = std::sqrt(blu * (blu - grn) + grn * (grn - red) + red * (red - blu));
  const float yc = (blu + grn + red + kYCRadiusWeight * chroma) / 3.F;
  const float sat = sat_weight(red, grn, blu);
  // SigmoidShaper
  const float x = (sat - 0.4F) * 5.F;
  const float sign = std::copysign(1.F, x);
  const float t = std::max(0.F, 1.F - 0.5F * sign * x);
  const float s = (1.F + sign * (1.F - t * t)) * 0.5F;
  const float glowGain = gain * s;
  float glowGainOut = 0.F;
  if (yc >= mid * 2.F) {
    glowGainOut = 0.F;
  } else if (yc <= mid * 2.F / 3.F) {
    glowGainOut = glowGain;
  } else {
    glowGainOut = glowGain * (mid / yc - 0.5F);
  }
  const float added = 1.F + glowGainOut;
  c = {red * added, grn * added, blu * added};
}

void dark_to_dim(Rgb& c, float gammaMinus1) noexcept {
  constexpr float kMinLum = 1e-10F;
  // Luminance assuming AP1 RGB.
  const float y = std::max(kMinLum, (0.27222871678091454F * c[0] + 0.67408176581114831F * c[1] + 0.053689517407937051F * c[2]));
  const float ypowOverY = std::pow(y, gammaMinus1);
  c = {c[0] * ypowOverY, c[1] * ypowOverY, c[2] * ypowOverY};
}

// ── GradingBSplineCurve (RGB curves) ───────────────────────────────────────

namespace {

void estimate_rgb_slopes(const std::vector<float>& px, const std::vector<float>& py, std::vector<float>& slopes) {
  std::vector<float> secantSlope;
  std::vector<float> secantLen;
  const std::size_t n = px.size();
  for (std::size_t i = 0; i < n - 1; ++i) {
    const float dx = px[i + 1] - px[i];
    const float dy = py[i + 1] - py[i];
    secantSlope.push_back(dy / dx);
    secantLen.push_back(std::sqrt(dx * dx + dy * dy));
  }
  if (n == 2) {
    slopes.push_back(secantSlope[0]);
    slopes.push_back(secantSlope[0]);
    return;
  }
  std::size_t i = 0;
  while (true) {
    std::size_t j = i;
    float dl = secantLen[i];
    while ((j < n - 2) && (std::fabs(secantSlope[j + 1] - secantSlope[j]) < 1e-6F)) {
      dl += secantLen[j + 1];
      j++;
    }
    for (std::size_t k = i; k <= j; ++k) secantLen[k] = dl;
    if (j >= n - 3) break;
    i = j + 1;
  }
  slopes.push_back(0.F);
  for (std::size_t k = 1; k < n - 1; ++k) {
    const float s = (secantLen[k] * secantSlope[k] + secantLen[k - 1] * secantSlope[k - 1]) / (secantLen[k] + secantLen[k - 1]);
    slopes.push_back(s);
  }
  slopes.push_back(std::max(0.01F, 0.5F * (3.F * secantSlope[n - 2] - slopes[n - 2])));
  slopes[0] = std::max(0.01F, 0.5F * (3.F * secantSlope[0] - slopes[1]));
}

void fit_rgb_spline(const std::vector<float>& px, const std::vector<float>& py, const std::vector<float>& slopes,
                    std::vector<float>& knots, std::vector<float>& a, std::vector<float>& b, std::vector<float>& c) {
  const std::size_t n = px.size();
  knots.push_back(px[0]);
  for (std::size_t i = 0; i < n - 1; ++i) {
    const float xi = px[i];
    const float xi1 = px[i + 1];
    const float yi = py[i];
    const float yi1 = py[i + 1];
    const float dx = xi1 - xi;
    const float dy = yi1 - yi;
    const float secant = dy / dx;
    if (std::fabs((slopes[i] + slopes[i + 1]) - 2.F * secant) < 1e-6F) {
      c.push_back(yi);
      b.push_back(slopes[i]);
      a.push_back(0.5F * (slopes[i + 1] - slopes[i]) / dx);
    } else {
      float ksi = 0.F;
      const float aa = slopes[i] - secant;
      const float bb = slopes[i + 1] - secant;
      if (aa * bb >= 0.F) {
        ksi = (xi + xi1) * 0.5F;
      } else if (std::fabs(aa) > std::fabs(bb)) {
        ksi = xi1 + aa * dx / (slopes[i + 1] - slopes[i]);
      } else {
        ksi = xi + bb * dx / (slopes[i + 1] - slopes[i]);
      }
      const float sBar = (2.F * secant - slopes[i + 1]) + (slopes[i + 1] - slopes[i]) * (ksi - xi) / dx;
      const float eta = (sBar - slopes[i]) / (ksi - xi);
      c.push_back(yi);
      b.push_back(slopes[i]);
      a.push_back(0.5F * eta);
      c.push_back(yi + slopes[i] * (ksi - xi) + 0.5F * eta * (ksi - xi) * (ksi - xi));
      b.push_back(sBar);
      a.push_back(0.5F * (slopes[i + 1] - sBar) / (xi1 - ksi));
      knots.push_back(ksi);
    }
    knots.push_back(xi1);
  }
}

bool adjust_rgb_slopes(const std::vector<float>& px, const std::vector<float>& py, std::vector<float>& slopes,
                       const std::vector<float>& knots) {
  bool adjusted = false;
  std::size_t i = 0;
  std::size_t j = 0;
  const std::size_t n = knots.size();
  while (j < n) {
    if (px[i] != knots[j]) {
      const float ksi = knots[j];
      const float xi = px[i];
      const float xi1 = px[i + 1];
      const float yi = py[i];
      const float yi1 = py[i + 1];
      const float sBar = (2.F * (yi1 - yi) - (ksi - xi) * slopes[i] - (xi1 - ksi) * slopes[i + 1]) / (xi1 - xi);
      if (sBar < 0.F) {
        adjusted = true;
        const float secant = (yi1 - yi) / (xi1 - xi);
        const float blendSlope = ((ksi - xi) * slopes[i] + (xi1 - ksi) * slopes[i + 1]) / (xi1 - xi);
        float aimSlope = 0.01F * 0.5F * (slopes[i] + slopes[i + 1]);
        if (aimSlope > secant) aimSlope = secant;
        const float adjust = (2.F * secant - aimSlope) / blendSlope;
        slopes[i] = slopes[i] * adjust;
        slopes[i + 1] = slopes[i + 1] * adjust;
      }
      i++;
    }
    j++;
  }
  return adjusted;
}

}  // namespace

bool fit_rgb_curve(const std::vector<float>& x, const std::vector<float>& y, const std::vector<float>& userSlopes,
                   std::vector<float>& knots, std::vector<float>& a, std::vector<float>& b, std::vector<float>& c) {
  if (x.size() < 2 || x.size() != y.size()) return false;
  std::vector<float> slopes;
  const bool defaultSlopes = std::ranges::all_of(userSlopes, [](float s) { return s == 0.F; });
  if (!defaultSlopes && userSlopes.size() == x.size()) {
    slopes = userSlopes;
  } else {
    estimate_rgb_slopes(x, y, slopes);
  }
  fit_rgb_spline(x, y, slopes, knots, a, b, c);
  if (adjust_rgb_slopes(x, y, slopes, knots)) {
    knots.clear();
    a.clear();
    b.clear();
    c.clear();
    fit_rgb_spline(x, y, slopes, knots, a, b, c);
  }
  return true;
}

float eval_curve(const std::vector<float>& curves, float offset, float x) noexcept {
  if (offset < 0.F) return x;
  const auto o = static_cast<std::size_t>(offset);
  if (o + 2 > curves.size()) return x;
  const auto knotsCnt = static_cast<std::size_t>(curves[o]);
  const auto sets = static_cast<std::size_t>(curves[o + 1]);
  if (sets == 0 || knotsCnt < 2 || o + 2 + knotsCnt + 3 * sets > curves.size()) return x;
  const std::size_t kn = o + 2;               // knots
  const std::size_t ca = kn + knotsCnt;       // A[sets]
  const std::size_t cb = ca + sets;           // B[sets]
  const std::size_t cc = cb + sets;           // C[sets]
  const float knStart = curves[kn];
  const float knEnd = curves[kn + knotsCnt - 1];
  if (x <= knStart) {
    return (x - knStart) * curves[cb] + curves[cc];
  }
  if (x >= knEnd) {
    const float aa = curves[ca + sets - 1];
    const float bb = curves[cb + sets - 1];
    const float cc2 = curves[cc + sets - 1];
    const float k = curves[kn + knotsCnt - 2];
    const float t = knEnd - k;
    const float slope = 2.F * aa * t + bb;
    const float offs = (aa * t + bb) * t + cc2;
    return (x - knEnd) * slope + offs;
  }
  std::size_t i = 0;
  for (; i < knotsCnt - 2; ++i) {
    if (x < curves[kn + i + 1]) break;
  }
  const float t = x - curves[kn + i];
  return (curves[ca + i] * t + curves[cb + i]) * t + curves[cc + i];
}

}  // namespace premation::rg::color::aces
