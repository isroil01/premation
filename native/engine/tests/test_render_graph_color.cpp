// D3 colour management + the project bit depth, GPU-free and OCIO-free: the op
// program's CPU twin (the WGSL interpreter's reference) against closed forms,
// and the rule that maps a project bit depth onto intermediate precision.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <vector>

#include "bit_depth.hpp"
#include "color/color_program.hpp"

using namespace premation::rg;
using namespace premation::rg::color;

namespace {

double srgb_decode(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double srgb_encode(double c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1 / 2.4) - 0.055; }

float run1(const Program& p, float v) {
  std::array<float, 3> c{v, v, v};
  evaluate(p, c);
  return c[0];
}

}  // namespace

TEST_CASE("the project bit depth selects the intermediate precision (TS intermediateFloatFormat + 8 bpc)") {
  // Today's default and the golden gate's precision.
  CHECK(select_intermediate({16, true, true, true}) == IntermediatePrecision::float16);
  // 32 needs the producer's float32 AND this device's filter + blend support.
  CHECK(select_intermediate({32, true, true, true}) == IntermediatePrecision::float32);
  CHECK(select_intermediate({32, true, false, true}) == IntermediatePrecision::float16);
  CHECK(select_intermediate({32, true, true, false}) == IntermediatePrecision::float16);
  // 8 bpc, or a producer with no float16 render targets: unorm8.
  CHECK(select_intermediate({8, true, true, true}) == IntermediatePrecision::unorm8);
  CHECK(select_intermediate({16, false, true, true}) == IntermediatePrecision::unorm8);
  CHECK(bits_of(IntermediatePrecision::float32) == 32);
  CHECK(bits_of(IntermediatePrecision::unorm8) == 8);
}

TEST_CASE("OCIO's moncurve with gamma 2.4 / offset 0.055 IS the sRGB curve, both directions") {
  Program decode;
  decode.ops.push_back(moncurve_op({2.4, 2.4, 2.4}, {0.055, 0.055, 0.055}, true, Negative::linear));
  Program encode;
  encode.ops.push_back(moncurve_op({2.4, 2.4, 2.4}, {0.055, 0.055, 0.055}, false, Negative::linear));
  double worstDecode = 0;
  double worstEncode = 0;
  double worstRoundTrip = 0;
  for (int i = 0; i <= 1000; ++i) {
    const double x = i / 1000.0;
    worstDecode = std::max(worstDecode, std::abs(run1(decode, static_cast<float>(x)) - srgb_decode(x)));
    worstEncode = std::max(worstEncode, std::abs(run1(encode, static_cast<float>(x)) - srgb_encode(x)));
    worstRoundTrip = std::max(worstRoundTrip, std::abs(run1(encode, run1(decode, static_cast<float>(x))) - x));
  }
  // OCIO derives the toe from gamma + offset so line and power meet with equal
  // slope (break 0.0030399 linear / 0.0392857 encoded); IEC 61966-2-1 rounds
  // them to 0.0031308 / 0.04045, so the two curves differ by < 1e-5 in the gap
  // between the breaks — a real (tiny) difference, not an error.
  CHECK(worstDecode < 2e-6);
  CHECK(worstEncode < 2e-5);
  CHECK(worstRoundTrip < 2e-6);
  // Negative style "linear": the toe extends below zero.
  CHECK(run1(decode, -0.02F) == Catch::Approx(-0.02 / 12.923210).epsilon(1e-4));
}

TEST_CASE("exponent negative styles: clamp, mirror, pass-thru") {
  Program clamp;
  clamp.ops.push_back(exponent_op({2.4, 2.4, 2.4}, Negative::clamp));
  Program mirror;
  mirror.ops.push_back(exponent_op({2.4, 2.4, 2.4}, Negative::mirror));
  Program pass;
  pass.ops.push_back(exponent_op({2.4, 2.4, 2.4}, Negative::pass_thru));
  CHECK(run1(clamp, 0.5F) == Catch::Approx(std::pow(0.5, 2.4)).epsilon(1e-6));
  CHECK(run1(clamp, -0.5F) == 0.0F);
  CHECK(run1(mirror, -0.5F) == Catch::Approx(-std::pow(0.5, 2.4)).epsilon(1e-6));
  CHECK(run1(pass, -0.5F) == -0.5F);
  // HDR values go through a pure power untouched by any clamp.
  CHECK(run1(clamp, 4.0F) == Catch::Approx(std::pow(4.0, 2.4)).epsilon(1e-6));
}

