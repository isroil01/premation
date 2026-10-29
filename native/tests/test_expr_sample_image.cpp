// motion_expr — AE `layer.sampleImage(point, radius, postEffect, t)` through a
// fake Host: the defaults (radius [0.5, 0.5], postEffect true, t = time), the
// bare global on this layer, another layer by name, and the errors.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <optional>
#include <string>

#include "expr.hpp"

namespace {

namespace ex = motion::expr;
using Catch::Approx;

/// Answers [x, y, rx + ry, t] for this layer and layer "B" (red, x10 when not
/// post-effect); "Busy" has no pixels; any other layer does not exist.
struct SampleHost final : ex::Host {
  bool lastPost = true;
  std::optional<std::u16string> lastLayer;
  std::optional<ImageSample> sample_image(const std::u16string* layer, std::array<double, 2> point,
                                          std::array<double, 2> radius, bool post_effect, double t) override {
    lastPost = post_effect;
    lastLayer = layer != nullptr ? std::optional<std::u16string>(*layer) : std::nullopt;
    if (layer != nullptr && *layer == u"Busy") return ImageSample{{}, u"sampleImage: the renderer did not draw the layer in time."};
    if (layer != nullptr && *layer != u"B") return std::nullopt;
    const double k = post_effect ? 1 : 10;
    return ImageSample{{point[0] * k, point[1], radius[0] + radius[1], t}, {}};
  }
};

SampleHost& host() {
  static SampleHost h;
  return h;
}

ex::Result run(const std::string& src, double t = 1.5) {
  ex::Context c;
  c.time = t;
  c.host = &host();
  return ex::Expression::compile(ex::utf8_to_utf16(src)).run(c);
}

double num(const std::string& src, double t = 1.5) {
  const ex::Result r = run(src, t);
  INFO(src);
  REQUIRE_FALSE(r.error);
  return r.number;
}

std::string error_of(const std::string& src) {
  const ex::Result r = run(src);
  REQUIRE(r.error);
  return ex::utf16_to_utf8(*r.error);
}

}  // namespace

TEST_CASE("sampleImage reads the host with AE's defaults", "[expr][sampleImage]") {
  CHECK(num("sampleImage([12, 34])[0]") == 12);
  CHECK(num("sampleImage([12, 34])[1]") == 34);
  CHECK(num("sampleImage([12, 34])[2]") == 1);       // radius [0.5, 0.5]
  CHECK(num("sampleImage([12, 34])[3]") == 1.5);     // t = time
  CHECK(host().lastPost);
  CHECK_FALSE(host().lastLayer.has_value());          // the bare global is this layer
  CHECK(num("thisLayer.sampleImage([1, 2], [3, 4], false, 7)[2]") == 7);
  CHECK(num("thisLayer.sampleImage([1, 2], [3, 4], false, 7)[3]") == 7);
  CHECK(num("thisLayer.sampleImage([1, 2], [3, 4], false, 7)[0]") == 10);
  CHECK_FALSE(host().lastPost);
  CHECK(num("sampleImage([5, 6], 2)[2]") == 4);      // a scalar radius is both sides
  CHECK(num("sampleImage([5, 6]).length") == 4);
}

TEST_CASE("sampleImage on another layer", "[expr][sampleImage]") {
  CHECK(num("thisComp.layer(\"B\").sampleImage([8, 9])[0]") == 8);
  REQUIRE(host().lastLayer.has_value());
  CHECK(*host().lastLayer == u"B");
  CHECK(num("var c = thisComp.layer(\"B\").sampleImage([2, 3], [1, 1], true, time + 1); c[3]") == Approx(2.5));
}

TEST_CASE("sampleImage errors", "[expr][sampleImage]") {
  CHECK(error_of("sampleImage()").find("give the point") != std::string::npos);
  CHECK(error_of("sampleImage([1])").find("[x, y]") != std::string::npos);
  CHECK(error_of("sampleImage([1, 2], [-1, 0])").find("radius") != std::string::npos);
  CHECK(error_of("thisComp.layer(\"Busy\").sampleImage([1, 2])").find("in time") != std::string::npos);
  // No host: the evaluation cannot draw.
  ex::Context c;
  const ex::Result r = ex::Expression::compile(u"sampleImage([1, 2])[0]").run(c);
  REQUIRE(r.error);
  CHECK(ex::utf16_to_utf8(*r.error).find("renderer") != std::string::npos);
}
