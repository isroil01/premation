// The SAM encoder / decoder pair through ONNX Runtime (CPU). The ORT C++ API
// lives only in sam_ort_ffi.cpp (CLAUDE.md: FFI only in *_ffi.cpp); this is
// all the rest of the engine sees. Runs in the object-matte CHILD process
// (child_job.hpp), so a crash inside the runtime fails the job only.
//
// Tensor names and shapes are the transformers.js SlimSAM export's, as
// samPipeline.ts feeds them (see sam_pipeline.hpp).
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "sam_pipeline.hpp"

namespace premation::jobs::sam {

/// A float tensor copied out of the runtime.
struct Tensor {
  std::vector<float> data;
  std::vector<std::int64_t> shape;
};

struct Embeddings {
  Tensor image;       ///< image_embeddings [1,256,64,64]
  Tensor positional;  ///< image_positional_embeddings [1,256,64,64]
};

struct Decoded {
  Tensor iouScores;  ///< iou_scores [1,1,3]
  Tensor predMasks;  ///< pred_masks [1,1,3,256,256] logits
};

class Models {
 public:
  Models() = default;
  virtual ~Models() = default;
  Models(const Models&) = delete;
  Models& operator=(const Models&) = delete;
  Models(Models&&) = delete;
  Models& operator=(Models&&) = delete;

  /// `pixels` = preprocess() output (3·1024·1024). False with `error`.
  virtual bool encode(std::span<const float> pixels, Embeddings& out, std::string& error) = 0;
  virtual bool decode(const Embeddings& emb, const Prompts& prompts, Decoded& out, std::string& error) = 0;
};

/// False in an engine build without ONNX Runtime (load() then always fails).
[[nodiscard]] bool runtime_available() noexcept;

/// Load the encoder and decoder files. Null with `error` (missing file, not a
/// model, no runtime in this build).
[[nodiscard]] std::unique_ptr<Models> load(const std::string& encoderPath, const std::string& decoderPath,
                                           std::string& error);

}  // namespace premation::jobs::sam