TEST_CASE("matrix and range ops; programs chain in order") {
  Program p;
  p.ops.push_back(matrix_op({2, 0, 0, 0, 1, 0, 0, 0, 0.5}, {0.1, 0, 0}));
  p.ops.push_back(range_op(1, 0, 0, 1));  // clamp to [0, 1]
  std::array<float, 3> c{0.3F, 2.0F, 0.4F};
  evaluate(p, c);
  CHECK(c[0] == Catch::Approx(0.7));
  CHECK(c[1] == 1.0F);  // clamped
  CHECK(c[2] == Catch::Approx(0.2));
  // An open range never clamps (±infinity as ±FLT_MAX in the uniforms).
  Program open;
  open.ops.push_back(range_op(2, 1, -std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()));
  CHECK(run1(open, 100.0F) == 201.0F);
}

TEST_CASE("a baked lattice reproduces its reference at the lattice points and interpolates between") {
  // Reference: the power part of the sRGB encode, x^(1/2.4), unclamped (a clamp
  // would put a kink inside a cell), through the log2 shaper the bake uses.
  const Shaper shaper{true, -12.0, 6.0};
  const auto power = [](double v) { return std::pow(v, 1 / 2.4); };
  const Program lut = bake_lut(shaper, 33, [&](std::span<float> rgb) {
    for (float& v : rgb) v = static_cast<float>(power(static_cast<double>(v)));
  });
  REQUIRE(lut.baked());
  REQUIRE(lut.ops.size() == 1);
  REQUIRE(lut.lut.size() == std::size_t{33} * 33 * 33 * 4);
  // At a lattice point: exact (up to the shaper's float round trip).
  const auto x = static_cast<float>(unshape(shaper, 20.0 / 32.0));
  CHECK(std::abs(run1(lut, x) - power(static_cast<double>(x))) < 1e-5);
  // Between points: in log2 space a power curve is an exponential, which a
  // trilinear cell of 18/32 stop follows to ~1e-3 of the value.
  double worst = 0;
  for (int i = 1; i < 200; ++i) {
    const double v = i / 200.0;
    worst = std::max(worst, std::abs(run1(lut, static_cast<float>(v)) - power(v)) / power(v));
  }
  CHECK(worst < 5e-3);
  // Below the shaper floor everything reads the first sample.
  CHECK(run1(lut, 0.0F) == run1(lut, static_cast<float>(std::exp2(-12.0))));
}

TEST_CASE("pack lays out 8 ops of 24 floats: header (type, negative style, lattice N) + 5 rows") {
  Program p;
  p.ops.push_back(matrix_op({1, 2, 3, 4, 5, 6, 7, 8, 9}, {10, 11, 12}));
  p.ops.push_back(exponent_op({2, 3, 4}, Negative::mirror));
  std::vector<float> out;
  pack(p, out);
  REQUIRE(out.size() == kMaxOps * kOpFloats);
  CHECK(out[0] == 1.0F);   // matrix
  CHECK(out[4] == 1.0F);   // row 0
  CHECK(out[7] == 10.0F);  // offset 0
  CHECK(out[24] == 2.0F);  // exponent
  CHECK(out[25] == 1.0F);  // mirror
  CHECK(out[28] == 2.0F);  // gamma r
  CHECK(out[48] == 0.0F);  // unused op = none
}

TEST_CASE("OCIO's ACEScg primaries agree with the TS renderer's linear Rec.709 → AP1 matrix") {
  // colorPipeline.ts / rg_math.hpp to_working carry these constants; the
  // colour-managed path derives them from the CG config's AP0 matrices.
  const auto m = from_linear_rec709(Space::aces_cg);
  const std::array<double, 9> ts = {0.613097396, 0.339523469, 0.047379562, 0.070194066, 0.916353879,
                                    0.013452032, 0.020615588, 0.109569769, 0.869814633};
  for (std::size_t i = 0; i < 9; ++i) CHECK(m.at(i) == Catch::Approx(ts.at(i)).margin(2e-6));
  // Rows of a white-preserving primaries matrix sum to 1.
  for (const Space s : {Space::aces_cg, Space::linear_rec2020, Space::aces2065}) {
    const auto k = from_linear_rec709(s);
    for (std::size_t r = 0; r < 3; ++r) CHECK(k.at(r * 3) + k.at(r * 3 + 1) + k.at(r * 3 + 2) == Catch::Approx(1.0).margin(1e-6));
  }
}
