// SDK 1.4 (X): a plugin out of process, on the `ripple` sample in a real premation-plugin-host.
//
//   * the engine never loads its module; its effects come from the child's description;
//   * a render out of process gives the same pixels as in process;
//   * abort() and a hang end the CHILD (the test process — the engine here — carries on), the
//     next render starts it again, and after three restarts the plugin is off for the session.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"
#include "native_effects.hpp"
#include "plugin_host_channel.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kRipple = "com.premation.samples.ripple";
constexpr std::uint32_t kW = 24, kH = 16;
constexpr std::uint32_t kFaultParamId = 901;
constexpr double kFaultAbort = 8;  // sample_util.hpp Fault::abort_process (1-based popup)
constexpr double kFaultHang = 6;   // Fault::hang (1.5 s)
constexpr double kFaultHeap = 9;   // Fault::heap_corruption (X4)

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

// X3: the per-frame cost of running out of process (hidden: `engine_plugins_tests "[.oopbench]"`).
// A 1920 × 1080 8-bit frame through ripple, in process and through the pipe; the difference is the
// cost of crossing (both images over the pipe + the child's own conversions).
TEST_CASE("out of process: per-frame cost (benchmark)", "[.oopbench]") {
  constexpr std::uint32_t kBw = 1920, kBh = 1080;
  pl::TexelImage big;
  big.format = pl::TexelFormat::rgba8;
  big.width = kBw;
  big.height = kBh;
  big.bytes.assign(std::size_t{kBw} * kBh * 4, std::uint8_t{128});
  const auto time_it = [&](pl::PluginHost& host) {
    const pl::EffectSpec* spec = host.effect(kRipple);
    REQUIRE(spec != nullptr);
    pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kBw, kBh, 8);
    pl::TexelImage out;
    REQUIRE(pl::run_native_cpu(host, in, big, {}, out).ok);  // warm: instances, the child's first frame
    constexpr int kFrames = 20;
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kFrames; ++i) REQUIRE(pl::run_native_cpu(host, in, big, {}, out).ok);
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / kFrames;
  };
  // The same threads both sides: the child renders with every core (plugin_host_main.cpp).
  const int cores = static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));
  pl::HostOptions ho = opts(false);
  ho.threads = cores;
  pl::PluginHost here(ho);
  here.scan();
  pl::HostOptions to = opts(true);
  to.threads = cores;
  pl::PluginHost there(to);
  there.scan();
  const double a = time_it(here);
  const double b = time_it(there);
  WARN("ripple 1920x1080 8-bit: in process " << a << " ms/frame, out of process " << b << " ms/frame (+" << (b - a) << " ms)");
  CHECK(b > 0);
}

TEST_CASE("out of process: heap corruption ends the plugin's process, never the engine (X4)", "[plugins][oop]") {
  pl::PluginHost host(opts(true));
  host.scan();
  REQUIRE(host.out_of_process(kRipple));
  pl::TexelImage out;
  pl::CallResult r = render(host, kFaultHeap, out);
  CHECK_FALSE(r.ok);
  CHECK(r.message.find("process ended") != std::string::npos);
  r = render(host, 1, out);  // started again
  INFO(r.message);
  CHECK(r.ok);
}

TEST_CASE("out of process: the user's pin wins over the policy (X2)", "[plugins][oop][isolation]") {
  const char* plugin = "com.premation.samples.ripple";
  {
    premation::doc::NativeEffects::set_isolation_pin(plugin, "engine");
    pl::PluginHost host(opts(true));  // the policy says out of process
    host.scan();
    CHECK_FALSE(host.out_of_process(kRipple));
  }
  {
    premation::doc::NativeEffects::set_isolation_pin(plugin, "process");
    pl::HostOptions o = opts(true);
    o.runOutOfProcess = [](std::string_view) { return false; };  // the policy says in process
    pl::PluginHost host(o);
    host.scan();
    CHECK(host.out_of_process(kRipple));
    pl::TexelImage out;
    CHECK(render(host, 1, out).ok);
  }
  premation::doc::NativeEffects::set_isolation_pin(plugin, "");
  CHECK(premation::doc::NativeEffects::isolation_pin(plugin).empty());
}
