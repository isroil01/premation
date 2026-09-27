// Pixel Motion + deinterlace parity (tests/data/pixel_motion_parity.json,
// frozen from the TypeScript engine's pixelMotionCrossEngine.test.ts): the
// integer luma, the flow field float for float, every warped frame byte for
// byte (FNV of the output plus its first 64 bytes), and deinterlaced frames.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <span>
#include <string>
#include <vector>

#include "json.hpp"
#include "native_effects.hpp"
#include "parity_rebless.hpp"
#include "pixel_motion.hpp"

namespace pm = premation::scene::pixmo;
using premation::js::Json;
using premation::test::json_numbers;

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
  premation::test::JsonFixture fx("pixel_motion_parity.json");
  REQUIRE(fx.ok());

  for (Json& c : fx.root().find_mut("flows")->arr_mut()) {
    INFO(c.at("name").str());
    const int w = int_of(c.at("w"));
    const int h = int_of(c.at("h"));
    const auto a = bytes_of(c.at("a"));
    const auto b = bytes_of(c.at("b"));
    const auto la = pm::luma_int_of(a, w, h);
    const auto lb = pm::luma_int_of(b, w, h);
    // little-endian, as the Int32Array's buffer
    CHECK(fx.answer(c, "lumaFnv", Json::string(fnv32(reinterpret_cast<const std::uint8_t*>(la.data()), la.size() * 4))));
    pm::FlowOptions o;
    const Json& jo = c.at("opts");
    if (jo.at("step").is_number()) o.step = jo.at("step").num();
    if (jo.at("blockRadius").is_number()) o.blockRadius = jo.at("blockRadius").num();
    if (jo.at("searchRadius").is_number()) o.searchRadius = jo.at("searchRadius").num();
    if (jo.at("minImprovement").is_number()) o.minImprovement = jo.at("minImprovement").num();
    const pm::FlowField fl = pm::compute_flow(la, lb, w, h, o);
    Json flow = Json::object();
    flow.set("cols", Json::number(static_cast<double>(fl.cols)));
    flow.set("rows", Json::number(static_cast<double>(fl.rows)));
    flow.set("step", Json::number(static_cast<double>(fl.step)));
    flow.set("dx", json_numbers(fl.dx));
    flow.set("dy", json_numbers(fl.dy));
    flow.set("valid", json_numbers(fl.valid));
    CHECK(fx.answer(c, "flow", std::move(flow)));
    Json* wp = c.find_mut("warp");
    REQUIRE(wp != nullptr);
    const int W = int_of(wp->at("W"));
    const int H = int_of(wp->at("H"));
    const auto A = bytes_of(wp->at("A"));
    const auto B = bytes_of(wp->at("B"));
    for (Json& ww : wp->find_mut("warps")->arr_mut()) {
      INFO("t = " << ww.at("t").num());
      std::vector<std::uint8_t> out(static_cast<std::size_t>(W) * static_cast<std::size_t>(H) * 4, 0);
      pm::warp_blend(A, B, W, H, fl, static_cast<double>(W) / w, static_cast<double>(H) / h, ww.at("t").num(), out);
      CHECK(fx.answer(ww, "fnv", Json::string(fnv32(out.data(), out.size()))));
      CHECK(fx.answer(ww, "head", json_numbers(std::span<const std::uint8_t>(out).first(std::min<std::size_t>(64, out.size())))));
    }
  }

  for (Json& c : fx.root().find_mut("fields")->arr_mut()) {
    const int w = int_of(c.at("w"));
    const int h = int_of(c.at("h"));
    auto data = bytes_of(c.at("src"));
    pm::deinterlace_data(data, w, h, c.at("keep").str() == "upper");
    CHECK(fx.answer(c, "out", json_numbers(data)));
  }
  REQUIRE(fx.finish());
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
