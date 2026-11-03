// Native SDK plugin effects in the document (G1, docs/PLUGIN_SDK.md).
//
// The plugin host (src/plugins) loads plugins, runs their PARAMS_SETUP and
// registers each effect here as an EffectDef in the document's own parameter
// vocabulary ('number' / 'color' / 'checkbox' / 'enum' / 'layer' /
// 'maskPath'). From then on a plugin effect is an ordinary effect:
// Registry::effect() resolves its type, so addEffect, the property catalog,
// setProperty, keyframes, expressions, save/open and the change events all
// work unchanged. This file is the ONLY coupling: the document core never
// sees a plugin binary, a selector or a pixel.
//
// Process-wide and thread-safe (the core thread resolves types; the host
// registers at startup / rescans). A registered EffectDef is never destroyed
// before the process ends — callers keep `const EffectDef*` — and a type
// re-registered by a rescan resolves to the newest entry.
//
// The host also installs three handlers the edit commands call:
//   created   addEffect of a native type → the instance's initial FLAT
//             sequence data (SEQUENCE_SETUP + FLATTEN), stored in the
//             document in the same history entry.
//   action    invokeEffectAction (a button, or a supervised param change) →
//             USER_CHANGED_PARAM → the param writes + new sequence data the
//             command applies as ONE history entry.
//   enabled   setPluginEnabled.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "catalog_data.hpp"
#include "engine_api.hpp"

