#include "subject_files.hpp"

#include <algorithm>
#include <cctype>
#include <system_error>

#include "log.hpp"

namespace premation::doc {

namespace {

/// `%xx` escapes decoded (a `file://` URL's path).
std::string percent_decode(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) != 0 && std::isxdigit(static_cast<unsigned char>(s[i + 2])) != 0) {
      const auto hex = [](char c) { return c >= 'a' ? c - 'a' + 10 : c >= 'A' ? c - 'A' + 10 : c - '0'; };
      out.push_back(static_cast<char>(hex(s[i + 1]) * 16 + hex(s[i + 2])));
      i += 2;
    } else {
      out.push_back(s[i]);
    }
  }
  return out;
}

/// A document `src` as a plain path: `file://` and `local-file://` decoded (a Windows drive after the
/// host part loses its leading slash), anything else as it is.
std::string src_path(std::string_view src) {
  for (const std::string_view scheme : {"local-file://", "file://"}) {
    if (!src.starts_with(scheme)) continue;
    std::string_view rest = src.substr(scheme.size());
    if (rest.starts_with("/") && rest.size() > 2 && rest[2] == ':') rest = rest.substr(1);  // /C:/… → C:/…
    return percent_decode(rest);
  }
  return std::string(src);
}

std::string fold(std::string s) {
  std::ranges::replace(s, '\\', '/');
#if defined(_WIN32)
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
#endif
  return s;
}

void collect_node(const Node& n, std::unordered_set<std::string>& out) {
  const Json& am = n.fx().at("alphaMatte");
  if (!am.is_object() || !am.at("frames").is_array()) return;
  for (const Json& f : am.at("frames").arr())
    if (f.at("src").is_string() && !f.at("src").str().empty()) out.insert(matte_file_key(std::string_view{f.at("src").str()}));
}

void collect_parts(const Parts& parts, std::unordered_set<std::string>& out) {
  for (const auto& [id, n] : parts.nodes)
    if (n != nullptr) collect_node(*n, out);
}

}  // namespace

std::string matte_file_key(std::string_view src) {
  const std::string plain = src_path(src);
  const std::filesystem::path p(std::u8string(plain.begin(), plain.end()));
  return matte_file_key(p);
}

std::string matte_file_key(const std::filesystem::path& p) {
  const std::u8string u = p.lexically_normal().u8string();
  return fold(std::string(u.begin(), u.end()));
}

std::filesystem::path object_matte_folder(const std::filesystem::path& projectPath) {
  if (projectPath.empty()) return {};
  return projectPath.parent_path() / "Object Matte";
}

void collect_matte_files(const Document& d, std::unordered_set<std::string>& out) {
  for (const auto& [id, n] : d.nodes())
    if (n != nullptr) collect_node(*n, out);
}

void collect_matte_files(const ChangeSet& changes, std::unordered_set<std::string>& out) {
  collect_parts(changes.before, out);
  collect_parts(changes.after, out);
}

bool is_stored_matte_name(std::string_view fileName) {
  const bool png = fileName.ends_with(".png") || fileName.ends_with(".png.tmp");
  return png && (fileName.starts_with("matte_") || fileName.starts_with("subject_"));
}

std::vector<std::filesystem::path> matte_files_to_delete(std::span<const std::filesystem::path> onDisk,
                                                         const std::unordered_set<std::string>& referenced) {
  std::vector<std::filesystem::path> out;
  for (const std::filesystem::path& p : onDisk) {
    const std::u8string name = p.filename().u8string();
    if (!is_stored_matte_name(std::string_view(reinterpret_cast<const char*>(name.data()), name.size()))) continue;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    if (referenced.contains(matte_file_key(p))) continue;
    out.push_back(p);
  }
  return out;
}

MatteGcResult gc_object_matte_files(const std::filesystem::path& projectPath, const Document& d, const History& history,
                                    const ChangeSet* gesture) {
  MatteGcResult r;
  const std::filesystem::path folder = object_matte_folder(projectPath);
  std::error_code ec;
  if (folder.empty() || !std::filesystem::is_directory(folder, ec)) return r;
  std::unordered_set<std::string> referenced;
  collect_matte_files(d, referenced);
  for (const Entry* e : history.entries())
    if (e != nullptr) collect_matte_files(e->changes, referenced);
  if (gesture != nullptr) collect_matte_files(*gesture, referenced);
  std::vector<std::filesystem::path> onDisk;
  for (std::filesystem::recursive_directory_iterator it(folder, std::filesystem::directory_options::skip_permission_denied, ec), end;
       !ec && it != end; it.increment(ec)) {
    if (it->is_regular_file(ec)) onDisk.push_back(it->path());
  }
  const std::vector<std::filesystem::path> doomed = matte_files_to_delete(onDisk, referenced);
  std::size_t stored = 0;
  for (const std::filesystem::path& p : onDisk) {
    const std::u8string name = p.filename().u8string();
    if (is_stored_matte_name(std::string_view(reinterpret_cast<const char*>(name.data()), name.size()))) ++stored;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  }
  for (const std::filesystem::path& p : doomed) {
    const auto size = std::filesystem::file_size(p, ec);
    const std::uint64_t bytes = ec ? 0 : static_cast<std::uint64_t>(size);
    ec.clear();
    if (std::filesystem::remove(p, ec) && !ec) {
      ++r.deleted;
      r.bytes += bytes;
    }
    ec.clear();
  }
  r.kept = stored - std::min(stored, r.deleted);
  const std::u8string fu = folder.u8string();
  PREMATION_LOG(info, "object_matte_gc")
      .kv("folder", std::string(fu.begin(), fu.end()))
      .kv("deleted", static_cast<std::uint64_t>(r.deleted))
      .kv("kept", static_cast<std::uint64_t>(r.kept))
      .kv("bytes", r.bytes);
  return r;
}

}  // namespace premation::doc
