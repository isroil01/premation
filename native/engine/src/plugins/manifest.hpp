// A plugin bundle's manifest (premation-plugin.json, docs/PLUGIN_SDK.md
// "Packaging"): read and version-checked BEFORE the binary is loaded, so an
// incompatible or malformed plugin never runs a line of code in the engine.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::plugins {

inline constexpr std::string_view kManifestFile = "premation-plugin.json";

struct ManifestEffect {
  std::string matchName;
  std::string name;
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
  /// The binary for THIS platform (the manifest's `binary.<platform>`), relative to the bundle.
  std::string binary;
  std::vector<ManifestEffect> effects;
};

/// Parse + validate. nullopt with `error` saying what is wrong.
[[nodiscard]] std::optional<Manifest> parse_manifest(std::string_view json, std::string_view platform, std::string& error);

/// The host runs a plugin built against SDK `major.minor` iff major == PR_SDK_VERSION_MAJOR and
/// minor ≤ PR_SDK_VERSION_MINOR (a plugin needing a newer minor may call what this host lacks).
[[nodiscard]] bool sdk_compatible(std::uint32_t major, std::uint32_t minor, std::string& why);

/// A plugin id: 1–100 of [A-Za-z0-9._-], starting with a letter. Effect match
/// names are `<id>` or `<id>.<name>` — unique across plugins by construction,
/// and never a built-in effect type.
[[nodiscard]] bool valid_plugin_id(std::string_view id) noexcept;

}  // namespace premation::plugins
