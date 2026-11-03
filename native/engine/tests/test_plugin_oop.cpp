// SDK 1.4 (X): a plugin out of process, on the `ripple` sample in a real premation-plugin-host.
//
//   * the engine never loads its module; its effects come from the child's description;
//   * a render out of process gives the same pixels as in process;
//   * abort() and a hang end the CHILD (the test process — the engine here — carries on), the
//     next render starts it again, and after three restarts the plugin is off for the session.
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <string>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"
#include "plugin_host_channel.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kRipple = "com.premation.samples.ripple";
constexpr std::uint32_t kW = 24, kH = 16;
constexpr std::uint32_t kFaultParamId = 901;
constexpr double kFaultAbort = 8;  // sample_util.hpp Fault::abort_process (1-based popup)
constexpr double kFaultHang = 6;   // Fault::hang (1.5 s)

pl::HostOptions opts(bool outOfProcess, std::uint32_t timeoutMs = 10000) {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "ripple"};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) {};
  if (outOfProcess) {
    o.spawnOutOfProcess = [](const fs::path& bundle, std::string& error) {
      return premation::exporter::spawn_plugin_host(fs::path(PREMATION_PLUGIN_HOST_EXE), bundle, fs::temp_directory_path() / "premation-oop-test.log", error);
    };
    o.runOutOfProcess = [](std::string_view) { return true; };
    o.outOfProcessTimeoutMs = timeoutMs;
  }
  return o;
}

pl::TexelImage ramp() {
  pl::TexelImage img;
  img.format = pl::TexelFormat::rgba8;
  img.width = kW;
  img.height = kH;
  img.bytes.resize(std::size_t{kW} * kH * 4);
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) {
      std::uint8_t* p = &img.bytes[(std::size_t{y} * kW + x) * 4];
      p[0] = static_cast<std::uint8_t>(x * 10);
      p[1] = static_cast<std::uint8_t>(y * 15);
      p[2] = 128;
      p[3] = 255;
    }
  }
  return img;
}

pl::CallResult render(pl::PluginHost& host, double fault, pl::TexelImage& out) {
  const pl::EffectSpec* spec = host.effect(kRipple);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kW, kH, 8);
  in.values[static_cast<std::size_t>(pl::param_slot(*spec, kFaultParamId))].v[0] = fault;
  const pl::TexelImage input = ramp();
  return pl::run_native_cpu(host, in, input, {}, out);
}

}  // namespace

TEST_CASE("out of process: the same effect and the same pixels as in process", "[plugins][oop]") {
  pl::PluginHost here(opts(false));
  here.scan();
  pl::PluginHost there(opts(true));
  there.scan();
  CHECK_FALSE(here.out_of_process(kRipple));
  REQUIRE(there.out_of_process(kRipple));
  const pl::EffectSpec* a = here.effect(kRipple);
  const pl::EffectSpec* b = there.effect(kRipple);
  REQUIRE(a != nullptr);
  REQUIRE(b != nullptr);
  CHECK(b->main == nullptr);  // the module was never loaded in this process
  CHECK(a->outFlags == b->outFlags);
  REQUIRE(a->params.size() == b->params.size());
  for (std::size_t i = 0; i < a->params.size(); ++i) {
    CHECK(a->params[i].key == b->params[i].key);
    CHECK(a->params[i].def == b->params[i].def);
  }
  pl::TexelImage inProcess;
  pl::TexelImage outOfProcess;
  REQUIRE(render(here, 1, inProcess).ok);
  const pl::CallResult r = render(there, 1, outOfProcess);
  INFO(r.message);
  REQUIRE(r.ok);
  CHECK(outOfProcess.bytes == inProcess.bytes);
}

TEST_CASE("out of process: abort() ends the plugin's process, never the engine; restarts are capped", "[plugins][oop]") {
  pl::PluginHost host(opts(true));
  host.scan();
  REQUIRE(host.out_of_process(kRipple));
  pl::TexelImage out;
  // abort() takes the child down: the render fails, the engine (this process) carries on.
  pl::CallResult r = render(host, kFaultAbort, out);
  CHECK_FALSE(r.ok);
  CHECK(r.message.find("process ended") != std::string::npos);
  // The next render starts it again (restart 1), and so on up to three restarts.
  r = render(host, 1, out);
  INFO(r.message);
  CHECK(r.ok);
  CHECK_FALSE(render(host, kFaultAbort, out).ok);
  CHECK(render(host, 1, out).ok);  // restart 2
  CHECK_FALSE(render(host, kFaultAbort, out).ok);
  CHECK(render(host, 1, out).ok);  // restart 3
  CHECK_FALSE(render(host, kFaultAbort, out).ok);
  r = render(host, 1, out);
  CHECK_FALSE(r.ok);
  CHECK(r.message.find("off until the next session") != std::string::npos);
}

TEST_CASE("out of process: a hang past the timeout ends the plugin's process; the call returns", "[plugins][oop]") {
  pl::PluginHost host(opts(true, 700));  // the sample hangs 1.5 s
  host.scan();
  REQUIRE(host.out_of_process(kRipple));
  pl::TexelImage out;
  const pl::CallResult r = render(host, kFaultHang, out);
  CHECK_FALSE(r.ok);
  CHECK(r.message.find("did not answer") != std::string::npos);
}
