// Footage colour spaces under colour management (render_graph/color): Display
// P3, Rec.2100 PQ / HLG at the white levels the HDR export writes, ACEScct and
// the camera log encodings through OCIO's studio config — each against a
// published reference value, and the GPU op program against OCIO's CPU.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "color/color_program.hpp"
#include "color/color_system.hpp"
#include "color/ocio_ffi.hpp"

using namespace premation::rg;
using Catch::Approx;

namespace {

/// SMPTE ST 2084 inverse EOTF: absolute luminance (nits) → PQ signal.
double pq_encode(double nits) {
  constexpr double m1 = 2610.0 / 16384.0;
  constexpr double m2 = 2523.0 / 4096.0 * 128.0;
  constexpr double c1 = 3424.0 / 4096.0;
  constexpr double c2 = 2413.0 / 4096.0 * 32.0;
  constexpr double c3 = 2392.0 / 4096.0 * 32.0;
  const double y = std::pow(nits / 10000.0, m1);
  return std::pow((c1 + c2 * y) / (1.0 + c3 * y), m2);
}

std::vector<float> convert(const color::Ocio& ocio, color::Space src, color::Space dst, std::vector<float> rgb) {
  std::string err;
  color::Request req;
  req.src = src;
  req.dst = dst;
  INFO(err);
  REQUIRE(ocio.apply_cpu(req, rgb, err));
  return rgb;
}

}  // namespace

TEST_CASE("HDR footage: PQ 203 nits and HLG 75 % land on working-space 1.0 (the HDR export's white)", "[color][hdr]") {
  if (!ColorSystem::available()) return;
  std::string err;
  const auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  const float white = static_cast<float>(pq_encode(203));
  auto pq = convert(*ocio, color::Space::rec2100_pq, color::Space::linear_rec2020, {white, white, white});
  CHECK(pq[0] == Approx(1.0).margin(2e-3));
  // 1000 nits is ~4.93× reference white: highlights stay above 1.0.
  const float bright = static_cast<float>(pq_encode(1000));
  CHECK(convert(*ocio, color::Space::rec2100_pq, color::Space::linear_rec2020, {bright, bright, bright})[0] ==
        Approx(1000.0 / 203.0).epsilon(5e-3));
  auto hlg = convert(*ocio, color::Space::rec2100_hlg, color::Space::linear_rec2020, {0.75F, 0.75F, 0.75F});
  CHECK(hlg[0] == Approx(1.0).margin(2e-3));
  // HLG's lower half is the square law: E' = sqrt(3E) → 0.5 is E = 1/12.
  CHECK(convert(*ocio, color::Space::rec2100_hlg, color::Space::linear_rec2020, {0.5F, 0.5F, 0.5F})[0] ==
        Approx((1.0 / 12.0) / 0.26496255).epsilon(5e-3));
}

TEST_CASE("Display P3: white is white, its red is outside sRGB", "[color][p3]") {
  if (!ColorSystem::available()) return;
  std::string err;
  const auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  auto w = convert(*ocio, color::Space::display_p3, color::Space::linear_srgb, {1, 1, 1});
  CHECK(w[0] == Approx(1.0).margin(1e-3));
  CHECK(w[1] == Approx(1.0).margin(1e-3));
  CHECK(w[2] == Approx(1.0).margin(1e-3));
  // P3-D65 red in linear Rec.709: (1.2249, −0.0420, −0.0196) — the published matrix.
  auto r = convert(*ocio, color::Space::linear_display_p3, color::Space::linear_srgb, {1, 0, 0});
  CHECK(r[0] == Approx(1.2249).margin(2e-3));
  CHECK(r[1] == Approx(-0.0420).margin(2e-3));
  CHECK(r[2] == Approx(-0.0196).margin(2e-3));
  // And back.
  auto back = convert(*ocio, color::Space::linear_srgb, color::Space::linear_display_p3, r);
  CHECK(back[0] == Approx(1.0).margin(1e-3));
}

TEST_CASE("Camera log footage: each encoding's 18 % grey code decodes to 0.18", "[color][log]") {
  if (!ColorSystem::available()) return;
  std::string err;
  const auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  struct Grey {
    color::Space space;
    double code;  // the manufacturer's published 18 % grey signal (full range)
    const char* name;
  };
  const Grey greys[] = {
      {color::Space::arri_logc3, 0.391007, "ARRI LogC3 EI800"},
      {color::Space::arri_logc4, 0.278396, "ARRI LogC4"},
      {color::Space::slog3_sgamut3, 420.0 / 1023.0, "Sony S-Log3"},
      {color::Space::vlog_vgamut, 0.423311, "Panasonic V-Log"},
      {color::Space::aces_cct, 0.4135884, "ACEScct"},
  };
  for (const Grey& g : greys) {
    INFO(g.name);
    // Neutral grey stays neutral through any gamut: compare in ACEScg (no white-point shift).
    const auto c = static_cast<float>(g.code);
    const auto v = convert(*ocio, g.space, color::Space::aces_cg, {c, c, c});
    CHECK(v[0] == Approx(0.18).epsilon(0.01));
    CHECK(v[1] == Approx(0.18).epsilon(0.01));
    CHECK(v[2] == Approx(0.18).epsilon(0.01));
  }
  // A camera encoding is only ever an input.
  color::Request bad;
  bad.src = color::Space::linear_srgb;
  bad.dst = color::Space::arri_logc3;
  std::vector<float> px{0.5F, 0.5F, 0.5F};
  CHECK_FALSE(ocio->apply_cpu(bad, px, err));
}

TEST_CASE("The GPU program for the new inputs matches OCIO's CPU (ops or a baked lattice)", "[color][program]") {
  if (!ColorSystem::available()) return;
  std::string err;
  const auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  for (const color::Space src : {color::Space::display_p3, color::Space::rec2100_pq, color::Space::rec2100_hlg, color::Space::arri_logc3,
                                 color::Space::slog3_sgamut3_cine, color::Space::apple_log, color::Space::aces_cct}) {
    INFO(static_cast<int>(src));
    color::Request req;
    req.src = src;
    req.dst = color::Space::linear_srgb;
    color::Program prog;
    REQUIRE(ocio->program(req, prog, err));
    std::vector<float> ref;
    for (int i = 0; i <= 10; ++i) {
      const float v = static_cast<float>(i) / 10.0F;
      ref.insert(ref.end(), {v, v * 0.7F, 1.0F - v});
    }
    std::vector<float> ours = ref;
    REQUIRE(ocio->apply_cpu(req, ref, err));
    color::evaluate(prog, ours);
    double worst = 0;
    for (std::size_t i = 0; i < ref.size(); ++i) {
      const double scale = std::max(1.0, std::abs(static_cast<double>(ref[i])));
      worst = std::max(worst, std::abs(static_cast<double>(ours[i]) - ref[i]) / scale);
    }
    INFO("worst relative error " << worst << (prog.baked() ? " (baked lattice)" : " (ops)"));
    CHECK(worst < 0.02);
  }
}
