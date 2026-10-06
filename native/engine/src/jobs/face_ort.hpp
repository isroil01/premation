// The face landmark model through ONNX Runtime (AE parity 3.3). The ORT API
// lives only in face_ort_ffi.cpp; this is what the rest of the engine sees.
// Runs in the face-track CHILD process (child_job.hpp), so a crash inside the
// runtime fails the job only.
//
// The model is a MediaPipe Face Mesh class export: one 192×192 RGB input in
// [0, 1] (NHWC or NCHW — read from the model), outputs found by size: the
// landmarks (468 × 3 or 478 × 3, crop pixels) and a one-value face score
// (a logit or a probability).
#pragma once

#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::jobs::face {

struct MeshOut {
  /// x, y, z per landmark, crop pixels (0…192).
  std::vector<float> landmarks;
  /// 0…1: is there a face in the crop.
  float score = 0;
};

class LandmarkModel {
 public:
  LandmarkModel() = default;
  virtual ~LandmarkModel() = default;
  LandmarkModel(const LandmarkModel&) = delete;
  LandmarkModel& operator=(const LandmarkModel&) = delete;
  LandmarkModel(LandmarkModel&&) = delete;
  LandmarkModel& operator=(LandmarkModel&&) = delete;

  /// True when the model takes NCHW (planar) input.
  [[nodiscard]] virtual bool planar() const noexcept = 0;
  /// The execution provider in use (cpu, directml, coreml, cuda).
  [[nodiscard]] virtual std::string provider() const = 0;
  virtual bool run(std::span<const float> input, MeshOut& out, std::string& error) = 0;
};

/// False when this engine build has no ONNX Runtime.
[[nodiscard]] bool runtime_available() noexcept;
[[nodiscard]] std::unique_ptr<LandmarkModel> load(const std::string& path, std::string& error);

}  // namespace premation::jobs::face
