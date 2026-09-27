// Cross-engine glTF model parity (tests/data/gltf_model_parity.json, frozen
// from the TypeScript engine's modelCrossEngine.test.ts): the C++ parse +
// primitive_to_entry over the same bytes must give the editor's model key,
// images and every primitive entry field — vertices and indices byte for byte.
// Models 0 and 1 are the render-tests model-maps / model-maps-off goldens'
// GLBs. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
// This test owns every answer of the fixture; test_threed_models.cpp reads only
// its input bytes.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "gltf_model.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "parity_rebless.hpp"

namespace gl = premation::scene::gltf;
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

Json opt_index(const std::optional<std::size_t>& i) {
  return i ? Json::number(static_cast<double>(*i)) : Json::null();
}

/// `holder[key]` is a list of answers: compare element by element (so a
/// mismatch names its element), or (re-blessing) store the whole list.
void answer_list(premation::test::JsonFixture& fx, Json& holder, std::string_view key, Json::Array got) {
  if (fx.reblessing()) {
    CHECK(fx.answer(holder, key, Json::array(std::move(got))));
    return;
  }
  Json* want = holder.find_mut(key);
  REQUIRE(want != nullptr);
  REQUIRE(want->is_array());
  auto& rows = want->arr_mut();
  REQUIRE(rows.size() == got.size());
  for (std::size_t i = 0; i < got.size(); ++i) {
    INFO(key << "[" << i << "]");
    CHECK(fx.answer(rows[i], std::move(got[i])));
  }
}

}  // namespace

TEST_CASE("glTF model parity: parse + primitive entries equal the editor's", "[scene][gltf][parity]") {
  premation::test::JsonFixture fx("gltf_model_parity.json");
  REQUIRE(fx.ok());
  auto& models = fx.root().find_mut("models")->arr_mut();
  REQUIRE(models.size() >= 5);
  std::size_t prims = 0;
  for (Json& m : models) {
    INFO(m.at("name").str());
    const auto bytes = premation::doc::native_unbase64(m.at("bytes").str());
    REQUIRE(bytes.has_value());
    const std::string modelKey = gl::model_key_for_bytes(*bytes);
    CHECK(fx.answer(m, "modelKey", Json::string(modelKey)));
    std::string err;
    const auto parsed = gl::parse(*bytes, err);
    if (!parsed) {
      CHECK(fx.answer(m, "error", Json::string(err)));
      if (fx.reblessing()) {
        m.erase("images");
        m.erase("primitives");
      }
      continue;
    }
    if (fx.reblessing()) {
      m.erase("error");
    } else {
      CHECK_FALSE(m.has("error"));
    }
    Json::Array images;
    for (const gl::Image& im : parsed->images) {
      images.push_back(Json::object(Json::Object{{"mimeType", Json::string(im.mimeType)},
                                                 {"length", Json::number(static_cast<double>(im.bytes.size()))},
                                                 {"fnv", Json::string(fnv1a64(im.bytes))}}));
    }
    answer_list(fx, m, "images", std::move(images));

    // Every primitive the parse kept, in order (modelCrossEngine.test.ts).
    Json::Array primitives;
    for (std::size_t mi = 0; mi < parsed->meshes.size(); ++mi) {
      for (std::size_t pi = 0; pi < parsed->meshes[mi].primitives.size(); ++pi) {
        INFO("mesh " << mi << " prim " << pi);
        const auto e = gl::primitive_to_entry(*parsed, modelKey, mi, pi);
        REQUIRE(e.has_value());
        std::string indicesFnv;
        if (e->index16) {
          std::vector<std::uint16_t> i16(e->indices.size());
          for (std::size_t k = 0; k < e->indices.size(); ++k) i16[k] = static_cast<std::uint16_t>(e->indices[k]);
          indicesFnv = fnv1a64(i16);
        } else {
          indicesFnv = fnv1a64(e->indices);
        }
        primitives.push_back(Json::object(Json::Object{
            {"mesh", Json::number(static_cast<double>(mi))},
            {"prim", Json::number(static_cast<double>(pi))},
            {"key", Json::string(e->key)},
            {"vertexCount", Json::number(static_cast<double>(e->vertices.size() / 8))},
            {"indexCount", Json::number(static_cast<double>(e->indices.size()))},
            {"index32", Json::boolean(!e->index16)},
            {"verticesFnv", Json::string(fnv1a64(e->vertices))},
            {"indicesFnv", Json::string(indicesFnv)},
            {"bbox", json_numbers(e->bbox)},
            {"fill", Json::string(e->fill)},
            {"textureImage", opt_index(e->textureImage)},
            {"doubleSided", Json::boolean(e->doubleSided)},
            {"metallic", Json::number(e->metallic)},
            {"roughness", Json::number(e->roughness)},
            {"maps", Json::object(Json::Object{{"normal", opt_index(e->maps.normal)},
                                               {"metallicRoughness", opt_index(e->maps.metallicRoughness)},
                                               {"occlusion", opt_index(e->maps.occlusion)},
                                               {"emissive", opt_index(e->maps.emissive)}})},
            {"normalScale", Json::number(e->normalScale)},
            {"occlusionStrength", Json::number(e->occlusionStrength)},
            {"emissive", json_numbers(e->emissive)},
            {"uvTransform", e->uvTransform ? json_numbers(*e->uvTransform) : Json::null()},
            {"skinned", Json::boolean(e->skinned)},
            {"morphTargets", Json::number(static_cast<double>(e->morphTargets))},
            {"morphDefaults", json_numbers(e->morphDefaults)},
        }));
        ++prims;
      }
    }
    answer_list(fx, m, "primitives", std::move(primitives));
  }
  CHECK(prims >= 5);
  REQUIRE(fx.finish());
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
