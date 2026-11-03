// reloadPlugin (W2, docs/PLUGIN_SDK.md "Hot reload"): a plugin's bundle is loaded again and the
// new build swapped in, without restarting the host.
//
//   * with a shadow folder the bundle's binary is not locked: the "rebuild" (overwriting it with
//     the other build) succeeds while the host has it loaded, and the reload renders the new build;
//   * the instance set up by the old build is set down and set up again by the new one (the probe
//     refuses to render another build's sequence data);
//   * a failed reload (a broken binary, a manifest whose id changed) keeps the old build loaded;
//   * a disabled or unknown plugin is not reloaded.
//
// tests/plugins/reload_probe.cpp is built twice (v1, v2) under one plugin id.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kPlugin = "com.premation.test.reload";
constexpr const char* kEffect = "com.premation.test.reload.probe";

#if defined(_WIN32)
constexpr const char* kBinary = "reload_probe.dll";
#elif defined(__APPLE__)
constexpr const char* kBinary = "libreload_probe.dylib";
#else
constexpr const char* kBinary = "libreload_probe.so";
#endif

fs::path build_of(int version) { return fs::path(version == 1 ? RELOAD_PROBE_V1 : RELOAD_PROBE_V2); }

void write_text(const fs::path& file, const std::string& text) {
  std::ofstream f(file, std::ios::binary | std::ios::trunc);
  f << text;
}

std::string manifest(const std::string& id = kPlugin) {
  return std::string(R"({ "manifestVersion": 1, "id": ")") + id + R"(", "name": "Reload probe", "version": "1.0.0",
    "sdk": { "major": 1, "minor": 2 },
    "binary": { "windows": "reload_probe.dll", "macos": "libreload_probe.dylib", "linux": "libreload_probe.so" },
    "effects": [ { "matchName": ")" + id + R"(.probe", "name": "Reload Probe", "category": "Test" } ] })";
}

/// A fresh dev folder holding one bundle built from `version`.
struct DevFolder {
  fs::path root;
  fs::path bundle;
  fs::path shadow;
  explicit DevFolder(int version) {
    root = fs::temp_directory_path() / "premation-plugin-reload-test";
    std::error_code ec;
    fs::remove_all(root, ec);
    bundle = root / "plugins" / "reload";
    shadow = root / "shadow";
    fs::create_directories(bundle);
    write_text(bundle / "premation-plugin.json", manifest());
    REQUIRE(rebuild(version));
  }
  /// "Build" `version` into the bundle: overwrite its binary.
  [[nodiscard]] bool rebuild(int version) const {
    std::error_code ec;
    fs::copy_file(build_of(version), bundle / kBinary, fs::copy_options::overwrite_existing, ec);
    return !ec;
  }
};

pl::HostOptions options(const DevFolder& dev, bool shadow = true) {
  pl::HostOptions o;
  o.searchPaths = {dev.root / "plugins"};
  o.threads = 2;
  o.attachToDocument = false;
  if (shadow) o.shadowDir = dev.shadow;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

/// The probe's red channel on instance "L/fx" (version / 4), or -1 when the render failed.
float render_red(pl::PluginHost& host) {
  const pl::EffectSpec* spec = host.effect(kEffect);
  if (spec == nullptr) return -1;
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", 8, 8, 32);
  pl::TexelImage input;
  input.format = pl::TexelFormat::rgba32f;
  input.width = 8;
  input.height = 8;
  input.bytes.assign(std::size_t{8} * 8 * 16, 0);
  pl::TexelImage out;
  const pl::CallResult r = pl::run_native_cpu(host, in, input, {}, out);
  if (!r.ok) {
    UNSCOPED_INFO("render: " << r.message);
    return -1;
  }
  float red = 0;
  std::memcpy(&red, out.bytes.data(), sizeof(red));
  return red;
}

pl::PluginStatus status_of(pl::PluginHost& host) {
  for (const pl::PluginRecord& r : host.plugins()) {
    if (r.id == kPlugin) return r.status;
  }
  return pl::PluginStatus::failed;
}

}  // namespace

TEST_CASE("plugin reload: a rebuilt bundle is swapped in; its instance is set up again by the new build", "[plugins][reload]") {
  const DevFolder dev(1);
  pl::PluginHost host(options(dev));
  host.scan();
  REQUIRE(status_of(host) == pl::PluginStatus::loaded);
  CHECK(render_red(host) == 0.25F);

  // The host loaded a shadow copy: the bundle's own binary can be overwritten while it runs.
  REQUIRE(dev.rebuild(2));
  CHECK(render_red(host) == 0.25F);  // nothing changes until the reload

  std::string why;
  REQUIRE(host.reload(kPlugin, why));
  INFO(why);
  CHECK(status_of(host) == pl::PluginStatus::loaded);
  // v2 refuses v1's sequence data: a pass means instance L/fx was set down and set up again.
  CHECK(render_red(host) == 0.5F);
  CHECK(host.plugins().size() == 1);  // the old record is retired, not listed twice

  // And back.
  REQUIRE(dev.rebuild(1));
  REQUIRE(host.reload(kPlugin, why));
  CHECK(render_red(host) == 0.25F);
}

TEST_CASE("plugin reload: a failed build keeps the old one loaded and says why", "[plugins][reload]") {
  const DevFolder dev(1);
  pl::PluginHost host(options(dev));
  host.scan();
  REQUIRE(render_red(host) == 0.25F);

  SECTION("a binary that does not load") {
    write_text(dev.bundle / kBinary, "not a shared library");
    std::string why;
    CHECK_FALSE(host.reload(kPlugin, why));
    CHECK_FALSE(why.empty());
    CHECK(status_of(host) == pl::PluginStatus::loaded);
    CHECK(render_red(host) == 0.25F);
    // The author fixes the build: the next reload takes it.
    REQUIRE(dev.rebuild(2));
    REQUIRE(host.reload(kPlugin, why));
    CHECK(render_red(host) == 0.5F);
  }
  SECTION("a manifest that does not parse") {
    write_text(dev.bundle / "premation-plugin.json", "{ not json");
    std::string why;
    CHECK_FALSE(host.reload(kPlugin, why));
    CHECK(why.find("manifest") != std::string::npos);
    CHECK(render_red(host) == 0.25F);
  }
  SECTION("a manifest whose id changed") {
    write_text(dev.bundle / "premation-plugin.json", manifest("com.premation.test.renamed"));
    std::string why;
    CHECK_FALSE(host.reload(kPlugin, why));
    CHECK(why.find("com.premation.test.renamed") != std::string::npos);
    CHECK(render_red(host) == 0.25F);
  }
}

TEST_CASE("plugin reload: unknown and disabled plugins are not reloaded", "[plugins][reload]") {
  const DevFolder dev(1);
  pl::PluginHost host(options(dev));
  host.scan();
  std::string why;
  CHECK_FALSE(host.reload("com.premation.test.nothing", why));
  CHECK(why.find("no plugin") != std::string::npos);
  REQUIRE(host.set_enabled(kPlugin, false));
  CHECK_FALSE(host.reload(kPlugin, why));
  CHECK(why.find("disabled") != std::string::npos);
}

#if defined(_WIN32)
TEST_CASE("plugin reload: without a shadow folder Windows keeps the loaded binary locked", "[plugins][reload]") {
  // Why Developer Mode starts the engine with --plugin-shadow.
  const DevFolder dev(1);
  pl::PluginHost host(options(dev, false));
  host.scan();
  REQUIRE(render_red(host) == 0.25F);
  CHECK_FALSE(dev.rebuild(2));
}
#endif
