// Cross-engine glTF model parity (tests/data/gltf_model_parity.json, written by
// src/core/scene/modelCrossEngine.test.ts): the C++ parse + primitive_to_entry
// over the same bytes must give the editor's model key, images and every
// primitive entry field — vertices and indices byte for byte. Models 0 and 1
// are the render-tests model-maps / model-maps-off goldens' GLBs.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "gltf_model.hpp"
#include "json.hpp"
#include "native_effects.hpp"

namespace gl = premation::scene::gltf;
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

std::optional<std::size_t> opt_index(const Json& j) {
  return j.is_number() ? std::optional<std::size_t>(static_cast<std::size_t>(j.num())) : std::nullopt;
}

}  // namespace

TEST_CASE("glTF model parity: parse + primitive entries equal the editor's", "[scene][gltf][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/gltf_model_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto& models = fixture->at("models").arr();
  REQUIRE(models.size() >= 5);
  std::size_t prims = 0;
  for (const Json& m : models) {
    INFO(m.at("name").str());
    const auto bytes = premation::doc::native_unbase64(m.at("bytes").str());
    REQUIRE(bytes.has_value());
    CHECK(gl::model_key_for_bytes(*bytes) == m.at("modelKey").str());
    std::string err;
    const auto parsed = gl::parse(*bytes, err);
    if (m.at("error").is_string()) {
      CHECK_FALSE(parsed.has_value());
      CHECK(err == m.at("error").str());
      continue;
    }
    REQUIRE(parsed.has_value());
    const auto& imgs = m.at("images").arr();
    REQUIRE(parsed->images.size() == imgs.size());
    for (std::size_t i = 0; i < imgs.size(); ++i) {
      CHECK(parsed->images[i].mimeType == imgs[i].at("mimeType").str());
      CHECK(parsed->images[i].bytes.size() == static_cast<std::size_t>(imgs[i].at("length").num()));
      CHECK(fnv1a64(parsed->images[i].bytes) == imgs[i].at("fnv").str());
    }
    for (const Json& p : m.at("primitives").arr()) {
      const auto mi = static_cast<std::size_t>(p.at("mesh").num());
      const auto pi = static_cast<std::size_t>(p.at("prim").num());
      INFO("mesh " << mi << " prim " << pi);
      const auto e = gl::primitive_to_entry(*parsed, m.at("modelKey").str(), mi, pi);
      REQUIRE(e.has_value());
      CHECK(e->key == p.at("key").str());
      CHECK(e->vertices.size() / 8 == static_cast<std::size_t>(p.at("vertexCount").num()));
      CHECK(e->indices.size() == static_cast<std::size_t>(p.at("indexCount").num()));
      CHECK(e->index16 == !p.at("index32").b());
      CHECK(fnv1a64(e->vertices) == p.at("verticesFnv").str());
      if (e->index16) {
        std::vector<std::uint16_t> i16(e->indices.begin(), e->indices.end());
        CHECK(fnv1a64(i16) == p.at("indicesFnv").str());
      } else {
        CHECK(fnv1a64(e->indices) == p.at("indicesFnv").str());
      }
      const auto& bb = p.at("bbox").arr();
      for (std::size_t k = 0; k < 6; ++k) CHECK(e->bbox.at(k) == bb[k].num());
      CHECK(e->fill == p.at("fill").str());
      CHECK(e->textureImage == opt_index(p.at("textureImage")));
      CHECK(e->doubleSided == p.at("doubleSided").b());
      CHECK(e->metallic == p.at("metallic").num());
      CHECK(e->roughness == p.at("roughness").num());
      CHECK(e->maps.normal == opt_index(p.at("maps").at("normal")));
      CHECK(e->maps.metallicRoughness == opt_index(p.at("maps").at("metallicRoughness")));
      CHECK(e->maps.occlusion == opt_index(p.at("maps").at("occlusion")));
      CHECK(e->maps.emissive == opt_index(p.at("maps").at("emissive")));
      CHECK(e->normalScale == p.at("normalScale").num());
      CHECK(e->occlusionStrength == p.at("occlusionStrength").num());
      for (std::size_t k = 0; k < 3; ++k) CHECK(e->emissive.at(k) == p.at("emissive").arr()[k].num());
      if (p.at("uvTransform").is_array()) {
        REQUIRE(e->uvTransform.has_value());
        for (std::size_t k = 0; k < 5; ++k) CHECK(e->uvTransform->at(k) == p.at("uvTransform").arr()[k].num());
      } else {
        CHECK_FALSE(e->uvTransform.has_value());
      }
      CHECK(e->skinned == p.at("skinned").b());
      CHECK(e->morphTargets == static_cast<std::size_t>(p.at("morphTargets").num()));
      REQUIRE(e->morphDefaults.size() == p.at("morphDefaults").arr().size());
      for (std::size_t k = 0; k < e->morphDefaults.size(); ++k) CHECK(e->morphDefaults[k] == p.at("morphDefaults").arr()[k].num());
      ++prims;
    }
  }
  CHECK(prims >= 5);
}

TEST_CASE("glTF image sources round-trip", "[scene][gltf]") {
  const std::string s = gl::image_src("gltf-daaa4bd9-3424", 3);
  CHECK(s == "gltf:gltf-daaa4bd9-3424#3");
  const auto p = gl::parse_image_src(s);
  REQUIRE(p.has_value());
  CHECK(p->first == "gltf-daaa4bd9-3424");
  CHECK(p->second == 3);
  CHECK_FALSE(gl::parse_image_src("blob:file:///x").has_value());
  CHECK_FALSE(gl::parse_image_src("gltf:k#x").has_value());
}
