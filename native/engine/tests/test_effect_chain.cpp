// E4: the CPU effect CHAIN (effects/effect_chain.cpp) against the TS bake path
// (bakeWorkerCore.ts runBakeJob → effectBake.ts applyEffectChain), on the
// recording canvas: tests/data/effect_chain_parity.json, frozen from the
// TypeScript engine's effectChainCrossEngine.test.ts; PARITY_REBLESS=1 writes
// the C++ answers instead (parity_rebless.hpp). Every case must issue the
// TS's Canvas2D program op for op — every putImageData carries the FNV-1a 64
// of its bytes, so each pixel pass is checked byte for byte where it lands —
// and end on the same bytes, on 1 thread and on 4. Each case's effects must
// also take the TS's route through the chain. (Re-blessing records the
// 1-thread answers; the 4-thread run is then checked against them.)
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <map>
#include <memory>
#include <string>

#include "effects/effect_chain.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"
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

TEST_CASE("effect chain: the C++ bake issues the TS bake's Canvas2D program and bytes", "[effects][chain][parity]") {
  test::JsonFixture fixture("effect_chain_parity.json");
  REQUIRE(fixture.ok());
  // The chain reads raster::json: a read-only copy of the inputs (JSON.stringify's
  // numbers parse back bit-identical); the answers are read and written on `fixture`.
  Value fx;
  std::string err;
  REQUIRE(raster::json::parse(js::stringify(fixture.root()), fx, err));

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
  js::Json::Array& rows = fixture.root().find_mut("cases")->arr_mut();
  REQUIRE(rows.size() == cases.size());
  for (std::size_t ci = 0; ci < cases.size(); ++ci) {
    const Value& c = cases[ci];
    js::Json& row = rows[ci];
    const std::string name = c["name"].str();
    INFO(name);
    const Value& img = fx["images"][c["image"].str()];
    const auto w = static_cast<std::uint32_t>(img["w"].num());
    const auto h = static_cast<std::uint32_t>(img["h"].num());
    const Value* mask = c.has("mask") ? &c["mask"] : nullptr;

    bool routes_ok = true;
    js::Json::Array routes;
    for (std::size_t i = 0; i < c["effects"].size(); ++i) {
      const std::string_view got = effects::effect_route(c["effects"][i]);
      routes.push_back(js::Json::string(std::string(got)));
      if (got != c["routes"][i].str()) {
        routes_ok = false;
        if (!fixture.reblessing()) {
          std::printf("  %s: effect %zu (%s) routes to %.*s, TS %s\n", name.c_str(), i, c["effects"][i]["type"].str().c_str(),
                      static_cast<int>(got.size()), got.data(), c["routes"][i].str().c_str());
        }
      }
    }
    if (routes_ok) ++routes_same;
    CHECK(fixture.answer(row, "routes", js::Json::array(std::move(routes))));

    for (effects::ThreadPool* pool : {static_cast<effects::ThreadPool*>(nullptr), &pool4}) {
      auto rec = std::make_shared<raster::test::Recording>();
      raster::test::RecordingCanvas oc(rec, w, h);
      effects::ChainReport report;
      const std::vector<std::uint8_t> out = effects::run_bake_job(oc, images[c["image"].str()], c["effects"], c["fillOpacity"].num(1), mask, pool, report);
      const auto& got = rec->ops;
      const std::string hash = fnv(out);
      js::Json::Array gotOps;
      for (const std::string& op : got) gotOps.push_back(js::Json::string(op));
      js::Json gotJson = js::Json::array(std::move(gotOps));
      {
        // Against the fixture as it stands (when re-blessing, the 4-thread run
        // sees the 1-thread C++ answers just stored).
        const js::Json::Array& want = row.at("ops").arr();
        std::size_t same = 0;
        std::size_t first = want.size();
        for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
          if (want[i].str() == got[i]) ++same;
          else if (first == want.size()) first = i;
        }
        const bool bytes = hash == row.at("hash").str();
        if (pool == nullptr && out != images[c["image"].str()]) ++changed;
        if (pool == nullptr) {
          ops_total += want.size();
          ops_same += same;
          puts += static_cast<std::size_t>(std::ranges::count_if(want, [](const js::Json& op) { return op.str().find("\"putImageData\"") != std::string::npos; }));
          if (bytes) ++bytes_same;
          if (same == want.size() && got.size() == want.size() && bytes) ++exact;
        }
        if ((same != want.size() || got.size() != want.size()) && !(fixture.reblessing() && pool == nullptr)) {
          const std::size_t i = std::min(first, std::min(want.size(), got.size()));
          std::printf("  %s (%s): first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", name.c_str(),
                      pool == nullptr ? "1 thread" : "4 threads", i, want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)",
                      i < got.size() ? got[i].c_str() : "(end)");
        }
      }
      for (const auto& u : report.unported) std::printf("  %s: unported %s\n", name.c_str(), u.c_str());
      CHECK(report.unported.empty());
      if (pool == nullptr) {
        CHECK(fixture.answer(row, "ops", std::move(gotJson)));
        CHECK(fixture.answer(row, "hash", js::Json::string(hash)));
      } else {
        CHECK(row.at("ops") == gotJson);
        CHECK(row.at("hash").str() == hash);
      }
    }
  }
  std::printf("effect chain vs effectBake.ts: %d/%zu cases exact (program + bytes), %d/%zu final bytes, %zu/%zu ops identical "
              "(%zu byte-checked putImageData), %d/%zu routes, %d cases change pixels; %zu pixel + %zu drawn effect types in the chain\n",
              exact, cases.size(), bytes_same, cases.size(), ops_same, ops_total, puts, routes_same, cases.size(), changed,
              effects::pixel_effect_types().size(), effects::chain_pixel_effects().size() - effects::pixel_effect_types().size());
  REQUIRE(fixture.finish());
}
