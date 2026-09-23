// E3 raster module, Skia-free half: JSON + CSS value parsing.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>

#include "raster/css.hpp"
#include "raster/json.hpp"

using namespace premation::raster;

TEST_CASE("json: numbers round-trip bit-exactly and structures parse", "[raster][json]") {
  json::Value v;
  std::string err;
  REQUIRE(json::parse(R"({"a":[1,-2.5,1e-7,183.4765625,0.1],"b":{"c":"xé😀"},"t":true,"n":null})", v, err));
  CHECK(v["a"][3].num() == 183.4765625);
  CHECK(v["a"][4].num() == 0.1);
  CHECK(v["a"][2].num() == 1e-7);
  CHECK(v["b"]["c"].str() == "x\xC3\xA9\xF0\x9F\x98\x80");
  CHECK(v["t"].truthy());
  CHECK(v["n"].is_null());
  CHECK(v["missing"]["deeper"].is_null());
  CHECK_FALSE(json::parse("[1,2", v, err));
  CHECK_FALSE(json::parse("{\"a\":1} x", v, err));
}

TEST_CASE("css: colours as Blink parses them", "[raster][css]") {
  const auto hex = css::parse_color("#f4f4f8");
  REQUIRE(hex);
  CHECK(hex->r == 0xf4);
  CHECK(hex->b == 0xf8);
  CHECK(hex->a == 1.0);
  const auto short4 = css::parse_color("#1234");
  REQUIRE(short4);
  CHECK(short4->r == 0x11);
  CHECK(short4->a == 0x44 / 255.0);
  const auto rgba = css::parse_color("rgba(255, 128, 0, 0.500)");
  REQUIRE(rgba);
  CHECK(rgba->g == 128);
  CHECK(rgba->a == 0.5);
  CHECK(css::parse_color("rebeccapurple")->r == 0x66);
  CHECK(css::parse_color("  WHITE ")->b == 255);
  CHECK(css::parse_color("transparent")->a == 0);
  CHECK(css::parse_color("hsl(120, 100%, 50%)")->g == 255);
  CHECK_FALSE(css::parse_color("var(--x)"));
  CHECK_FALSE(css::parse_color("#12345"));
  CHECK_FALSE(css::parse_color("undefined"));
}

TEST_CASE("css: the font shorthand the TS painters build", "[raster][css]") {
  const auto f = css::parse_font("600 56px \"Arial\", Inter, system-ui, sans-serif");
  REQUIRE(f);
  CHECK(f->weight == 600);
  CHECK(f->sizePx == 56);
  REQUIRE(f->families.size() == 4);
  CHECK(f->families[0] == "Arial");
  CHECK(f->families[3] == "sans-serif");
  const auto g = css::parse_font("italic small-caps 400 12.5px 'My Font'");
  REQUIRE(g);
  CHECK(g->italic);
  CHECK(g->smallCaps);
  CHECK(g->sizePx == 12.5);
  CHECK(g->families[0] == "My Font");
  CHECK_FALSE(css::parse_font("bold"));
}

TEST_CASE("css: lengths, filters, unicode ranges", "[raster][css]") {
  CHECK(*css::parse_length_px("3px", 10) == 3);
  CHECK(*css::parse_length_px("0", 10) == 0);
  CHECK(*css::parse_length_px("-1.5px", 10) == -1.5);
  CHECK(*css::parse_length_px("0.5em", 10) == 5);
  CHECK(css::parse_filter("blur(4px)")->blurPx == 4);
  CHECK(css::parse_filter("none")->blurPx == 0);
  CHECK_FALSE(css::parse_filter("drop-shadow(1px 1px 1px red)"));
  const auto r = css::parse_unicode_range("U+0600-06FF, U+FB50-FDFF, U+0020");
  REQUIRE(r.size() == 3);
  CHECK(r[0].lo == 0x600);
  CHECK(r[0].hi == 0x6FF);
  CHECK(r[2].lo == 0x20);
  CHECK(r[2].hi == 0x20);
}
