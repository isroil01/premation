// Cross-engine image-sky parity (tests/data/env_asset_parity.json, frozen from
// the TypeScript engine's envAssetCrossEngine.test.ts): from the same decoded
// RGBA8 equirect, the C++ resample, SH9 projection, derived rig and reflection
// atlas (env_light.cpp) must equal environmentLight.ts — floats and bytes
// exactly. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "env_light.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"

namespace sc = premation::scene;
using premation::js::Json;
using premation::test::json_numbers;

namespace {

template <class T>
std::string fnv1a64(const std::vector<T>& v) {
  std::vector<std::uint8_t> bytes(v.size() * sizeof(T));
  std::memcpy(bytes.data(), v.data(), bytes.size());
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (const std::uint8_t b : bytes) {
    h ^= b;
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> out{};
  std::snprintf(out.data(), out.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(out.data());
}

/// envAssetCrossEngine.test.ts `image(w, h, seed)`.
std::vector<std::uint8_t> image(std::uint32_t w, std::uint32_t h, std::uint32_t seed) {
  std::vector<std::uint8_t> px(std::size_t{w} * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::size_t o = (std::size_t{y} * w + x) * 4;
      px[o] = static_cast<std::uint8_t>((x * 7 + y * 3 + seed) & 255U);
      px[o + 1] = static_cast<std::uint8_t>((x * x + y * 5 + seed * 3) & 255U);
      px[o + 2] = static_cast<std::uint8_t>(((x ^ y) * 11 + seed * 7) & 255U);
      px[o + 3] = 255;
    }
  }
  return px;
}

}  // namespace

TEST_CASE("image-sky parity: resample, SH, rig and reflection atlas equal environmentLight.ts", "[scene][env][parity]") {
  premation::test::JsonFixture fx("env_asset_parity.json");
  REQUIRE(fx.ok());
  auto& rows = fx.root().find_mut("rows")->arr_mut();
  REQUIRE(rows.size() >= 3);
  for (Json& row : rows) {
    const std::string name = row.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(row.at("w").num());
    const auto h = static_cast<std::uint32_t>(row.at("h").num());
    const std::vector<std::uint8_t> px = image(w, h, static_cast<std::uint32_t>(row.at("seed").num()));
    const sc::EnvPixels base = sc::resample_equirect(px, static_cast<int>(w), static_cast<int>(h), sc::kEnvSpecWidth, sc::kEnvSpecHeight, false);
    CHECK(fx.answer(row, "resampled",
                    Json::object(Json::Object{{"width", Json::number(base.width)},
                                              {"height", Json::number(base.height)},
                                              {"fnv", Json::string(fnv1a64(base.data))}})));

    const std::array<float, 27> sh = sc::sh_project(base);
    CHECK(fx.answer(row, "sh", json_numbers(sh)));

    const std::vector<sc::EnvRigLight> rig = sc::environment_rig(sh, 80, 30);
    Json::Array gotRig;
    for (const sc::EnvRigLight& l : rig) {
      gotRig.push_back(Json::object(Json::Object{{"kind", Json::string(l.ambient ? "ambient" : "parallel")},
                                                 {"color", Json::string(l.color)},
                                                 {"intensity", Json::number(l.intensity)},
                                                 {"from", l.ambient ? Json::null() : json_numbers(l.from)}}));
    }
    CHECK(fx.answer(row, "rig", Json::array(std::move(gotRig))));

    const std::string id = sc::env_atlas_key("asset:" + name + "#" + sc::hash_env_pixels(base));
    const sc::EnvSpecularMap atlas = sc::build_env_specular_atlas(base, id);
    CHECK(fx.answer(row, "atlas",
                    Json::object(Json::Object{{"id", Json::string(atlas.id)},
                                              {"width", Json::number(atlas.width)},
                                              {"height", Json::number(atlas.height)},
                                              {"levels", Json::number(atlas.levels)},
                                              {"scale", Json::number(atlas.scale)},
                                              {"fnv", Json::string(fnv1a64(atlas.data))}})));
    CHECK(atlas.id == id);
  }
  REQUIRE(fx.finish());
}
