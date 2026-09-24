#include "cuda_ffi.hpp"

#include <windows.h>

#include <array>
#include <cstring>
#include <memory>
#include <type_traits>

namespace premation::media::cuda {
namespace {

// The five driver-API entry points used here (cuda.h signatures; CUresult and
// CUdevice are ints on every platform; CUDAAPI is __stdcall = the x64 default).
using CuInit = int (*)(unsigned int);
using CuDeviceGetCount = int (*)(int*);
using CuDeviceGet = int (*)(int*, int);
using CuDeviceGetName = int (*)(char*, int, int);
using CuDeviceGetLuid = int (*)(char*, unsigned int*, int);

struct LibraryCloser {
  void operator()(HMODULE h) const {
    if (h != nullptr) FreeLibrary(h);
  }
};
using Library = std::unique_ptr<std::remove_pointer_t<HMODULE>, LibraryCloser>;

template <typename Fn>
Fn symbol(HMODULE lib, const char* name) {
  // FARPROC → the entry point's real type (the documented GetProcAddress idiom).
  return reinterpret_cast<Fn>(GetProcAddress(lib, name));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

}  // namespace

DeviceMatch device_for_luid(std::uint64_t luid, std::string& error) {
  DeviceMatch out;
  // Search System32 only: never a nvcuda.dll planted next to a project file.
  const Library lib(LoadLibraryExW(L"nvcuda.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32));
  if (!lib) {
    error = "no NVIDIA CUDA driver (nvcuda.dll)";
    return out;
  }
  const auto init = symbol<CuInit>(lib.get(), "cuInit");
  const auto count = symbol<CuDeviceGetCount>(lib.get(), "cuDeviceGetCount");
  const auto get = symbol<CuDeviceGet>(lib.get(), "cuDeviceGet");
  const auto name = symbol<CuDeviceGetName>(lib.get(), "cuDeviceGetName");
  const auto getLuid = symbol<CuDeviceGetLuid>(lib.get(), "cuDeviceGetLuid");
  if (init == nullptr || count == nullptr || get == nullptr || name == nullptr || getLuid == nullptr) {
    error = "CUDA driver too old (no cuDeviceGetLuid)";
    return out;
  }
  if (init(0) != 0) {
    error = "cuInit failed";
    return out;
  }
  int n = 0;
  if (count(&n) != 0 || n <= 0) {
    error = "no CUDA device";
    return out;
  }
  for (int i = 0; i < n; ++i) {
    int dev = 0;
    if (get(&dev, i) != 0) continue;
    std::array<char, 8> raw{};
    unsigned int mask = 0;
    if (getLuid(raw.data(), &mask, dev) != 0) continue;
    LUID l{};
    std::memcpy(&l, raw.data(), sizeof(l));
    const std::uint64_t v = (static_cast<std::uint64_t>(static_cast<std::uint32_t>(l.HighPart)) << 32U) | l.LowPart;
    if (luid != 0 && v != luid) continue;
    std::array<char, 256> buf{};
    if (name(buf.data(), static_cast<int>(buf.size()), dev) == 0) out.name = buf.data();
    out.ordinal = i;
    return out;
  }
  error = "the render adapter is not a CUDA device";
  return out;
}

}  // namespace premation::media::cuda
