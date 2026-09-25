// F1: the encoder child an export job feeds — ffmpeg, spawned by the engine
// with a pipe on its stdin (raw frames), stdout discarded and stderr to a log
// file. Every OS call lives in child_process_ffi.cpp (CLAUDE.md: FFI only in
// *_ffi.cpp).
//
// The child dies with the engine: on Windows it is placed in a job object that
// kills its processes when the last handle closes (the engine's, including
// when the engine crashes or the supervisor kills it); elsewhere it is killed
// by the destructor, and a crashed engine closes the pipe, which ends ffmpeg's
// input.
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace premation::exporter {

class ChildProcess {
 public:
  /// Start `exe args…`. Null with `error` when the OS refuses (ENOENT etc.).
  static std::unique_ptr<ChildProcess> spawn(const std::string& exe, const std::vector<std::string>& args,
                                             const std::string& stderrPath, std::string& error);
  ~ChildProcess();
  ChildProcess(const ChildProcess&) = delete;
  ChildProcess& operator=(const ChildProcess&) = delete;
  ChildProcess(ChildProcess&&) = delete;
  ChildProcess& operator=(ChildProcess&&) = delete;

  /// Blocking write of the whole buffer to the child's stdin. False when the child is gone.
  bool write(std::span<const std::uint8_t> bytes) noexcept;
  /// Close stdin (end of input) and wait for the exit code.
  int finish() noexcept;
  /// Kill the child (cancel / failure). Safe to call more than once.
  void kill() noexcept;

 private:
  ChildProcess() = default;
  struct Os;
  std::unique_ptr<Os> os_;
};

/// POSIX: a write to a dead encoder returns an error instead of raising SIGPIPE. No-op on Windows.
void ignore_broken_pipes() noexcept;

/// Windows command-line quoting of one argument (CommandLineToArgvW's rules). Pure; tested.
[[nodiscard]] std::string quote_windows_arg(const std::string& arg);

}  // namespace premation::exporter
