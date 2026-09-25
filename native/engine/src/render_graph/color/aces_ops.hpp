// D3: the OpenColorIO kernels an ACES 1.x output transform is made of, ported
// operation for operation from OCIO 2.5.2 so the colour program runs the
// ACES views exactly instead of through a baked lattice:
//
//   ops/fixedfunction/FixedFunctionOpCPU.cpp  RedMod03 / RedMod10 / Glow03 / Glow10 / DarkToDim10 (forward)
//   ops/gradingrgbcurve/GradingBSplineCurve.cpp  EstimateRGBSlopes, FitRGBSpline, AdjustRGBSlopes,
//                                                computeKnotsAndCoefsForRGBCurve, KnotsCoefs::evalCurve
//
// Float arithmetic in OCIO's order (the lattice it replaces was 1.5e-2 off in
// gamut; these are compared against OCIO's own CPU processor in the tests).
// GPU-free and OCIO-free: the WGSL twins live in shaders/color_wgsl.hpp.
#pragma once

#include <array>
#include <vector>

namespace premation::rg::color::aces {

using Rgb = std::array<float, 3>;

void red_mod_03(Rgb& c) noexcept;
void red_mod_10(Rgb& c) noexcept;
void glow(Rgb& c, float gain, float mid) noexcept;
/// `gammaMinus1`: OCIO stores gamma − 1 (Y^gamma / Y).
void dark_to_dim(Rgb& c, float gammaMinus1) noexcept;

/// One curve's block in Program::curves (see color_program.hpp), evaluated at
/// x: OCIO KnotsCoefs::evalCurve. `offset` < 0 = identity.
[[nodiscard]] float eval_curve(const std::vector<float>& curves, float offset, float x) noexcept;

/// OCIO computeKnotsAndCoefsForRGBCurve's fit (slopes estimated when every
/// user slope is zero, adjusted, refit) → knots and the A, B, C coefficient
/// sets. False when the points cannot form a curve (fewer than two).
bool fit_rgb_curve(const std::vector<float>& x, const std::vector<float>& y, const std::vector<float>& userSlopes,
                   std::vector<float>& knots, std::vector<float>& a, std::vector<float>& b, std::vector<float>& c);

}  // namespace premation::rg::color::aces
