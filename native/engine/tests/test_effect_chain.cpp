// E4: the CPU effect CHAIN (effects/effect_chain.cpp) against the TS bake path
// (bakeWorkerCore.ts runBakeJob → effectBake.ts applyEffectChain), on the
// recording canvas: tests/data/effect_chain_parity.json, written by
// src/core/effects/effectChainCrossEngine.test.ts. Every case must issue the
// TS's Canvas2D program op for op — every putImageData carries the FNV-1a 64
// of its bytes, so each pixel pass is checked byte for byte where it lands —
// and end on the same bytes, on 1 thread and on 4. Each case's effects must
// also take the TS's route through the chain.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>

#include "effects/effect_chain.hpp"
#include "raster/json.hpp"
#include "recording_canvas.hpp"

using namespace premation;
using raster::json::Value;

namespace {

std::vector<std::uint8_t> base64(std::string_view s) {
  const auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<std::uint8_t> out;
  unsigned buf = 0;
  int bits = 0;
  for (const char c : s) {
    const int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6U) | static_cast<unsigned>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((buf >> static_cast<unsigned>(bits)) & 0xFFU));
    }
  }
  return out;
}

std::string fnv(std::span<const std::uint8_t> bytes) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (const std::uint8_t b : bytes) h = (h ^ b) * 0x100000001b3ULL;
  return std::to_string(h);
}

}  // namespace

TEST_CASE("effect chain: the C++ bake issues the TS bake's Canvas2D program and bytes", "[effects][chain]") {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/effect_chain_parity.json", std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  Value fx;
  std::string err;
  REQUIRE(raster::json::parse(ss.str(), fx, err));

  std::map<std::string, std::vector<std::uint8_t>> images;
  for (std::size_t i = 0; i < fx["images"].size(); ++i) images[fx["images"].keys()[i]] = base64(fx["images"].items()[i]["b64"].str());

  effects::ThreadPool pool4(4);
  int exact = 0;
  int bytes_same = 0;
  int routes_same = 0;
  int changed = 0;  // cases whose output differs from their input (the rest are neutral settings / drawn-only)
  std::size_t ops_total = 0;
  std::size_t ops_same = 0;
  std::size_t puts = 0;
  const auto& cases = fx["cases"].items();
  for (const auto& c : cases) {
    const std::string name = c["name"].str();
    INFO(name);
    const Value& img = fx["images"][c["image"].str()];
    const auto w = static_cast<std::uint32_t>(img["w"].num());
    const auto h = static_cast<std::uint32_t>(img["h"].num());
    const Value* mask = c.has("mask") ? &c["mask"] : nullptr;

    bool routes_ok = true;
    for (std::size_t i = 0; i < c["effects"].size(); ++i) {
      const std::string_view got = effects::effect_route(c["effects"][i]);
      if (got != c["routes"][i].str()) {
        routes_ok = false;
        std::printf("  %s: effect %zu (%s) routes to %.*s, TS %s\n", name.c_str(), i, c["effects"][i]["type"].str().c_str(),
                    static_cast<int>(got.size()), got.data(), c["routes"][i].str().c_str());
      }
    }
    if (routes_ok) ++routes_same;
    CHECK(routes_ok);

    for (effects::ThreadPool* pool : {static_cast<effects::ThreadPool*>(nullptr), &pool4}) {
      auto rec = std::make_shared<raster::test::Recording>();
      raster::test::RecordingCanvas oc(rec, w, h);
      effects::ChainReport report;
      const std::vector<std::uint8_t> out = effects::run_bake_job(oc, images[c["image"].str()], c["effects"], c["fillOpacity"].num(1), mask, pool, report);
      const auto& want = c["ops"].items();
      const auto& got = rec->ops;
      std::size_t same = 0;
      std::size_t first = want.size();
      for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
        if (want[i].str() == got[i]) ++same;
        else if (first == want.size()) first = i;
      }
      const bool bytes = fnv(out) == c["hash"].str();
      if (pool == nullptr && out != images[c["image"].str()]) ++changed;
      if (pool == nullptr) {
        ops_total += want.size();
        ops_same += same;
        puts += static_cast<std::size_t>(std::ranges::count_if(want, [](const Value& op) { return op.str().find("\"putImageData\"") != std::string::npos; }));
        if (bytes) ++bytes_same;
        if (same == want.size() && got.size() == want.size() && bytes) ++exact;
      }
      if (same != want.size() || got.size() != want.size()) {
        const std::size_t i = std::min(first, std::min(want.size(), got.size()));
        std::printf("  %s (%s): first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", name.c_str(),
                    pool == nullptr ? "1 thread" : "4 threads", i, want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)",
                    i < got.size() ? got[i].c_str() : "(end)");
      }
      for (const auto& u : report.unported) std::printf("  %s: unported %s\n", name.c_str(), u.c_str());
      CHECK(report.unported.empty());
      CHECK(got.size() == want.size());
      CHECK(same == want.size());
      CHECK(bytes);
    }
  }
  std::printf("effect chain vs effectBake.ts: %d/%zu cases exact (program + bytes), %d/%zu final bytes, %zu/%zu ops identical "
              "(%zu byte-checked putImageData), %d/%zu routes, %d cases change pixels; %zu pixel + %zu drawn effect types in the chain\n",
              exact, cases.size(), bytes_same, cases.size(), ops_same, ops_total, puts, routes_same, cases.size(), changed,
              effects::pixel_effect_types().size(), effects::chain_pixel_effects().size() - effects::pixel_effect_types().size());
}
