// ONNX Runtime sessions with a GPU execution provider when this runtime build
// has one (AE parity 3.1): DirectML on Windows (the high-performance adapter),
// Core ML on macOS, CUDA where its provider is compiled in; the CPU provider
// otherwise. PREMATION_ORT_PROVIDER=cpu forces the CPU. A GPU provider that
// appends but then fails to build the session (an operator it cannot place, a
// driver that refuses the device) falls back to a CPU session, so a model
// always opens. Included ONLY by *_ffi.cpp files (CLAUDE.md: FFI lives there)
// and only after <onnxruntime_cxx_api.h>.
#pragma once

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#if defined(_WIN32) && __has_include(<dml_provider_factory.h>)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <dml_provider_factory.h>
#define PREMATION_ORT_DML 1
#endif
#if defined(__APPLE__) && __has_include(<coreml_provider_factory.h>)
#include <coreml_provider_factory.h>
#define PREMATION_ORT_COREML 1
#endif

namespace premation::jobs::ort {

/// The intra-op pool for a CPU session that did not ask for a size: two cores
/// short of the machine (at least one), so the editor's UI, the engine's own
/// render thread and the job worker's frame decode keep running while a model
/// does. ORT's default is every core.
inline int default_cpu_threads() {
  const unsigned cores = std::thread::hardware_concurrency();
  return cores == 0 ? 1 : static_cast<int>(std::max(1U, cores - 2U));
}

/// CPU-only options. `threads` > 0 caps the intra-op pool (a live stream wants
/// few); 0 = default_cpu_threads(). The pool never spins between runs
/// (allow_spinning=0): a hover's decoder call is followed by seconds of
/// nothing, and spinning threads would burn a core each the whole while.
inline Ort::SessionOptions cpu_options(int threads = 0) {
  Ort::SessionOptions o;
  o.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  o.SetIntraOpNumThreads(threads > 0 ? threads : default_cpu_threads());
  o.AddConfigEntry("session.intra_op.allow_spinning", "0");
  o.AddConfigEntry("session.inter_op.allow_spinning", "0");
  return o;
}

/// True when PREMATION_ORT_PROVIDER=cpu asks for the CPU everywhere.
inline bool cpu_forced() {
  const char* env = std::getenv("PREMATION_ORT_PROVIDER");
  return env != nullptr && std::string_view(env) == "cpu";
}

#if defined(PREMATION_ORT_DML)
/// DirectML.dll is delay-loaded (the engine starts without it): load it here
/// first, so a machine without the redistributable gets the CPU instead of a
/// delay-load fault inside the first DML call.
inline bool directml_loadable() {
  static const bool ok = LoadLibraryExW(L"DirectML.dll", nullptr, 0) != nullptr;
  return ok;
}
#endif

/// Why the GPU provider was not used, once per process on stderr (the job
/// child's log, child_job.cpp): a CPU fallback must be explainable.
inline void note_gpu_refusal(std::string_view provider, std::string_view why) {
  static bool said = false;
  if (said) return;
  said = true;
  std::fprintf(stderr, "premation: %.*s unavailable, using the CPU: %.*s\n", static_cast<int>(provider.size()), provider.data(),
               static_cast<int>(why.size()), why.data());
}

/// Options for one model; `provider` reports the execution provider chosen
/// ("dml", "coreml", "cuda" or "cpu").
inline Ort::SessionOptions session_options(std::string& provider) {
  Ort::SessionOptions o = cpu_options();
  provider = "cpu";
  if (cpu_forced()) return o;
#if defined(PREMATION_ORT_DML)
  if (!directml_loadable()) note_gpu_refusal("DirectML", "DirectML.dll could not be loaded");
  if (directml_loadable()) {
    try {
      // DirectML wants sequential execution and no memory pattern.
      o.DisableMemPattern();
      o.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
      const OrtDmlApi* dml = nullptr;
      Ort::ThrowOnError(Ort::GetApi().GetExecutionProviderApi("DML", ORT_API_VERSION, reinterpret_cast<const void**>(&dml)));
      // The discrete GPU on a hybrid laptop, not whichever adapter DXGI lists first.
      OrtDmlDeviceOptions device{};
      device.Preference = HighPerformance;
      device.Filter = Gpu;
      Ort::ThrowOnError(dml->SessionOptionsAppendExecutionProvider_DML2(o, &device));
      provider = "dml";
      return o;
    } catch (const Ort::Exception& e) {
      note_gpu_refusal("DirectML", e.what());
      o = cpu_options();
    }
  }
#endif
#if defined(PREMATION_ORT_COREML)
  try {
    Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_CoreML(o, 0));
    provider = "coreml";
    return o;
  } catch (const Ort::Exception&) {
    o = cpu_options();
  }
#endif
  try {
    // CUDA, when the runtime was built with it (the generic call throws otherwise).
    OrtCUDAProviderOptions cuda{};
    o.AppendExecutionProvider_CUDA(cuda);
    provider = "cuda";
  } catch (const Ort::Exception&) {
    o = cpu_options();
  }
  return o;
}

