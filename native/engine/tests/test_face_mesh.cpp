// AE parity 3.3: face tracking's crop maths and smoothing (the model has its own runtime).

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "jobs/face_mesh.hpp"

namespace fm = premation::jobs::face;

TEST_CASE("a crop maps back onto the frame through its rotation", "[jobs][face]") {
  const fm::Roi roi{fm::P2{300, 200}, 192 * 2, 0.3};
  const fm::P2 centre = fm::crop_to_frame(roi, fm::P2{96, 96});
  CHECK(std::abs(centre.x - 300) < 1e-9);
  CHECK(std::abs(centre.y - 200) < 1e-9);
  const fm::P2 right = fm::crop_to_frame(roi, fm::P2{192, 96});
  CHECK(std::abs(std::hypot(right.x - 300, right.y - 200) - 192) < 1e-6);
  CHECK(std::abs(std::atan2(right.y - 200, right.x - 300) - 0.3) < 1e-9);
}

TEST_CASE("the next crop is level with the eyes and covers the face", "[jobs][face]") {
  std::vector<fm::P2> lm(fm::kLandmarks);
  // A face 100 px wide around (500, 300), tilted 20°.
  const double a = 20 * 3.14159265358979323846 / 180;
  for (std::size_t i = 0; i < lm.size(); ++i) {
    const double u = std::cos(static_cast<double>(i) * 0.7) * 50;
    const double v = std::sin(static_cast<double>(i) * 0.7) * 60;
    lm[i] = fm::P2{500 + std::cos(a) * u - std::sin(a) * v, 300 + std::sin(a) * u + std::cos(a) * v};
  }
  for (const int i : fm::kRightEye) lm[static_cast<std::size_t>(i)] = fm::P2{500 + std::cos(a) * -25 - std::sin(a) * -10, 300 + std::sin(a) * -25 + std::cos(a) * -10};
  for (const int i : fm::kLeftEye) lm[static_cast<std::size_t>(i)] = fm::P2{500 + std::cos(a) * 25 - std::sin(a) * -10, 300 + std::sin(a) * 25 + std::cos(a) * -10};
  const fm::Roi r = fm::roi_from_landmarks(lm);
  CHECK(std::abs(r.angle - a) < 1e-6);
  CHECK(r.side > 120 * 1.5);
  CHECK(std::abs(r.centre.x - 500) < 6);
  CHECK(std::abs(r.centre.y - 300) < 6);
}

TEST_CASE("the first crop is the mask's box grown", "[jobs][face]") {
  const std::vector<fm::P2> outline{{100, 100}, {200, 100}, {200, 240}, {100, 240}};
  const fm::Roi r = fm::roi_from_outline(outline);
  CHECK(r.centre.x == 150);
  CHECK(r.centre.y == 170);
  CHECK(std::abs(r.side - 140 * 1.25) < 1e-9);
}

TEST_CASE("the One Euro filter steadies a still face and follows a moving one", "[jobs][face]") {
  fm::OneEuro f(1.0, 0.05);
  std::vector<fm::P2> p{{100, 100}};
  (void)f.filter(p, 0);
  double maxJitter = 0;
  for (int k = 1; k < 30; ++k) {
    std::vector<fm::P2> noisy{{100 + ((k % 2) ? 1.5 : -1.5), 100}};
    maxJitter = std::max(maxJitter, std::abs(f.filter(noisy, 1.0 / 30)[0].x - 100));
  }
  CHECK(maxJitter < 1.0);
  fm::OneEuro g(1.0, 0.05);
  (void)g.filter(p, 0);
  double x = 100;
  for (int k = 1; k < 30; ++k) {
    std::vector<fm::P2> moving{{100 + 20.0 * k, 100}};
    x = g.filter(moving, 1.0 / 30)[0].x;
  }
  CHECK(std::abs(x - (100 + 20.0 * 29)) < 40);  // lags little at speed
}

TEST_CASE("a crop samples the frame inside the rotated square", "[jobs][face]") {
  const int W = 400;
  const int H = 300;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W * H * 4), 0);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) rgba[static_cast<std::size_t>((y * W + x) * 4)] = x < 200 ? 255 : 0;
  const std::vector<float> c = fm::crop(rgba, W, H, fm::Roi{fm::P2{200, 150}, 192, 0}, false);
  CHECK(c[(96 * 192 + 40) * 3] > 0.99f);   // left half: red
  CHECK(c[(96 * 192 + 150) * 3] < 0.01f);  // right half: none
  const std::vector<float> planar = fm::crop(rgba, W, H, fm::Roi{fm::P2{200, 150}, 192, 0}, true);
  CHECK(planar[96 * 192 + 40] > 0.99f);
}
