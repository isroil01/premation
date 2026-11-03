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
class Contrib;  // P7: commands, importers, output modules, panels (contrib.hpp)

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
  // SDK 1.2 (struct_size-guarded).
  std::string description;        ///< the param's (a GROUP_START: the group's) tooltip ("" = none)
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
  /// SDK 1.4 (C): the manifest's channels for this effect.
  std::vector<std::string> publishes;
  std::vector<std::string> reads;
  [[nodiscard]] bool has(std::uint32_t flag) const noexcept { return (outFlags & flag) != 0; }
};

/// SDK 1.4 (C): one frame's published channels, by name.
using ChannelValues = std::map<std::string, std::vector<double>, std::less<>>;

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
  /// The manifest's `icon` when that file exists ("ui/icon.png"), else "".
  std::string icon;
  /// The manifest's `panelTitle` ("" = none).
  std::string panelTitle;
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

/// SDK 1.2 (PR_SAMPLE_SCENE_DEPTH): the comp's 3D layers and camera posed at a sample's time, for
/// its scene depth (render_graph/scene_depth.cpp draws the frame's renderables with these instead).
struct DepthPose {
  /// The comp camera at that time; absent = the frame's (the comp has no camera layer, or the frame
  /// shows the comp through a viewer's own view).
  std::optional<api::RenderCamera3D> camera;
  /// Renderable id → its `three_d.model` at that time (16, column-major). A drawn layer not listed
  /// keeps its frame pose.
  std::vector<std::pair<std::string, std::vector<double>>> models;
};

/// SDK 1.2: what the effect asked to read at one other LAYER time (checkout_time), as the
/// engine evaluated it (scene_finish.cpp) — PR_SAMPLE_* bits in `what`.
struct TimeSample {
  std::int64_t time = 0;  ///< layer time, flicks
  std::uint32_t what = 0;
  std::vector<ParamValue> values;  ///< PR_SAMPLE_PARAMS: parallel to EffectSpec::params
  std::optional<SceneCamera> camera;
  std::optional<std::vector<SceneLight>> lights;
  std::vector<std::optional<std::array<double, 16>>> layerMatrices;
  /// PR_SAMPLE_SCENE_DEPTH (an effect with PR_OUT_FLAG_USES_SCENE_DEPTH).
  std::optional<DepthPose> depth;
};

/// SDK 1.2: one checkout_time request from SMART_PRE_RENDER.
struct TimeRequest {
  std::int64_t time = 0;  ///< layer time, flicks
  std::uint32_t what = 0;
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
  // SDK 1.2.
  std::int64_t layerStart = 0;  ///< comp time of layer time 0, flicks
  bool layer3d = false;
  bool motionBlur = false;  ///< comp + layer switches on for this render
  double shutterAngle = 0, shutterPhase = 0;
  std::uint32_t motionBlurSamples = 0;
  /// Comp px → world px (row-major 3×3; render_glue fills it from the chain's buffer).
  std::array<double, 9> compToWorld{1, 0, 0, 0, 1, 0, 0, 0, 1};
  /// The times the effect checked out (PR_OUT_FLAG_SAMPLES_TIME), sorted by time.
  std::vector<TimeSample> samples;
  /// SDK 1.4 (T): a STATEFUL effect's state after this frame's SIM_STEP (get_sim_state); absent = none.
  std::optional<std::vector<std::uint8_t>> simState;
  /// SDK 1.4 (C): the frame's channels this effect reads (scene_finish.cpp: `ch.<name>`).
  ChannelValues channels;
};

