// D2w effects: whole CPU-baked effect chains (scene/bake_chain.cpp) against
// effectBake.ts. The C++ bake on a recording Canvas2D must issue the TS's
// Canvas2D program op for op — every putImageData carrying the same FNV-1a 64
// of its bytes (tests/data/bake_chain_parity.json, written by
// src/core/effects/nativeBakeChainCrossEngine.test.ts).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "bake_chain.hpp"
#include "canvas.hpp"
#include "json.hpp"
#include "recording_canvas.hpp"

namespace sc = premation::scene;
namespace js = premation::js;
namespace raster = premation::raster;

namespace {

/// nativeBakeChainCrossEngine.test.ts `pattern(w, h)`.
std::vector<std::uint8_t> pattern(std::uint32_t w, std::uint32_t h) {
  std::vector<std::uint8_t> d(static_cast<std::size_t>(w) * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::size_t i = (static_cast<std::size_t>(y) * w + x) * 4;
      d[i] = static_cast<std::uint8_t>((x * 7 + y * 3) & 255U);
      d[i + 1] = static_cast<std::uint8_t>((x * 5 + y * 11 + ((x * y) % 17)) & 255U);
      d[i + 2] = static_cast<std::uint8_t>((255U - x * 3 - y * 2) & 255U);
      d[i + 3] = (x + y) % 9 == 0 ? 0 : static_cast<std::uint8_t>((x * 13 + y * 29 + 64) & 255U);
    }
  }
  return d;
}

}  // namespace

TEST_CASE("bake chain: the C++ issues effectBake.ts's Canvas2D program", "[scene][bake]") {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/bake_chain_parity.json", std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  const auto fx = js::parse(ss.str());
  REQUIRE(fx.has_value());

  int exact = 0;
  std::size_t opsTotal = 0;
  std::size_t opsSame = 0;
  const js::Json::Array& cases = fx->at("cases").arr();
  for (const js::Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(c.at("w").num());
    const auto h = static_cast<std::uint32_t>(c.at("h").num());
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, w, h);
    oc.putImageData(pattern(w, h), w, h, 0, 0);  // the layer content (the recorders hold real pixels)
    std::vector<std::string> unsupported;
    sc::bake::bake_layer_raster(oc, c.at("spec"), c.at("bw").num(), c.at("bh").num(), c.at("ss").num(), unsupported);
    for (const std::string& u : unsupported) std::printf("  %s: unsupported: %s\n", name.c_str(), u.c_str());
    CHECK(unsupported.empty());

    const js::Json::Array& want = c.at("ops").arr();
    const auto& got = rec->ops;
    std::size_t same = 0;
    std::size_t first = want.size();
    for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
      if (want[i].str() == got[i]) ++same;
      else if (first == want.size()) first = i;
    }
    opsTotal += want.size();
    opsSame += same;
    if (same == want.size() && got.size() == want.size()) {
      ++exact;
    } else {
      const std::size_t i = std::min(first, std::min(want.size(), got.size()));
      std::printf("  %s: first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", name.c_str(), i,
                  want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)", i < got.size() ? got[i].c_str() : "(end)");
    }
    CHECK(got.size() == want.size());
    CHECK(same == want.size());
  }
  std::printf("bake chains vs effectBake.ts: %d/%zu cases op-for-op, %zu/%zu ops identical\n", exact, cases.size(), opsSame,
              opsTotal);
}

namespace {

/// A closed rectangular mask path (corner points), layer px.
js::Json rect_mask(double x0, double y0, double x1, double y1) {
  js::Json pts = js::Json::array();
  for (const auto& [x, y] : std::vector<std::pair<double, double>>{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}) {
    js::Json p = js::Json::object();
    for (const char* k : {"x", "inX", "outX"}) p.set(k, js::Json::number(x));
    for (const char* k : {"y", "inY", "outY"}) p.set(k, js::Json::number(y));
    pts.arr_mut().push_back(std::move(p));
  }
  js::Json path = js::Json::object();
  path.set("id", js::Json::string("m"));
  path.set("mode", js::Json::string("add"));
  path.set("closed", js::Json::boolean(true));
  path.set("points", std::move(pts));
  path.set("feather", js::Json::number(0));
  path.set("opacity", js::Json::number(1));
  path.set("expansion", js::Json::number(0));
  js::Json paths = js::Json::array();
  paths.arr_mut().push_back(std::move(path));
  js::Json mask = js::Json::object();
  mask.set("paths", std::move(paths));
  return mask;
}

}  // namespace

TEST_CASE("footage bake: the mask matte lands on the bitmap (bake_footage)", "[scene][bake][footage]") {
  // A 40 × 20 layer baked at 2× (80 × 40), opaque red.
  const raster::CanvasOptions opts;
  const auto frame = [&opts] {
    auto c = raster::Canvas2D::make(80, 40, opts);
    std::vector<std::uint8_t> red(80U * 40U * 4U);
    for (std::size_t i = 0; i < red.size(); i += 4) {
      red[i] = 255;
      red[i + 3] = 255;
    }
    c->putImageData(red, 80, 40, 0, 0);
    return c;
  };
  const auto alpha_at = [](const raster::Canvas2D& c, std::uint32_t x, std::uint32_t y) {
    return c.pixels().at((static_cast<std::size_t>(y) * c.width() + x) * 4 + 3);
  };
  js::Json spec = js::Json::object();
  spec.set("effects", js::Json::array());
  spec.set("width", js::Json::number(40));
  spec.set("height", js::Json::number(20));
  std::vector<std::string> unsupported;
  {
    // A mask covering the layer box however its space is anchored: nothing is cut.
    auto c = frame();
    js::Json s = spec;
    s.set("mask", rect_mask(-40, -20, 40, 20));
    sc::bake::bake_footage(*c, s, unsupported);
    CHECK(alpha_at(*c, 5, 5) == 255);
    CHECK(alpha_at(*c, 75, 35) == 255);
  }
  {
    // A mask far outside the box: the whole bitmap is cut away.
    auto c = frame();
    js::Json s = spec;
    s.set("mask", rect_mask(1000, 1000, 1100, 1100));
    sc::bake::bake_footage(*c, s, unsupported);
    CHECK(alpha_at(*c, 5, 5) == 0);
    CHECK(alpha_at(*c, 40, 20) == 0);
  }
  {
    // No mask, no effects: the frame as drawn.
    auto c = frame();
    sc::bake::bake_footage(*c, spec, unsupported);
    CHECK(alpha_at(*c, 40, 20) == 255);
  }
  CHECK(unsupported.empty());
}
