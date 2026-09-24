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
// retrying, 3 GPU device lost, 4 unrecoverable framing error on the command
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
};

inline constexpr int kExitOk = 0;
inline constexpr int kExitCannotStart = 2;
inline constexpr int kExitDeviceLost = 3;
inline constexpr int kExitFraming = 4;
inline constexpr int kExitException = 70;

inline constexpr const char* kEngineVersion = "0.2.0-c2";

int run_engine(const EngineOptions& options);

}  // namespace premation
