// svg_anim: animated SVG (SMIL and CSS animations) sampled at a document time,
// and the import facts of an SVG file (svg_render.hpp svg_facts).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <string>

#include "svg_anim.hpp"
#include "svg_doc.hpp"
#include "svg_render.hpp"

using namespace premation::raster::svg;
using Catch::Approx;

namespace {

Document parse(std::string_view s) {
  Document d;
  std::string err;
  REQUIRE(parse_xml(s, d, err));
  return d;
}

int by_id(const Document& d, std::string_view id) { return d.by_id(id); }

std::string attr(const Document& d, std::string_view id, std::string_view name) {
  const int n = by_id(d, id);
  REQUIRE(n >= 0);
  const std::string* v = d.nodes[static_cast<std::size_t>(n)].attr(name);
  return v != nullptr ? *v : std::string();
}

/// The document at `t`: its CSS additions returned, the attributes changed in place.
std::string at(Document& d, double t) {
  std::string css;
  std::vector<std::string> unsupported;
  apply_animations(d, t, css, unsupported);
  return css;
}

constexpr std::string_view kSmil = R"svg(<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
  <circle id="c" cx="40" cy="90" r="30" fill="red">
    <animate attributeName="cx" from="40" to="280" dur="2s" repeatCount="indefinite"/>
    <animate attributeName="fill" values="#ff0000;#0000ff" dur="2s" repeatCount="indefinite"/>
  </circle>
  <rect id="r" x="0" y="0" width="10" height="10" transform="translate(5 5)">
    <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="4s" fill="freeze"/>
  </rect>
  <rect id="late" x="0" y="0" width="10" height="10">
    <set attributeName="width" to="99" begin="3s"/>
  </rect>
</svg>)svg";

}  // namespace

TEST_CASE("svg anim: SMIL values interpolate at the document time, loop, and freeze") {
  {
    Document d = parse(kSmil);
    (void)at(d, 1.0);
    CHECK(std::stod(attr(d, "c", "cx")) == Approx(160));
    CHECK(attr(d, "c", "fill") == "rgba(128,0,128,1)");
    // A CSS property also goes in as inline style, so a <style> rule cannot beat the animation.
    CHECK(attr(d, "c", "style").find("fill:rgba(128,0,128,1)") != std::string::npos);
    // animateTransform replaces the element's own transform while it runs.
    CHECK(attr(d, "r", "transform") == "rotate(90 50 50)");
    // <set> has not begun.
    CHECK(attr(d, "late", "width") == "10");
  }
  {
    Document d = parse(kSmil);
    (void)at(d, 3.0);  // repeatCount indefinite: 1 s into the second pass
    CHECK(std::stod(attr(d, "c", "cx")) == Approx(160));
    CHECK(attr(d, "late", "width") == "99");
  }
  {
    Document d = parse(kSmil);
    (void)at(d, 10.0);  // fill="freeze": the end value holds
    CHECK(attr(d, "r", "transform") == "rotate(360 50 50)");
  }
}

TEST_CASE("svg anim: syncbase chains, keyTimes, discrete and spline modes") {
  constexpr std::string_view chain = R"svg(<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
    <rect id="a" x="0" width="1" height="1"><animate id="one" attributeName="x" from="0" to="10" dur="1s" begin="0s;two.end"/></rect>
    <rect id="b" x="0" width="1" height="1"><animate id="two" attributeName="x" from="0" to="20" dur="1s" begin="one.end"/></rect>
    <rect id="k" x="0" width="1" height="1"><animate attributeName="x" values="0;10;100" keyTimes="0;0.8;1" dur="1s"/></rect>
    <rect id="d" x="0" width="1" height="1"><animate attributeName="x" values="1;2;3" calcMode="discrete" dur="3s"/></rect>
    <rect id="s" x="0" width="1" height="1"><animate attributeName="x" values="0;100" calcMode="spline" keySplines="0 0 1 1" dur="1s"/></rect>
  </svg>)svg";
  Document d = parse(chain);
  (void)at(d, 2.5);  // one ran 0–1, two 1–2, one again 2–3
  CHECK(std::stod(attr(d, "a", "x")) == Approx(5));
  CHECK(attr(d, "b", "x") == "0");  // two is between its runs (no freeze): the base value
  Document k = parse(chain);
  (void)at(k, 0.4);
  CHECK(std::stod(attr(k, "k", "x")) == Approx(5));      // halfway to keyTime 0.8
  CHECK(attr(k, "d", "x") == "1");                        // discrete: the first third
  CHECK(std::stod(attr(k, "s", "x")) == Approx(40).margin(0.5));  // linear spline
}

TEST_CASE("svg anim: CSS @keyframes become rules, transforms the transform attribute about the origin") {
  constexpr std::string_view css = R"svg(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
    <style>
      .spin { transform-origin: 160px 90px; animation: spin 2s linear infinite; }
      .pulse { animation: pulse 1s linear infinite alternate; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes pulse { 0% { opacity: 1; } 100% { opacity: 0.2; } }
    </style>
    <rect id="sq" class="spin" x="130" y="60" width="60" height="60"/>
    <circle id="dot" class="pulse" cx="60" cy="90" r="30"/>
  </svg>)svg";
  Document d = parse(css);
  const std::string extra = at(d, 1.5);
  CHECK(attr(d, "sq", "transform") == "translate(160 90) rotate(270) translate(-160 -90)");
  // alternate: the second iteration runs backwards, half way = 0.6.
  CHECK(extra.find(".pulse{opacity:0.6 !important;}") != std::string::npos);
  // The @keyframes blocks are gone from the <style> text the cascade reads.
  for (const Node& n : d.nodes) {
    if (!n.element) CHECK(n.text.find("@keyframes") == std::string::npos);
  }
}

TEST_CASE("svg facts: size from width / height or the viewBox, animation length") {
  const SvgFacts plain = svg_facts(R"svg(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="1" height="1"/></svg>)svg");
  REQUIRE(plain.ok);
  CHECK(plain.width == Approx(64));
  CHECK(plain.height == Approx(32));
  CHECK_FALSE(plain.animated);
  const SvgFacts moving = svg_facts(kSmil);
  REQUIRE(moving.ok);
  CHECK(moving.width == Approx(320));
  CHECK(moving.animated);
  CHECK(moving.durationSec == Approx(4));  // the freezing rotation's 4 s (the looping ones count one 2 s pass)
  CHECK_FALSE(svg_facts("<html/>").ok);
  CHECK_FALSE(svg_facts("<svg").ok);
}
