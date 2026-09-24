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

struct NativeEffect {
  EffectDef def;         ///< type = the plugin's match name
  std::string provider;  ///< the plugin id
  std::string category;
  bool gpu = false;
  bool supportsFloat = false;
  bool generator = false;
  /// Buttons (PR_PARAM_BUTTON): the action names invokeEffectAction takes (`p<id>`), with labels.
  std::vector<std::pair<std::string, std::string>> actions;
  /// Supervised params (PR_PARAM_FLAG_SUPERVISE): the document keys whose change the plugin reacts to.
  std::vector<std::string> supervised;
  /// Arbitrary-data params (PR_PARAM_ARBITRARY_DATA): not properties — bytes in fx.pluginData
  /// under native_arb_key(key), written by the plugin (USER_CHANGED_PARAM) or setPluginData.
  std::vector<std::string> arbitrary;
};

/// What invokeEffectAction hands the host.
struct NativeActionRequest {
  std::string layer;
  std::string effectId;
  std::string type;
  std::string action;  ///< a button's `p<id>`, or `changed:p<id>` after a supervised edit
  /// The effect's migrated params (static values).
  Json params;
  /// The instance's flat sequence data from the document (empty = none yet).
  std::vector<std::uint8_t> sequence;
  /// Arbitrary-data params: key → bytes.
  std::vector<std::pair<std::string, std::vector<std::uint8_t>>> arb;
  double timeSeconds = 0;
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
  /// The newest registration of `type`, or nullptr (not a native effect).
  [[nodiscard]] static const NativeEffect* find(std::string_view type) noexcept;
  /// Every native effect currently available (newest per type, in registration order).
  [[nodiscard]] static std::vector<const NativeEffect*> list();
  /// Mark a provider's effects unavailable to new instances (listings) while
  /// documents that use them keep resolving (a disabled / failed / removed plugin).
  static void set_available(std::string_view provider, bool available);
  [[nodiscard]] static bool available(std::string_view type) noexcept;

  using CreatedFn = std::function<std::optional<std::vector<std::uint8_t>>(std::string_view type)>;
  using ActionFn = std::function<std::variant<NativeEdit, NativeFailure>(const NativeActionRequest&)>;
  using EnabledFn = std::function<bool(std::string_view plugin, bool enabled)>;
  static void set_handlers(CreatedFn created, ActionFn action, EnabledFn enabled);
  static void clear_handlers();

  /// addEffect: the initial flat sequence data for a new instance (nullopt = none).
  [[nodiscard]] static std::optional<std::vector<std::uint8_t>> created(std::string_view type);
  /// invokeEffectAction. No handler = a NativeFailure.
  [[nodiscard]] static std::variant<NativeEdit, NativeFailure> action(const NativeActionRequest& r);
  /// setPluginEnabled: false = no such plugin (or no host).
  [[nodiscard]] static bool set_enabled(std::string_view plugin, bool enabled);
};

/// The document's pluginData group of an effect instance, and its keys (setPluginData's group/key).
[[nodiscard]] std::string native_data_group(std::string_view effectId);
inline constexpr std::string_view kNativeSequenceKey = "sequence";
/// `arb:<param key>`.
[[nodiscard]] std::string native_arb_key(std::string_view paramKey);

/// base64 (RFC 4648, padded) — the encoding fx.pluginData stores bytes in.
[[nodiscard]] std::string native_base64(const std::vector<std::uint8_t>& bytes);
[[nodiscard]] std::optional<std::vector<std::uint8_t>> native_unbase64(std::string_view text);

}  // namespace premation::doc
