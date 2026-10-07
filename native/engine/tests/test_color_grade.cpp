// AE parity 5.1: the colour effects past their LUT — Lumetri's curves, wheels,
// creative tints, saturation / vibrance, Hue / Luma vs curves, HSL Secondary
// and vignette; Levels' individual controls; Hue/Saturation's colour ranges and
// Colorize. Neutral params keep each effect on its old route.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "effects/effect_chain.hpp"
#include "raster/json.hpp"

using premation::effects::apply_color_grade;
using premation::effects::build_channel_lut;
using premation::effects::color_grade_needs_pixels;
using premation::effects::RgbaView;
using premation::raster::json::Value;

namespace {

Value params(const std::string& json) {
  Value v;
  std::string err;
  REQUIRE(premation::raster::json::parse(json, v, err));
  return v;
}

struct Image {
  int w, h;
  std::vector<std::uint8_t> px;
  Image(int w_, int h_, std::array<std::uint8_t, 4> c) : w(w_), h(h_), px(static_cast<std::size_t>(w_ * h_ * 4)) {
    for (std::size_t i = 0; i < px.size(); i += 4) {
      for (std::size_t k = 0; k < 4; ++k) px[i + k] = c[k];
    }
  }
  RgbaView view() { return {std::span<std::uint8_t>(px), w, h}; }
  [[nodiscard]] std::array<int, 4> at(int x, int y) const {
    const std::size_t i = (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4;
    return {px[i], px[i + 1], px[i + 2], px[i + 3]};
  }
};

}  // namespace

TEST_CASE("colour grades: neutral params keep the LUT / CSS route", "[effects][color]") {
  CHECK_FALSE(color_grade_needs_pixels("lumetri", params(R"({"exposure":1,"saturation":100,"hueVsSat":[[0,128],[255,128]]})")));
  CHECK_FALSE(color_grade_needs_pixels("levels", params(R"({"inputBlack":10,"redGamma":2})")));
  CHECK_FALSE(color_grade_needs_pixels("hue-saturation", params(R"({"hue":30,"saturation":20})")));
  CHECK(color_grade_needs_pixels("lumetri", params(R"({"saturation":50})")));
  CHECK(color_grade_needs_pixels("lumetri", params(R"({"vignetteAmount":-40})")));
  CHECK(color_grade_needs_pixels("lumetri", params(R"({"hueVsSat":[[0,40],[255,128]]})")));
  CHECK(color_grade_needs_pixels("levels", params(R"({"alphaOutputWhite":128})")));
  CHECK(color_grade_needs_pixels("hue-saturation", params(R"({"colorize":true})")));
  CHECK(color_grade_needs_pixels("hue-saturation", params(R"({"redsSaturation":-100})")));
  // A Lumetri written before these controls existed builds the same table.
  const auto before = build_channel_lut("lumetri", params(R"({"exposure":0.5,"contrast":20})"));
  const auto after = build_channel_lut("lumetri", params(
      R"({"exposure":0.5,"contrast":20,"rgbCurve":[[0,0],[255,255]],"shadowsAmount":0,"fadedFilm":0,"shadowTintAmount":0})"));
  CHECK(before.r == after.r);
  CHECK(before.g == after.g);
  CHECK(before.b == after.b);
}

TEST_CASE("Lumetri: curves, wheels and faded film shape the per-channel LUT", "[effects][color]") {
  const auto curve = build_channel_lut("lumetri", params(R"({"rgbCurve":[[0,0],[128,200],[255,255]]})"));
  CHECK(curve.r[128] > 180);
  CHECK(curve.g[128] == curve.r[128]);
  const auto red = build_channel_lut("lumetri", params(R"({"redCurve":[[0,0],[255,128]]})"));
  CHECK(red.r[255] < 140);
  CHECK(red.g[255] == 255);
  // A blue shadows wheel lifts blue (and lowers red) in the shadows, barely in the highlights.
  const auto wheel = build_channel_lut("lumetri", params(R"({"shadowsHue":240,"shadowsAmount":100})"));
  CHECK(wheel.b[30] > 30);
  CHECK(wheel.r[30] < 30);
  CHECK(wheel.b[250] - 250 < wheel.b[30] - 30);
  const auto faded = build_channel_lut("lumetri", params(R"({"fadedFilm":100})"));
  CHECK(faded.r[0] > 30);
  CHECK(faded.r[255] >= 250);
}

TEST_CASE("Lumetri: saturation, Hue vs Saturation, HSL Secondary and vignette", "[effects][color]") {
  {
    Image img(4, 4, {200, 40, 40, 255});
    apply_color_grade("lumetri", params(R"({"saturation":0})"), img.view(), nullptr);
    const auto c = img.at(1, 1);
    CHECK(std::abs(c[0] - c[1]) <= 1);
    CHECK(std::abs(c[1] - c[2]) <= 1);
    CHECK(c[3] == 255);
  }
  {
    // Hue vs Sat pulled down at red (x = 0) desaturates red, leaves blue alone.
    Image redImg(2, 2, {220, 30, 30, 255});
    Image blueImg(2, 2, {30, 30, 220, 255});
    const Value p = params(R"({"hueVsSat":[[0,0],[60,128],[255,128]]})");
    apply_color_grade("lumetri", p, redImg.view(), nullptr);
    apply_color_grade("lumetri", p, blueImg.view(), nullptr);
    CHECK(std::abs(redImg.at(0, 0)[0] - redImg.at(0, 0)[1]) < 20);
    CHECK(blueImg.at(0, 0)[2] > 200);
    CHECK(blueImg.at(0, 0)[0] < 40);
  }
  {
    // HSL Secondary, Show Mask: a red key is white over red, black over green.
    Image red(2, 2, {220, 30, 30, 255});
    Image green(2, 2, {30, 220, 30, 255});
    const Value p = params(R"({"hslEnable":true,"hslShowMask":true,"hslHue":0,"hslHueRange":20,"hslHueSoftness":10})");
    apply_color_grade("lumetri", p, red.view(), nullptr);
    apply_color_grade("lumetri", p, green.view(), nullptr);
    CHECK(red.at(0, 0)[0] > 240);
    CHECK(green.at(0, 0)[0] < 10);
    // Correction only where keyed: desaturate the reds.
    Image red2(2, 2, {220, 30, 30, 255});
    Image green2(2, 2, {30, 220, 30, 255});
    const Value q = params(R"({"hslEnable":true,"hslHue":0,"hslHueRange":20,"hslHueSoftness":10,"hslSaturation":0})");
    apply_color_grade("lumetri", q, red2.view(), nullptr);
    apply_color_grade("lumetri", q, green2.view(), nullptr);
    CHECK(std::abs(red2.at(0, 0)[0] - red2.at(0, 0)[1]) <= 2);
    CHECK(green2.at(0, 0)[1] > 200);
  }
  {
    Image img(64, 64, {200, 200, 200, 255});
    apply_color_grade("lumetri", params(R"({"vignetteAmount":-100,"vignetteMidpoint":30,"vignetteFeather":30})"), img.view(), nullptr);
    CHECK(img.at(32, 32)[0] == 200);
    CHECK(img.at(0, 0)[0] < 60);
  }
}

TEST_CASE("Levels: individual channel controls and the alpha channel", "[effects][color]") {
  // Params arrive resolved (paramsOf: the registry defaults under the stored values).
  const auto lut = build_channel_lut("levels", params(R"({"inputBlack":0,"inputWhite":255,"gamma":1,"outputBlack":0,"outputWhite":255,"redOutputWhite":128})"));
  CHECK(lut.r[255] == 128);
  CHECK(lut.g[255] == 255);
  // The master levels run first, then the channel's own.
  const auto both = build_channel_lut("levels", params(R"({"inputBlack":0,"inputWhite":255,"gamma":1,"outputBlack":0,"outputWhite":128,"blueOutputWhite":128})"));
  CHECK(both.g[255] == 128);
  CHECK(both.b[255] == 64);
  Image img(2, 2, {255, 255, 255, 255});
  apply_color_grade("levels", params(R"({"inputBlack":0,"inputWhite":255,"gamma":1,"outputBlack":0,"outputWhite":255,"alphaOutputWhite":128,"greenOutputBlack":100})"), img.view(), nullptr);
  CHECK(img.at(0, 0)[3] == 128);
  CHECK(img.at(0, 0)[1] == 255);
  CHECK(img.at(0, 0)[0] == 255);
}

TEST_CASE("Hue/Saturation: colour ranges and Colorize", "[effects][color]") {
  Image red(2, 2, {220, 30, 30, 255});
  Image green(2, 2, {30, 220, 30, 255});
  const Value ranges = params(R"({"redsSaturation":-100})");
  apply_color_grade("hue-saturation", ranges, red.view(), nullptr);
  apply_color_grade("hue-saturation", ranges, green.view(), nullptr);
  CHECK(std::abs(red.at(0, 0)[0] - red.at(0, 0)[1]) <= 1);
  CHECK(green.at(0, 0)[1] > 200);
  CHECK(green.at(0, 0)[0] < 40);
  // Colorize: every pixel takes the hue; a mid grey becomes a blue.
  Image grey(2, 2, {128, 128, 128, 200});
  apply_color_grade("hue-saturation", params(R"({"colorize":true,"colorizeHue":240,"colorizeSaturation":80})"), grey.view(), nullptr);
  const auto c = grey.at(0, 0);
  CHECK(c[2] > c[0] + 60);
  CHECK(c[3] == 200);
}
