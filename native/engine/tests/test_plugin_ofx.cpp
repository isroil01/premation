// SDK 1.4 (O): an OpenFX plugin, hosted out of process. The `ofxinvert` sample (Invert.ofx.bundle,
// written against the OFX C API only) in a real premation-plugin-host:
//
//   * the bundle is found by the scan and loaded out of process only (row O2);
//   * its effect is `ofx:<identifier>`, its params map onto Premation params (double → slider,
//     boolean → checkbox, RGB → colour, choice → popup, groups → Effect Controls groups);
//   * a render through it inverts the picture as the plugin's maths says.
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <string>

#include "cpu_render.hpp"
#include "host.hpp"
#include "plugin_host_channel.hpp"

#if defined(PREMATION_HAVE_OFX_SAMPLE)

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kInvert = "ofx:com.premation.samples.ofxinvert";

pl::HostOptions ofx_opts(bool withChild) {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "ofx"};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) {};
  if (withChild) {
    o.spawnOutOfProcess = [](const fs::path& bundle, std::string& error) {
      return premation::exporter::spawn_plugin_host(fs::path(PREMATION_PLUGIN_HOST_EXE), bundle, fs::temp_directory_path() / "premation-ofx-test.log", error);
    };
  }
  return o;
}

const pl::ParamSpec* param_named(const pl::EffectSpec& e, std::string_view name) {
  for (const pl::ParamSpec& s : e.params) {
    if (s.name == name) return &s;
  }
  return nullptr;
}

}  // namespace

TEST_CASE("OpenFX: a bundle is hosted out of process; its params map onto Premation's", "[plugins][ofx]") {
  pl::PluginHost host(ofx_opts(true));
  host.scan();
  const pl::EffectSpec* spec = host.effect(kInvert);
  REQUIRE(spec != nullptr);
  CHECK(host.out_of_process(kInvert));
  CHECK(spec->main == nullptr);
  CHECK(spec->name == "OFX Invert");
  CHECK(spec->category == "Premation Samples");
  CHECK(spec->version == PR_VERSION(1, 0, 0));  // O3: the plugin's pluginVersionMajor / Minor
  const pl::ParamSpec* amount = param_named(*spec, "Amount");
  REQUIRE(amount != nullptr);
  CHECK(amount->type == PR_PARAM_FLOAT_SLIDER);
  CHECK(amount->def[0] == 1.0);
  CHECK(amount->validMax == 1.0);
  CHECK(amount->description == "How far toward the inverted colour.");
  const pl::ParamSpec* alpha = param_named(*spec, "Invert Alpha");
  REQUIRE(alpha != nullptr);
  CHECK(alpha->type == PR_PARAM_CHECKBOX);
  CHECK(alpha->group == "Advanced");
  const pl::ParamSpec* tint = param_named(*spec, "Tint");
  REQUIRE(tint != nullptr);
  CHECK(tint->type == PR_PARAM_COLOR);
  const pl::ParamSpec* mode = param_named(*spec, "Mode");
  REQUIRE(mode != nullptr);
  CHECK(mode->type == PR_PARAM_POPUP);
  CHECK(mode->choices == std::vector<std::string>{"Colour", "Luma"});
  CHECK(mode->def[0] == 1.0);  // OFX index 0 → Premation's 1-based popup

  // Without a plugin host process the bundle is listed, never loaded here.
  pl::PluginHost noChild(ofx_opts(false));
  noChild.scan();
  CHECK(noChild.effect(kInvert) == nullptr);
  bool listed = false;
  for (const pl::PluginRecord& r : noChild.plugins()) {
    if (r.id != "ofx.invert") continue;
    listed = true;
    CHECK(r.status == pl::PluginStatus::failed);
    CHECK(r.error.find("out of process only") != std::string::npos);
  }
  CHECK(listed);
}

TEST_CASE("OpenFX: a render through the plugin", "[plugins][ofx]") {
  pl::PluginHost host(ofx_opts(true));
  host.scan();
  const pl::EffectSpec* spec = host.effect(kInvert);
  REQUIRE(spec != nullptr);
  constexpr std::uint32_t kW = 8, kH = 4;
  pl::TexelImage input;
  input.format = pl::TexelFormat::rgba8;
  input.width = kW;
  input.height = kH;
  input.bytes.resize(std::size_t{kW} * kH * 4);
  for (std::size_t i = 0; i < std::size_t{kW} * kH; ++i) {
    input.bytes[i * 4] = 255;  // opaque red
    input.bytes[i * 4 + 1] = 0;
    input.bytes[i * 4 + 2] = 0;
    input.bytes[i * 4 + 3] = 255;
  }
  input.bytes[0] = 0;  // the first pixel (top-left) green, to catch a flipped image
  input.bytes[1] = 255;
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kW, kH, 8);
  pl::TexelImage out;
  pl::CallResult r = pl::run_native_cpu(host, in, input, {}, out);
  INFO(r.message);
  REQUIRE(r.ok);
  REQUIRE(out.bytes.size() == input.bytes.size());
  // Fully inverted: red → cyan, and the top-left green → magenta (not some other pixel).
  CHECK(int{out.bytes[4]} == 0);
  CHECK(int{out.bytes[5]} == 255);
  CHECK(int{out.bytes[6]} == 255);
  CHECK(int{out.bytes[0]} == 255);
  CHECK(int{out.bytes[1]} == 0);
  CHECK(int{out.bytes[2]} == 255);
  CHECK(int{out.bytes[3]} == 255);
  // Amount 0 leaves it as it was; the param reached the plugin.
  const auto slot = [&](std::string_view name) {
    for (std::size_t i = 0; i < spec->params.size(); ++i) {
      if (spec->params[i].name == name) return i;
    }
    FAIL("no param");
    return std::size_t{0};
  };
  in.values[slot("Amount")].v[0] = 0;
  r = pl::run_native_cpu(host, in, input, {}, out);
  REQUIRE(r.ok);
  CHECK(out.bytes == input.bytes);
}

#endif
