#include "manifest.hpp"

#include <premation_sdk/pr_types.h>

#include <algorithm>
#include <cctype>
#include <cmath>

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
  const std::string_view one[] = {platform};
  return parse_manifest(json, std::span<const std::string_view>(one), error);
}

namespace {

/// A contribution id: 1–64 of [A-Za-z0-9._-], not starting with '.' or '-'.
bool valid_local_id(std::string_view id) noexcept {
  if (id.empty() || id.size() > 64) return false;
  for (const char c : id) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return id.front() != '.' && id.front() != '-';
}

/// A file extension as the manifest gives it ("ppm", ".PPM") → "ppm"; "" when not one.
std::string extension_of(const js::Json& v) {
  if (!v.is_string()) return {};
  std::string e = v.str();
  if (!e.empty() && e.front() == '.') e.erase(0, 1);
  if (e.empty() || e.size() > 16) return {};
  for (char& c : e) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return {};
  }
  return e;
}

/// `key` must be absent or an array of objects; each needs a valid, unique `id`.
bool contribution_list(const js::Json& j, std::string_view key, std::string& error) {
  const js::Json& list = j.at(key);
  if (list.is_undefined()) return true;
  if (!list.is_array()) {
    error = "\"" + std::string(key) + "\" must be an array";
    return false;
  }
  std::vector<std::string> seen;
  for (const js::Json& e : list.arr()) {
    const std::string id = e.at("id").is_string() ? e.at("id").str() : std::string();
    if (!e.is_object() || !valid_local_id(id)) {
      error = std::string(key) + ": every entry needs an \"id\" (1-64 of A-Z a-z 0-9 . _ -), got '" + id + "'";
      return false;
    }
    if (std::ranges::find(seen, id) != seen.end()) {
      error = std::string(key) + ": '" + id + "' is listed twice";
      return false;
    }
    seen.push_back(id);
  }
  return true;
}

std::string str_or(const js::Json& v, std::string def) { return v.is_string() && !v.str().empty() ? v.str() : std::move(def); }

}  // namespace

bool parse_contributions(const js::Json& j, Manifest& m, std::string& error) {
  for (const std::string_view key : {"commands", "importers", "outputModules", "panels"}) {
    if (!contribution_list(j, key, error)) return false;
  }
  for (const js::Json& e : j.at("commands").arr()) {
    ManifestCommand c;
    c.id = e.at("id").str();
    c.name = str_or(e.at("name"), c.id);
    c.menu = str_or(e.at("menu"), "");
    m.commands.push_back(std::move(c));
  }
  for (const js::Json& e : j.at("importers").arr()) {
    ManifestImporter c;
    c.id = e.at("id").str();
    c.name = str_or(e.at("name"), c.id);
    for (const js::Json& x : e.at("extensions").arr()) {
      const std::string ext = extension_of(x);
      if (ext.empty()) {
        error = "importers: '" + c.id + "' has an extension that is not 1-16 letters or digits";
        return false;
      }
      if (std::ranges::find(c.extensions, ext) == c.extensions.end()) c.extensions.push_back(ext);
    }
    if (c.extensions.empty()) {
      error = "importers: '" + c.id + "' lists no extensions";
      return false;
    }
    m.importers.push_back(std::move(c));
  }
  for (const js::Json& e : j.at("outputModules").arr()) {
    ManifestOutputModule c;
    c.id = e.at("id").str();
    c.name = str_or(e.at("name"), c.id);
    c.extension = extension_of(e.at("extension"));
    if (c.extension.empty()) {
      error = "outputModules: '" + c.id + "' needs an \"extension\" (1-16 letters or digits)";
      return false;
    }
    if (const js::Json& opts = e.at("options"); !opts.is_undefined() && !opts.is_array()) {
      error = "outputModules: '" + c.id + "' \"options\" must be an array";
      return false;
    }
    for (const js::Json& o : e.at("options").arr()) {
      ManifestOutputOption op;
      op.id = o.at("id").is_string() ? o.at("id").str() : std::string();
      op.name = str_or(o.at("name"), op.id);
      op.type = o.at("type").is_string() ? o.at("type").str() : std::string();
      if (!valid_local_id(op.id) || (op.type != "popup" && op.type != "number" && op.type != "checkbox")) {
        error = "outputModules: '" + c.id + "' option '" + op.id + "' needs an id and a type (popup, number, checkbox)";
        return false;
      }
      for (const js::Json& ch : o.at("choices").arr()) {
        if (ch.is_string()) op.choices.push_back(ch.str());
      }
      if (op.type == "popup" && (op.choices.empty() || op.choices.size() > 64)) {
        error = "outputModules: '" + c.id + "' popup '" + op.id + "' needs 1-64 choices";
        return false;
      }
      const js::Json& d = o.at("default");
      op.def = d.is_number() ? d.num() : d.is_bool() ? (d.b() ? 1.0 : 0.0) : (op.type == "popup" ? 1.0 : 0.0);
      if (o.at("min").is_number()) op.min = o.at("min").num();
      if (o.at("max").is_number()) op.max = o.at("max").num();
      if (op.type == "popup") op.def = std::clamp(std::round(op.def), 1.0, static_cast<double>(op.choices.size()));
      if (op.type == "checkbox") op.def = op.def != 0 ? 1.0 : 0.0;
      c.options.push_back(std::move(op));
    }
    m.outputModules.push_back(std::move(c));
  }
  for (const js::Json& e : j.at("panels").arr()) {
    ManifestPanel c;
    c.id = e.at("id").str();
    c.name = str_or(e.at("name"), c.id);
    c.page = str_or(e.at("page"), "index.html");
    // A page inside the bundle's ui/ folder: relative, no `..`, no backslashes, no hidden parts.
    const bool bad = c.page.find("..") != std::string::npos || c.page.find('\\') != std::string::npos || c.page.front() == '/' ||
                     c.page.find(':') != std::string::npos || c.page.front() == '.' || c.page.find("/.") != std::string::npos;
    if (bad) {
      error = "panels: '" + c.id + "' page must be a path inside the bundle's ui/ folder";
      return false;
    }
    m.panels.push_back(std::move(c));
  }
  return true;
}

