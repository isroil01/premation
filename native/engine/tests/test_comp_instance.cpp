// A nested composition's layers are re-keyed under the instance (`<instance>::<id>`),
// and every reference between them moves with them: a track matte's source and
// Behind Subject's footage layer. A text layer behind the subject of footage in
// a precomp read the bare footage id, found no `<id>#subject` matte and drew uncut.
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "scene/comp_instance.hpp"

using namespace premation::scene;

TEST_CASE("prefix_layer_ids re-keys Behind Subject with the footage it names", "[scene][precomp]") {
  RLayer footage;
  footage.id = "layer_1";
  footage.subjectSrc = "item_1";
  RLayer text;
  text.id = "layer_4";
  text.behindSubject = "layer_1";
  text.behindSubjects = {"s1"};
  text.matteSourceId = "layer_1";
  RLayer plain;
  plain.id = "layer_5";

  std::vector<RLayer> layers{text, footage, plain};
  prefix_layer_ids(layers, "layer_2::");

  REQUIRE(layers[0].id == "layer_2::layer_4");
  REQUIRE(layers[0].behindSubject.value_or("") == layers[1].id);
  REQUIRE(layers[0].matteSourceId.value_or("") == layers[1].id);
  // Subject ids are the footage's own (s1, s2…), not layer ids: they stay as they are.
  REQUIRE(layers[0].behindSubjects == std::vector<std::string>{"s1"});
  REQUIRE_FALSE(layers[2].behindSubject.has_value());
}

TEST_CASE("prefix_layer_ids re-keys Behind Subject two precomps deep", "[scene][precomp]") {
  RLayer text;
  text.id = "t";
  text.behindSubject = "v";
  RLayer video;
  video.id = "v";
  RLayer inner;
  inner.id = "inner";
  inner.precompLayers = std::vector<RLayer>{text, video};
  std::vector<RLayer> layers{inner};

  // The inner pass prefixes its own layers first, then the outer pass prefixes again.
  prefix_layer_ids(*layers[0].precompLayers, "inner::");
  prefix_layer_ids(layers, "outer::");

  const std::vector<RLayer>& kids = *layers[0].precompLayers;
  REQUIRE(kids[0].id == "outer::inner::t");
  REQUIRE(kids[0].behindSubject.value_or("") == kids[1].id);
}
