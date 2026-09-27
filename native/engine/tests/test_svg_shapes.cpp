// convertLayer {shapesFromVector}'s SVG parts (scene/svg_shapes.cpp): the
// viewport, transforms / nested viewports / <use>, shapes as Bézier runs,
// fills (colour, gradient FillPaint), strokes, text and what is not carried.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <string>

#include "svg_shapes.hpp"

using namespace premation;
using Catch::Matchers::WithinAbs;

TEST_CASE("svg shapes: parts in viewport px with their paint", "[svg][shapes]") {
  const std::string svg = R"svg(<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50" width="200" height="100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f" stop-opacity="0.5"/></linearGradient>
      <circle id="dot" r="5" fill="#0f0"/></defs>
    <rect x="10" y="10" width="20" height="10" fill="url(#g)" opacity="0.5"/>
    <g transform="translate(50 25)"><use xlink:href="#dot" x="10"/></g>
    <path d="M0 0 L10 0 L10 10 Z" fill="none" stroke="#000" stroke-width="2"/>
    <text x="0" y="40" font-size="8" fill="#123456">Hello</text>
    <animate attributeName="opacity" to="0" dur="1s"/>
  </svg>)svg";
  std::string why;
  const auto shapes = scene::svg_document_shapes(svg, std::nullopt, why);
  REQUIRE(shapes.has_value());
  CHECK(shapes->width == 200);
  CHECK(shapes->height == 100);
  REQUIRE(shapes->parts.size() == 4);
  const auto& rect = shapes->parts[0];
  // viewBox 100×50 onto 200×100: ×2.
  CHECK_THAT(rect.centerX, WithinAbs(40, 1e-6));
  CHECK_THAT(rect.centerY, WithinAbs(30, 1e-6));
  CHECK_THAT(rect.width, WithinAbs(40, 1e-6));
  CHECK_THAT(rect.opacity, WithinAbs(0.5, 1e-9));
  REQUIRE(rect.fillPaint.is_object());
  CHECK(rect.fillPaint.at("type").str() == "linear");
  CHECK_THAT(rect.fillPaint.at("angle").num(), WithinAbs(90, 1e-9));
  CHECK(rect.fillPaint.at("opacityStops").arr().size() == 2);
  const auto& dot = shapes->parts[1];
  CHECK_THAT(dot.centerX, WithinAbs(120, 1e-4));  // (50 + 10) × 2
  CHECK_THAT(dot.centerY, WithinAbs(50, 1e-4));
  CHECK_THAT(dot.width, WithinAbs(20, 1e-4));
  CHECK(dot.fill == "rgb(0, 255, 0)");
  REQUIRE(dot.runs.size() == 1);
  CHECK(dot.runs[0].points.size() == 4);
  CHECK(dot.runs[0].closed);
  const auto& tri = shapes->parts[2];
  CHECK(tri.fill == "transparent");
  REQUIRE(tri.stroke.is_object());
  CHECK_THAT(tri.stroke.at("width").num(), WithinAbs(4, 1e-9));
  CHECK(tri.runs[0].points.size() == 3);
  const auto& text = shapes->parts[3];
  CHECK(text.kind == doc::SvgPart::Kind::text);
  CHECK(text.text == "Hello");
  CHECK_THAT(text.fontSize, WithinAbs(16, 1e-9));
  CHECK(!shapes->notCarried.empty());

  CHECK_FALSE(scene::svg_document_shapes("<div/>", std::nullopt, why).has_value());
  const auto recoloured = scene::svg_document_shapes(svg, std::string("#ff00ff"), why);
  REQUIRE(recoloured.has_value());
  CHECK(recoloured->parts[1].fill == "rgb(255, 0, 255)");
}
