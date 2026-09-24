// svg_doc (D2w): the Skia-free half of the SVG renderer — XML, the CSS cascade
// Blink applies to SVG, and the path / transform / viewBox micro-syntaxes.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "svg_doc.hpp"

using namespace premation::raster;
using namespace premation::raster::svg;
using Catch::Approx;

namespace {
Document parse(std::string_view s) {
  Document d;
  std::string err;
  REQUIRE(parse_xml(s, d, err));
  return d;
}
int first(const Document& d, std::string_view name) {
  for (std::size_t i = 0; i < d.nodes.size(); ++i) {
    if (d.nodes[i].element && d.nodes[i].name == name) return static_cast<int>(i);
  }
  return -1;
}
}  // namespace

TEST_CASE("svg xml: namespaces, entities, CDATA, errors") {
  const Document d = parse(
      "<?xml version=\"1.0\"?><!-- c --><svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:l=\"http://www.w3.org/1999/xlink\">"
      "<use l:href=\"#a\"/><text>a &amp; &#x41;<![CDATA[<b>]]></text><foo:bar xmlns:foo=\"urn:x\"/></svg>");
  REQUIRE(d.root >= 0);
  CHECK(d.nodes[static_cast<std::size_t>(d.root)].svgNs);
  const int use = first(d, "use");
  REQUIRE(use >= 0);
  CHECK(*d.href(use) == "#a");
  const int text = first(d, "text");
  std::string all;
  for (int k : d.nodes[static_cast<std::size_t>(text)].children) all += d.nodes[static_cast<std::size_t>(k)].text;
  CHECK(all == "a & A<b>");
  CHECK_FALSE(d.nodes[static_cast<std::size_t>(first(d, "bar"))].svgNs);
  Document bad;
  std::string err;
  CHECK_FALSE(parse_xml("<svg><g></svg>", bad, err));
  CHECK_FALSE(parse_xml("<svg>&nbsp;</svg>", bad, err));
}

TEST_CASE("svg path data: normalisation as SVGPathNormalizer emits it") {
  const auto segs = parse_path_data("m10 20 h5 v5 l-5 0 z q 10 -10 20 0 t 20 0");
  REQUIRE(segs.size() == 7);
  CHECK(segs[0].op == PathSeg::Op::move);
  CHECK(segs[1].p[0] == 15.0F);
  CHECK(segs[2].p[1] == 25.0F);
  CHECK(segs[4].op == PathSeg::Op::close);
  // Quadratic → cubic: c1 = p0 + 2/3 (q − p0) from the subpath start (10,20).
  CHECK(segs[5].op == PathSeg::Op::cubic);
  CHECK(segs[5].p[0] == Approx(10 + 2.0 / 3.0 * 10));
  CHECK(segs[5].p[4] == 30.0F);
  // T reflects the previous control point.
  CHECK(segs[6].p[4] == 50.0F);
  // An arc decomposes into cubics ending on the target; an error keeps what came before.
  const auto arc = parse_path_data("M20 50 A 30 20 0 1 1 80 50 L 50 90 Z");
  REQUIRE(arc.size() >= 4);
  const auto& lastArc = arc[arc.size() - 3];
  CHECK(lastArc.op == PathSeg::Op::cubic);
  CHECK(lastArc.p[4] == Approx(80).margin(1e-3));
  CHECK(lastArc.p[5] == Approx(50).margin(1e-3));
  CHECK(parse_path_data("M0 0 L10 10 L x").size() == 2);
  CHECK(parse_path_data("L0 0").empty());
  // Arc flags need no separators.
  CHECK(parse_path_data("M0 0a5 5 0 1010 0").size() >= 2);
}

