// SDK 1.4 (M): ONNX Runtime FFI for the plugin ML suite (ml.hpp). Ort::Exception never leaves
// this file. Without the runtime it builds to a stub whose load() fails with a clear reason.
#include "ml.hpp"

#include <fstream>
#include <map>
#include <mutex>
#include <optional>

#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define PREMATION_PLUGINS_ORT 1
#elif __has_include(<onnxruntime/onnxruntime_cxx_api.h>)
#include <onnxruntime/onnxruntime_cxx_api.h>
#define PREMATION_PLUGINS_ORT 1
#endif

#ifdef PREMATION_PLUGINS_ORT
#include <algorithm>
#include <exception>

#include "../jobs/ort_providers_ffi.hpp"
#endif

namespace premation::plugins::ml {

namespace {

constexpr std::uintmax_t kMaxModelBytes = std::uintmax_t{1} << 30;  // 1 GB

struct Registry {
#ifdef PREMATION_PLUGINS_ORT
  // Declared first, destroyed last: every cached session goes before the environment.
  std::optional<Ort::Env> env;
#endif
  std::mutex mutex;
  std::map<std::uint64_t, std::shared_ptr<Model>> byHash;
  std::uint64_t bytes = 0;
  std::uint64_t runs = 0;
};

Registry& registry() {
  static Registry r;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process-wide sessions
  return r;
}

/// FNV-1a over the file's bytes (the session cache key).
bool hash_file(const std::filesystem::path& file, std::uint64_t& hash, std::uint64_t& size, std::string& error) {
  std::error_code ec;
  const std::uintmax_t n = std::filesystem::file_size(file, ec);
  if (ec) {
    error = "the model file is missing";
    return false;
  }
  if (n > kMaxModelBytes) {
    error = "the model file is over 1 GB";
    return false;
  }
  std::ifstream in(file, std::ios::binary);
  if (!in) {
    error = "the model file cannot be read";
    return false;
  }
  hash = 1469598103934665603ULL;
  std::vector<char> buf(1 << 16);
  while (in) {
    in.read(buf.data(), static_cast<std::streamsize>(buf.size()));
    const auto got = static_cast<std::size_t>(in.gcount());
    for (std::size_t i = 0; i < got; ++i) {
      hash ^= static_cast<unsigned char>(buf[i]);
      hash *= 1099511628211ULL;
    }
  }
  size = n;
  return true;
}

#ifdef PREMATION_PLUGINS_ORT

/// One environment for every plugin (the registry's; call with its mutex held).
Ort::Env& env() {
  Registry& r = registry();
  if (!r.env) r.env.emplace(ORT_LOGGING_LEVEL_WARNING, "premation-plugins");
  return *r.env;
}

class OrtModel final : public Model {
 public:
  explicit OrtModel(const std::filesystem::path& file)
      : session_(jobs::ort::open_session(env(), file.c_str(), provider_)), memory_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    Ort::AllocatorWithDefaultOptions alloc;
    for (std::size_t i = 0; i < session_.GetInputCount(); ++i) inputs_.emplace_back(session_.GetInputNameAllocated(i, alloc).get());
    for (std::size_t i = 0; i < session_.GetOutputCount(); ++i) outputs_.emplace_back(session_.GetOutputNameAllocated(i, alloc).get());
  }

  [[nodiscard]] std::string provider() const override { return provider_.empty() ? std::string("cpu") : provider_; }

