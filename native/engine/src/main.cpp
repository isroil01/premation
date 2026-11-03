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
//                    [--disk-cache-min-draw-ms N]  frames that draw faster stay off the disk cache
//                    [--ram-cache-mb N]    the RAM tier's size (default: half the installed memory, leaving 4 GiB)
//                    [--shader-cache-dir D] Dawn's blob cache (compiled shaders, pipeline state) across launches
//                                          (default: PREMATION_SHADER_CACHE_DIR, else none)
//                                          (default: measured — slower than a disk read; 0 = every exact frame)
//                    [--no-gpu]            no Dawn: frames are simulated (protocol work, CI)
//                    [--test-ports]        in-memory projects + fake media (cross-engine tests)
//                    [--test-ports-dir D]  with --test-ports: project files also read from / written to D
//                    [--log-level debug|info|warn|error]
//                    [--plugins DIR]       native plugin bundles (repeatable; + PREMATION_PLUGIN_PATH)
//                    [--plugin-journal F]  the plugin crash journal (quarantines a plugin that killed the engine)
//                    [--plugin-disabled ID] a plugin the user disabled: listed, not loaded (repeatable)
//                    [--plugin-shadow D]   Developer Mode: load plugin binaries from copies under D (reloadPlugin)
//                    [--revoked F]         the verified revocation list: listed plugins never load
//                    [--entitlement F]     the Premation Cloud entitlement token (plugins/entitlement.hpp)
//                    [--version]
//   premation-engine --export JOB.json     F1: render one export job and exit (export/export_job.hpp)
//   premation-engine --job JOB.json        an engine job's crash-isolated half (jobs/child_job.hpp)
//   premation-engine --job-worker START    the long-lived job process (jobs/job_worker.hpp)
//
// stdin/stdout: the command pipe; fd 3/4: the frame channel; stderr: log.
// See engine_process.hpp for the thread structure and exit codes.

#include <charconv>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <optional>
#include <string>
#include <string_view>

#include "engine_process.hpp"
#include "os_ffi.hpp"
#if defined(PREMATION_HAVE_PREPARE)
#include <string>

#include "cli_prepare.hpp"
#endif
#if defined(PREMATION_HAVE_EXPORT)
#include <string>

#include "export_job.hpp"
#endif
#if defined(PREMATION_HAVE_JOBS)
#include <string>
#endif

namespace {

/// The last words of an engine that is going down on an exception nobody
/// caught (any thread): the reason goes to stderr, which Electron main keeps in
/// <userData>/logs/engine.log — a user's crash report then says what failed.
[[noreturn]] void on_terminate() noexcept {
  const char* what = "unknown";
  try {
    if (const std::exception_ptr e = std::current_exception()) std::rethrow_exception(e);
    what = "std::terminate without an exception";
  } catch (const std::exception& e) {
    what = e.what();
  } catch (...) {
    what = "a non-std exception";
  }
  std::fputs("{\"lvl\":\"error\",\"ev\":\"uncaught_exception\",\"what\":\"", stderr);
  for (const char* c = what; *c != '\0'; ++c) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): a C string
    const char ch = *c;
    if (ch == '"' || ch == '\\') std::fputc('\\', stderr);
    std::fputc(static_cast<unsigned char>(ch) < 0x20 ? ' ' : ch, stderr);
  }
  std::fputs("\"}\n", stderr);
  std::fflush(stderr);
  std::abort();
}

bool parse_u32(std::string_view s, std::uint32_t& out) {
  const auto* end = s.data() + s.size();
  const auto r = std::from_chars(s.data(), end, out);
  return r.ec == std::errc() && r.ptr == end;
}

