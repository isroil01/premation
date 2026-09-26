// glTF morph + skin parity (tests/data/model_deform_parity.json, frozen from
// the TypeScript engine's modelDeformCrossEngine.test.ts): morphedMeshFor then
// skinnedMeshFor on the registered model — the buffer keys and every vertex
// float equal the editor's. PARITY_REBLESS=1 writes the C++ answers instead
// (parity_rebless.hpp). The model bytes, its key (which the fixture's nodes
// carry in their Model props) and the per-row nodes / weights / worlds are
// inputs and stay.
#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "gltf_model.hpp"
#include "json.hpp"
#include "model_deform.hpp"
#include "native_effects.hpp"
#include "parity_rebless.hpp"

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

/// modelDeformCrossEngine.test.ts' `{ key, tag?, vertices }` of a deformed mesh.
Json deformed_json(const gl::Deformed& d, bool withTag) {
  Json::Object o{{"key", Json::string(d.key)}};
  if (withTag) o.push_back({"tag", Json::string(d.tag)});
  o.push_back({"vertices", premation::test::json_numbers(d.vertices)});
  return Json::object(std::move(o));
}

}  // namespace

TEST_CASE("model deform parity: morph targets and skinning equal the editor's", "[scene][gltf][parity]") {
  premation::test::JsonFixture fx("model_deform_parity.json");
  REQUIRE(fx.ok());
  const auto bytes = doc::native_unbase64(fx.root().at("bytes").str());
  REQUIRE(bytes.has_value());
  // An input, not an answer: the rows' Model props name the model by it.
  const std::string modelKey = fx.root().at("modelKey").str();
  CHECK(gl::model_key_for_bytes(*bytes) == modelKey);
  gl::clear_models();
  const auto model = gl::register_model(modelKey, *bytes);
  REQUIRE(model != nullptr);
  REQUIRE(model->parsed.has_value());
  const auto it = model->entries.find({0, 0});
  REQUIRE(it != model->entries.end());
  const gl::Entry& entry = it->second;

  for (Json& row : fx.root().find_mut("rows")->arr_mut()) {
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
    CHECK(fx.answer(row, "morphed", morphed ? deformed_json(*morphed, true) : Json::null()));

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
    CHECK(fx.answer(row, "skinned", skinned ? deformed_json(*skinned, false) : Json::null()));
    const std::string deformedKey = skinned ? skinned->key : morphed ? morphed->key : entry.key;
    CHECK(fx.answer(row, "deformedKey", Json::string(deformedKey)));
  }
  gl::clear_models();
  REQUIRE(fx.finish());
}