TEST_CASE("svg transforms, lengths, viewBox") {
  const auto m = parse_transform("translate(10 20) rotate(90) scale(2)");
  REQUIRE(m);
  CHECK(m->a == Approx(0).margin(1e-12));
  CHECK(m->b == Approx(2));
  CHECK(m->e == Approx(10));
  CHECK(m->f == Approx(20));
  const auto r = parse_transform("rotate(45 50 50)");
  REQUIRE(r);
  CHECK(r->a * 50 + r->c * 50 + r->e == Approx(50));
  CHECK_FALSE(parse_transform("translate(10,"));
  CHECK_FALSE(parse_transform("frobnicate(1)"));
  const auto l = parse_length("50%");
  REQUIRE(l);
  CHECK(resolve(*l, 200, 16) == Approx(100));
  CHECK(resolve(*parse_length("1in"), 0, 16) == Approx(96));
  CHECK_FALSE(parse_length("12 px"));
  const auto vb = parse_view_box("0 0 200 100");
  REQUIRE(vb);
  const Mat2D slice = view_box_transform(*vb, parse_aspect_ratio("xMidYMid slice"), 100, 100);
  CHECK(slice.a == Approx(1));
  CHECK(slice.e == Approx(-50));
  const Mat2D meet = view_box_transform(*vb, parse_aspect_ratio(""), 100, 100);
  CHECK(meet.a == Approx(0.5));
  CHECK(meet.f == Approx(25));
  CHECK_FALSE(parse_view_box("0 0 -1 10"));
}

TEST_CASE("svg cascade: presentation < rules by specificity < style, !important, inheritance") {
  Document d = parse(
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>rect { fill: red } .a { fill: #00ff00; stroke-width: 4 }"
      " #t { fill: blue } g > .b { fill: yellow !important } :hover { fill: black }</style>"
      "<g fill=\"#123456\" stroke=\"url(#grad) none\" opacity=\"0.5\">"
      "<rect class=\"a\" fill=\"black\"/><rect id=\"t\" class=\"a\" style=\"fill: white\"/>"
      "<rect class=\"b\" style=\"fill: white\"/><circle/></g></svg>");
  expand_uses(d);
  std::vector<svg::Style> st;
  std::vector<std::string> unsupported;
  compute_styles(d, "", st, unsupported);
  std::vector<int> rects;
  for (std::size_t i = 0; i < d.nodes.size(); ++i) {
    if (d.nodes[i].element && d.nodes[i].name == "rect") rects.push_back(static_cast<int>(i));
  }
  REQUIRE(rects.size() == 3);
  const auto col = [&](int i) { return st[static_cast<std::size_t>(i)].fill.color; };
  CHECK(col(rects[0]) == css::Color{0, 255, 0, 1});
  CHECK(st[static_cast<std::size_t>(rects[0])].strokeWidth.v == 4);
  CHECK(col(rects[1]) == css::Color{255, 255, 255, 1});
  CHECK(col(rects[2]) == css::Color{255, 255, 0, 1});
  const int circle = first(d, "circle");
  CHECK(col(circle) == css::Color{0x12, 0x34, 0x56, 1});                      // inherited
  CHECK(st[static_cast<std::size_t>(circle)].opacity == 1.0);                // not inherited
  CHECK(st[static_cast<std::size_t>(circle)].stroke.kind == Paint::Kind::url);
  CHECK(st[static_cast<std::size_t>(circle)].stroke.url == "grad");
  CHECK(st[static_cast<std::size_t>(circle)].stroke.fallback == Paint::Kind::none);
  CHECK(std::ranges::find(unsupported, "CSS selector :hover") == unsupported.end());  // never matches: skipped silently
}

TEST_CASE("svg use: the shadow tree is a clone invisible to getElementById, cycles stay empty") {
  Document d = parse(
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><defs><g id=\"a\"><rect id=\"r\"/><use href=\"#a\"/></g></defs>"
      "<use id=\"u\" href=\"#a\"/></svg>");
  const std::size_t before = d.nodes.size();
  expand_uses(d);
  CHECK(d.nodes.size() > before);
  CHECK(d.by_id("r") < static_cast<int>(before));
  const int u = d.by_id("u");
  REQUIRE(d.nodes[static_cast<std::size_t>(u)].children.size() == 1);
  CHECK(d.nodes[static_cast<std::size_t>(d.nodes[static_cast<std::size_t>(u)].children[0])].shadow);
}

TEST_CASE("svg data urls") {
  std::string mime;
  const auto b = data_url_bytes("data:image/png;base64,iVBORw0K", &mime);
  REQUIRE(b);
  CHECK(mime == "image/png");
  CHECK((*b)[1] == 'P');
  const auto p = data_url_bytes("data:text/plain,a%20b");
  REQUIRE(p);
  CHECK(std::string(p->begin(), p->end()) == "a b");
}