/// SDK 1.4 (T): the state of a STATEFUL effect instance at one of its layer frames.
struct SimRequest {
  /// Any frame's inputs (matchName, instance, layer size, sequence…): the effect and the instance.
  RenderInputs base;
  /// The layer frame wanted (0 = the layer's first frame; earlier times use frame 0).
  std::int64_t frame = 0;
  /// Flicks per frame (the step's dt).
  std::int64_t step = 0;
  /// What makes every frame's inputs what they are (the effect's record, its keyframes, the
  /// sequence data): while it is the same, the per-frame input hashes are kept. 0 = re-evaluate
  /// every frame's inputs on every call (an expression may read anything).
  std::uint64_t inputsKey = 0;
  /// The effect's inputs at layer frame `k` (its params evaluated at k × step).
  std::function<RenderInputs(std::int64_t k)> inputsAt;
  /// T4: stop stepping after this long (ms) and set `*partial` — the viewer's frame stays
  /// responsive; the states made so far are kept and the next request goes on from them. 0 = no limit.
  double budgetMs = 0;
  bool* partial = nullptr;
};

struct SimStats {
  std::uint64_t steps = 0;      ///< SIM_STEP calls made
  std::uint64_t cacheHits = 0;  ///< requests answered by a kept state without stepping
  std::uint64_t bytes = 0;      ///< states kept in RAM now
  std::uint64_t diskBytes = 0;  ///< states kept on disk now (HostOptions::simDiskDir)
  std::uint64_t diskHits = 0;   ///< requests a state read back from disk answered
};

/// SDK 1.2: what SMART_PRE_RENDER said besides layer checkouts.
struct PreRenderInfo {
  std::vector<TimeRequest> times;  ///< checkout_time, merged per time, in call order
  PrRect request{};
  PrRect result{};  ///< result_rect as the plugin left it (preset to `request`)
};

/// SDK 1.2: a decoded asset image (get_asset_image): linear, premultiplied RGBA float, rows top-down.
struct AssetImage {
  std::int32_t width = 0;
  std::int32_t height = 0;
  std::vector<float> rgba;
};

