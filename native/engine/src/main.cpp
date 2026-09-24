// premation-engine — the Premation engine process (docs/NATIVE_CORE_PLAN.md
// §5 C2, protocol docs/ENGINE_API.md, frames docs/VIEWPORT_ROUTE.md).
// Started and supervised by electron/engineSupervisor.ts:
//
//   premation-engine [--host-pid PID]      Electron main; shared slot handles are duplicated into it
//                    [--gpu-vendor N]      PCI vendor id of Chromium's GPU (app.getGPUInfo) — the
//                                          engine MUST use the same adapter for shared textures
//                    [--power low|high]    adapter preference when no vendor is given (default high)
//                    [--slots N]           frame-slot ring size (default 3, C1's measured value)
//                    [--frame-cache-mb N]  D4 frame cache budget (default: a quarter of the adapter's VRAM budget; 0 = off)
//                    [--no-gpu]            no Dawn: frames are simulated (protocol work, CI)
//                    [--test-ports]        in-memory projects + fake media (cross-engine tests)
//                    [--test-ports-dir D]  with --test-ports: project files also read from / written to D
//                    [--log-level debug|info|warn|error]
//                    [--plugins DIR]       native plugin bundles (repeatable; + PREMATION_PLUGIN_PATH)
//                    [--plugin-journal F]  the plugin crash journal (quarantines a plugin that killed the engine)
//                    [--version]
//
// stdin/stdout: the command pipe; fd 3/4: the frame channel; stderr: log.
// See engine_process.hpp for the thread structure and exit codes.

#include <charconv>
#include <cstdio>
#include <exception>
#include <string_view>

#include "engine_process.hpp"

namespace {

bool parse_u32(std::string_view s, std::uint32_t& out) {
  const auto* end = s.data() + s.size();
  const auto r = std::from_chars(s.data(), end, out);
  return r.ec == std::errc() && r.ptr == end;
}

int run(int argc, char** argv) {
  premation::EngineOptions o;
  o.render.highPerformance = true;
  for (int i = 1; i < argc; ++i) {
    const std::string_view k = argv[i];
    const std::string_view v = i + 1 < argc ? std::string_view(argv[i + 1]) : std::string_view();
    bool ok = true;
    if (k == "--version") {
      std::printf("%s\n", premation::kEngineVersion);
      return 0;
    } else if (k == "--no-gpu") {
      o.noGpu = true;
      continue;
    } else if (k == "--test-ports") {
      // Tests only: in-memory project files and deterministic fake media
      // (the TypeScript harness's `fakePorts`), for the cross-engine replay.
      o.testPorts = true;
      continue;
    } else if (k == "--test-ports-dir") {
      // Tests only: the cross-engine replay seeds fixture projects here and
      // compares what each engine saved.
      o.testPortsDir = std::string(v);
      ok = !v.empty();
    } else if (k == "--host-pid") {
      ok = parse_u32(v, o.render.hostPid);
    } else if (k == "--gpu-vendor") {
      ok = parse_u32(v, o.render.vendorId);
    } else if (k == "--slots") {
      ok = parse_u32(v, o.render.slots);
    } else if (k == "--frame-cache-mb") {
      std::uint32_t mb = 0;
      ok = parse_u32(v, mb);
      o.render.frameCacheBytes = std::size_t{mb} << 20U;
    } else if (k == "--power") {
      o.render.highPerformance = v != "low";
    } else if (k == "--plugins") {
      o.pluginPaths.emplace_back(v);
      ok = !v.empty();
    } else if (k == "--plugin-journal") {
      o.pluginJournal = std::string(v);
      ok = !v.empty();
    } else if (k == "--log-level") {
      if (v == "debug") o.logLevel = premation::log::Level::debug;
      else if (v == "warn") o.logLevel = premation::log::Level::warn;
      else if (v == "error") o.logLevel = premation::log::Level::error;
      else o.logLevel = premation::log::Level::info;
    } else {
      std::fprintf(stderr, "premation-engine: unknown argument '%.*s'\n", static_cast<int>(k.size()), k.data());
      return 64;
    }
    if (!ok) {
      std::fprintf(stderr, "premation-engine: bad value for %.*s\n", static_cast<int>(k.size()), k.data());
      return 64;
    }
    ++i;
  }
  return premation::run_engine(o);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception& e) {  // allocation failure; nothing else throws by design
    std::fprintf(stderr, "{\"lvl\":\"error\",\"ev\":\"exception\",\"what\":\"%s\"}\n", e.what());
    return premation::kExitException;
  }
}
