// AE parity 5.5: Mesh Warp over a variable mesh, Liquify's painted field and Reshape.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "effects/kernels.hpp"

using namespace premation::effects;

namespace {

/// A vertical edge: black left of `edge`, white from it.
std::vector<std::uint8_t> edge_image(int w, int h, int edge) {
  std::vector<std::uint8_t> px(static_cast<std::size_t>(w * h * 4), 255);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < edge; ++x) {
      const std::size_t i = (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return px;
}
int red(const std::vector<std::uint8_t>& px, int w, int x, int y) {
  return px[(static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4];
}

}  // namespace

TEST_CASE("mesh warp over a variable mesh", "[effects][warp]") {
  const int w = 40, h = 20;
  auto px = edge_image(w, h, 20);
  const auto before = px;
  // 2 × 1 cells: 3 × 2 vertices. A zero mesh, and a wrong-sized one, do nothing.
  std::vector<double> zero(12, 0.0);
  mesh_warp_grid(RgbaView{px, w, h}, 2, 1, zero, nullptr);
  CHECK(px == before);
  std::vector<double> wrong(10, 3.0);
  mesh_warp_grid(RgbaView{px, w, h}, 2, 1, wrong, nullptr);
  CHECK(px == before);
  // Every vertex offset +6 px in x: the edge moves 6 px right.
  std::vector<double> right(12, 0.0);
  for (std::size_t i = 0; i < 12; i += 2) right[i] = 6;
  mesh_warp_grid(RgbaView{px, w, h}, 2, 1, right, nullptr);
  CHECK(red(px, w, 23, 10) == 0);
  CHECK(red(px, w, 27, 10) == 255);
}

TEST_CASE("liquify field shifts by its offsets × amount", "[effects][warp]") {
  const int w = 40, h = 20;
  auto px = edge_image(w, h, 20);
  std::vector<double> field(static_cast<std::size_t>((4 + 1) * (2 + 1) * 2), 0.0);
  for (std::size_t i = 0; i < field.size(); i += 2) field[i] = 8;
  liquify_field(RgbaView{px, w, h}, 4, 2, field, 0.5, nullptr);  // 50 %: 4 px
  CHECK(red(px, w, 22, 10) == 0);
  CHECK(red(px, w, 25, 10) == 255);
  auto same = edge_image(w, h, 20);
  const auto ref = same;
  liquify_field(RgbaView{same, w, h}, 4, 2, field, 0, nullptr);
  CHECK(same == ref);
}

TEST_CASE("reshape morphs the source outline toward the destination", "[effects][warp]") {
  const int w = 60, h = 60;
  auto px = edge_image(w, h, 30);
  // Source: a square around the edge; destination: the same square 10 px right.
  const std::vector<double> xy{20, 20, 40, 20, 40, 40, 20, 40, 30, 20, 50, 20, 50, 40, 30, 40};
  const auto before = px;
  CHECK_FALSE(reshape(RgbaView{px, w, h}, xy, 0, 4, 4, 4, {}, 0, 1, nullptr));
  CHECK(px == before);
  REQUIRE(reshape(RgbaView{px, w, h}, xy, 0, 4, 4, 4, {}, 1, 0, nullptr));
  // Inside the moved square the edge has travelled right; the frame's border holds.
  CHECK(red(px, w, 34, 30) == 0);
  CHECK(red(px, w, 2, 2) == 0);
  CHECK(red(px, w, 58, 58) == 255);
}
