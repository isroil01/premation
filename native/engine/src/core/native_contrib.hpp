// What native SDK plugins contribute besides effects (P7, docs/PLUGIN_SDK.md):
// commands (pr_command.h) and footage importers (pr_io.h), seen from the
// document core. Like native_effects.hpp this is the ONLY coupling: the core
// never sees a plugin binary or a selector; the plugin host (src/plugins)
// installs the handlers at start, and without a host there are no commands and
// no plugin importers.
//
// Process-wide and thread-safe: commands run on the core thread; importers are
// asked from the core thread (import, probe) and the frame builder (frames).
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"

namespace premation::doc {

// ── commands (P7a) ────────────────────────────────────────────────────────

/// What a command does to the document: the engine API, run by the session inside
/// the invocation's one journal. Both throw EngineFail on an engine error (the
/// host turns it into the plugin's error JSON; nothing it did stays).
class PluginCommandBridge {
 public:
  PluginCommandBridge() = default;
  virtual ~PluginCommandBridge() = default;
  PluginCommandBridge(const PluginCommandBridge&) = delete;
  PluginCommandBridge& operator=(const PluginCommandBridge&) = delete;
  PluginCommandBridge(PluginCommandBridge&&) = delete;
  PluginCommandBridge& operator=(PluginCommandBridge&&) = delete;
  virtual api::QueryResult query(const api::Query& q) = 0;
  /// An EDIT command only (anything else: invalidArgument).
  virtual api::CommandResult command(const api::Command& c) = 0;
};

struct PluginCommandRequest {
  std::string plugin;
  std::string command;
  std::string comp;  ///< "" = none
  std::vector<std::string> layers;
  api::Time time = 0;
  double fps = 0;
  std::string args = "{}";
};

/// SDK 1.4 (U1): one item a viewer tool draws (PR_TOOL_DRAW_*), comp px.
struct PluginToolItem {
  std::uint32_t kind = 0;
  std::vector<double> xy;
  std::array<float, 4> rgba{0, 0, 0, 0};  ///< all 0 = the editor's accent
  double width = 1;
};

struct PluginToolFeedback {
  std::vector<PluginToolItem> items;
  std::string message;
};

struct PluginCommandOutcome {
  std::string label;    ///< the history entry's label (the command's name)
  std::string message;  ///< PrCommandOut.return_msg
};

class NativeCommands {
 public:
  using ListFn = std::function<std::vector<api::PluginCommandInfo>()>;
  using RunFn = std::function<std::variant<PluginCommandOutcome, api::EngineError>(const PluginCommandRequest&, PluginCommandBridge&)>;
  static void set_handlers(ListFn list, RunFn run);
  /// SDK 1.4 (U1): PR_COMMAND_TOOL_EVENT (no edits) — the tool's overlay and status for one event.
  using ToolEventFn = std::function<std::variant<PluginToolFeedback, api::EngineError>(const PluginCommandRequest&)>;
  static void set_tool_event_handler(ToolEventFn fn);
  [[nodiscard]] static std::variant<PluginToolFeedback, api::EngineError> tool_event(const PluginCommandRequest& r);
  static void clear_handlers();
  /// listPluginCommands (empty without a host).
  [[nodiscard]] static std::vector<api::PluginCommandInfo> list();
  /// runPluginCommand. No host = notFound.
  [[nodiscard]] static std::variant<PluginCommandOutcome, api::EngineError> run(const PluginCommandRequest& r, PluginCommandBridge& bridge);
};

// ── footage importers (P7b) ───────────────────────────────────────────────

/// One frame a plugin importer read: STRAIGHT RGBA float, display-encoded (sRGB) unless `linear`.
struct NativeImage {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool linear = false;
  std::vector<float> rgba;
};

class NativeImporters {
 public:
  /// Does a loaded plugin import `path` (by extension)?
  using ClaimFn = std::function<bool(std::string_view path)>;
  /// importFiles' probe: the facts FilePorts records (`{type, metadata: {width, height, fps, duration, …}}`).
  using ProbeFn = std::function<bool(const std::string& path, js::Json& facts, std::string& error)>;
  /// The frame at `seconds` of source time.
  using FrameFn = std::function<bool(const std::string& path, double seconds, NativeImage& out, std::string& error)>;
  /// Why a listed plugin importer of `path`'s extension cannot read it (its plugin is disabled,
  /// revoked, locked, quarantined, failed); "" = no listed importer refuses it.
  using RefuseFn = std::function<std::string(std::string_view path)>;
  static void set_handlers(ClaimFn claim, ProbeFn probe, FrameFn frame, RefuseFn refuse = nullptr);
  static void clear_handlers();
  [[nodiscard]] static bool claims(std::string_view path);
  /// When claims() is false: why the plugin that would import `path` does not ("" = none would).
  [[nodiscard]] static std::string refusal(std::string_view path);
  /// Is any plugin importer loaded (FilePorts imports without a decoder probe then)?
  static void set_any(bool any);
  [[nodiscard]] static bool any();
  [[nodiscard]] static bool probe(const std::string& path, js::Json& facts, std::string& error);
  [[nodiscard]] static bool read_frame(const std::string& path, double seconds, NativeImage& out, std::string& error);

  /// The last read failure of a file ("plugin failed to read 'x.ppm': …"), for layerErrors;
  /// cleared by the next good read of it.
  static void set_failure(const std::string& path, std::string message);
  static void clear_failure(const std::string& path);
  [[nodiscard]] static std::optional<std::string> failure(const std::string& path);
};

}  // namespace premation::doc
