// P7 — what native plugins contribute besides effects (docs/PLUGIN_SDK.md
// "Commands", "Importers", "Output modules", "Panels"): AE's AEGP commands,
// AEIO importers and output modules, and effect-less panels.
//
// The plugin host (host.cpp) loads the module and hands this class the
// manifest of every bundle (listed even when not loaded) and the SDK 1.2
// trailing fields of each loaded module's PrPluginInfo. Every call into the
// plugin goes through PluginHost::call_guarded: the crash guard, the crash
// journal and the watchdog, serialised with the plugin's other non-render
// selectors.
//
// Isolation:
//   command        a crash rolls back every edit (the session's journal) and
//                  disables the command for the session; an error rolls back.
//   importer       a crash disables the importer for the session; every read
//                  of its files then fails ("plugin failed to read …" on
//                  layerErrors); the frame renders without that footage.
//   output module  a crash or error fails the export job with the plugin's
//                  message; the engine and the editor are unaffected.
#pragma once

#include <premation_sdk/premation_sdk.h>

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "manifest.hpp"
#include "native_contrib.hpp"

namespace premation::plugins {

class PluginHost;

/// Journal / watchdog codes of the P7 selectors (journal_ffi.cpp command_name).
inline constexpr std::int32_t kJournalCommandRun = 1000;
inline constexpr std::int32_t kJournalImportBase = 1010;  ///< + PR_IMPORT_*
inline constexpr std::int32_t kJournalOutputBase = 1020;  ///< + PR_OUTPUT_*

/// What an export hands an output module at BEGIN.
struct OutputParams {
  std::string path;
  std::int32_t width = 0;
  std::int32_t height = 0;
  double fps = 30;
  std::int64_t frameCount = 0;
  std::uint32_t audioRate = 0;
  std::uint32_t audioChannels = 0;
  /// The user's option values (`{ "<id>": value }`); missing options take their declared default.
  std::string optionsJson = "{}";
};

/// One running export through an output module (BEGIN done). END runs on finish() or, cancelled, on destruction.
class OutputJob {
 public:
  OutputJob(PluginHost& host, std::string pluginId, std::string moduleId, PrOutputMainFn main);
  ~OutputJob();
  OutputJob(const OutputJob&) = delete;
  OutputJob& operator=(const OutputJob&) = delete;
  OutputJob(OutputJob&&) = delete;
  OutputJob& operator=(OutputJob&&) = delete;

  bool begin(const OutputParams& p, std::string& error);
  /// `rgba`: width × height × 4 floats, straight, display-encoded, rows top-down.
  bool write_frame(std::int64_t index, std::int64_t time, const float* rgba, std::string& error);
  /// Interleaved float32, `frames` × audioChannels.
  bool write_audio(const float* samples, std::uint32_t frames, std::string& error);
  /// END (cancelled = the job did not finish).
  bool finish(bool cancelled, std::string& error);

 private:
  bool call(PrIoCmd cmd, PrOutputCall& c, std::string& error);
  PluginHost& host_;
  std::string plugin_;
  std::string module_;
  PrOutputMainFn main_;
  OutputParams params_;
  PrHandle jobData_ = 0;
  bool begun_ = false;
  bool ended_ = false;
};

/// The export's frame (straight, display-encoded RGBA8, or RGBA64LE at `depth` 16, tight rows) →
/// straight RGBA float, what PR_OUTPUT_WRITE_FRAME hands the module.
void export_frame_to_float(std::span<const std::uint8_t> rgba, int depth, std::vector<float>& out);
/// Planar channels → interleaved float (WRITE_AUDIO's layout).
void interleave_audio(const std::vector<std::vector<float>>& channels, std::vector<float>& out);

class Contrib {
 public:
  explicit Contrib(PluginHost& host);
  ~Contrib();
  Contrib(const Contrib&) = delete;
  Contrib& operator=(const Contrib&) = delete;
  Contrib(Contrib&&) = delete;
  Contrib& operator=(Contrib&&) = delete;

