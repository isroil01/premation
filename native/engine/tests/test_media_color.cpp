// E1 colour: the Y'CbCr → R'G'B' matrices (yuv.cpp, which the GPU pass and
// its CPU twin share) against ffmpeg's swscale, per matrix (BT.601 / 709 /
// 2020 / FCC / 240M), range (limited / full) and bit depth (8 / 10 / 12 / 16).
// Each case also proves it can tell: the WRONG matrix and the WRONG range are
// measured against the same reference and must miss by far more than the
// tolerance, so a matrix or range mix-up can't pass.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <string>

#include "swscale_ref_ffi.hpp"
#include "yuv.hpp"

using namespace premation::media;

namespace {

swsref::Yuv444 grid(std::uint8_t depth, Range r) { return swsref::code_grid(depth, r); }

FrameFormat format_of(std::uint8_t depth, Matrix m, Range r) {
  FrameFormat f;
  f.layout = Layout::planarYuv;
  f.bitDepth = depth;
  f.bytesPerSample = depth > 8 ? 2 : 1;
  f.chromaShiftX = 0;
  f.chromaShiftY = 0;
  f.matrix = m;
  f.range = r;
  return f;
}

/// Worst |twin − reference| over the grid, converting with (m, r).
double worst_vs(const swsref::Yuv444& img, const std::vector<double>& ref, Matrix m, Range r, std::string* where = nullptr) {
  const YuvToRgb c = yuv_to_rgb(format_of(img.bitDepth, m, r));
  double worst = 0;
  for (std::size_t i = 0; i < img.y.size(); ++i) {
    const auto o = convert_codes(c, img.y[i], img.cb[i], img.cr[i], 0, false);
    for (std::size_t k = 0; k < 3; ++k) {
      const double e = std::abs(o.at(k) - ref.at(i * 3 + k));
      if (e > worst && where != nullptr) {
        *where = "Y'CbCr (" + std::to_string(img.y[i]) + ", " + std::to_string(img.cb[i]) + ", " + std::to_string(img.cr[i]) + ") channel " +
                 std::to_string(k) + ": ours " + std::to_string(o.at(k)) + ", swscale " + std::to_string(ref.at(i * 3 + k));
      }
      worst = std::max(worst, e);
    }
  }
  return worst;
}

}  // namespace

TEST_CASE("Y'CbCr matrices match swscale: every matrix x range x depth, and a mix-up cannot pass", "[media][yuv][color]") {
  // swscale is the looser side: its fixed-point output tops out ~1/256 short of
  // white (measured: 10-bit limited Y'CbCr (940, 512, 64) → B = 0.99616 where
  // H.273 gives exactly 1.0, since Cb is neutral and Y' is nominal white; 8-bit
  // full range Y' 255 → 0.9961). Everywhere else the two agree to ~1e-4. So
  // the tolerance is one 8-bit step — and the WRONG matrix / range must still
  // miss by 8× that.
  constexpr double kTolerance = 4.5e-3;
  for (const Matrix m : {Matrix::bt709, Matrix::smpte170m, Matrix::bt2020nc, Matrix::fcc, Matrix::smpte240m}) {
    for (const Range r : {Range::limited, Range::full}) {
      for (const std::uint8_t depth : {std::uint8_t{8}, std::uint8_t{10}, std::uint8_t{12}, std::uint8_t{16}}) {
        const swsref::Yuv444 img = grid(depth, r);
        std::vector<double> ref;
        std::string error;
        REQUIRE(swsref::to_rgb(img, m, r, ref, error));
        std::string where;
        const double worst = worst_vs(img, ref, m, r, &where);
        // The confusable neighbour: 601 ↔ 709 (240M sits within 0.015 of 709, so it is checked against 601).
        const Matrix wrongM = m == Matrix::bt709 || m == Matrix::smpte240m ? Matrix::smpte170m : Matrix::bt709;
        const double wrongMatrix = worst_vs(img, ref, wrongM, r);
        const double wrongRange = worst_vs(img, ref, m, r == Range::full ? Range::limited : Range::full);
        INFO("matrix " << static_cast<int>(m) << " range " << static_cast<int>(r) << " depth " << int{depth} << ": worst " << worst
                       << " at " << where << ", wrong matrix " << wrongMatrix << ", wrong range " << wrongRange);
        CHECK(worst < kTolerance);
        CHECK(wrongMatrix > 8 * kTolerance);
        CHECK(wrongRange > 8 * kTolerance);
      }
    }
  }
}