namespace premation::doc {

/// A button (PR_PARAM_BUTTON): the action name invokeEffectAction takes (`p<id>`), its label, and
/// where the effect card draws it — inside `group` (EffectParamDef::group's spelling, "" = top
/// level), before `def.params[at]`.
struct NativeAction {
  std::string key;
  std::string label;
  std::string group;
  std::uint32_t at = 0;
};

/// A twirl-down group (PR_PARAM_GROUP_START): its path as its params' `group` spells it, the
/// GROUP_START param's key, and whether it starts twirled up (PR_PARAM_FLAG_START_COLLAPSED).
struct NativeGroup {
  std::string path;
  std::string key;
  bool collapsed = false;
  std::string description;  ///< the GROUP_START's PrParamDef.description (SDK 1.2): the header's tooltip
};

/// SDK 1.3 — a PR_PARAM_CUSTOM_UI row: placed like a button (`at` params before it, in `group`),
/// `height` px tall.
struct NativeCustomUi {
  std::string key;
  std::string label;
  std::string group;
  std::uint32_t at = 0;
  double height = 120;
  std::string description;
  /// How many of the buttons at the same `at` were declared before it (their order between the same params).
  std::uint32_t afterButtons = 0;
};

struct NativeEffect {
  EffectDef def;         ///< type = the plugin's match name
  std::string provider;  ///< the plugin id
  std::string category;
  bool gpu = false;
  bool supportsFloat = false;
  bool generator = false;
  /// Buttons, in declaration order.
  std::vector<NativeAction> actions;
  /// Groups, in declaration order.
  std::vector<NativeGroup> groups;
  /// PR_CMD_ABOUT's text (name, version, vendor, credits) — the effect card's About.
  std::string about;
  /// Supervised params (PR_PARAM_FLAG_SUPERVISE): the document keys whose change the plugin reacts to.
  std::vector<std::string> supervised;
  /// Arbitrary-data params (PR_PARAM_ARBITRARY_DATA): not properties — bytes in fx.pluginData
  /// under native_arb_key(key), written by the plugin (USER_CHANGED_PARAM) or setPluginData.
  std::vector<std::string> arbitrary;
  /// SDK 1.1 PR_OUT_FLAG_CUSTOM_OVERLAY: draws a viewer overlay (DRAW_OVERLAY) with draggable handles.
  bool overlay = false;
  /// SDK 1.1: the plugin's bundle ships a panel (`ui/index.html`, PluginInfo.panel).
  bool panel = false;
  /// SDK 1.1 FILE params: the document key and the extensions offered ("cube|3dl", "" = any).
  /// The value is a project item id, so collect / relink / save carry the file.
  std::vector<std::pair<std::string, std::string>> files;
  /// SDK 1.3 PR_PARAM_CUSTOM_UI rows: boxes the plugin draws in Effect Controls (DRAW_PARAM_UI).
  std::vector<NativeCustomUi> customUis;
};

/// SDK 1.4 (L1) — a plugin layer type (manifest `layerTypes`): createLayer kind=generator with
/// `generator` = `type` makes a solid carrying `effect` as its effect `layer`.
struct NativeLayerType {
  std::string type;      ///< "<pluginId>:<id>"
  std::string name;
  std::string effect;    ///< the generator effect's match name
  std::string category;
  std::string provider;  ///< the plugin id
};

/// SDK 1.1 — one item of a plugin's viewer overlay (DRAW_OVERLAY), layer px (SDK 1.2: or comp px, `space`);
/// SDK 1.3 — or of an Effect Controls box (DRAW_PARAM_UI), box px.
struct NativeOverlayItem {
  std::string kind;  ///< "line" | "path" | "handle"; SDK 1.3 boxes also "fill" | "text"
  std::vector<double> points;  ///< x, y pairs
  bool closed = false;
  std::vector<double> color;   ///< straight rgba 0..1; empty = the viewer's handle colour
  std::uint32_t handle = 0;    ///< a handle's id (OVERLAY_DRAG)
  std::uint32_t shape = 0;     ///< PR_OVERLAY_HANDLE_*
  std::uint32_t space = 0;     ///< SDK 1.2 PR_OVERLAY_SPACE_*: 0 layer px, 1 composition px
  std::string text;            ///< SDK 1.3 "text": UTF-8, one line
  double size = 0;             ///< SDK 1.3 "text": px
  std::uint32_t align = 0;     ///< SDK 1.3 "text": PR_UI_TEXT_*
};

/// SDK 1.3 — the Effect Controls box a DRAW_PARAM_UI / PARAM_UI_DRAG call is for.
struct NativeParamUiTarget {
  std::string key;  ///< the PR_PARAM_CUSTOM_UI param's key (`p7`)
  double width = 0, height = 0;
};

/// SDK 1.1 — dragEffectOverlay's pointer, in the handle's space (layer px; SDK 1.2: or comp px).
struct NativeOverlayDrag {
  std::uint32_t handle = 0;
  std::int32_t phase = 0;  ///< PR_OVERLAY_DRAG_*
  double x = 0, y = 0, startX = 0, startY = 0;
  std::uint32_t space = 0;  ///< SDK 1.2 PR_OVERLAY_SPACE_*
};

/// SDK 1.2 — what a plugin's get_comp_camera / get_comp_lights / get_layer_transform answer in
/// DRAW_OVERLAY / OVERLAY_DRAG: the composition the layer is in, at the request's time, read off
/// the document (NativeEffects::fill_scene; the plugin host evaluates only what the effect declared).
struct NativeScene {
  double compW = 0, compH = 0;
  std::optional<api::RenderCamera3D> camera;  ///< absent = no camera layer: the comp's default view
  std::vector<api::RenderLight3D> lights;
  /// LAYER param key → that layer's world matrix (layer px → world px, 16, column-major).
  std::vector<std::pair<std::string, std::vector<double>>> matrices;
};

struct SpaceCtx;  // worldxf.hpp

/// What invokeEffectAction hands the host.
struct NativeActionRequest {
  std::string layer;
  std::string effectId;
  std::string type;
  std::string action;  ///< a button's `p<id>`, or `changed:p<id>` after a supervised edit
  /// SDK 1.1: invokeEffectAction's payload (a plugin panel's data for the button), UTF-8.
  std::string payload;
  /// SDK 1.1 FILE params, resolved against the document's items: key → the file.
  struct File {
    std::string key;
    std::string item;  ///< the project item id ("" = none chosen)
    std::string path;  ///< the file on disk ("" when none / not backed by a file)
    std::string name;  ///< the item's name
    bool missing = false;  ///< chosen, but the file is not there
  };
  std::vector<File> files;
  /// The effect's migrated params (static values).
  Json params;
  /// The instance's flat sequence data from the document (empty = none yet).
  std::vector<std::uint8_t> sequence;
  /// Arbitrary-data params: key → bytes.
  std::vector<std::pair<std::string, std::vector<std::uint8_t>>> arb;
  double timeSeconds = 0;
  /// SDK 1.2: the layer's own time at `timeSeconds` (handlers_native.hpp NativeLayerClock).
  std::optional<double> layerTimeSeconds;
  /// SDK 1.2: the comp camera / lights / LAYER matrices for DRAW_OVERLAY / OVERLAY_DRAG (fill_scene).
  std::optional<NativeScene> scene;
  /// The layer's size in layer px as the document places it (DRAW_OVERLAY / OVERLAY_DRAG:
  /// native_layer_frame). Wins over the size the instance's last render saw, which is none
  /// before the first render.
  std::optional<std::pair<double, double>> layerSize;
  /// SDK 1.3: set = draw_overlay / overlay_drag run the Effect Controls box's selectors
  /// (DRAW_PARAM_UI / PARAM_UI_DRAG) instead of the viewer overlay's.
  std::optional<NativeParamUiTarget> paramUi;
};

/// What the plugin changed.
struct NativeEdit {
  /// Property path under the effect (`p2`, `p1X`) → value in the API's encoding. An animated
  /// property takes it as a keyframe at the playhead (AE's set-param-value on a keyed param).
  std::vector<std::pair<std::string, api::Value>> params;
  std::optional<std::vector<std::uint8_t>> sequence;
  std::vector<std::pair<std::string, std::vector<std::uint8_t>>> arb;
};

/// A failure the handler reports (the command answers it as an EngineError).
struct NativeFailure {
  std::string message;
};

class NativeEffects {
 public:
  static void add(NativeEffect e);
  /// SDK 1.4: register a plugin layer type (newest wins, as for effects).
  static void add_layer_type(NativeLayerType t);
  /// The layer type `type` while its plugin's effects are available; nullopt otherwise.
  [[nodiscard]] static std::optional<NativeLayerType> layer_type(std::string_view type);
  /// The newest registration of `type`, or nullptr (not a native effect).
  [[nodiscard]] static const NativeEffect* find(std::string_view type) noexcept;
  /// Every native effect currently available (newest per type, in registration order).
  [[nodiscard]] static std::vector<const NativeEffect*> list();
  /// Mark a provider's effects unavailable to new instances (listings) while
  /// documents that use them keep resolving (a disabled / failed / removed plugin).
  static void set_available(std::string_view provider, bool available);
  [[nodiscard]] static bool available(std::string_view type) noexcept;
  /// Premation Cloud (plugins/entitlement.hpp): a plugin found but `locked`
  /// for want of an entitlement. Its effects are not registered; `locked`
  /// lets the frame name the reason ("requires Premation Cloud") rather than
  /// report a missing plugin. `type` is an effect match name (`<id>` or `<id>.<name>`).
  static void set_locked(std::string_view plugin, bool locked);
  [[nodiscard]] static bool locked(std::string_view type) noexcept;