  // ── the host's side (load_bundle, set_enabled, the constructor) ──
  /// A bundle's manifest (every bundle the scan found, loaded or not).
  void note_manifest(const std::string& pluginId, const std::filesystem::path& dir, const Manifest& m);
  /// A loaded module: bind the manifest's commands / importers / output modules to its entry points.
  /// "" when they match; else why not (the plugin then fails to load).
  [[nodiscard]] std::string bind(const std::string& pluginId, const PrPluginInfo& info);
  /// setPluginEnabled(true) / a reload: forget crashed commands and importers of the plugin, close its files.
  void reset(const std::string& pluginId);
  /// Install / remove the document handlers (native_contrib.hpp).
  void attach();
  void detach();
  /// The host is going away: detach and CLOSE every open importer file (before GLOBAL_SETDOWN).
  void shutdown();

  // ── what the engine API shows ──
  [[nodiscard]] std::vector<api::PluginCommandInfo> commands() const;
  /// PluginInfo's P7 fields (commands, importers, outputModules, panels) for `info.id`.
  void fill(api::PluginInfo& info) const;

  // ── commands (core thread) ──
  [[nodiscard]] std::variant<doc::PluginCommandOutcome, api::EngineError> run(const doc::PluginCommandRequest& r,
                                                                             doc::PluginCommandBridge& bridge);
  /// SDK 1.4 (U1): PR_COMMAND_TOOL_EVENT — a viewer tool's overlay and status for one event (no edits).
  [[nodiscard]] std::variant<doc::PluginToolFeedback, api::EngineError> tool_event(const doc::PluginCommandRequest& r);

  // ── importers (any thread) ──
  /// The loaded importer for `path`'s extension, if any.
  [[nodiscard]] bool claims(std::string_view path) const;
  /// No loaded importer claims `path` but a listed one would: why its plugin does not run
  /// ("plugin '<id>' is disabled", revoked, locked, …). "" = no listed importer reads it.
  [[nodiscard]] std::string refusal(std::string_view path) const;
  /// Plugins with an importer that crashed this session (off until the plugin is enabled again).
  [[nodiscard]] std::set<std::string, std::less<>> importers_off() const;
  bool probe(const std::string& path, js::Json& facts, std::string& error);
  bool read_frame(const std::string& path, double seconds, doc::NativeImage& out, std::string& error);
  /// Interleaved float32 sample frames [start, start + frames); `channels` set from the probe.
  bool read_audio(const std::string& path, std::int64_t start, std::uint32_t frames, std::vector<float>& out,
                  std::uint32_t& channels, std::string& error);
  /// The file's sound as PROBE reported it (channels 0 = none): what the audio decoders
  /// (audio/external_audio.hpp) conform plugin footage from.
  bool audio_format(const std::string& path, std::uint32_t& rate, std::uint32_t& channels, std::int64_t& frames,
                    std::string& codec, std::string& error);

  // ── output modules (the export process) ──
  /// `format` is `plugin:<plugin id>/<module id>`; nullptr + `error` when no loaded plugin provides it.
  [[nodiscard]] std::unique_ptr<OutputJob> output_job(std::string_view format, std::string& error);
  /// The module's options with the user's values merged over the declared defaults (BEGIN's options_json).
  [[nodiscard]] std::string output_options(std::string_view format, std::string_view userJson) const;

 private:
  struct Entry;
  struct OpenFile;
  [[nodiscard]] bool loaded(const std::string& pluginId) const;
  /// The importer entry for `path` (nullptr = none / not loaded / crashed), under mutex_.
  const Entry* importer_for(std::string_view path, std::string& why) const;
  /// PROBE through the guard. False + `error`.
  bool call_import(const Entry& e, PrIoCmd cmd, PrImportCall& c, std::string& error);
  OpenFile* open_file(const Entry& e, const std::string& path, std::string& error);
  void close_files(std::string_view pluginId);

  PluginHost& host_;
  mutable std::recursive_mutex mutex_;
  std::map<std::string, Manifest, std::less<>> manifests_;
  std::map<std::string, std::filesystem::path, std::less<>> dirs_;
  std::map<std::string, std::unique_ptr<Entry>, std::less<>> entries_;  ///< "<plugin>/<kind>/<id>"
  std::set<std::string, std::less<>> crashed_;                         ///< entry keys disabled this session
  std::map<std::string, std::string, std::less<>> crashWhy_;
  std::map<std::string, std::unique_ptr<OpenFile>, std::less<>> files_;  ///< path → OPEN state
  std::uint64_t fileTick_ = 0;
  bool attached_ = false;
};

}  // namespace premation::plugins
