// glTF morph + skin parity (tests/data/model_deform_parity.json, written by
// src/core/scene/modelDeformCrossEngine.test.ts): morphedMeshFor then
// skinnedMeshFor on the registered model — the buffer keys and every vertex
// float equal the editor's.
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "gltf_model.hpp"
#include "json.hpp"
#include "model_deform.hpp"
#include "native_effects.hpp"

namespace gl = premation::scene::gltf;
namespace doc = premation::doc;
namespace xf = motion::xf;
using premation::js::Json;

namespace {

xf::Mat4 mat4_of(const Json& a) {
  xf::Mat4 m{};
  for (std::size_t i = 0; i < 16; ++i) m[i] = a.arr()[i].num();
  return m;
}

void check_vertices(const Json& want, const std::vector<float>& got) {
  REQUIRE(want.arr().size() == got.size());
  for (std::size_t i = 0; i < got.size(); ++i) CHECK(static_cast<double>(got[i]) == want.arr()[i].num());
}

}  // namespace

TEST_CASE("model deform parity: morph targets and skinning equal the editor's", "[scene][gltf][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/model_deform_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("model_deform_parity.json not generated yet (GEN_NATIVE_DEFORM=1 npx jest modelDeformCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto bytes = doc::native_unbase64(fixture->at("bytes").str());
  REQUIRE(bytes.has_value());
  const std::string modelKey = fixture->at("modelKey").str();
  CHECK(gl::model_key_for_bytes(*bytes) == modelKey);
  gl::clear_models();
  const auto model = gl::register_model(modelKey, *bytes);
  REQUIRE(model != nullptr);
  REQUIRE(model->parsed.has_value());
  const auto it = model->entries.find({0, 0});
  REQUIRE(it != model->entries.end());
  const gl::Entry& entry = it->second;

  for (const Json& row : fixture->at("rows").arr()) {
    INFO(row.at("name").str());
    std::map<std::string, doc::Node, std::less<>> nodes;
    for (const Json& ns : row.at("nodes").arr()) {
      doc::Node n;
      n.id = ns.at("id").str();
      n.name = n.id;
      if (ns.at("parent").is_string()) n.parent = ns.at("parent").str();
      for (const Json& c : ns.at("children").arr()) n.children.push_back(c.str());
      for (const Json& cj : ns.at("components").arr()) {
        doc::Component c;
        c.id = cj.at("id").str();
        c.type = cj.at("type").str();
        c.props = cj.at("props");
        n.components.push_back(std::move(c));
      }
      nodes.emplace(n.id, std::move(n));
    }
    std::vector<std::pair<std::string, double>> av;
    for (const auto& m : row.at("animated").obj()) av.emplace_back(m.key, m.value.num());
    const premation::scene::Values animated(std::move(av));
    const doc::Node& mesh = nodes.at("mesh");

    const std::optional<gl::Deformed> morphed = entry.morphTargets > 0 ? gl::morphed_mesh_for(mesh, entry, &animated) : std::nullopt;
    const Json& wantMorph = row.at("morphed");
    REQUIRE(morphed.has_value() == wantMorph.is_object());
    if (morphed) {
      CHECK(morphed->key == wantMorph.at("key").str());
      CHECK(morphed->tag == wantMorph.at("tag").str());
      check_vertices(wantMorph.at("vertices"), morphed->vertices);
    }

    const Json& worlds = row.at("jointWorlds");
    const gl::SkinResolvers r{
        [&](const std::string& id) -> const doc::Node* {
          const auto n = nodes.find(id);
          return n == nodes.end() ? nullptr : &n->second;
        },
        [&](const std::string& id) -> std::optional<std::string> {
          const auto n = nodes.find(id);
          return n == nodes.end() ? std::nullopt : n->second.parent;
        },
        [&](const std::string& id) -> std::optional<xf::Mat4> {
          const Json& w = worlds.at(id);
          if (!w.is_array()) return std::nullopt;
          return mat4_of(w);
        }};
    const Json& skinProp = mesh.comp("Model")->props.at("skin");
    const std::optional<double> skinIdx = skinProp.is_number() ? std::optional<double>(skinProp.num()) : std::nullopt;
    gl::JointMapCache cache;
    const std::optional<gl::Deformed> skinned =
        entry.skinned ? gl::skinned_mesh_for(mesh, modelKey, skinIdx, entry, model->skins, mat4_of(row.at("layerWorld")), r, cache,
                                             morphed ? &*morphed : nullptr)
                      : std::nullopt;
    const Json& wantSkin = row.at("skinned");
    REQUIRE(skinned.has_value() == wantSkin.is_object());
    if (skinned) {
      CHECK(skinned->key == wantSkin.at("key").str());
      check_vertices(wantSkin.at("vertices"), skinned->vertices);
    }
    const std::string deformedKey = skinned ? skinned->key : morphed ? morphed->key : entry.key;
    CHECK(deformedKey == row.at("deformedKey").str());
  }
  gl::clear_models();
}