/// Decodes an image file into straight or premultiplied pixels; `premultiplied` / `linear` say
/// which (the host converts to linear premultiplied). False + `error` when it cannot.
struct DecodedAsset {
  AssetImage image;
  bool linear = false;         ///< false = sRGB-encoded (8-bit footage)
  bool premultiplied = false;  ///< false = straight alpha
  bool unsupported = false;    ///< set by a decoder that does not read this kind of file
};
using AssetImageDecoder = std::function<bool(const std::filesystem::path& file, DecodedAsset& out, std::string& error)>;
/// Install the engine's image decoders (scene_finish.cpp does, for every binary that renders
/// frames). Without one only the host's own formats decode (Radiance .hdr, binary .ppm / .pfm).
void set_asset_image_decoder(AssetImageDecoder decoder);

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
  /// SDK 1.2 get_asset_image_gpu: `image` as an rgba32float texture on the render's device,
  /// uploaded once per `key` (file + modification time) and kept with the device. nullptr = no GPU.
  virtual const PrGpuWorld* gpu_asset(const std::string& /*key*/, const AssetImage& /*image*/) { return nullptr; }
  /// SDK 1.2 checkout_scene_depth_gpu / checkout_scene_depth (S6): the depth of the comp's other
  /// 3D layers in the render's world (pr_host.h), made when first asked. nullptr = no GPU to make it.
  virtual const PrGpuWorld* gpu_scene_depth() { return nullptr; }
  virtual PrWorld* cpu_scene_depth() { return nullptr; }
  /// SDK 1.2 checkout_scene_depth_gpu_at / _at: the same depth with the comp's 3D layers and camera
  /// posed at a checked-out sample (`sample.depth`). nullptr = no GPU.
  virtual const PrGpuWorld* gpu_scene_depth_at(const TimeSample& /*sample*/) { return nullptr; }
  virtual PrWorld* cpu_scene_depth_at(const TimeSample& /*sample*/) { return nullptr; }
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
  /// A P7 call (command, importer, output module) reported progress: besides
  /// restarting its own watchdog clock, the engine tells its core watchdog the
  /// core thread is alive (engine_process.cpp). Empty = nothing more.
  std::function<void()> onProgress;
  /// Worker threads for iterate() (0 = hardware concurrency − 1, at most 16).
  int threads = 0;
  /// Register the effects with the document (NativeEffects) and install its handlers.
  bool attachToDocument = true;
  /// Plugins the user disabled (Electron's `state.json`, `--plugin-disabled`):
  /// listed as disabled and NOT loaded — none of their code runs until
  /// setPluginEnabled turns them on.
  std::vector<std::string> disabled;
  /// Developer Mode (`--plugin-shadow`): when set, each plugin binary (and the shared libraries
  /// beside it) is copied to <shadowDir>/<plugin id>/<n>/ and loaded from there. The bundle's own
  /// files stay unlocked, so the author's build can overwrite them, and reload() loads the new
  /// build. Empty = load in place (the shipping default).
  std::filesystem::path shadowDir;
  /// SDK 1.4 (T2): where simulation states evicted from RAM go (`--sim-cache-dir`). Named by the
  /// hash chain of their inputs, so they stay valid across sessions; empty = RAM only.
  std::filesystem::path simDiskDir;
  /// How much of it they may use; the oldest files go first.
  std::uint64_t simDiskBudget = std::uint64_t{1} << 30U;
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
  /// reloadPlugin (Developer Mode, W2): load the plugin's bundle again — manifest, binary (from a
  /// fresh shadow copy when HostOptions::shadowDir is set), GLOBAL_SETUP and PARAMS_SETUP — and,
  /// only if that succeeds, swap it in. Renders already running finish on the old module; the next
  /// render of each instance sets the old one down and sets the new one up from the document's
  /// flat sequence data. The old module stays mapped (pinned): code of it may still be on a stack.
  /// A failed reload keeps the old module loaded and says why in `why`. False = not reloaded.
  bool reload(std::string_view pluginId, std::string& why);
  /// SDK 1.4 (E1/E2): offer the loaded, enabled plugins' expression functions to expressions
  /// (motion::expr::set_plugin_functions). Done after every scan, reload and enable / disable by
  /// the engine's host (attachToDocument); a test host calls it itself.
  void publish_expression_functions();
  /// One call of a plugin expression function, crash-guarded and under the watchdog. False +
  /// `error` when there is no such function or it failed (a fault disables it for the session).
  bool call_expression(std::string_view pluginId, std::string_view name, std::span<const double> args, std::vector<double>& out,
                       std::string& error);
  [[nodiscard]] const EffectSpec* effect(std::string_view matchName) const;

  // ── document side (the core thread) ──
  /// SEQUENCE_SETUP → FLATTEN → SETDOWN: a new instance's flat sequence data.
  std::optional<std::vector<std::uint8_t>> initial_sequence(std::string_view matchName);
  /// USER_CHANGED_PARAM (invokeEffectAction).
  std::variant<doc::NativeEdit, doc::NativeFailure> user_changed(const doc::NativeActionRequest& r);
  /// SDK 1.1 DRAW_OVERLAY: the effect instance's viewer overlay (layer px).
  /// SDK 1.3: with r.paramUi, DRAW_PARAM_UI — that Effect Controls box (box px).
  std::variant<std::vector<doc::NativeOverlayItem>, doc::NativeFailure> draw_overlay(const doc::NativeActionRequest& r);
  /// SDK 1.1 OVERLAY_DRAG (dragEffectOverlay): what the plugin wrote for the handle's new position.
  /// SDK 1.3: with r.paramUi, PARAM_UI_DRAG (dragEffectParamUi).
  std::variant<doc::NativeEdit, doc::NativeFailure> overlay_drag(const doc::NativeActionRequest& r, const doc::NativeOverlayDrag& d);
  /// SDK 1.3: the 1-based index of effect `type`'s PR_PARAM_CUSTOM_UI param `key`; 0 = none.
  [[nodiscard]] std::uint32_t custom_ui_index(const std::string& type, const std::string& key) const;
  /// UPDATE_PARAMS_UI (getEffectUi): every param's UI state for these inputs.
  std::variant<std::vector<ParamUi>, std::string> params_ui(const RenderInputs& in);
  /// getEffectUi for a document effect instance (the document's static params, sequence and arbitrary data).
  std::variant<std::vector<api::EffectParamUi>, doc::NativeFailure> params_ui_for(const doc::NativeActionRequest& r);
  /// SDK 1.2 LIST_ASSET_FILES (Collect Files): the files beside FILE param `key`'s asset the effect
  /// reads, '/'-separated and relative to the asset's folder ("..", absolute and drive paths dropped).
  /// No such plugin, an SDK 1.0 / 1.1 module or no asset = none; a fault or an error = a NativeFailure.
  std::variant<std::vector<std::string>, doc::NativeFailure> asset_files_for(const doc::NativeActionRequest& r, std::string_view key);
  /// listPlugins.
  [[nodiscard]] std::vector<api::PluginInfo> plugin_infos() const;

  // ── render side (any thread) ──
  /// SMART_PRE_RENDER. `info` (SDK 1.2): the times checked out and the result rect.
  CallResult pre_render(const RenderInputs& in, std::vector<CheckoutRequest>& out, PreRenderInfo* info = nullptr);
  /// SDK 1.4 (C): PR_CMD_PUBLISH_CHANNELS — the channels the instance publishes this frame
  /// (`in.channels`: the ones it reads, published before it). Crash-guarded like a render.
  CallResult publish_channels(const RenderInputs& in, ChannelValues& out);
  /// SMART_RENDER (or FRAME_SETUP / RENDER / FRAME_SETDOWN for non-smart
  /// effects), into `io`'s worlds of `format`.
  CallResult render_cpu(const RenderInputs& in, CheckoutSource& io, PrPixelFormat format);
  /// SMART_RENDER_GPU on `device` (GPU_DEVICE_SETUP on first use per device).
  CallResult render_gpu(const RenderInputs& in, CheckoutSource& io, const PrGpuDeviceInfo& device, void* commandEncoder,
                        const PrGpuWorld& input, const PrGpuWorld& output);
  /// GPU_DEVICE_SETDOWN for every effect set up on `deviceIndex` (the device is going away).
  void gpu_device_gone(std::uint32_t deviceIndex);
  /// SDK 1.4 (T): the state after layer frame `q.frame`'s SIM_STEP. Steps from the newest kept
  /// state whose every earlier frame had the same inputs (frame 0 starts from none), keeping each
  /// state it makes; scrubbing back re-uses them, and an edit at frame k re-steps from k. nullopt +
  /// `why` when a step fails (a fault disables the instance, as in a render).
  std::optional<std::vector<std::uint8_t>> sim_state(const SimRequest& q, std::string& why);
  [[nodiscard]] SimStats sim_stats() const;
  /// The RAM the kept states may use (default 256 MB); the least recently used go first.
  void set_sim_budget(std::size_t bytes);

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

  // ── P7 (contrib.hpp): plugins that are not effects ──
  /// What the plugins contribute besides effects: commands, importers, output modules, panels.
  [[nodiscard]] Contrib& contrib() noexcept { return *contrib_; }
  /// fn(ctx, host, suite) for `pluginId` under the crash guard, the crash journal and the watchdog
  /// (`journalCmd` names it there), serialised with the plugin's other non-render selectors. The
  /// PrHost answers the memory and log callbacks (the render-only ones refuse it). `skipped` when
  /// the plugin is not loaded; a fault pins the module (and a hang quarantines the plugin).
  using GuardedFn = void (*)(void* ctx, PrHost* host, const PrHostSuite* suite);
  CallResult call_guarded(std::string_view pluginId, std::int32_t journalCmd, GuardedFn fn, void* ctx);

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
  std::unique_ptr<Contrib> contrib_;
  std::atomic<std::uint64_t> frame_{0};
};

}  // namespace premation::plugins