/// True when the model holds integer-quantized operators (dynamic / QLinear
/// quantization). DirectML in ORT 1.23 (and 1.24) dies with an access
/// violation while building a session for such a graph — the SlimSAM pair
/// does it — which no try/catch survives, so those models stay on the CPU.
/// The op types are plain strings in the protobuf: a byte search finds them.
inline bool has_integer_quant_ops(const ORTCHAR_T* path) {
  std::ifstream f(std::filesystem::path(path), std::ios::binary);
  if (!f) return false;
  static constexpr std::array<std::string_view, 5> kOps{"DynamicQuantizeLinear", "MatMulInteger", "ConvInteger", "QLinearConv",
                                                         "QLinearMatMul"};
  // Chunks overlap by the longest name, so a name across a boundary is still seen.
  constexpr std::size_t kChunk = std::size_t{4} << 20;
  constexpr std::size_t kOverlap = 32;
  std::string buf(kChunk + kOverlap, '\0');
  std::size_t kept = 0;
  while (f) {
    f.read(buf.data() + kept, static_cast<std::streamsize>(kChunk));
    const std::size_t n = kept + static_cast<std::size_t>(f.gcount());
    const std::string_view view(buf.data(), n);
    for (const std::string_view op : kOps)
      if (view.find(op) != std::string_view::npos) return true;
    kept = std::min(kOverlap, n);
    std::copy(buf.begin() + static_cast<std::ptrdiff_t>(n - kept), buf.begin() + static_cast<std::ptrdiff_t>(n), buf.begin());
  }
  return false;
}

/// A session on the GPU provider when one opens it, else on the CPU.
/// `provider` reports which; `gpuError` (when given) the GPU's refusal.
/// `cpuThreads` caps the CPU pool of the CPU session (0 = ORT's default).
inline Ort::Session open_session(const Ort::Env& env, const ORTCHAR_T* path, std::string& provider, int cpuThreads = 0,
                                 std::string* gpuError = nullptr) {
  Ort::SessionOptions gpu = session_options(provider);
  if (provider == "dml" && has_integer_quant_ops(path)) {
    provider = "cpu";  // see has_integer_quant_ops: a crash, not an error
    if (gpuError != nullptr) *gpuError = "integer-quantized model";
  }
  if (provider != "cpu") {
    try {
      return Ort::Session(env, path, gpu);
    } catch (const Ort::Exception& e) {
      note_gpu_refusal(provider, e.what());
      if (gpuError != nullptr) *gpuError = e.what();
    }
  }
  provider = "cpu";
  const Ort::SessionOptions cpu = cpu_options(cpuThreads);
  return Ort::Session(env, path, cpu);
}

}  // namespace premation::jobs::ort
