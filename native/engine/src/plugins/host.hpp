// The native plugin host (G1, docs/PLUGIN_SDK.md): discovery, loading, the
// selector calls, per-instance sequence data, crash isolation, and the
// document registration of every plugin effect.
//
// GPU-free on purpose: pixels come and go through PrWorld / PrGpuWorld
// structs a render-side glue fills (gpu_glue.cpp, the render graph's
// NativeEffectHost), so the host itself is unit-tested without a device.
//
// Threads. Render selectors (SMART_PRE_RENDER, SMART_RENDER, SMART_RENDER_GPU)
// run on whichever thread renders — the engine builds one frame on its core
// thread while the render thread draws another — concurrently only for
// effects that declare PR_OUT_FLAG_THREADED_RENDER; every other selector is
// serialised per plugin module. Sequence data is read-only during render.
//
// Isolation. Every call goes through guarded_call + the crash journal + the
// watchdog. A fault in a RENDER selector disables that effect INSTANCE (the
// layer renders as if the effect were off, the failure is on layerErrors);
// a fault in setup / params / sequence selectors fails the whole plugin
// (listed, not loaded); a hang quarantines the plugin; a death the guard
// cannot see quarantines it at the next engine start (journal.hpp).
#pragma once

#include <premation_sdk/premation_sdk.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

#include "entitlement.hpp"
#include "guard.hpp"
#include "native_effects.hpp"

