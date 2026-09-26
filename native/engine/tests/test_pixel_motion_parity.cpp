// Pixel Motion + deinterlace parity (tests/data/pixel_motion_parity.json,
// written by src/core/rendering/pixelMotionCrossEngine.test.ts): the integer
// luma, the flow field float for float, every warped frame byte for byte (FNV
// of the output plus its first 64 bytes), and deinterlaced frames.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "json.hpp"
#include "native_effects.hpp"
#include "pixel_motion.hpp"

namespace pm = premation::scene::pixmo;
using premation::js::Json;

namespace {

std::string fnv32(const std::uint8_t* p, std::size_t n) {
  std::uint32_t h = 0x811c9dc5U;
  for (std::size_t i = 0; i < n; ++i) h = (h ^ p[i]) * 0x01000193U;
  std::array<char, 9> buf{};
  std::snprintf(buf.data(), buf.size(), "%08x", h);
  return std::string(buf.data());
}

std::vector<std::uint8_t> bytes_of(const Json& b64) {
  const auto v = premation::doc::native_unbase64(b64.str());
  REQUIRE(v.has_value());
  return *v;
}

int int_of(const Json& v) { return static_cast<int>(v.num()); }

}  // namespace

TEST_CASE("pixel motion parity: flow, warp and deinterlace equal the editor's", "[scene][pixmo][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/pixel_motion_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("pixel_motion_parity.json not generated yet (GEN_NATIVE_PIXMO=1 npx jest pixelMotionCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());

  for (const Json& c : fixture->at("flows").arr()) {
    INFO(c.at("name").str());
    const int w = int_of(c.at("w"));
    const int h = int_of(c.at("h"));
    const auto a = bytes_of(c.at("a"));
    const auto b = bytes_of(c.at("b"));
    const auto la = pm::luma_int_of(a, w, h);
    const auto lb = pm::luma_int_of(b, w, h);
    CHECK(fnv32(reinterpret_cast<const std::uint8_t*>(la.data()), la.size() * 4) == c.at("lumaFnv").str());  // little-endian, as Int32Array
    pm::FlowOptions o;
    const Json& jo = c.at("opts");
    if (jo.at("step").is_number()) o.step = jo.at("step").num();
    if (jo.at("blockRadius").is_number()) o.blockRadius = jo.at("blockRadius").num();
    if (jo.at("searchRadius").is_number()) o.searchRadius = jo.at("searchRadius").num();
    if (jo.at("minImprovement").is_number()) o.minImprovement = jo.at("minImprovement").num();
    const pm::FlowField fl = pm::compute_flow(la, lb, w, h, o);
    const Json& want = c.at("flow");
    CHECK(fl.cols == int_of(want.at("cols")));
    CHECK(fl.rows == int_of(want.at("rows")));
    CHECK(fl.step == int_of(want.at("step")));
    REQUIRE(fl.dx.size() == want.at("dx").arr().size());
    for (std::size_t i = 0; i < fl.dx.size(); ++i) {
      CHECK(static_cast<double>(fl.dx[i]) == want.at("dx").arr()[i].num());
      CHECK(static_cast<double>(fl.dy[i]) == want.at("dy").arr()[i].num());
      CHECK(static_cast<double>(fl.valid[i]) == want.at("valid").arr()[i].num());
    }
    const Json& wp = c.at("warp");
    const int W = int_of(wp.at("W"));
    const int H = int_of(wp.at("H"));
    const auto A = bytes_of(wp.at("A"));
    const auto B = bytes_of(wp.at("B"));
    for (const Json& ww : wp.at("warps").arr()) {
      std::vector<std::uint8_t> out(static_cast<std::size_t>(W) * static_cast<std::size_t>(H) * 4, 0);
      pm::warp_blend(A, B, W, H, fl, static_cast<double>(W) / w, static_cast<double>(H) / h, ww.at("t").num(), out);
      for (std::size_t i = 0; i < ww.at("head").arr().size(); ++i) CHECK(static_cast<double>(out[i]) == ww.at("head").arr()[i].num());
      CHECK(fnv32(out.data(), out.size()) == ww.at("fnv").str());
    }
  }

  for (const Json& c : fixture->at("fields").arr()) {
    const int w = int_of(c.at("w"));
    const int h = int_of(c.at("h"));
    auto data = bytes_of(c.at("src"));
    pm::deinterlace_data(data, w, h, c.at("keep").str() == "upper");
    REQUIRE(data.size() == c.at("out").arr().size());
    for (std::size_t i = 0; i < data.size(); ++i) CHECK(static_cast<double>(data[i]) == c.at("out").arr()[i].num());
  }
}

TEST_CASE("Uint8Clamped stores round half to even", "[scene][pixmo]") {
  CHECK(pm::to_uint8_clamp(0.5) == 0);
  CHECK(pm::to_uint8_clamp(1.5) == 2);
  CHECK(pm::to_uint8_clamp(2.5) == 2);
  CHECK(pm::to_uint8_clamp(2.5000001) == 3);
  CHECK(pm::to_uint8_clamp(-3) == 0);
  CHECK(pm::to_uint8_clamp(300) == 255);
  CHECK(pm::to_uint8_clamp(254.5) == 254);
  CHECK(pm::to_uint8_clamp(std::nan("")) == 0);
}
