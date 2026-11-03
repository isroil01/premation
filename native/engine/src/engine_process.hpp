// premation-engine's process structure (docs/NATIVE_CORE_PLAN.md §5 C2).
//
//   thread            owns                               talks to
//   ───────────────   ─────────────────────────────────  ─────────────────────────────
//   command reader    stdin, the frame decoder           core queue (push)
//   frames reader     fd 4                               ring (Release), core queue (Ping)
//   core (main)       Document, History, clock, Session  outbox, FrameSink
//   render            Dawn device, compositor, slot ring frames outbox (Slots, FrameReady)
//   command writer    stdout                             ← outbox queue
//   frames writer     fd 3                               ← outbox queue
//
// The core thread is the only one that reads or writes the document, and it
// takes work from exactly one FIFO — so commands apply in arrival order, one
// at a time, and the same request stream always produces the same revisions,
// events and frames. The clock is the same FIFO's timeout: when a frame is
// due the pop returns empty and the core ticks.
//
// Exit codes: 0 normal (Goodbye or host gone), 2 cannot start (no GPU,
// no stdio) — the supervisor falls back to the TypeScript engine without
// retrying, 3 GPU device lost and not recoverable in-process (the render
// thread recovers a loss itself when it can), 4 unrecoverable framing error on the command
// pipe, 70 unexpected exception.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "core/log.hpp"
#if defined(PREMATION_ENGINE_HEADLESS)
namespace premation::render {
// premation-engine-headless (tests, CI without Dawn): the options the command
// line parses; only `slots` is read, by the simulated frame sink.
struct RenderOptions {
  std::uint32_t slots = 3;
  std::uint32_t hostPid = 0;
  std::uint32_t vendorId = 0;
  bool highPerformance = false;
  std::size_t frameCacheBytes = 0;  // --frame-cache-mb parses here; no GPU, no frame cache
  double diskCacheMinDrawMs = -1;   // --disk-cache-min-draw-ms likewise; nothing is drawn, nothing cached
  std::uint64_t ramCacheBytes = 0;  // --ram-cache-mb likewise
  std::string shaderCacheDir;       // --shader-cache-dir likewise; no GPU, no shaders
};
}  // namespace premation::render
#else
#include "render/render_thread.hpp"
#endif

namespace premation {

struct EngineOptions {
  render::RenderOptions render;
  bool noGpu = false;
  /// In-memory project files and fake media probes (the cross-engine tests).
  bool testPorts = false;
  /// With testPorts: a directory the fake project files are mirrored to (and read from when not in memory).
  std::string testPortsDir;
  log::Level logLevel = log::Level::info;
  /// G1: native plugin folders (a bundle, or a folder of bundles); PREMATION_PLUGIN_PATH adds more.
  std::vector<std::string> pluginPaths;
  /// G1: the plugin crash journal (empty = none: a plugin that kills the engine is not remembered).
  std::string pluginJournal;
  /// Plugins the user disabled (listed, not loaded) — Electron's native-plugins/state.json.
  std::vector<std::string> pluginDisabled;
  /// Developer Mode (`--plugin-shadow DIR`): plugin binaries load from copies under DIR, so a
  /// plugin's own build can overwrite them, and reloadPlugin swaps in the rebuilt module.
  std::string pluginShadow;
  /// SDK 1.4 (T2): where plugin simulation states evicted from RAM are kept (`--sim-cache-dir`); empty = RAM only.
  std::string pluginSimDir;
  /// SDK 1.4 (X) `--plugin-isolation auto|off|all`: auto runs third-party effect plugins in a
  /// premation-plugin-host (first-party com.premation.* in process); off = all in process.
  std::string pluginIsolation = "auto";
  /// `--plugin-watchdog <ms>`: how long a plugin call may run before it is a hang (0 = never: a
  /// debugger stopped in a selector); negative = the host's default (10 s).
  int pluginWatchdogMs = -1;
  /// The verified revocation list as a file (`{"revoked":[{"id","reason"}]}`); empty = none.
  std::string pluginRevoked;
  /// The Premation Cloud entitlement token file (`--entitlement`); empty = none (entitled plugins are locked).
  std::string pluginEntitlement;
};

inline constexpr int kExitOk = 0;
inline constexpr int kExitCannotStart = 2;
inline constexpr int kExitDeviceLost = 3;
inline constexpr int kExitFraming = 4;
inline constexpr int kExitException = 70;

inline constexpr const char* kEngineVersion = "0.2.0-c2";

int run_engine(const EngineOptions& options);

/// `premation-engine --job FILE` (jobs/child_job.hpp): the child's main, with the plugin
/// host the job file asks for (P7b). Built with the engine jobs only.
int run_job_child(const std::string& jobFile);

/// `premation-engine --job-worker FILE` (jobs/job_worker.hpp): the long-lived job process —
/// one request per stdin line, models kept loaded between them. Built with the engine jobs only.
int run_job_worker(const std::string& startFile);

/// `premation-engine --live FILE` (live/live_host.hpp): the camera + hand model child. Built with the engine jobs only.
int run_live_child(const std::string& settingsFile);

}  // namespace premation