  using CreatedFn = std::function<std::optional<std::vector<std::uint8_t>>(std::string_view type)>;
  using ActionFn = std::function<std::variant<NativeEdit, NativeFailure>(const NativeActionRequest&)>;
  using EnabledFn = std::function<bool(std::string_view plugin, bool enabled)>;
  static void set_handlers(CreatedFn created, ActionFn action, EnabledFn enabled);
  /// listPlugins / getEffectUi (the host answers; no host = no plugins).
  using ListFn = std::function<std::vector<api::PluginInfo>()>;
  using UiFn = std::function<std::variant<std::vector<api::EffectParamUi>, NativeFailure>(const NativeActionRequest&)>;
  static void set_query_handlers(ListFn list, UiFn ui);
  /// rescanPlugins: the host rescans its folders and answers listPlugins.
  static void set_rescan_handler(ListFn rescan);
  /// reloadPlugin (Developer Mode): true = the new build is loaded; false = `why` says why (the old
  /// module stays). No handler = no plugin host.
  using ReloadFn = std::function<bool(std::string_view plugin, std::string& why)>;
  static void set_reload_handler(ReloadFn reload);
  /// SDK 1.4 (T2): the bytes of simulation states kept in RAM and on disk (getRenderStats).
  using SimBytesFn = std::function<std::pair<std::uint64_t, std::uint64_t>()>;
  static void set_sim_bytes_handler(SimBytesFn fn);
  [[nodiscard]] static std::optional<std::pair<std::uint64_t, std::uint64_t>> sim_bytes();
  /// SDK 1.1 viewer overlays: DRAW_OVERLAY (overlay geometry) and OVERLAY_DRAG (dragEffectOverlay).
  using OverlayFn = std::function<std::variant<std::vector<NativeOverlayItem>, NativeFailure>(const NativeActionRequest&)>;
  using DragFn = std::function<std::variant<NativeEdit, NativeFailure>(const NativeActionRequest&, const NativeOverlayDrag&)>;
  static void set_overlay_handlers(OverlayFn draw, DragFn drag);
  /// SDK 1.2: fill `r.scene` (the comp camera, lights, LAYER matrices at r.timeSeconds) for an
  /// overlay call — the host's evaluator (it reads what the effect declared it uses). No handler:
  /// `r.scene` stays empty and the scene callbacks answer PR_ERR_INVALID_CALLBACK as before.
  using SceneFn = std::function<void(const SpaceCtx& space, NativeActionRequest& r)>;
  static void set_scene_handler(SceneFn fn);
  static void fill_scene(const SpaceCtx& space, NativeActionRequest& r);
  [[nodiscard]] static std::variant<std::vector<NativeOverlayItem>, NativeFailure> draw_overlay(const NativeActionRequest& r);
  [[nodiscard]] static std::variant<NativeEdit, NativeFailure> overlay_drag(const NativeActionRequest& r, const NativeOverlayDrag& d);
  /// SDK 1.2 PR_CMD_LIST_ASSET_FILES (Collect Files): the files beside FILE param `key`'s asset
  /// (`r.files`' entry for it holds the asset's path) the effect reads, relative to the asset's
  /// folder. No handler / no such plugin = none; a fault = a NativeFailure (the asset is still collected).
  using AssetFilesFn = std::function<std::variant<std::vector<std::string>, NativeFailure>(const NativeActionRequest&, std::string_view key)>;
  static void set_asset_files_handler(AssetFilesFn fn);
  [[nodiscard]] static std::variant<std::vector<std::string>, NativeFailure> asset_files(const NativeActionRequest& r,
                                                                                         std::string_view key);
  static void clear_handlers();

