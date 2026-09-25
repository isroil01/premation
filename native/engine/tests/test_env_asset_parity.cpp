// Cross-engine image-sky parity (tests/data/env_asset_parity.json, written by
// src/core/scene/envAssetCrossEngine.test.ts): from the same decoded RGBA8
// equirect, the C++ resample, SH9 projection, derived rig and reflection atlas
// (env_light.cpp) must equal environmentLight.ts — floats and bytes exactly.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "env_light.hpp"
#include "json.hpp"

namespace sc = premation::scene;
using premation::js::Json;

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
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/env_asset_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto& rows = fixture->at("rows").arr();
  REQUIRE(rows.size() >= 3);
  for (const Json& row : rows) {
    const std::string name = row.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(row.at("w").num());
    const auto h = static_cast<std::uint32_t>(row.at("h").num());
    const std::vector<std::uint8_t> px = image(w, h, static_cast<std::uint32_t>(row.at("seed").num()));
    const sc::EnvPixels base = sc::resample_equirect(px, static_cast<int>(w), static_cast<int>(h), sc::kEnvSpecWidth, sc::kEnvSpecHeight, false);
    CHECK(base.width == static_cast<int>(row.at("resampled").at("width").num()));
    CHECK(base.height == static_cast<int>(row.at("resampled").at("height").num()));
    CHECK(fnv1a64(base.data) == row.at("resampled").at("fnv").str());

    const std::array<float, 27> sh = sc::sh_project(base);
    const auto& wantSh = row.at("sh").arr();
    REQUIRE(wantSh.size() == 27);
    for (std::size_t i = 0; i < 27; ++i) CHECK(static_cast<double>(sh.at(i)) == wantSh[i].num());

    const std::vector<sc::EnvRigLight> rig = sc::environment_rig(sh, 80, 30);
    const auto& wantRig = row.at("rig").arr();
    REQUIRE(rig.size() == wantRig.size());
    for (std::size_t i = 0; i < rig.size(); ++i) {
      CHECK(rig[i].ambient == (wantRig[i].at("kind").str() == "ambient"));
      CHECK(rig[i].color == wantRig[i].at("color").str());
      CHECK(rig[i].intensity == wantRig[i].at("intensity").num());
      if (!rig[i].ambient) {
        for (std::size_t k = 0; k < 3; ++k) CHECK(rig[i].from.at(k) == wantRig[i].at("from").arr()[k].num());
      }
    }

    const std::string id = sc::env_atlas_key("asset:" + name + "#" + sc::hash_env_pixels(base));
    CHECK(id == row.at("atlas").at("id").str());
    const sc::EnvSpecularMap atlas = sc::build_env_specular_atlas(base, id);
    CHECK(atlas.width == static_cast<std::uint32_t>(row.at("atlas").at("width").num()));
    CHECK(atlas.height == static_cast<std::uint32_t>(row.at("atlas").at("height").num()));
    CHECK(atlas.levels == static_cast<std::uint32_t>(row.at("atlas").at("levels").num()));
    CHECK(atlas.scale == row.at("atlas").at("scale").num());
    CHECK(fnv1a64(atlas.data) == row.at("atlas").at("fnv").str());
  }
}
