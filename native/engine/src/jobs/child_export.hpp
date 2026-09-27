// A job's offline render through a CHILD engine: `premation-engine --export
// JOB.json` (export/export_job.hpp) on a snapshot of the document, the same
// renderer export uses. The transcribe job's audio mixdown (`audioOnly`) and
// the solo render a job reads instead of footage (`render_layer_alone`) go
// through here; auto-reframe and the render job run their own loops.
#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "job_api.hpp"
#include "json.hpp"
#include "media_input.hpp"

namespace premation::doc {
class Document;
}

namespace premation::jobs {

/// A folder under the temp directory, removed with everything in it.
struct TempTree {
  std::filesystem::path path;
  /// Creates `<temp>/<prefix>/<unique>`. Throws EngineFail(io) when it cannot.
  explicit TempTree(const std::string& prefix);
  ~TempTree();
  TempTree(const TempTree&) = delete;
  TempTree& operator=(const TempTree&) = delete;
  TempTree(TempTree&&) = delete;
  TempTree& operator=(TempTree&&) = delete;
};

/// The document as a project file a child can open: captured, `motion-blob:`
/// refs rewritten to the bundle's files. Core thread (prepare).
[[nodiscard]] std::string snapshot_project_json(const doc::Document& d, const std::string& bundleRoot);

/// Run `job` (its projectPath / workDir already set) in a child engine. Relays
/// the child's frame progress to `control` as `label`, scaled into
/// [`from`, `to`]. Returns the child's successful preflight line, or nullopt
/// when cancelled. Throws EngineFail: `unsupported` when this engine cannot
/// start a child or the child refuses the comp (its preflight reason), `io` /
/// `internal` when the child fails.
[[nodiscard]] std::optional<js::Json> run_child_export(const js::Json& job, const std::filesystem::path& workDir, JobControl& control,
                                                       const std::string& label, double from, double to);

/// The solo render a job reads instead of footage (autoTrace.ts
/// renderLayerAlone): `layer` drawn alone — effects, masks and parents
/// included, every other layer suppressed as by solo — on a TRANSPARENT
/// `comp`, comp-sized, at composition frames `first`…`last` of the comp's
/// rate. `projectJson` is snapshot_project_json(). nullopt when cancelled.
[[nodiscard]] std::optional<std::vector<RgbaImage>> render_layer_alone(const std::string& projectJson, const std::string& comp,
                                                                       const std::string& layer, std::int64_t first, std::int64_t last,
                                                                       JobControl& control, const std::string& label, double from,
                                                                       double to);

/// The PNG frames a sequence export wrote into `<workDir>/frames`, in order.
/// nullopt when cancelled while reading.
[[nodiscard]] std::optional<std::vector<RgbaImage>> read_png_frames(const std::filesystem::path& workDir, JobControl& control,
                                                                    const std::string& label, double from, double to);

}  // namespace premation::jobs