  /// addEffect: the initial flat sequence data for a new instance (nullopt = none).
  [[nodiscard]] static std::optional<std::vector<std::uint8_t>> created(std::string_view type);
  /// invokeEffectAction. No handler = a NativeFailure.
  [[nodiscard]] static std::variant<NativeEdit, NativeFailure> action(const NativeActionRequest& r);
  /// setPluginEnabled: false = no such plugin (or no host).
  [[nodiscard]] static bool set_enabled(std::string_view plugin, bool enabled);
  /// listPlugins: every plugin the host found (empty without a host).
  [[nodiscard]] static std::vector<api::PluginInfo> plugins();
  /// rescanPlugins: nullopt when no plugin host is attached.
  [[nodiscard]] static std::optional<std::vector<api::PluginInfo>> rescan();
  /// reloadPlugin: nullopt when no plugin host is attached; else whether it reloaded (`why` if not).
  [[nodiscard]] static std::optional<bool> reload(std::string_view plugin, std::string& why);
  /// getEffectUi for a native effect instance (`action` unused). No host = a NativeFailure.
  [[nodiscard]] static std::variant<std::vector<api::EffectParamUi>, NativeFailure> params_ui(const NativeActionRequest& r);
};

/// The document's pluginData group of an effect instance, and its keys (setPluginData's group/key).
[[nodiscard]] std::string native_data_group(std::string_view effectId);
inline constexpr std::string_view kNativeSequenceKey = "sequence";
/// `arb:<param key>`.
[[nodiscard]] std::string native_arb_key(std::string_view paramKey);

/// SDK 1.1 CURVE: the document's `[[x, y], …]` (0..255, the Curves effect's form) → x, y
/// pairs in 0..1, x ascending, at least two points (identity for anything unreadable).
[[nodiscard]] std::vector<double> native_curve(const Json& v);
/// The plugin's 0..1 pairs → the document's form.
[[nodiscard]] Json native_curve_json(const std::vector<double>& xy);
/// SDK 1.1 GRADIENT: the document's `[[position, r, g, b, a], …]` (0..1) → 5 doubles per
/// stop, by position, at least one stop (black → white for anything unreadable).
[[nodiscard]] std::vector<double> native_gradient(const Json& v);
[[nodiscard]] Json native_gradient_json(const std::vector<double>& stops);

/// base64 (RFC 4648, padded) — the encoding fx.pluginData stores bytes in.
[[nodiscard]] std::string native_base64(const std::vector<std::uint8_t>& bytes);
[[nodiscard]] std::optional<std::vector<std::uint8_t>> native_unbase64(std::string_view text);

}  // namespace premation::doc
