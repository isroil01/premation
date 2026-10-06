// ONNX Runtime FFI for the SAM pair (sam_ort.hpp) — the only file that sees
// the ORT C++ API. A GPU execution provider when the runtime has one
// (ort_providers_ffi.hpp, AE parity 3.1), else the CPU. Ort::Exception never leaves
// this file: every call returns false with the message.
//
// Built without the runtime (no onnxruntime headers on the include path),
// this compiles to a stub whose load() fails with a clear error, so the rest
// of engine_jobs builds and the object-matte job fails typed, not at link.
#include "sam_ort.hpp"

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_SAM_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_SAM_ORT 1
#endif

// The engine build links the runtime (CMake defines PREMATION_HAVE_ONNXRUNTIME
// when find_package found it): there, a missing header is a build error, not a
// silently stubbed feature.
#if defined(PREMATION_HAVE_ONNXRUNTIME) && PREMATION_HAVE_ONNXRUNTIME && !defined(PREMATION_SAM_ORT)
#error "onnxruntime was found by CMake but <onnxruntime_cxx_api.h> is not on the include path"
#endif

#ifdef PREMATION_SAM_ORT
#include "ort_providers_ffi.hpp"

#include <array>
#include <exception>
#include <filesystem>
#include <string_view>
#include <utility>
#endif

namespace premation::jobs::sam {

#ifdef PREMATION_SAM_ORT

namespace {

std::filesystem::path path_of(const std::string& utf8) {
  // UTF-8 in, the platform's path (ORTCHAR_T is wchar_t on Windows, char elsewhere).
  const std::u8string u(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size());
  return std::filesystem::path(u);
}

/// Copy a float tensor out of the runtime. False when it is not float.
bool copy_out(const Ort::Value& v, Tensor& out, std::string_view name, std::string& error) {
  if (!v.IsTensor()) {
    error = std::string(name) + " is not a tensor";
    return false;
  }
  const Ort::TensorTypeAndShapeInfo info = v.GetTensorTypeAndShapeInfo();
  if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
    error = std::string(name) + " is not float32";
    return false;
  }
  out.shape = info.GetShape();
  const std::size_t n = info.GetElementCount();
  const float* d = v.GetTensorData<float>();
  out.data.assign(d, d + n);
  return true;
}

class OrtModels final : public Models {
 public:
  OrtModels(const std::string& encoderPath, const std::string& decoderPath)
      : env_(ORT_LOGGING_LEVEL_WARNING, "premation-sam"),
        options_(make_options()),
        encoder_(env_, path_of(encoderPath).c_str(), options_),
        decoder_(env_, path_of(decoderPath).c_str(), options_),
        memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {}

  bool encode(std::span<const float> pixels, Embeddings& out, std::string& error) override {
    try {
      std::vector<float> in(pixels.begin(), pixels.end());
      const std::array<std::int64_t, 4> shape{1, 3, kInputSize, kInputSize};
      Ort::Value input = Ort::Value::CreateTensor<float>(memory_, in.data(), in.size(), shape.data(), shape.size());
      const std::array<const char*, 1> inNames{"pixel_values"};
      const std::array<const char*, 2> outNames{"image_embeddings", "image_positional_embeddings"};
      std::vector<Ort::Value> outs =
          encoder_.Run(Ort::RunOptions{nullptr}, inNames.data(), &input, inNames.size(), outNames.data(), outNames.size());
      if (outs.size() != 2) {
        error = "the encoder answered " + std::to_string(outs.size()) + " outputs";
        return false;
      }
      return copy_out(outs[0], out.image, "image_embeddings", error) &&
             copy_out(outs[1], out.positional, "image_positional_embeddings", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

  bool decode(const Embeddings& emb, const Prompts& prompts, Decoded& out, std::string& error) override {
    try {
      const auto n = static_cast<std::int64_t>(prompts.count());
      std::vector<float> coords = prompts.coords;
      std::vector<std::int64_t> labels = prompts.labels;
      std::vector<float> image = emb.image.data;
      std::vector<float> positional = emb.positional.data;
      const std::array<std::int64_t, 4> pointsShape{1, 1, n, 2};
      const std::array<std::int64_t, 3> labelsShape{1, 1, n};
      std::array<Ort::Value, 4> inputs{
          Ort::Value::CreateTensor<float>(memory_, coords.data(), coords.size(), pointsShape.data(), pointsShape.size()),
          Ort::Value::CreateTensor<std::int64_t>(memory_, labels.data(), labels.size(), labelsShape.data(),
                                                 labelsShape.size()),
          Ort::Value::CreateTensor<float>(memory_, image.data(), image.size(), emb.image.shape.data(),
                                          emb.image.shape.size()),
          Ort::Value::CreateTensor<float>(memory_, positional.data(), positional.size(), emb.positional.shape.data(),
                                          emb.positional.shape.size()),
      };
      const std::array<const char*, 4> inNames{"input_points", "input_labels", "image_embeddings",
                                               "image_positional_embeddings"};
      const std::array<const char*, 2> outNames{"iou_scores", "pred_masks"};
      std::vector<Ort::Value> outs = decoder_.Run(Ort::RunOptions{nullptr}, inNames.data(), inputs.data(),
                                                  inputs.size(), outNames.data(), outNames.size());
      if (outs.size() != 2) {
        error = "the decoder answered " + std::to_string(outs.size()) + " outputs";
        return false;
      }
      return copy_out(outs[0], out.iouScores, "iou_scores", error) &&
             copy_out(outs[1], out.predMasks, "pred_masks", error);
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  static Ort::SessionOptions make_options() {
    std::string provider;
    return ort::session_options(provider);
  }

  // Declaration order is construction order: the Env outlives the sessions.
  Ort::Env env_;
  Ort::SessionOptions options_;
  Ort::Session encoder_;
  Ort::Session decoder_;
  Ort::MemoryInfo memory_;
};

}  // namespace

bool runtime_available() noexcept { return true; }

std::unique_ptr<Models> load(const std::string& encoderPath, const std::string& decoderPath, std::string& error) {
  try {
    return std::make_unique<OrtModels>(encoderPath, decoderPath);
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

#else  // no ONNX Runtime in this build

bool runtime_available() noexcept { return false; }

std::unique_ptr<Models> load(const std::string& /*encoderPath*/, const std::string& /*decoderPath*/,
                             std::string& error) {
  error = "this engine build has no ONNX Runtime";
  return nullptr;
}

#endif

}  // namespace premation::jobs::sam
