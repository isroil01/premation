// SDK 1.1 parameter types (plan P6): STRING, CURVE, GRADIENT and FILE reach a
// plugin as declared and as the document stores them, through the chain entry
// (fx_wire) as through the host; a FILE param's bytes come from get_asset_bytes
// and a missing file is a skipped input, never a failed render.
//
// The `grademap` sample is the probe: luma → Tone Curve → Gradient (→ a 1D
// .cube LUT from the FILE param), written to the channels named by Channels.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "cpu_render.hpp"
#include "fx_wire.hpp"
#include "host.hpp"
#include "native_effects.hpp"

namespace pl = premation::plugins;
namespace api = premation::api;
namespace doc = premation::doc;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

constexpr const char* kGradeMap = "com.premation.samples.grademap";
constexpr std::uint32_t kW = 8, kH = 4;
enum : std::uint32_t { kChannels = 1, kCurve = 2, kGradient = 3, kLut = 4, kMix = 5 };

pl::HostOptions opts() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

/// An opaque mid-grey image (8 bpc).
pl::TexelImage grey(std::uint8_t level = 128) {
  pl::TexelImage img;
  img.format = pl::TexelFormat::rgba8;
  img.width = kW;
  img.height = kH;
  img.bytes.assign(std::size_t{kW} * kH * 4, level);
  for (std::size_t i = 3; i < img.bytes.size(); i += 4) img.bytes[i] = 255;
  return img;
}

std::array<int, 3> px(const pl::TexelImage& img) { return {img.bytes[0], img.bytes[1], img.bytes[2]}; }

const pl::ParamSpec& spec_of(const pl::EffectSpec& e, std::uint32_t id) {
  for (const auto& s : e.params) {
    if (s.id == id) return s;
  }
  FAIL("no param " << id);
  return e.params.front();
}

}  // namespace

TEST_CASE("SDK 1.1 params: declared defaults", "[plugins][params]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kGradeMap);
  REQUIRE(spec != nullptr);
  CHECK(spec_of(*spec, kChannels).type == PR_PARAM_STRING);
  CHECK(spec_of(*spec, kChannels).text == "rgb");
  CHECK(spec_of(*spec, kCurve).curve == std::vector<double>{0, 0, 0.5, 0.5, 1, 1});
  CHECK(spec_of(*spec, kGradient).gradient == std::vector<double>{0, 0, 0, 0, 1, 1, 1, 1, 1, 1});
  CHECK(spec_of(*spec, kLut).fileTypes == "cube");
  // Never keyframed.
  for (const std::uint32_t id : {kChannels, kCurve, kGradient, kLut}) CHECK((spec_of(*spec, id).flags & PR_PARAM_FLAG_CANNOT_ANIMATE) != 0);
}

TEST_CASE("SDK 1.1 params: values reach the render", "[plugins][params]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kGradeMap);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kW, kH, 8);
  const auto slot = [&](std::uint32_t id) { return static_cast<std::size_t>(pl::param_slot(*spec, id)); };

  // Defaults: identity curve, black → white: grey stays (about) grey.
  pl::TexelImage out;
  REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);
  for (const int c : px(out)) CHECK(std::abs(c - 128) <= 2);

  SECTION("a gradient maps luma to colour, only on the named channels") {
    in.values[slot(kGradient)].gradient = {0, 1, 0, 0, 1, 1, 1, 0, 0, 1};  // all red
    REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);
    CHECK(px(out) == std::array<int, 3>{255, 0, 0});
    in.values[slot(kChannels)].text = "g";
    REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);
    const auto p = px(out);
    CHECK(std::abs(p[0] - 128) <= 1);  // r untouched
    CHECK(p[1] == 0);                  // g mapped (red has no green)
    CHECK(std::abs(p[2] - 128) <= 1);
  }

  SECTION("a curve bends luma before the gradient") {
    in.values[slot(kCurve)].curve = {0, 1, 1, 1};  // everything to white
    REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);
    for (const int c : px(out)) CHECK(c == 255);
  }

  SECTION("a FILE param's bytes through get_asset_bytes; a missing file is skipped") {
    const fs::path dir = fs::temp_directory_path() / "premation-p6-params";
    fs::create_directories(dir);
    const fs::path cube = dir / "blue.cube";
    {
      std::ofstream f(cube);
      f << "# test\nLUT_1D_SIZE 2\n0 0 0\n0 0 1\n";
    }
    pl::ParamValue& lut = in.values[slot(kLut)];
    lut.fileItem = "item_lut";
    lut.filePath = cube.string();
    lut.fileName = "blue.cube";
    REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);
    const auto p = px(out);
    CHECK(p[0] == 0);
    CHECK(p[1] == 0);
    CHECK(std::abs(p[2] - 128) <= 2);  // r, g → 0; b passes 0..1 straight through

    lut.filePath.clear();
    lut.fileMissing = true;
    REQUIRE(pl::run_native_cpu(host, in, grey(), {}, out).ok);  // not an error: the LUT is skipped
    for (const int c : px(out)) CHECK(std::abs(c - 128) <= 2);
    fs::remove_all(dir);
  }
}

