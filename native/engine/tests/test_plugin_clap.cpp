// SDK 1.4 (A): a CLAP audio plugin, hosted out of process. The `clapgain` sample (ClapGain.clap,
// written against the CLAP headers only) in a real premation-plugin-host:
//
//   * the file is found by the scan, described by its process (params with ranges and defaults);
//   * blocks of audio go through it with param values, keeping state per instance;
//   * without a plugin host process it is listed, never loaded here.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "audio/external_effects.hpp"
#include "host.hpp"
#include "plugin_host_channel.hpp"

#if defined(PREMATION_HAVE_CLAP_SAMPLE)

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kGain = "com.premation.samples.clapgain";

pl::HostOptions clap_opts(bool withChild) {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "clap"};
  o.threads = 1;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) {};
  if (withChild) {
    o.spawnOutOfProcess = [](const fs::path& file, std::string& error) {
      return premation::exporter::spawn_plugin_host(fs::path(PREMATION_PLUGIN_HOST_EXE), file, fs::temp_directory_path() / "premation-clap-test.log", error);
    };
  }
  return o;
}

}  // namespace

TEST_CASE("CLAP: a .clap file is described by its process", "[plugins][clap]") {
  pl::PluginHost host(clap_opts(true));
  host.scan();
  const std::vector<pl::AudioPluginInfo> list = host.audio_plugins();
  REQUIRE(list.size() == 1);
  const pl::AudioPluginInfo& a = list[0];
  CHECK(a.id == kGain);
  CHECK(a.name == "Clap Gain");
  CHECK(a.vendor == "Premation");
  CHECK(a.pluginId == "clap.clapgain");
  REQUIRE(a.params.size() == 2);
  CHECK(a.params[0].id == 1);
  CHECK(a.params[0].name == "Gain");
  CHECK(a.params[0].min == -60);
  CHECK(a.params[0].max == 24);
  CHECK(a.params[1].name == "Pan");

  pl::PluginHost noChild(clap_opts(false));
  noChild.scan();
  CHECK(noChild.audio_plugins().empty());
  bool listed = false;
  for (const pl::PluginRecord& r : noChild.plugins()) {
    if (r.id != "clap.clapgain") continue;
    listed = true;
    CHECK(r.error.find("out of process only") != std::string::npos);
  }
  CHECK(listed);
}

TEST_CASE("CLAP: audio through the plugin, with its params", "[plugins][clap]") {
  pl::PluginHost host(clap_opts(true));
  host.scan();
  // A stereo block of a 440 Hz sine at 0.5.
  constexpr std::size_t kFrames = 256;
  std::vector<float> block(kFrames * 2);
  for (std::size_t f = 0; f < kFrames; ++f) {
    const auto s = static_cast<float>(0.5 * std::sin(2 * 3.141592653589793 * 440 * static_cast<double>(f) / 48000));
    block[f * 2] = s;
    block[f * 2 + 1] = s;
  }
  // -6.0206 dB halves it; centred pan leaves both sides at the same level.
  std::vector<float> out = block;
  const std::vector<std::pair<std::uint32_t, double>> half{{1, -6.0205999}, {2, 0.0}};
  std::string why;
  REQUIRE(host.process_audio(kGain, "layer/fx", 48000, 2, out, half, false, why));
  for (std::size_t i = 0; i < out.size(); ++i) CHECK(std::abs(out[i] - block[i] * 0.5F) < 1e-5F);
  // Hard right: the left side goes silent, the right gets the equal-power boost (√2).
  out = block;
  const std::vector<std::pair<std::uint32_t, double>> right{{1, 0.0}, {2, 1.0}};
  REQUIRE(host.process_audio(kGain, "layer/fx", 48000, 2, out, right, false, why));
  CHECK(std::abs(out[100]) < 1e-6F);
  CHECK(std::abs(out[101] - block[101] * std::sqrt(2.0F)) < 1e-5F);
  // A plugin that is not there leaves the audio alone and says why.
  out = block;
  CHECK_FALSE(host.process_audio("com.nobody.gain", "layer/fx", 48000, 2, out, half, false, why));
  CHECK(out == block);
}

TEST_CASE("CLAP: an attached host serves the mixer's CLAP effects (ExternalEffects)", "[plugins][clap]") {
  pl::HostOptions o = clap_opts(true);
  o.attachToDocument = true;
  std::vector<float> block(256, 0.5F);
  {
    pl::PluginHost host(std::move(o));
    host.scan();
    const std::vector<std::pair<std::uint32_t, double>> half{{1, -6.0205999}};
    REQUIRE(premation::audio::ExternalEffects::process(kGain, "layer/fx", 48000, 2, block, half, true));
    CHECK(std::abs(block[10] - 0.25F) < 1e-5F);
  }
  // The host is gone: nothing processes, the audio is left alone.
  std::fill(block.begin(), block.end(), 0.5F);
  CHECK_FALSE(premation::audio::ExternalEffects::process(kGain, "layer/fx", 48000, 2, block, {}, false));
  CHECK(block[10] == 0.5F);
}

#endif
