// LoadLibrary / dlopen for plugin binaries (module.hpp).
#include "module.hpp"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace premation::plugins {

#if defined(_WIN32)

namespace {
std::string last_error_text() {
  const DWORD code = GetLastError();
  char* buf = nullptr;
  const DWORD n = FormatMessageA(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                 nullptr, code, 0, reinterpret_cast<LPSTR>(&buf), 0, nullptr);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): FORMAT_MESSAGE_ALLOCATE_BUFFER's contract
  std::string text = n > 0 && buf != nullptr ? std::string(buf, n) : std::string();
  if (buf != nullptr) LocalFree(buf);
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == ' ')) text.pop_back();
  return "error " + std::to_string(code) + (text.empty() ? "" : " (" + text + ")");
}
}  // namespace

std::unique_ptr<DynamicLibrary> DynamicLibrary::open(const std::filesystem::path& path, std::string& error) {
  // No "missing DLL" message boxes from the loader: a broken plugin is a logged error.
  DWORD oldMode = 0;
  SetThreadErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX, &oldMode);
  HMODULE h = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  const std::string why = h == nullptr ? last_error_text() : std::string();
  SetThreadErrorMode(oldMode, nullptr);
  if (h == nullptr) {
    error = "LoadLibrary failed: " + why;
    return nullptr;
  }
  std::unique_ptr<DynamicLibrary> lib(new DynamicLibrary());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  lib->handle_ = h;
  return lib;
}

DynamicLibrary::~DynamicLibrary() {
  if (handle_ != nullptr && !pinned_) FreeLibrary(static_cast<HMODULE>(handle_));
}

void* DynamicLibrary::symbol(const char* name) const {
  return reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(handle_), name));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): FARPROC → void*
}

const char* platform_key() noexcept { return "windows"; }

#else

std::unique_ptr<DynamicLibrary> DynamicLibrary::open(const std::filesystem::path& path, std::string& error) {
  void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (h == nullptr) {
    const char* e = dlerror();
    error = std::string("dlopen failed: ") + (e != nullptr ? e : "unknown error");
    return nullptr;
  }
  std::unique_ptr<DynamicLibrary> lib(new DynamicLibrary());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  lib->handle_ = h;
  return lib;
}

DynamicLibrary::~DynamicLibrary() {
  if (handle_ != nullptr && !pinned_) dlclose(handle_);
}

void* DynamicLibrary::symbol(const char* name) const { return dlsym(handle_, name); }

const char* platform_key() noexcept {
#if defined(__APPLE__)
  return "macos";
#else
  return "linux";
#endif
}

#endif

}  // namespace premation::plugins