int run(int argc, char** argv) {
  premation::EngineOptions o;
  o.render.highPerformance = true;
  // Developer aid: the log level from the environment when the host passes no
  // --log-level (the app's supervisor passes none) — so a debug session can
  // turn on debug lines without changing the host. The flag still wins.
  if (const std::optional<std::string> lvl = premation::os::env_var("PREMATION_LOG_LEVEL")) {
    if (*lvl == "debug") o.logLevel = premation::log::Level::debug;
    else if (*lvl == "warn") o.logLevel = premation::log::Level::warn;
    else if (*lvl == "error") o.logLevel = premation::log::Level::error;
  }
  for (int i = 1; i < argc; ++i) {
    const std::string_view k = argv[i];
    const std::string_view v = i + 1 < argc ? std::string_view(argv[i + 1]) : std::string_view();
    bool ok = true;
    if (k == "--version") {
      std::printf("%s\n", premation::kEngineVersion);
      return 0;
    } else if (k == "--export") {
      // F1: one export job, then exit (export/export_job.hpp). No command pipe,
      // no viewport: the export supervisor talks to it in JSON lines.
#if defined(PREMATION_HAVE_EXPORT)
      if (v.empty()) {
        std::fprintf(stderr, "premation-engine: --export needs a job file\n");
        return 64;
      }
      return premation::exporter::run_export(std::string(v));
#else
      std::fprintf(stderr, "premation-engine: built without export (F1)\n");
      return 3;
#endif
    } else if (k == "--prepare") {
      // The CLI's document half (cli_prepare.hpp): open, reframe / transcribe /
      // list, save a copy for --export. JSON lines on stdout, then exit.
#if defined(PREMATION_HAVE_PREPARE)
      if (v.empty()) {
        std::fprintf(stderr, "premation-engine: --prepare needs a job file\n");
        return 64;
      }
      return premation::cli::run_prepare(std::string(v));
#else
      std::fprintf(stderr, "premation-engine: built without --prepare\n");
      return 3;
#endif
    } else if (k == "--job") {
      // A job that loads a model runs here, in a process of its own
      // (jobs/child_job.hpp): JSON lines on stdout, the engine that started it
      // reads them. A crash here fails that job only.
#if defined(PREMATION_HAVE_JOBS)
      if (v.empty()) {
        std::fprintf(stderr, "premation-engine: --job needs a job file\n");
        return 64;
      }
      return premation::run_job_child(std::string(v));
#else
      std::fprintf(stderr, "premation-engine: built without engine jobs\n");
      return 3;
#endif
    } else if (k == "--job-worker") {
      // The long-lived job process (jobs/job_worker.hpp): requests on stdin,
      // answers on stdout, models kept loaded between them. A crash here
      // fails the request in flight only; the engine starts a new worker.
#if defined(PREMATION_HAVE_JOBS)
      if (v.empty()) {
        std::fprintf(stderr, "premation-engine: --job-worker needs a start file\n");
        return 64;
      }
      return premation::run_job_worker(std::string(v));
#else
      std::fprintf(stderr, "premation-engine: built without engine jobs\n");
      return 3;
#endif
    } else if (k == "--live") {
      // Live performance input (live/live_host.hpp): the camera and the hand
      // model run here, in a process of their own; JSON lines on stdout. A
      // crash here stops live input only.
#if defined(PREMATION_HAVE_JOBS)
      if (v.empty()) {
        std::fprintf(stderr, "premation-engine: --live needs a settings file\n");
        return 64;
      }
      return premation::run_live_child(std::string(v));
#else
      std::fprintf(stderr, "premation-engine: built without live input\n");
      return 3;
#endif
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
    } else if (k == "--disk-cache-min-draw-ms") {
      std::uint32_t ms = 0;
      ok = parse_u32(v, ms);
      o.render.diskCacheMinDrawMs = static_cast<double>(ms);
    } else if (k == "--ram-cache-mb") {
      std::uint32_t mb = 0;
      ok = parse_u32(v, mb);
      o.render.ramCacheBytes = std::uint64_t{mb} << 20U;
    } else if (k == "--shader-cache-dir") {
      o.render.shaderCacheDir = std::string(v);
      ok = !v.empty();
    } else if (k == "--power") {
      o.render.highPerformance = v != "low";
    } else if (k == "--plugins") {
      o.pluginPaths.emplace_back(v);
      ok = !v.empty();
    } else if (k == "--plugin-journal") {
      o.pluginJournal = std::string(v);
      ok = !v.empty();
    } else if (k == "--plugin-disabled") {
      o.pluginDisabled.emplace_back(v);
      ok = !v.empty();
    } else if (k == "--plugin-shadow") {
      o.pluginShadow = std::string(v);
      ok = !v.empty();
    } else if (k == "--revoked") {
      o.pluginRevoked = std::string(v);
      ok = !v.empty();
    } else if (k == "--entitlement") {
      o.pluginEntitlement = std::string(v);
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
  // The shader cache from the environment when the host passes no folder (the
  // headless suites, a CLI render): the flag still wins.
  if (o.render.shaderCacheDir.empty()) {
    if (const std::optional<std::string> dir = premation::os::env_var("PREMATION_SHADER_CACHE_DIR")) {
      o.render.shaderCacheDir = *dir;
    }
  }
  return premation::run_engine(o);
}

}  // namespace

int main(int argc, char** argv) {
  std::set_terminate(on_terminate);
  try {
    return run(argc, argv);
  } catch (const std::exception& e) {  // allocation failure; nothing else throws by design
    std::fprintf(stderr, "{\"lvl\":\"error\",\"ev\":\"exception\",\"what\":\"%s\"}\n", e.what());
    return premation::kExitException;
  }
}
