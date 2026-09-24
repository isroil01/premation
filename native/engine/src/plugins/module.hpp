// A loaded plugin binary (G1). The only place that calls LoadLibrary / dlopen
// is module_ffi.cpp (CLAUDE.md: OS FFI only in *_ffi.cpp).
#pragma once

#include <filesystem>
#include <memory>
#include <string>

namespace premation::plugins {

class DynamicLibrary {
 public:
  /// Load `path` (its own directory is searched for its dependencies). nullptr + `error` on failure.
  static std::unique_ptr<DynamicLibrary> open(const std::filesystem::path& path, std::string& error);
  ~DynamicLibrary();
  DynamicLibrary(const DynamicLibrary&) = delete;
  DynamicLibrary& operator=(const DynamicLibrary&) = delete;
  DynamicLibrary(DynamicLibrary&&) = delete;
  DynamicLibrary& operator=(DynamicLibrary&&) = delete;

  /// An exported symbol, or nullptr.
  [[nodiscard]] void* symbol(const char* name) const;
  /// Keep the module mapped for the rest of the process (a plugin that crashed
  /// may still own threads / callbacks; unmapping its code under them would
  /// turn a contained fault into an engine crash).
  void pin() noexcept { pinned_ = true; }

 private:
  DynamicLibrary() = default;
  void* handle_ = nullptr;
  bool pinned_ = false;
};

/// The binary name the manifest's `binary` object keys by: "windows" | "macos" | "linux".
[[nodiscard]] const char* platform_key() noexcept;

}  // namespace premation::plugins
