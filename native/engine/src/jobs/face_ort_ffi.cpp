// ONNX Runtime FFI for the face landmark model (face_ort.hpp). Ort::Exception
// never leaves this file. Without the runtime it builds to a stub whose
// load() fails with a clear error.
#include "face_ort.hpp"

#include "face_mesh.hpp"

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_FACE_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_FACE_ORT 1
#endif

#ifdef PREMATION_FACE_ORT
#include "ort_providers_ffi.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <exception>
#include <filesystem>
#endif

namespace premation::jobs::face {

#ifdef PREMATION_FACE_ORT

namespace {

std::filesystem::path path_of(const std::string& utf8) {
  const std::u8string u(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size());
  return std::filesystem::path(u);
}

class OrtLandmarks final : public LandmarkModel {
 public:
  explicit OrtLandmarks(const std::string& path)
      : env_(ORT_LOGGING_LEVEL_WARNING, "premation-face"),
        options_(ort::session_options(provider_)),
        session_(env_, path_of(path).c_str(), options_),
        memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    Ort::AllocatorWithDefaultOptions alloc;
    inName_ = session_.GetInputNameAllocated(0, alloc).get();
    const std::vector<std::int64_t> shape = session_.GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
    planar_ = shape.size() == 4 && shape[1] == 3;
    for (std::size_t i = 0; i < session_.GetOutputCount(); ++i) outNames_.emplace_back(session_.GetOutputNameAllocated(i, alloc).get());
  }

  [[nodiscard]] bool planar() const noexcept override { return planar_; }
  [[nodiscard]] std::string provider() const override { return provider_; }

  bool run(std::span<const float> input, MeshOut& out, std::string& error) override {
    try {
      std::vector<float> in(input.begin(), input.end());
      const std::array<std::int64_t, 4> shape =
          planar_ ? std::array<std::int64_t, 4>{1, 3, kInput, kInput} : std::array<std::int64_t, 4>{1, kInput, kInput, 3};
      Ort::Value tensor = Ort::Value::CreateTensor<float>(memory_, in.data(), in.size(), shape.data(), shape.size());
      const char* inName = inName_.c_str();
      std::vector<const char*> outNames;
      for (const std::string& n : outNames_) outNames.push_back(n.c_str());
      std::vector<Ort::Value> outs = session_.Run(Ort::RunOptions{nullptr}, &inName, &tensor, 1, outNames.data(), outNames.size());
      out = MeshOut{};
      bool haveScore = false;
      for (Ort::Value& v : outs) {
        if (!v.IsTensor()) continue;
        const Ort::TensorTypeAndShapeInfo info = v.GetTensorTypeAndShapeInfo();
        if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) continue;
        const std::size_t n = info.GetElementCount();
        const float* d = v.GetTensorData<float>();
        if ((n == kLandmarks * 3 || n == 478 * 3) && out.landmarks.empty()) out.landmarks.assign(d, d + n);
        else if (n == 1 && !haveScore) {
          const float s = d[0];
          out.score = s >= 0 && s <= 1 ? s : 1.0f / (1.0f + std::exp(-s));
          haveScore = true;
        }
      }
      if (out.landmarks.empty()) {
        error = "the model has no 468- or 478-point landmark output";
        return false;
      }
      if (!haveScore) out.score = 1;
      return true;
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  static constexpr std::size_t kLandmarks = 468;
  std::string provider_;
  Ort::Env env_;
  Ort::SessionOptions options_;
  Ort::Session session_;
  Ort::MemoryInfo memory_;
  std::string inName_;
  std::vector<std::string> outNames_;
  bool planar_ = false;
};

}  // namespace

bool runtime_available() noexcept { return true; }

std::unique_ptr<LandmarkModel> load(const std::string& path, std::string& error) {
  try {
    return std::make_unique<OrtLandmarks>(path);
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
}

#else

bool runtime_available() noexcept { return false; }

std::unique_ptr<LandmarkModel> load(const std::string& /*path*/, std::string& error) {
  error = "this engine build has no ONNX Runtime";
  return nullptr;
}

#endif

}  // namespace premation::jobs::face
