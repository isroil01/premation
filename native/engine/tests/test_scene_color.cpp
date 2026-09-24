// D2w: the document's colour settings → RenderView.colorManagement (scene/color_settings.hpp).
#include <catch2/catch_test_macros.hpp>

#include "color_settings.hpp"
#include "model.hpp"

namespace api = premation::api;
namespace doc = premation::doc;
namespace sc = premation::scene;

TEST_CASE("unmanaged: None and the spaces the TS pipeline renders itself", "[scene][color]") {
  doc::Document d;
  // The default project (linear sRGB, no OCIO config) = today's pipeline, byte for byte.
  CHECK_FALSE(sc::color_management_of(d).management.has_value());
  CHECK(sc::color_management_of(d).note.empty());
  d.project_mut().working_space = api::ColorWorkingSpace::none;
  CHECK_FALSE(sc::color_management_of(d).management.has_value());
  d.project_mut().working_space = api::ColorWorkingSpace::acescg;
  CHECK_FALSE(sc::color_management_of(d).management.has_value());
}

TEST_CASE("managed working spaces composite linear in their primaries", "[scene][color]") {
  doc::Document d;
  const auto ws = [&](api::ColorWorkingSpace w) {
    d.project_mut().working_space = w;
    const auto c = sc::color_management_of(d);
    REQUIRE(c.management.has_value());
    CHECK(c.management->display_space == api::RenderColorSpace::srgb);
    CHECK_FALSE(c.management->output_space.has_value());
    CHECK_FALSE(c.management->view.has_value());
    return c.management->working_space;
  };
  CHECK(ws(api::ColorWorkingSpace::srgb) == api::RenderColorSpace::linear_srgb);
  CHECK(ws(api::ColorWorkingSpace::rec709) == api::RenderColorSpace::linear_srgb);
  CHECK(ws(api::ColorWorkingSpace::rec2020) == api::RenderColorSpace::linear_rec2020);
  CHECK(ws(api::ColorWorkingSpace::acescct) == api::RenderColorSpace::aces_cg);
}

TEST_CASE("an OCIO config manages even the pipeline's own spaces", "[scene][color]") {
  doc::Document d;
  d.project_mut().ocio_config = "ocio://studio-config-latest";
  auto c = sc::color_management_of(d);
  REQUIRE(c.management.has_value());
  CHECK(c.management->working_space == api::RenderColorSpace::linear_srgb);
  CHECK(c.management->ocio_config == std::optional<std::string>("ocio://studio-config-latest"));
  d.project_mut().working_space = api::ColorWorkingSpace::acescg;
  c = sc::color_management_of(d);
  REQUIRE(c.management.has_value());
  CHECK(c.management->working_space == api::RenderColorSpace::aces_cg);
}

TEST_CASE("viewer display and the output module", "[scene][color]") {
  doc::Document d;
  d.project_mut().working_space = api::ColorWorkingSpace::rec2020;
  d.color_mut().displayTransform = "aces";
  auto c = sc::color_management_of(d, "Rec. 709");
  REQUIRE(c.management.has_value());
  CHECK(c.management->view == std::optional<std::string>("ACES 1.0 - SDR Video"));
  CHECK(c.management->output_space == std::optional<api::RenderColorSpace>(api::RenderColorSpace::rec709));
  // An unknown output space keeps the display and says why.
  c = sc::color_management_of(d, "Cineon Log");
  REQUIRE(c.management.has_value());
  CHECK_FALSE(c.management->output_space.has_value());
  CHECK_FALSE(c.note.empty());
}

TEST_CASE("what RenderColorSpace cannot express stays unmanaged and says so", "[scene][color]") {
  doc::Document d;
  d.project_mut().working_space = api::ColorWorkingSpace::display_p3;
  auto c = sc::color_management_of(d);
  CHECK_FALSE(c.management.has_value());
  CHECK_FALSE(c.note.empty());
  d.project_mut().working_space = api::ColorWorkingSpace::rec2020;
  d.color_mut().displayTransform = "pq";
  c = sc::color_management_of(d);
  CHECK_FALSE(c.management.has_value());
  CHECK(c.note.find("pq") != std::string::npos);
}

TEST_CASE("colour-space names", "[scene][color]") {
  using S = api::RenderColorSpace;
  CHECK(sc::color_space_named("sRGB IEC61966-2.1") == std::optional<S>(S::srgb));
  CHECK(sc::color_space_named("Rec. 709") == std::optional<S>(S::rec709));
  CHECK(sc::color_space_named("Linear sRGB") == std::optional<S>(S::linear_srgb));
  CHECK(sc::color_space_named("ACEScg") == std::optional<S>(S::aces_cg));
  CHECK(sc::color_space_named("rec2020") == std::optional<S>(S::rec2020));
  CHECK(sc::color_space_named("ACES2065-1") == std::optional<S>(S::aces2065));
  CHECK_FALSE(sc::color_space_named("").has_value());
  CHECK_FALSE(sc::color_space_named("Display P3").has_value());
}
