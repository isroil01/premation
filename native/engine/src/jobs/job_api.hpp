// Engine jobs (ENGINE_API.md §4.9, docs/TS_ENGINE_REMOVAL.md decision B): the
// analysis and render work the editor used to run in the page — tracking,
// stabilize, auto-trace, scene detect, object matte, audio analysis, proxies —
// runs in the engine.
//
// The shape of every job:
//
//   prepare   core thread. Validates the JobSpec against the document and
//             copies out everything the work reads (the footage file, the
//             layer's timing, the composition's rate). Throws EngineFail.
//   work      a worker thread (JobRunner). Pure over its inputs: decodes,
//             analyses, never touches the document. Reports progress, checks
//             `cancelled()`. A job that loads a model runs its work in a child
//             engine process (child_job.hpp), so a crash fails the job only.
//   apply     core thread again, when the job finished. The result writes the
//             document through ordinary commands inside ONE journal — one
//             history entry, undoable, the same events any edit produces. A
//             command that fails (the layer was deleted meanwhile) rolls the
//             whole result back and the job reports the error.
//
// Nothing here includes ffmpeg or the OS: the kinds that decode live in
// engine_jobs (jobs/*.cpp), the Session sees only this interface.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"

namespace premation::doc {
class Document;
}

namespace premation::jobs {

/// What a job's work sees of its run: cancellation and progress.
class JobControl {
 public:
  JobControl() = default;
  virtual ~JobControl() = default;
  JobControl(const JobControl&) = delete;
  JobControl& operator=(const JobControl&) = delete;
  JobControl(JobControl&&) = delete;
  JobControl& operator=(JobControl&&) = delete;

  [[nodiscard]] virtual bool cancelled() const noexcept = 0;
  /// `fraction` 0…1 of the whole job; `message` a short status ("Tracking frame 12 of 90").
  virtual void progress(double fraction, std::string message) = 0;
};

/// What applying a result may do: run commands, one journal, and read the document between them.
class JobApply {
 public:
  JobApply() = default;
  virtual ~JobApply() = default;
  JobApply(const JobApply&) = delete;
  JobApply& operator=(const JobApply&) = delete;
  JobApply(JobApply&&) = delete;
  JobApply& operator=(JobApply&&) = delete;

  /// Run one edit command inside the job's journal. Throws EngineFail: the
  /// whole result is rolled back.
  virtual api::CommandResult run(const api::Command& cmd) = 0;
  [[nodiscard]] virtual const doc::Document& document() const = 0;
};

/// A finished job's result: its summary for the UI and how it edits the document.
class JobResult {
 public:
  JobResult() = default;
  virtual ~JobResult() = default;
  JobResult(const JobResult&) = delete;
  JobResult& operator=(const JobResult&) = delete;
  JobResult(JobResult&&) = delete;
  JobResult& operator=(JobResult&&) = delete;

  /// JobInfo.result: the kind's summary, JSON (beats found, silences, shots, track length…).
  [[nodiscard]] virtual std::string summary_json() const = 0;
  /// The history entry's label ("Track Motion", "Remove Silence").
  [[nodiscard]] virtual std::string label() const = 0;
  /// False when there is nothing to write (analysis only, nothing found): apply is skipped.
  [[nodiscard]] virtual bool has_edits() const { return true; }
  /// Write the result through commands (core thread). Throws EngineFail.
  virtual void apply(JobApply& a) const = 0;
};

/// The work half: runs on a worker thread. Throws EngineFail (or anything
/// derived from std::exception) to fail the job; returns null when cancelled.
using JobWork = std::function<std::unique_ptr<JobResult>(JobControl&)>;

struct PreparedJob {
  /// The JobSpec variant's name ("trackMotion"): JobInfo.kind.
  std::string kind;
  JobWork work;
};

/// Where the document's footage lives, for `prepare` to turn a layer's `src`
/// into a file (resolve_footage_path, job_inputs.hpp).
struct JobDocContext {
  const doc::Document& doc;
  /// The `.motion` bundle `motion-blob:` footage lives in ('' = none).
  std::string bundleRoot;
  /// The project file ('' = untitled): default output folders sit next to it.
  std::string projectPath;
  /// The engine's playhead (flicks).
  api::Time time = 0;
  /// A 2D layer's layer -> composition affine at composition second `s`
  /// (layerSpace.ts world2DAt: {a, b, c, d, e, f}, centre-origin layer space
  /// -> composition pixels); nullopt for a 3D layer / camera / light. Empty
  /// when the caller has no evaluator (tests): a kind that needs it refuses.
  std::function<std::optional<std::array<double, 6>>(std::string_view layer, double seconds)> layerToComp;
  /// A layer's base (unscaled) box at composition second `s`, px: {width,
  /// height} (layer_geometry_at). nullopt for a kind with no box. Empty = none.
  std::function<std::optional<std::array<double, 2>>(std::string_view layer, double seconds)> layerSize;
};

/// The job kinds this engine build can run (engine_jobs: make_job_kinds).
class JobKinds {
 public:
  JobKinds() = default;
  virtual ~JobKinds() = default;
  JobKinds(const JobKinds&) = delete;
  JobKinds& operator=(const JobKinds&) = delete;
  JobKinds(JobKinds&&) = delete;
  JobKinds& operator=(JobKinds&&) = delete;

  /// Validate `spec` and snapshot its inputs (core thread). Throws EngineFail:
  /// `unsupported` for a kind this build cannot run, `notFound` /
  /// `invalidArgument` for a spec the document cannot satisfy.
  [[nodiscard]] virtual PreparedJob prepare(const api::JobSpec& spec, const JobDocContext& ctx) = 0;
};

/// The JobSpec variant's name, as JobInfo.kind reports it.
[[nodiscard]] std::string job_kind_name(const api::JobSpec& spec);

}  // namespace premation::jobs
