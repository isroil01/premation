// modelImport (AE parity 4.7): normalize a 3D model for import — model_convert
// turns a .glb / .gltf (+ sidecars, compressed geometry / textures), .obj,
// .fbx, .usda or .usdz into one plain GLB, written temp + rename into the
// job's output folder (model_convert.hpp import_model_files does the work).
// No document change: the editor imports the .glb as a project asset
// (importFiles) and lays the model's layers out from it.
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "model_convert.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

namespace {

/// A path from engine-API UTF-8.
fs::path path_of(const std::string& s) { return fs::path(std::u8string(s.begin(), s.end())); }

std::string utf8(const fs::path& p) {
  const std::u8string u = p.u8string();
  return {u.begin(), u.end()};
}

class ModelImportResult final : public JobResult {
 public:
  std::string glb;
  std::string name;
  std::vector<std::string> warnings;
  [[nodiscard]] std::string summary_json() const override {
    js::Json o = js::Json::object();
    o.set("glb", js::Json::string(glb));
    o.set("name", js::Json::string(name));
    js::Json w = js::Json::array();
    for (const std::string& s : warnings) w.arr_mut().push_back(js::Json::string(s));
    o.set("warnings", std::move(w));
    return js::stringify(o);
  }
  [[nodiscard]] std::string label() const override { return "Import 3D Model"; }
  [[nodiscard]] bool has_edits() const override { return false; }
  void apply(JobApply& /*a*/) const override {}
};

}  // namespace

PreparedJob prepare_model_import(const api::ModelImportJob& spec, const JobDocContext& ctx) {
  if (spec.files.empty()) fail(ErrorCode::invalid_argument, "modelImport needs the model file");
  const fs::path model = path_of(spec.files.front());
  std::string ext = utf8(model.extension());
  std::ranges::transform(ext, ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (!scene::modelio::is_model_extension(ext)) {
    fail(ErrorCode::invalid_argument, "'" + utf8(model.filename()) + "' is not a 3D model (.glb, .gltf, .obj, .fbx, .usda, .usdz)");
  }
  fs::path folder = spec.output_folder.empty() ? fs::path() : path_of(spec.output_folder);
  if (folder.empty()) {
    folder = !ctx.projectPath.empty() ? fs::path(ctx.projectPath).parent_path() / "Models" : fs::temp_directory_path() / "premation-models";
  }
  std::string name = spec.name ? *spec.name : std::string();
  const std::vector<std::string> files = spec.files;
  return PreparedJob{"modelImport", [files, folder, name](JobControl& control) -> std::unique_ptr<JobResult> {
    std::optional<scene::modelio::ImportedModel> imported;
    try {
      imported = scene::modelio::import_model_files(
          files, folder, name, [&control](double f, const std::string& m) { control.progress(f, m); },
          [&control] { return control.cancelled(); });
    } catch (const scene::modelio::ModelIoError& e) {
      fail(ErrorCode::io, e.what());
    } catch (const scene::modelio::ConvertError& e) {
      fail(ErrorCode::invalid_argument, e.what());
    }
    if (!imported) return nullptr;
    auto result = std::make_unique<ModelImportResult>();
    result->glb = utf8(imported->glb);
    result->name = imported->name;
    result->warnings = std::move(imported->warnings);
    return result;
  }};
}

}  // namespace premation::jobs