TEST_CASE("SDK 1.1 params: the chain entry carries them", "[plugins][params]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kGradeMap);
  REQUIRE(spec != nullptr);
  api::RenderEffect e;
  e.type = std::string(pl::kNativeFxType);
  const auto text = [&](std::string name, std::string v) {
    api::RenderEffectParam p;
    p.name = std::move(name);
    p.kind = api::RenderParamKind::text;
    p.text = std::move(v);
    e.params.push_back(std::move(p));
  };
  const auto nums = [&](std::string name, std::vector<double> v) {
    api::RenderEffectParam p;
    p.name = std::move(name);
    p.kind = api::RenderParamKind::numbers;
    p.numbers = std::move(v);
    e.params.push_back(std::move(p));
  };
  text("p.p1", "b");
  nums("p.p2", {0, 0.2, 1, 0.8});
  nums("p.p3", {0, 0, 0, 1, 1});
  text("p.p4", "item_9");
  doc::NativeActionRequest::File f;
  f.key = "p4";
  f.item = "item_9";
  f.path = "/somewhere/a.cube";
  f.name = "a.cube";
  pl::encode_native_file(e, f);

  pl::RenderInputs in;
  pl::decode_native_fx(e, *spec, in);
  const auto& v = in.values;
  CHECK(v[static_cast<std::size_t>(pl::param_slot(*spec, kChannels))].text == "b");
  CHECK(v[static_cast<std::size_t>(pl::param_slot(*spec, kCurve))].curve == std::vector<double>{0, 0.2, 1, 0.8});
  CHECK(v[static_cast<std::size_t>(pl::param_slot(*spec, kGradient))].gradient == std::vector<double>{0, 0, 0, 1, 1});
  const pl::ParamValue& file = v[static_cast<std::size_t>(pl::param_slot(*spec, kLut))];
  CHECK(file.fileItem == "item_9");
  CHECK(file.filePath == "/somewhere/a.cube");
  CHECK(file.fileName == "a.cube");
  CHECK_FALSE(file.fileMissing);

  // Absent entries: the declared defaults.
  pl::RenderInputs bare;
  api::RenderEffect empty;
  pl::decode_native_fx(empty, *spec, bare);
  CHECK(bare.values[static_cast<std::size_t>(pl::param_slot(*spec, kChannels))].text == "rgb");
  CHECK(bare.values[static_cast<std::size_t>(pl::param_slot(*spec, kCurve))].curve.size() == 6);
}

TEST_CASE("SDK 1.1 params: the document's curve and gradient forms", "[plugins][params]") {
  // The Curves effect's form (0..255), sorted, clamped; unreadable → identity.
  CHECK(doc::native_curve(Json::array({Json::array({Json::number(255), Json::number(0)}), Json::array({Json::number(0), Json::number(255)})})) ==
        std::vector<double>{0, 1, 1, 0});
  CHECK(doc::native_curve(Json::string("x")) == std::vector<double>{0, 0, 1, 1});
  CHECK(doc::native_curve(Json::array({Json::array({Json::number(-50), Json::number(999)}), Json::array({Json::number(255), Json::number(255)})})) ==
        std::vector<double>{0, 1, 1, 1});
  CHECK(doc::native_curve_json({0, 0.5, 1, 1}) == Json::array({Json::array({Json::number(0), Json::number(127.5)}), Json::array({Json::number(255), Json::number(255)})}));
  // Stops by position; a malformed stop is dropped; none → black → white.
  CHECK(doc::native_gradient(Json::array({Json::array({Json::number(1), Json::number(1), Json::number(0), Json::number(0), Json::number(1)}),
                                          Json::array({Json::number(0)}),
                                          Json::array({Json::number(0), Json::number(0), Json::number(0), Json::number(1), Json::number(1)})})) ==
        std::vector<double>{0, 0, 0, 1, 1, 1, 1, 0, 0, 1});
  CHECK(doc::native_gradient(Json()) == std::vector<double>{0, 0, 0, 0, 1, 1, 1, 1, 1, 1});
}