std::optional<Manifest> parse_manifest(std::string_view json, std::span<const std::string_view> platforms, std::string& error) {
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
  for (const std::string_view key : platforms) {
    if (bin.at(key).is_string() && !bin.at(key).str().empty()) {
      m.binary = bin.at(key).str();
      m.binaryKey = std::string(key);
      break;
    }
  }
  if (m.binary.empty() || m.binary.find("..") != std::string::npos || m.binary.find('/') != std::string::npos ||
      m.binary.find('\\') != std::string::npos) {
    std::string tried;
    for (const std::string_view key : platforms) tried += (tried.empty() ? "" : ", ") + std::string(key);
    error = "no usable binary for this platform (tried " + tried + "; a file name inside the bundle)";
    return std::nullopt;
  }
  const js::Json& effects = j.at("effects");
  // P7: a plugin may contribute no effect at all (commands, importers, output modules, panels).
  if (!effects.is_undefined() && !effects.is_array()) {
    error = "\"effects\" must be an array";
    return std::nullopt;
  }
  for (const js::Json& e : effects.arr()) {
    ManifestEffect me;
    me.matchName = e.at("matchName").is_string() ? e.at("matchName").str() : "";
    me.name = e.at("name").is_string() ? e.at("name").str() : me.matchName;
    me.category = e.at("category").is_string() ? e.at("category").str() : m.name;
    // SDK 1.4 (C): channel names, 1..64 of letters, digits, '_', '.', '-'.
    for (const auto& [field, list] : {std::pair<const char*, std::vector<std::string>*>{"publishes", &me.publishes}, {"reads", &me.reads}}) {
      const js::Json& names = e.at(field);
      if (names.is_undefined()) continue;
      if (!names.is_array()) {
        error = "effect '" + me.matchName + "': \"" + field + "\" must be an array";
        return std::nullopt;
      }
      for (const js::Json& n : names.arr()) {
        const std::string name = n.is_string() ? n.str() : std::string();
        const bool ok = !name.empty() && name.size() <= 64 && std::ranges::all_of(name, [](char c) {
          return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_' || c == '.' || c == '-';
        });
        if (!ok) {
          error = "effect '" + me.matchName + "': channel '" + name + "' must be 1-64 letters, digits, '_', '.' or '-'";
          return std::nullopt;
        }
        if (std::ranges::find(*list, name) == list->end()) list->push_back(name);
      }
    }
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
  if (const js::Json& ent = j.at("entitlement"); !ent.is_undefined()) {
    if (!ent.is_string() || ent.str().empty()) {
      error = "\"entitlement\" must be a string";
      return std::nullopt;
    }
    m.entitlement = ent.str();
  }
  // `"icon"`: a picture in the bundle's ui/ folder (served as plugin-ui://<id>/…). Cosmetic: a value
  // that is not one is ignored rather than failing the plugin.
  if (const js::Json& icon = j.at("icon"); icon.is_string()) {
    std::string rel = icon.str();
    std::ranges::replace(rel, '\\', '/');
    const auto dot = rel.rfind('.');
    std::string ext = dot == std::string::npos ? std::string() : rel.substr(dot);
    std::ranges::transform(ext, ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const bool picture = ext == ".png" || ext == ".svg" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp";
    const bool inUi = rel.starts_with("ui/") && rel.size() > 3 && rel.size() <= 256 && rel.find("/.") == std::string::npos &&
                      rel.find(':') == std::string::npos && rel.find("//") == std::string::npos;
    if (picture && inUi) m.icon = std::move(rel);
  }
  // `"panelTitle"`: what the effect card's button to the bundle's panel (ui/index.html) says ("Studio").
  if (const js::Json& t = j.at("panelTitle"); t.is_string() && !t.str().empty() && t.str().size() <= 40) m.panelTitle = t.str();
  if (!parse_contributions(j, m, error)) return std::nullopt;
  // SDK 1.4: layer types, each drawn by one of the effects above (checked to be a generator at load).
  if (!contribution_list(j, "layerTypes", error)) return std::nullopt;
  for (const js::Json& e : j.at("layerTypes").arr()) {
    ManifestLayerType lt;
    lt.id = e.at("id").str();
    lt.name = str_or(e.at("name"), lt.id);
    lt.effect = e.at("effect").is_string() ? e.at("effect").str() : std::string();
    lt.category = str_or(e.at("category"), m.name);
    if (std::ranges::none_of(m.effects, [&](const ManifestEffect& me) { return me.matchName == lt.effect; })) {
      error = "layerTypes: '" + lt.id + "' names effect '" + lt.effect + "', which the manifest's \"effects\" do not list";
      return std::nullopt;
    }
    m.layerTypes.push_back(std::move(lt));
  }
  // SDK 1.4 (U): viewer tools, each run by one of the commands above.
  if (!contribution_list(j, "tools", error)) return std::nullopt;
  for (const js::Json& e : j.at("tools").arr()) {
    ManifestTool t;
    t.id = e.at("id").str();
    t.name = str_or(e.at("name"), t.id);
    t.command = e.at("command").is_string() ? e.at("command").str() : std::string();
    t.shortcut = e.at("shortcut").is_string() ? e.at("shortcut").str() : std::string();
    if (std::ranges::none_of(m.commands, [&](const ManifestCommand& c) { return c.id == t.command; })) {
      error = "tools: '" + t.id + "' names command '" + t.command + "', which the manifest's \"commands\" do not list";
      return std::nullopt;
    }
    if (t.shortcut.size() > 32) {
      error = "tools: '" + t.id + "': the shortcut is too long";
      return std::nullopt;
    }
    m.tools.push_back(std::move(t));
  }
  // SDK 1.4 (E1/E2): expression functions [{ "name" }] and interpolators [name] (each one of them).
  if (const js::Json& fns = j.at("expressionFunctions"); !fns.is_undefined()) {
    if (!fns.is_array()) {
      error = "\"expressionFunctions\" must be an array";
      return std::nullopt;
    }
    for (const js::Json& f : fns.arr()) {
      const std::string name = f.at("name").is_string() ? f.at("name").str() : std::string();
      const bool ident = !name.empty() && name.size() <= 64 && (std::isalpha(static_cast<unsigned char>(name[0])) != 0 || name[0] == '_') &&
                         std::ranges::all_of(name, [](char c) { return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_'; });
      if (!ident || std::ranges::find(m.expressionFunctions, name) != m.expressionFunctions.end()) {
        error = "expressionFunctions: '" + name + "' must be a unique identifier (letters, digits, _)";
        return std::nullopt;
      }
      m.expressionFunctions.push_back(name);
    }
  }
  if (const js::Json& ips = j.at("interpolators"); !ips.is_undefined()) {
    for (const js::Json& i : ips.arr()) {
      const std::string name = i.is_string() ? i.str() : std::string();
      if (std::ranges::find(m.expressionFunctions, name) == m.expressionFunctions.end()) {
        error = "interpolators: '" + name + "' must be one of the manifest's expressionFunctions";
        return std::nullopt;
      }
      m.interpolators.push_back(name);
    }
  }
  if (m.effects.empty() && m.expressionFunctions.empty() && m.commands.empty() && m.importers.empty() && m.outputModules.empty() && m.panels.empty()) {
    error = "the manifest lists no effects, commands, importers, output modules or panels";
    return std::nullopt;
  }
  return m;
}

}  // namespace premation::plugins
