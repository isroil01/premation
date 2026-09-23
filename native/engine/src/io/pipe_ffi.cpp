#include "pipe_ffi.hpp"

#include <cstdio>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace premation::io {

#ifdef _WIN32

namespace {

HANDLE as_handle(Handle h) {
  // NOLINTNEXTLINE(performance-no-int-to-ptr): Handle stores a HANDLE's bits.
  return reinterpret_cast<HANDLE>(h.value);
}

Handle from_handle(HANDLE h) {
  if (h == nullptr || h == INVALID_HANDLE_VALUE) return {};
  return Handle{reinterpret_cast<std::intptr_t>(h)};
}

// An fd inherited through the CRT's lpReserved2 block (how libuv passes
// stdio[3..] to a child); -1 when the engine was started without it.
void ignore_invalid_parameter(const wchar_t*, const wchar_t*, const wchar_t*, unsigned, uintptr_t) {}

Handle inherited_fd(int fd) {
  // _get_osfhandle on an fd that was never inherited calls the CRT's invalid
  // parameter handler, which terminates the process by default. Started by
  // hand (no fd 3/4) is legitimate: the engine then runs without a frame
  // channel.
  const _invalid_parameter_handler previous = _set_thread_local_invalid_parameter_handler(ignore_invalid_parameter);
  const intptr_t h = _get_osfhandle(fd);
  (void)_set_thread_local_invalid_parameter_handler(previous);
  if (h == -1 || h == -2) return {};
  if (GetFileType(reinterpret_cast<HANDLE>(h)) != FILE_TYPE_PIPE) return {};  // NOLINT(performance-no-int-to-ptr)
  return Handle{h};
}

}  // namespace

bool claim_stdio(Pipes& pipes, std::string& error) {
  (void)_setmode(_fileno(stdin), _O_BINARY);
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (in == nullptr || in == INVALID_HANDLE_VALUE || out == nullptr || out == INVALID_HANDLE_VALUE) {
    error = "stdin/stdout are not available";
    return false;
  }
  HANDLE privateOut = nullptr;
  if (DuplicateHandle(GetCurrentProcess(), out, GetCurrentProcess(), &privateOut, 0, FALSE, DUPLICATE_SAME_ACCESS) ==
      0) {
    error = "DuplicateHandle(stdout) failed";
    return false;
  }
  // From here on anything written to "stdout" — printf, std::cout, a
  // library's diagnostics — goes to stderr, the log.
  std::fflush(stdout);
  (void)_dup2(_fileno(stderr), _fileno(stdout));
  if (err != nullptr && err != INVALID_HANDLE_VALUE) (void)SetStdHandle(STD_OUTPUT_HANDLE, err);
  pipes.commandIn = from_handle(in);
  pipes.commandOut = from_handle(privateOut);
  pipes.framesOut = inherited_fd(3);
  pipes.framesIn = inherited_fd(4);
  return true;
}

std::ptrdiff_t read_some(Handle h, std::span<std::uint8_t> buf) noexcept {
  DWORD got = 0;
  const DWORD want = static_cast<DWORD>(buf.size() < 0x40000000U ? buf.size() : 0x40000000U);
  if (ReadFile(as_handle(h), buf.data(), want, &got, nullptr) == 0) {
    const DWORD e = GetLastError();
    return (e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF) ? 0 : -1;
  }
  return static_cast<std::ptrdiff_t>(got);
}

bool write_all(Handle h, std::span<const std::uint8_t> data) noexcept {
  const std::uint8_t* p = data.data();
  std::size_t left = data.size();
  while (left > 0) {
    constexpr std::size_t kChunk = std::size_t{1} << 24U;
    const DWORD want = static_cast<DWORD>(left < kChunk ? left : kChunk);
    DWORD wrote = 0;
    if (WriteFile(as_handle(h), p, want, &wrote, nullptr) == 0 || wrote == 0) return false;
    p += wrote;
    left -= wrote;
  }
  return true;
}

#else  // POSIX

namespace {

Handle inherited_fd(int fd) {
  if (fcntl(fd, F_GETFD) == -1) return {};
  return Handle{fd};
}

}  // namespace

bool claim_stdio(Pipes& pipes, std::string& error) {
  const int privateOut = dup(STDOUT_FILENO);
  if (privateOut < 0) {
    error = "dup(stdout) failed";
    return false;
  }
  (void)fcntl(privateOut, F_SETFD, FD_CLOEXEC);
  std::fflush(stdout);
  (void)dup2(STDERR_FILENO, STDOUT_FILENO);
  pipes.commandIn = Handle{STDIN_FILENO};
  pipes.commandOut = Handle{privateOut};
  pipes.framesOut = inherited_fd(3);
  pipes.framesIn = inherited_fd(4);
  return true;
}

std::ptrdiff_t read_some(Handle h, std::span<std::uint8_t> buf) noexcept {
  for (;;) {
    const ssize_t n = ::read(static_cast<int>(h.value), buf.data(), buf.size());
    if (n < 0 && errno == EINTR) continue;
    return n;
  }
}

bool write_all(Handle h, std::span<const std::uint8_t> data) noexcept {
  const std::uint8_t* p = data.data();
  std::size_t left = data.size();
  while (left > 0) {
    const ssize_t n = ::write(static_cast<int>(h.value), p, left);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    p += n;
    left -= static_cast<std::size_t>(n);
  }
  return true;
}

#endif

}  // namespace premation::io