  bool run(std::span<const Tensor> in, std::vector<Tensor>& out, std::string& error) override {
    try {
      if (in.size() != inputs_.size()) {
        error = "the model takes " + std::to_string(inputs_.size()) + " input(s), got " + std::to_string(in.size());
        return false;
      }
      std::vector<Ort::Value> values;
      std::vector<const char*> inNames;
      for (std::size_t i = 0; i < in.size(); ++i) {
        const Tensor& t = in[i];
        std::size_t count = 1;
        for (const std::int64_t d : t.shape) count *= static_cast<std::size_t>(std::max<std::int64_t>(d, 0));
        if (count != t.data.size()) {
          error = "input " + std::to_string(i) + ": the shape holds " + std::to_string(count) + " values, the data " + std::to_string(t.data.size());
          return false;
        }
        // ORT reads the buffer only; the API takes it non-const.
        values.push_back(Ort::Value::CreateTensor<float>(memory_, const_cast<float*>(t.data.data()), t.data.size(), t.shape.data(),  // NOLINT(cppcoreguidelines-pro-type-const-cast)
                                                         t.shape.size()));
        const std::string& name = t.name.empty() ? inputs_[i] : t.name;
        const auto it = std::ranges::find(inputs_, name);
        if (it == inputs_.end()) {
          error = "the model has no input '" + name + "'";
          return false;
        }
        inNames.push_back(it->c_str());
      }
      if (out.empty()) {
        for (const std::string& n : outputs_) out.push_back(Tensor{n, {}, {}});
      }
      std::vector<const char*> outNames;
      for (std::size_t i = 0; i < out.size(); ++i) {
        const std::string& name = out[i].name.empty() && i < outputs_.size() ? outputs_[i] : out[i].name;
        const auto it = std::ranges::find(outputs_, name);
        if (it == outputs_.end()) {
          error = "the model has no output '" + name + "'";
          return false;
        }
        outNames.push_back(it->c_str());
      }
      std::vector<Ort::Value> results = session_.Run(Ort::RunOptions{nullptr}, inNames.data(), values.data(), values.size(), outNames.data(), outNames.size());
      for (std::size_t i = 0; i < results.size() && i < out.size(); ++i) {
        if (!results[i].IsTensor()) {
          error = "output '" + std::string(outNames[i]) + "' is not a tensor";
          return false;
        }
        const Ort::TensorTypeAndShapeInfo info = results[i].GetTensorTypeAndShapeInfo();
        if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
          error = "output '" + std::string(outNames[i]) + "' is not float32";
          return false;
        }
        const float* d = results[i].GetTensorData<float>();
        out[i].name = outNames[i];
        out[i].shape = info.GetShape();
        out[i].data.assign(d, d + info.GetElementCount());  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): ORT's buffer
      }
      return true;
    } catch (const std::exception& e) {
      error = e.what();
      return false;
    }
  }

 private:
  std::string provider_;
  Ort::Session session_;
  Ort::MemoryInfo memory_;
  std::vector<std::string> inputs_;
  std::vector<std::string> outputs_;
};

#endif

}  // namespace

bool runtime_available() noexcept {
#ifdef PREMATION_PLUGINS_ORT
  return true;
#else
  return false;
#endif
}

std::shared_ptr<Model> load(const std::filesystem::path& file, std::string& error) {
  std::uint64_t hash = 0;
  std::uint64_t size = 0;
  if (!hash_file(file, hash, size, error)) return nullptr;
  Registry& r = registry();
  const std::scoped_lock lock(r.mutex);
  if (const auto it = r.byHash.find(hash); it != r.byHash.end()) return it->second;
#ifdef PREMATION_PLUGINS_ORT
  try {
    auto m = std::make_shared<OrtModel>(file);
    r.byHash.emplace(hash, m);
    r.bytes += size;
    return m;
  } catch (const std::exception& e) {
    error = e.what();
    return nullptr;
  }
#else
  error = "this engine build has no ONNX Runtime";
  return nullptr;
#endif
}

void note_run() {
  Registry& r = registry();
  const std::scoped_lock lock(r.mutex);
  ++r.runs;
}

Stats stats() {
  Registry& r = registry();
  const std::scoped_lock lock(r.mutex);
  return Stats{static_cast<std::uint32_t>(r.byHash.size()), r.bytes, r.runs};
}

}  // namespace premation::plugins::ml
