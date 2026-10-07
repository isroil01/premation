// ONNX Runtime session options with a GPU execution provider when this
// runtime build has one (AE parity 3.1): DirectML on Windows, Core ML on
// macOS, CUDA where its provider is compiled in; the CPU provider otherwise
// (and always as the fallback inside ORT). PREMATION_ORT_PROVIDER=cpu forces
// the CPU. Included ONLY by *_ffi.cpp files (CLAUDE.md: FFI lives there) and
// only after <onnxruntime_cxx_api.h>.
#pragma once

#include <cstdlib>
#include <string>
#include <string_view>

#if defined(_WIN32) && __has_include(<dml_provider_factory.h>)
#include <dml_provider_factory.h>
#define PREMATION_ORT_DML 1
#endif
#if defined(__APPLE__) && __has_include(<coreml_provider_factory.h>)
#include <coreml_provider_factory.h>
#define PREMATION_ORT_COREML 1
#endif

namespace premation::jobs::ort {

/// Options for one model; `provider` reports the execution provider chosen.
inline Ort::SessionOptions session_options(std::string& provider) {
  Ort::SessionOptions o;
  o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  provider = "cpu";
  const char* env = std::getenv("PREMATION_ORT_PROVIDER");
  if (env != nullptr && std::string_view(env) == "cpu") return o;
#if defined(PREMATION_ORT_DML)
  try {
    // DirectML wants sequential execution and no memory pattern.
    o.DisableMemPattern();
    o.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(o, 0));
    provider = "directml";
    return o;
  } catch (const Ort::Exception&) {
    o = Ort::SessionOptions{};
    o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  }
#endif
#if defined(PREMATION_ORT_COREML)
  try {
    Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_CoreML(o, 0));
    provider = "coreml";
    return o;
  } catch (const Ort::Exception&) {
    o = Ort::SessionOptions{};
    o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  }
#endif
  try {
    // CUDA, when the runtime was built with it (the generic call throws otherwise).
    OrtCUDAProviderOptions cuda{};
    o.AppendExecutionProvider_CUDA(cuda);
    provider = "cuda";
  } catch (const Ort::Exception&) {
    o = Ort::SessionOptions{};
    o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  }
  return o;
}

}  // namespace premation::jobs::ort
