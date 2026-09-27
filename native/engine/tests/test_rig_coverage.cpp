// Image-layer rig coverage (rig_coverage.hpp): an SVG source is drawn by the
// C++ SVG renderer and its alpha read into the coverage mask; a relative path
// resolves against the project folder; a session / remote URL stays
// unreachable (reported by the walk).
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <string>

#include "rig_coverage.hpp"

namespace sc = premation::scene;

namespace {

// The left half of a 64 × 64 box opaque, the right half empty.
constexpr const char* kHalfSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect x='0' y='0' width='32' height='64' fill='black'/></svg>";

bool covered(const premation::scene::rig::CoverageMask& m, int col, int row) {
  return m.cells.at(static_cast<std::size_t>(row) * static_cast<std::size_t>(m.cols) + static_cast<std::size_t>(col)) != 0;
}

}  // namespace

TEST_CASE("rig coverage: an SVG image's alpha is the mask", "[scene][rig][svg]") {
  const std::string src = std::string("data:image/svg+xml,") + kHalfSvg;
  const sc::CoverageLookup got = sc::image_coverage_mask("svg-half", src);
  REQUIRE(got.unreachable.empty());
  REQUIRE(got.mask);
  const auto& m = *got.mask;
  REQUIRE(m.cols > 4);
  REQUIRE(m.rows > 4);
  CHECK(covered(m, 1, m.rows / 2));
  CHECK_FALSE(covered(m, m.cols - 2, m.rows / 2));
}

TEST_CASE("rig coverage: relative paths resolve against the project folder", "[scene][rig]") {
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "premation-rig-coverage";
  std::filesystem::create_directories(dir);
  {
    std::ofstream f(dir / "half.svg", std::ios::binary);
    f << kHalfSvg;
  }
  const sc::CoverageLookup none = sc::image_coverage_mask("rel", "half.svg");
  CHECK_FALSE(none.unreachable.empty());  // no project folder
  const sc::CoverageLookup got = sc::image_coverage_mask("rel", "half.svg", dir);
  CHECK(got.unreachable.empty());
  REQUIRE(got.mask);
  CHECK(covered(*got.mask, 1, got.mask->rows / 2));
  std::filesystem::remove_all(dir);

  CHECK_FALSE(sc::image_coverage_mask("blob", "blob:http://localhost/abc").unreachable.empty());
  CHECK_FALSE(sc::image_coverage_mask("web", "https://example.com/a.png").unreachable.empty());
}
