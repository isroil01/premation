// Crash isolation for jobs that load a model (object matte / SAM through ONNX
// Runtime): the work runs in a CHILD engine process,
//
//   premation-engine --job FILE      FILE = {"work": NAME, "input": {...}}
//
// which prints JSON lines on stdout —
//   {"ev":"progress","fraction":F,"message":S}
//   {"ev":"result","result":{...}}
//   {"ev":"error","code":S,"message":S}
// — and exits 0. A crash, a kill or a non-zero exit fails the job with the
// exit status; the engine that asked keeps running. Cancel kills the child.
#pragma once

#include <functional>
#include <optional>
#include <string>

#include "job_api.hpp"

namespace premation::jobs {

/// Runs IN THE CHILD: the input JSON in, the result JSON out. Throws
/// EngineFail to fail the job with a typed error.
using ChildWork = std::function<std::string(const std::string& inputJson, JobControl& control)>;

/// Make `name` runnable in a child. Called by register_child_works() (job_kinds.cpp), in both processes.
void register_child_work(const std::string& name, ChildWork work);

/// Every kind's child work (job_kinds.cpp).
void register_child_works();

/// The engine executable a child is started from (main.cpp sets argv[0]'s
/// resolved path at startup). Empty = run child work in-process (tests, the
/// headless tools): no isolation, same results.
void set_child_executable(std::string path);
/// The executable set above ('' = none known).
[[nodiscard]] std::string child_executable();

/// Parent side: run `name` on `inputJson` in a child process; progress is
/// relayed to `control`. The result JSON, or nullopt when cancelled. Throws
/// EngineFail: the child's own error, or `internal` when it crashed.
[[nodiscard]] std::optional<std::string> run_child(const std::string& name, const std::string& inputJson, JobControl& control);

/// `premation-engine --job FILE`: the child's main. Returns the exit code.
int child_main(const std::string& jobFile);

}  // namespace premation::jobs
