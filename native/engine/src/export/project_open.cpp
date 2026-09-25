#include "project_open.hpp"

#include <fstream>
#include <sstream>
#include <system_error>

namespace premation::exporter {
namespace fs = std::filesystem;
using js::Json;

namespace {

constexpr std::string_view kBlobScheme = "motion-blob:";

bool read_text(const fs::path& p, std::string& out) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  return static_cast<bool>(in) || in.eof();
}

/// A chunk's JSON, or `fallback` when the chunk is absent or unreadable (decodeBundle's parseChunk).
Json chunk(const fs::path& bundle, const char* name, Json fallback) {
  std::string text;
  if (!read_text(bundle / name, text)) return fallback;
  auto parsed = js::parse(text);
  return parsed && parsed->is_object() ? std::move(*parsed) : std::move(fallback);
}

bool is_hex_hash(std::string_view h) {
  if (h.size() < 8 || h.size() > 128) return false;
  for (const char c : h) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

fs::path blob_path(const fs::path& bundle, std::string_view hash) {
  return bundle / "blobs" / std::string(hash.substr(0, 2)) / std::string(hash);
}

std::string utf8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return {s.begin(), s.end()};
}

}  // namespace

void rewrite_blob_refs(Json& v, const fs::path& bundle) {
  if (v.is_string()) {
    const std::string& s = v.str();
    if (s.starts_with(kBlobScheme)) {
      const std::string_view hash = std::string_view(s).substr(kBlobScheme.size());
      if (is_hex_hash(hash)) v = Json::string(utf8(blob_path(bundle, hash)));
    }
    return;
  }
  if (v.is_array()) {
    for (Json& e : v.arr_mut()) rewrite_blob_refs(e, bundle);
  } else if (v.is_object()) {
    for (auto& m : v.obj_mut()) rewrite_blob_refs(m.value, bundle);
  }
}

bool open_project(const fs::path& path, OpenedProject& out, std::string& error) {
  std::error_code ec;
  out = {};
  if (fs::is_directory(path, ec)) {
    // decodeBundle.
    const Json manifest = chunk(path, "manifest.json", Json::object());
    Json doc = Json::object();
    doc.set("version", manifest.at("documentVersion").is_string() ? manifest.at("documentVersion") : Json::string("1.1.0"));
    {
      Json scene = chunk(path, "scene.json", Json());
      if (scene.is_undefined()) {
        scene = Json::object();
        scene.set("version", Json::string("1.0.0"));
        scene.set("nodes", Json::array());
      }
      doc.set("scene", std::move(scene));
    }
    {
      Json anim = chunk(path, "animation.json", Json());
      if (anim.is_undefined()) {
        anim = Json::object();
        anim.set("tracks", Json::object());
        anim.set("expressions", Json::object());
      }
      doc.set("animation", std::move(anim));
    }
    const Json timeline = chunk(path, "timeline.json", Json::object());
    for (const char* k : {"timelines", "motionBlur", "guides", "colorManagement"}) {
      if (!timeline.at(k).is_undefined() && !timeline.at(k).is_null()) doc.set(k, timeline.at(k));
    }
    const Json meta = chunk(path, "meta.json", Json::object());
    for (const char* k : {"comps", "comp", "swatches", "materials", "transitions"}) {
      if (!meta.at(k).is_undefined() && !meta.at(k).is_null()) doc.set(k, meta.at(k));
    }
    const Json project = chunk(path, "project.json", Json::object());
    for (const char* k : {"projectItems", "projectSettings", "renderQueue", "plugins", "pluginStorage"}) {
      if (!project.at(k).is_undefined() && !project.at(k).is_null()) doc.set(k, project.at(k));
    }
    if (!doc.at("scene").at("nodes").is_array() && manifest.is_undefined()) {
      error = "'" + utf8(path) + "' is not a .motion bundle";
      return false;
    }
    // readBundleAssets → assetsFromRecords: the library the hidden window hydrates.
    const Json registry = chunk(path, "assets/registry.json", Json::object());
    if (registry.at("assets").is_array()) {
      for (const Json& r : registry.at("assets").arr()) {
        const std::string type = r.at("type").is_string() ? r.at("type").str() : "";
        if (type != "video" && type != "audio" && type != "image") continue;
        if (!r.at("id").is_string() || !r.at("hash").is_string()) continue;
        Json a = Json::object();
        a.set("id", r.at("id"));
        a.set("name", r.at("name"));
        a.set("type", Json::string(type));
        a.set("src", Json::string(std::string(kBlobScheme) + r.at("hash").str()));
        a.set("size", r.at("size"));
        if (r.at("tags").is_array() && !r.at("tags").arr().empty()) a.set("tags", r.at("tags"));
        if (r.at("label").is_string() && !r.at("label").str().empty()) a.set("label", r.at("label"));
        if (r.at("width").is_number() || r.at("height").is_number() || r.at("duration").is_number()) {
          Json md = Json::object();
          for (const char* k : {"width", "height", "duration"}) {
            if (r.at(k).is_number()) md.set(k, r.at(k));
          }
          a.set("metadata", std::move(md));
        }
        out.sessionAssets.push_back(std::move(a));
      }
    }
    rewrite_blob_refs(doc, path);
    for (Json& a : out.sessionAssets) rewrite_blob_refs(a, path);
    out.document = std::move(doc);
    out.mediaBase = path;
    return true;
  }
  std::string text;
  if (!read_text(path, text)) {
    error = "could not read '" + utf8(path) + "'";
    return false;
  }
  auto parsed = js::parse(text);
  if (!parsed || !parsed->is_object()) {
    error = "'" + utf8(path) + "' is not a project document";
    return false;
  }
  // A render-tests scene: its footage records are the harness's session assets.
  if (parsed->at("harness").at("assets").is_array()) out.sessionAssets = parsed->at("harness").at("assets").arr();
  if (parsed->at("nodes").is_array()) {
    // A legacy scene-only ProjectFile (parseLegacyDocument).
    Json doc = Json::object();
    doc.set("version", Json::string("1.1.0"));
    doc.set("scene", std::move(*parsed));
    Json anim = Json::object();
    anim.set("tracks", Json::object());
    anim.set("expressions", Json::object());
    doc.set("animation", std::move(anim));
    out.document = std::move(doc);
  } else {
    out.document = std::move(*parsed);
  }
  out.mediaBase = path.parent_path();
  return true;
}

}  // namespace premation::exporter
