#include "manifest.hpp"

#include <premation_sdk/pr_types.h>

#include "json.hpp"

namespace premation::plugins {

bool valid_plugin_id(std::string_view id) noexcept {
  if (id.empty() || id.size() > 100) return false;
  const char f = id.front();
  if (!((f >= 'a' && f <= 'z') || (f >= 'A' && f <= 'Z'))) return false;
  for (const char c : id) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

bool sdk_compatible(std::uint32_t major, std::uint32_t minor, std::string& why) {
  if (major != PR_SDK_VERSION_MAJOR) {
    why = "built for SDK " + std::to_string(major) + "." + std::to_string(minor) + "; this engine runs SDK " +
          std::to_string(PR_SDK_VERSION_MAJOR) + ".x";
    return false;
  }
  if (minor > PR_SDK_VERSION_MINOR) {
    why = "needs SDK " + std::to_string(major) + "." + std::to_string(minor) + "; this engine has " +
          std::to_string(PR_SDK_VERSION_MAJOR) + "." + std::to_string(PR_SDK_VERSION_MINOR);
    return false;
  }
  return true;
}

std::optional<Manifest> parse_manifest(std::string_view json, std::string_view platform, std::string& error) {
  const auto parsed = js::parse(json);
  if (!parsed || !parsed->is_object()) {
    error = "the manifest is not a JSON object";
    return std::nullopt;
  }
  const js::Json& j = *parsed;
  Manifest m;
  const auto str = [&](std::string_view k) { return j.at(k).is_string() ? j.at(k).str() : std::string(); };
  const js::Json& mv = j.at("manifestVersion");
  m.manifestVersion = mv.is_number() ? static_cast<std::uint32_t>(mv.num()) : 0;
  if (m.manifestVersion != 1) {
    error = "unsupported manifestVersion (this engine reads 1)";
    return std::nullopt;
  }
  m.id = str("id");
  if (!valid_plugin_id(m.id)) {
    error = "invalid plugin id '" + m.id + "'";
    return std::nullopt;
  }
  m.name = str("name");
  m.version = str("version");
  m.vendor = str("vendor");
  if (m.name.empty()) m.name = m.id;
  const js::Json& sdk = j.at("sdk");
  if (!sdk.at("major").is_number() || !sdk.at("minor").is_number()) {
    error = "the manifest has no sdk {major, minor}";
    return std::nullopt;
  }
  m.sdkMajor = static_cast<std::uint32_t>(sdk.at("major").num());
  m.sdkMinor = static_cast<std::uint32_t>(sdk.at("minor").num());
  const js::Json& bin = j.at("binary");
  if (bin.at(platform).is_string()) m.binary = bin.at(platform).str();
  if (m.binary.empty() || m.binary.find("..") != std::string::npos || m.binary.find('/') != std::string::npos ||
      m.binary.find('\\') != std::string::npos) {
    error = "no usable binary for platform '" + std::string(platform) + "' (a file name inside the bundle)";
    return std::nullopt;
  }
  const js::Json& effects = j.at("effects");
  if (!effects.is_array() || effects.arr().empty()) {
    error = "the manifest lists no effects";
    return std::nullopt;
  }
  for (const js::Json& e : effects.arr()) {
    ManifestEffect me;
    me.matchName = e.at("matchName").is_string() ? e.at("matchName").str() : "";
    me.name = e.at("name").is_string() ? e.at("name").str() : me.matchName;
    me.category = e.at("category").is_string() ? e.at("category").str() : m.name;
    const bool owned = me.matchName == m.id || (me.matchName.size() > m.id.size() + 1 && me.matchName.starts_with(m.id) &&
                                                me.matchName[m.id.size()] == '.');
    if (!owned || !valid_plugin_id(me.matchName)) {
      error = "effect match name '" + me.matchName + "' must be '" + m.id + "' or '" + m.id + ".<name>'";
      return std::nullopt;
    }
    for (const ManifestEffect& other : m.effects) {
      if (other.matchName == me.matchName) {
        error = "effect '" + me.matchName + "' is listed twice";
        return std::nullopt;
      }
    }
    m.effects.push_back(std::move(me));
  }
  return m;
}

}  // namespace premation::plugins
