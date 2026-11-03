// A plugin bundle's manifest (premation-plugin.json, docs/PLUGIN_SDK.md
// "Packaging"): read and version-checked BEFORE the binary is loaded, so an
// incompatible or malformed plugin never runs a line of code in the engine.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::js {
class Json;
}  // namespace premation::js

namespace premation::plugins {

inline constexpr std::string_view kManifestFile = "premation-plugin.json";

struct ManifestEffect {
  std::string matchName;
  std::string name;
  std::string category;
};

/// P7a — a command (manifest `commands`): the Plugins menu / command palette entry.
struct ManifestCommand {
  std::string id;
  std::string name;
  std::string menu;  ///< submenu ("" = the plugin's own)
};
/// P7b — a footage importer (manifest `importers`).
struct ManifestImporter {
  std::string id;
  std::string name;
  std::vector<std::string> extensions;  ///< lower case, no dot
};
/// P7c — one declared option of an output module.
struct ManifestOutputOption {
  std::string id;
  std::string name;
  std::string type;  ///< "popup" | "number" | "checkbox"
  std::vector<std::string> choices;
  double def = 0;  ///< popup: 1-based index; checkbox: 0 / 1
  std::optional<double> min, max;
};
/// P7c — an output module (manifest `outputModules`).
struct ManifestOutputModule {
  std::string id;
  std::string name;
  std::string extension;  ///< lower case, no dot
  std::vector<ManifestOutputOption> options;
};
/// P7d — a dockable panel (manifest `panels`): `page` under the bundle's `ui/`.
struct ManifestPanel {
  std::string id;
  std::string name;
  std::string page;
};

/// SDK 1.4 (L1) — a layer type (manifest `layerTypes`): a kind of layer the plugin draws. It is
/// drawn by one of the bundle's own GENERATOR effects (`effect`), whose params become the layer's
/// own properties; no new entry point.
struct ManifestLayerType {
  std::string id;      ///< local id; the layer's type is "<plugin id>:<id>"
  std::string name;    ///< New ▸ Layer ▸ <name>
  std::string effect;  ///< the generator effect's match name (listed in `effects`)
  std::string category;
};

struct Manifest {
  std::uint32_t manifestVersion = 1;
  std::string id;
  std::string name;
  std::string version;
  std::string vendor;
  std::uint32_t sdkMajor = 0;
  std::uint32_t sdkMinor = 0;
  /// The binary for THIS platform (the first of the platform keys the manifest's `binary` has), relative to the bundle.
  std::string binary;
  /// The `binary` key it came from (e.g. `macos-universal`).
  std::string binaryKey;
  std::vector<ManifestEffect> effects;
  /// `"entitlement"`: the bundle loads only with a valid token for it
  /// (entitlement.hpp; today only `premation-cloud`). Empty = free.
  std::string entitlement;
  /// `"icon"`: bundle-relative, under `ui/` ("ui/icon.png"; png / svg / jpg / webp). Empty = none.
  std::string icon;
  /// `"panelTitle"`: the label of the effect card's button to the bundle's panel ("Studio"). Empty = "Panel".
  std::string panelTitle;
  // P7 — contributions that are not effects (docs/PLUGIN_SDK.md "Commands", "Importers", …).
  std::vector<ManifestCommand> commands;
  std::vector<ManifestImporter> importers;
  std::vector<ManifestOutputModule> outputModules;
  std::vector<ManifestPanel> panels;
  std::vector<ManifestLayerType> layerTypes;  // SDK 1.4
};

/// Parse + validate. `platforms` are the `binary` keys to try, most specific
/// first (module.hpp `platform_keys`: e.g. macos-arm64, macos-universal, macos).
/// nullopt with `error` saying what is wrong.
[[nodiscard]] std::optional<Manifest> parse_manifest(std::string_view json, std::span<const std::string_view> platforms,
                                                     std::string& error);
/// One key (tests, tools).
[[nodiscard]] std::optional<Manifest> parse_manifest(std::string_view json, std::string_view platform, std::string& error);

/// P7: the manifest's `commands`, `importers`, `outputModules` and `panels` (parse_manifest calls it).
/// False with `error` when one is malformed.
[[nodiscard]] bool parse_contributions(const premation::js::Json& j, Manifest& m, std::string& error);

/// The host runs a plugin built against SDK `major.minor` iff major == PR_SDK_VERSION_MAJOR and
/// minor ≤ PR_SDK_VERSION_MINOR (a plugin needing a newer minor may call what this host lacks).
[[nodiscard]] bool sdk_compatible(std::uint32_t major, std::uint32_t minor, std::string& why);

/// A plugin id: 1–100 of [A-Za-z0-9._-], starting with a letter. Effect match
/// names are `<id>` or `<id>.<name>` — unique across plugins by construction,
/// and never a built-in effect type.
[[nodiscard]] bool valid_plugin_id(std::string_view id) noexcept;

}  // namespace premation::plugins
