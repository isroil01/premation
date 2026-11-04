// SDK 1.4 (M): the ML suite's runtime — ONNX models a plugin ships in its bundle, run on the
// engine's ONNX Runtime build (ml_ort_ffi.cpp; without the runtime every load fails with a clear
// reason). One environment per process; one session per model file content.
#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::plugins::ml {

struct Tensor {
  std::string name;  ///< "" = by position
  std::vector<std::int64_t> shape;
  std::vector<float> data;
};

class Model {
 public:
  Model() = default;
  Model(const Model&) = delete;
  Model& operator=(const Model&) = delete;
  Model(Model&&) = delete;
  Model& operator=(Model&&) = delete;
  virtual ~Model() = default;
  /// "dml" | "coreml" | "cuda" | "cpu"
  [[nodiscard]] virtual std::string provider() const = 0;
  /// Runs the model: `outputs` sized and filled (by name, else by position; empty = every output).
  virtual bool run(std::span<const Tensor> inputs, std::vector<Tensor>& outputs, std::string& error) = 0;
};

/// True when this build has ONNX Runtime.
[[nodiscard]] bool runtime_available() noexcept;

/// The model at `file` (shared: the same content hash is the same session). nullptr + `error`.
[[nodiscard]] std::shared_ptr<Model> load(const std::filesystem::path& file, std::string& error);

/// Count one run (stats) of the model at `file` (its last use, for trim_idle).
void note_run(const std::filesystem::path& file = {});

/// M2 — GPU memory pressure: release the sessions no run used for `idleSeconds` (0 = every session no
/// run holds now). They load again on their next run. Returns the bytes of their model files.
std::uint64_t trim_idle(double idleSeconds);

/// Sessions open now and the bytes of their model files (Cache & Memory, the layer profiler).
struct Stats {
  std::uint32_t models = 0;
  std::uint64_t bytes = 0;
  std::uint64_t runs = 0;
};
[[nodiscard]] Stats stats();

}  // namespace premation::plugins::ml
