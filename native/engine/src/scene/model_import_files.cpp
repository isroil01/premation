// The modelImport job's file work (model_convert.hpp import_model_files):
// read the selection, convert, write the GLB temp + rename under a free name.
#include <algorithm>
#include <cctype>
#include <fstream>
#include <iterator>
#include <string>
#include <system_error>
#include <vector>

#include "model_convert.hpp"

namespace premation::scene::modelio {

namespace fs = std::filesystem;

namespace {

/// A path from UTF-8.
fs::path path_of(const std::string& s) { return fs::path(std::u8string(s.begin(), s.end())); }

std::string utf8(const fs::path& p) {
  const std::u8string u = p.u8string();
  return {u.begin(), u.end()};
}

}  // namespace

std::optional<ImportedModel> import_model_files(std::span<const std::string> files, const fs::path& folder, std::string name,
                                                const std::function<void(double, const std::string&)>& progress,
                                                const std::function<bool()>& cancelled) {
  if (files.empty()) throw ConvertError("the import needs the model file");
  const fs::path model = path_of(files.front());
  std::string ext = utf8(model.extension());
  std::ranges::transform(ext, ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (!is_model_extension(ext)) {
    throw ConvertError("'" + utf8(model.filename()) + "' is not a 3D model (.glb, .gltf, .obj, .fbx, .usda, .usdz)");
  }
  if (name.empty()) name = utf8(model.stem());
  // A file name the OS takes: no separators or reserved characters.
  std::ranges::replace_if(
      name, [](char c) { return c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|'; },
      '_');
  if (name.empty()) name = "model";

  std::vector<SourceFile> sources;
  sources.reserve(files.size());
  for (std::size_t i = 0; i < files.size(); ++i) {
    if (cancelled()) return std::nullopt;
    progress(0.3 * static_cast<double>(i) / static_cast<double>(files.size()), "Reading " + utf8(path_of(files[i]).filename()));
    std::ifstream in(path_of(files[i]), std::ios::binary);
    if (!in) throw ModelIoError("cannot read '" + files[i] + "'");
    SourceFile f;
    f.path = files[i];
    f.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    sources.push_back(std::move(f));
  }
  progress(0.35, "Converting the model");
  ConvertResult r = convert_model(sources);
  if (cancelled()) return std::nullopt;

  progress(0.9, "Writing the model");
  std::error_code ec;
  fs::create_directories(folder, ec);
  if (ec) throw ModelIoError("cannot create '" + utf8(folder) + "': " + ec.message());
  // A free name: never overwrite an earlier import.
  fs::path target = folder / path_of(name + ".glb");
  for (int n = 2; fs::exists(target, ec) && n < 10000; ++n) target = folder / path_of(name + " " + std::to_string(n) + ".glb");
  // Temp file + rename: the folder never holds a half-written model.
  fs::path temp = target;
  temp += ".partial";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    if (!out) throw ModelIoError("cannot write '" + utf8(temp) + "'");
    out.write(reinterpret_cast<const char*>(r.glb.data()), static_cast<std::streamsize>(r.glb.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    if (!out) {
      out.close();
      fs::remove(temp, ec);
      throw ModelIoError("cannot write '" + utf8(temp) + "'");
    }
  }
  fs::rename(temp, target, ec);
  if (ec) {
    fs::remove(temp, ec);
    throw ModelIoError("cannot write '" + utf8(target) + "'");
  }
  ImportedModel out;
  out.glb = target;
  out.name = name;
  for (std::string& w : r.warnings) {
    if (std::ranges::find(out.warnings, w) == out.warnings.end()) out.warnings.push_back(std::move(w));
  }
  progress(1.0, "Done");
  return out;
}

}  // namespace premation::scene::modelio