namespace premation::plugins {

class CrashJournal;
class DynamicLibrary;
class WorkerPool;

/// One declared parameter (the host's copy of a PrParamDef from PARAMS_SETUP).
struct ParamSpec {
  PrParamType type = PR_PARAM_LAYER;
  std::uint32_t id = 0;
  std::uint32_t flags = 0;
  std::string name;
  std::array<double, 4> def{};
  double validMin = 0, validMax = 0, sliderMin = 0, sliderMax = 0;
  std::int32_t precision = 0;
  std::vector<std::string> choices;
  std::string key;    ///< the document key: `p<id>`
  std::string group;  ///< enclosing group names, " / "-joined ("" = top level)
  // SDK 1.1 defaults.
  std::string text;               ///< STRING
  std::vector<double> curve;      ///< CURVE: x, y pairs in 0..1
  std::vector<double> gradient;   ///< GRADIENT: 5 doubles per stop
  std::string fileTypes;          ///< FILE: "cube|3dl" ("" = any)
};

struct EffectSpec {
  std::string matchName;
  std::string name;
  std::string category;
  std::string pluginId;
  PrEffectMainFn main = nullptr;
  std::uint32_t outFlags = 0;
  std::uint32_t version = 0;
  std::string about;
  /// params[1..] in order: ParamSpec i is PrParamDef index i + 1.
  std::vector<ParamSpec> params;
  PrHandle globalData = 0;
  bool ready = false;
  [[nodiscard]] bool has(std::uint32_t flag) const noexcept { return (outFlags & flag) != 0; }
};

/// `locked`: needs an entitlement (manifest `entitlement`) with no valid token — never loaded.
enum class PluginStatus : std::uint8_t { loaded, disabled, failed, quarantined, revoked, locked };
[[nodiscard]] std::string_view to_string(PluginStatus s) noexcept;

/// What the host tells the world about one plugin (listPlugins).
struct PluginRecord {
  std::string id;
  std::string name;
  std::string version;
  std::string vendor;
  std::string sdk;
  std::string path;
  PluginStatus status = PluginStatus::failed;
  std::string error;
  std::vector<std::string> effects;
  bool gpu = false;
  /// SDK 1.1: the bundle ships a panel (`ui/index.html`).
  bool panel = false;
};

/// One parameter's value at the frame (decoded from the FrameScene entry).
struct ParamValue {
  std::array<double, 4> v{};
  std::string layer;         ///< LAYER: the referenced layer id ("" = none)
  std::vector<double> path;  ///< PATH: 6 doubles per vertex
  bool pathClosed = false;
  std::vector<std::uint8_t> arb;
  // SDK 1.1.
  std::string text;              ///< STRING
  std::vector<double> curve;     ///< CURVE: x, y pairs in 0..1 (empty = the declared default)
  std::vector<double> gradient;  ///< GRADIENT: 5 doubles per stop (empty = the declared default)
  std::string fileItem;          ///< FILE: the project item id ("" = none chosen)
  std::string filePath;          ///< FILE: the file on disk ("" = none / missing)
  std::string fileName;
  bool fileMissing = false;
};

/// SDK 1.1 (pr_scene.h): the comp's camera at the frame, as the engine evaluated it.
struct SceneCamera {
  bool hasCamera = false;
  bool orthographic = false;
  bool dofEnabled = false;
  std::array<double, 16> view{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  std::array<double, 16> projection{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  std::array<double, 3> eye{};
  double zoom = 0;
  double focusDistance = 0;
  double aperture = 0;
};

/// SDK 1.1: one comp light at the frame (RenderLight3D's fields, in pr_scene.h's terms).
struct SceneLight {
  std::int32_t type = 0;  ///< PrLightType
  std::array<double, 3> color{1, 1, 1};
  double intensity = 1;
  std::array<double, 3> position{};
  std::array<double, 3> direction{};
  double coneAngle = 0;
  double coneFeather = 0;
  std::int32_t falloff = 0;
  double falloffDistance = 0;
  bool castsShadows = false;
  double shadowDarkness = 0;
  double shadowDiffusion = 0;
};

/// Everything a render selector call needs besides pixels.
struct RenderInputs {
  std::string matchName;
  std::string instance;  ///< "<layer>/<effectId>" — the sequence / failure key
  std::string layerId;
  std::vector<std::uint8_t> sequence;  ///< the FLAT sequence data from the document
  std::vector<ParamValue> values;      ///< parallel to EffectSpec::params
  std::int64_t layerTime = 0;
  std::int64_t compTime = 0;
  std::int64_t timeStep = 0;
  double fps = 30;
  std::int32_t layerW = 0, layerH = 0;
  std::int32_t worldW = 0, worldH = 0;
  std::array<double, 9> layerToWorld{1, 0, 0, 0, 1, 0, 0, 0, 1};
  std::uint32_t projectBits = 16;
  bool draft = false;
  /// SDK 1.1 — present when the effect declared PR_OUT_FLAG_USES_CAMERA (scene_finish fills it).
  std::optional<SceneCamera> camera;
  /// SDK 1.1 — PR_OUT_FLAG_USES_LIGHTS.
  std::optional<std::vector<SceneLight>> lights;
  /// SDK 1.1 — PR_OUT_FLAG_USES_LAYER_TRANSFORMS: a LAYER param's world matrix (column-major),
  /// parallel to `values` (nullopt = the param names no layer / none evaluated).
  std::vector<std::optional<std::array<double, 16>>> layerMatrices;
  /// The comp size (the default camera's film).
  double compW = 0, compH = 0;
};

/// A layer checkout asked for in SMART_PRE_RENDER.
struct CheckoutRequest {
  std::uint32_t id = 0;
  std::uint32_t paramIndex = 0;  ///< 0 = the input; else a LAYER param's index
  std::int64_t time = 0;         ///< layer time, flicks
};

/// Pixels for a smart render: the render-side glue implements it.
class CheckoutSource {
 public:
  CheckoutSource() = default;
  virtual ~CheckoutSource() = default;
  CheckoutSource(const CheckoutSource&) = delete;
  CheckoutSource& operator=(const CheckoutSource&) = delete;
  CheckoutSource(CheckoutSource&&) = delete;
  CheckoutSource& operator=(CheckoutSource&&) = delete;
  /// nullptr = the checkout exists but is empty (no such layer / nothing drawn).
  virtual PrWorld* cpu_checkout(std::uint32_t checkoutId) = 0;
  virtual PrWorld* cpu_output() = 0;
  virtual const PrGpuWorld* gpu_checkout(std::uint32_t checkoutId) = 0;
};

struct CallResult {
  bool ok = false;
  Fault fault;          ///< a crash (the instance or plugin is now disabled)
  std::string message;  ///< the plugin's return_msg, or what went wrong
  /// The effect did not run because the instance / plugin is disabled.
  bool skipped = false;
};

/// A disabled instance, for layerErrors.
struct InstanceFailure {
  std::string instance;
  std::string layerId;
  std::string pluginId;
  std::string matchName;
  std::string message;
};

/// UPDATE_PARAMS_UI's answer for one param (getEffectUi).
struct ParamUi {
  std::string key;
  std::string name;
  bool enabled = true;
  bool hidden = false;
};

struct HostOptions {
  /// Folders scanned for plugin bundles (each bundle: a folder with premation-plugin.json).
  std::vector<std::filesystem::path> searchPaths;
  /// The crash journal file (empty = no journal: nothing survives an engine death).
  std::filesystem::path journal;
  /// A call longer than this is a hang (0 = no watchdog).
  std::chrono::milliseconds watchdog{10000};
  /// What a hang does beyond quarantining the plugin. Default: log and end the
  /// engine process (the supervisor restarts it; the hung thread cannot be
  /// stopped safely). Tests install a recorder.
  std::function<void(const std::string& pluginId, std::string_view command)> onHang;
  /// Worker threads for iterate() (0 = hardware concurrency − 1, at most 16).
  int threads = 0;
  /// Register the effects with the document (NativeEffects) and install its handlers.
  bool attachToDocument = true;
  /// Plugins the user disabled (Electron's `state.json`, `--plugin-disabled`):
  /// listed as disabled and NOT loaded — none of their code runs until
  /// setPluginEnabled turns them on.
  std::vector<std::string> disabled;
  /// The registry's signed revocation list, already verified by Electron
  /// (`--revoked <file>`): plugin id → reason. A revoked plugin is listed
  /// `revoked` and never loaded; setPluginEnabled cannot turn it on.
  std::map<std::string, std::string, std::less<>> revoked;
  /// The Premation Cloud entitlement token file (`--entitlement`, written by
  /// Electron main; entitlement.hpp). A bundle whose manifest requires an
  /// entitlement loads only when this verifies and has not expired; otherwise
  /// it is listed `locked` and its effects pass through.
  std::filesystem::path entitlement;
  /// The key the token must be signed with (tests substitute their own).
  std::string operatorKey = std::string(kOperatorPublicKey);
  /// Milliseconds since the epoch, for the token's expiry (tests pin it).
  /// Read at load only — never during rendering.
  std::function<std::int64_t()> nowMs;
};

/// `--revoked <file>`: `{"revoked":[{"id":"…","reason":"…"}]}` → id → reason.
/// A missing or malformed file is an empty list (logged): Electron verified the
/// signed list before writing it, and a bad file must not stop the engine.
[[nodiscard]] std::map<std::string, std::string, std::less<>> read_revoked_file(const std::filesystem::path& file);

class PluginHost {
 public:
  explicit PluginHost(HostOptions options);
  ~PluginHost();
  PluginHost(const PluginHost&) = delete;
  PluginHost& operator=(const PluginHost&) = delete;
  PluginHost(PluginHost&&) = delete;
  PluginHost& operator=(PluginHost&&) = delete;

  /// Discover and load every plugin in the search paths (again: new bundles
  /// load; loaded ones stay). Returns the records afterwards.
  std::vector<PluginRecord> scan();
  [[nodiscard]] std::vector<PluginRecord> plugins() const;
  /// setPluginEnabled. Enabling a quarantined / failed plugin retries it and
  /// clears its disabled instances. False = no such plugin.
  bool set_enabled(std::string_view pluginId, bool enabled);
  [[nodiscard]] const EffectSpec* effect(std::string_view matchName) const;

  // ── document side (the core thread) ──
  /// SEQUENCE_SETUP → FLATTEN → SETDOWN: a new instance's flat sequence data.
  std::optional<std::vector<std::uint8_t>> initial_sequence(std::string_view matchName);
  /// USER_CHANGED_PARAM (invokeEffectAction).
  std::variant<doc::NativeEdit, doc::NativeFailure> user_changed(const doc::NativeActionRequest& r);
  /// SDK 1.1 DRAW_OVERLAY: the effect instance's viewer overlay (layer px).
  std::variant<std::vector<doc::NativeOverlayItem>, doc::NativeFailure> draw_overlay(const doc::NativeActionRequest& r);
  /// SDK 1.1 OVERLAY_DRAG (dragEffectOverlay): what the plugin wrote for the handle's new position.
  std::variant<doc::NativeEdit, doc::NativeFailure> overlay_drag(const doc::NativeActionRequest& r, const doc::NativeOverlayDrag& d);
  /// UPDATE_PARAMS_UI (getEffectUi): every param's UI state for these inputs.
  std::variant<std::vector<ParamUi>, std::string> params_ui(const RenderInputs& in);
  /// getEffectUi for a document effect instance (the document's static params, sequence and arbitrary data).
  std::variant<std::vector<api::EffectParamUi>, doc::NativeFailure> params_ui_for(const doc::NativeActionRequest& r);
  /// listPlugins.
  [[nodiscard]] std::vector<api::PluginInfo> plugin_infos() const;

  // ── render side (any thread) ──
  CallResult pre_render(const RenderInputs& in, std::vector<CheckoutRequest>& out);
  /// SMART_RENDER (or FRAME_SETUP / RENDER / FRAME_SETDOWN for non-smart
  /// effects), into `io`'s worlds of `format`.
  CallResult render_cpu(const RenderInputs& in, CheckoutSource& io, PrPixelFormat format);
  /// SMART_RENDER_GPU on `device` (GPU_DEVICE_SETUP on first use per device).
  CallResult render_gpu(const RenderInputs& in, CheckoutSource& io, const PrGpuDeviceInfo& device, void* commandEncoder,
                        const PrGpuWorld& input, const PrGpuWorld& output);
  /// GPU_DEVICE_SETDOWN for every effect set up on `deviceIndex` (the device is going away).
  void gpu_device_gone(std::uint32_t deviceIndex);

  /// The world depth an effect renders at in a project of `projectBits` (AE's down-conversion).
  [[nodiscard]] static PrPixelFormat world_format(const EffectSpec& e, std::uint32_t projectBits) noexcept;
  [[nodiscard]] bool instance_disabled(std::string_view instance, std::string* why = nullptr) const;
  [[nodiscard]] std::vector<InstanceFailure> failures() const;

  /// Drop instances not rendered for `idleFrames` frames (SEQUENCE_SETDOWN).
  /// Their state is the document's flat copy, so a later render rebuilds them.
  void collect_instances(std::uint64_t idleFrames);
  void next_frame() noexcept { frame_.fetch_add(1, std::memory_order_relaxed); }

  /// The process's active host (the engine's; the render glue and the scene
  /// hook reach it through here). nullptr when none is attached.
  static PluginHost* active() noexcept;

  /// PrHostSuite callbacks reach the host through these (host.cpp internals).
  struct Impl;
  [[nodiscard]] Impl& impl() noexcept { return *impl_; }

 private:
  /// USER_CHANGED_PARAM / DRAW_OVERLAY / OVERLAY_DRAG on a private instance built from the
  /// document's flat data: its params and sequence, the call, the flattened result.
  std::variant<doc::NativeEdit, doc::NativeFailure> instance_call(const doc::NativeActionRequest& req, std::int32_t cmd,
                                                                  std::uint32_t paramIndex, void* extra,
                                                                  std::vector<doc::NativeOverlayItem>* draw);
  std::unique_ptr<Impl> impl_;
  std::atomic<std::uint64_t> frame_{0};
};

}  // namespace premation::plugins
