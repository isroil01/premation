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
#include <vector>

#include "bake_chain.hpp"
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
