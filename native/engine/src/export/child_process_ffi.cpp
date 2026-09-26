#include "child_process.hpp"

#include <algorithm>
#include <array>
#include <string>

#if defined(_WIN32)
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

extern char** environ;  // NOLINT(readability-redundant-declaration): POSIX, not declared by every libc header
#endif

namespace premation::exporter {

std::string quote_windows_arg(const std::string& arg) {
  if (!arg.empty() && arg.find_first_of(" \t\n\v\"") == std::string::npos) return arg;
  std::string out = "\"";
  std::size_t backslashes = 0;
  for (const char c : arg) {
    if (c == '\\') {
      ++backslashes;
      continue;
    }
    if (c == '"') {
      out.append(backslashes * 2 + 1, '\\');
    } else {
      out.append(backslashes, '\\');
    }
    backslashes = 0;
    out += c;
  }
  out.append(backslashes * 2, '\\');
  out += '"';
  return out;
}

void ignore_broken_pipes() noexcept {
#if !defined(_WIN32)
  (void)std::signal(SIGPIPE, SIG_IGN);
#endif
}

#if defined(_WIN32)

namespace {

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<std::size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string last_error_text(const char* what) {
  const DWORD code = GetLastError();
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) {
    return std::string(what) + ": the executable was not found";
  }
  return std::string(what) + " failed (Windows error " + std::to_string(code) + ")";
}

}  // namespace

struct ChildProcess::Os {
  HANDLE process = nullptr;
  HANDLE stdinWrite = nullptr;
  HANDLE stdoutRead = nullptr;
  HANDLE job = nullptr;
  bool exited = false;
  int code = -1;
};

std::unique_ptr<ChildProcess> ChildProcess::spawn(const std::string& exe, const std::vector<std::string>& args,
                                                  const std::string& stderrPath, std::string& error,
                                                  bool captureStdout) {
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE readEnd = nullptr;
  HANDLE writeEnd = nullptr;
  // 4 MiB pipe buffer: one write call moves most of a 1080p frame.
  if (CreatePipe(&readEnd, &writeEnd, &sa, 4U << 20U) == 0) {
    error = last_error_text("CreatePipe");
    return nullptr;
  }
  SetHandleInformation(writeEnd, HANDLE_FLAG_INHERIT, 0);
  HANDLE outRead = nullptr;
  HANDLE outWrite = nullptr;
  if (captureStdout) {
    if (CreatePipe(&outRead, &outWrite, &sa, 1U << 16U) == 0) {
      error = last_error_text("CreatePipe");
      CloseHandle(readEnd);
      CloseHandle(writeEnd);
      return nullptr;
    }
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
  }
  HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  HANDLE errFile = stderrPath.empty()
                       ? nul
                       : CreateFileW(widen(stderrPath).c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_ALWAYS,
                                     FILE_ATTRIBUTE_NORMAL, nullptr);
  if (errFile == INVALID_HANDLE_VALUE) errFile = nul;

  std::string cmd = quote_windows_arg(exe);
  for (const std::string& a : args) {
    cmd += ' ';
    cmd += quote_windows_arg(a);
  }
  std::wstring wcmd = widen(cmd);
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = readEnd;
  si.hStdOutput = captureStdout ? outWrite : nul;
  si.hStdError = errFile;
  PROCESS_INFORMATION pi{};
  // Suspended until it is in the job, so it can never outlive the engine.
  const BOOL ok = CreateProcessW(nullptr, wcmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr,
                                 nullptr, &si, &pi);
  const std::string spawnError = ok == 0 ? last_error_text("starting the encoder") : std::string();
  CloseHandle(readEnd);
  if (outWrite != nullptr) CloseHandle(outWrite);
  if (errFile != nul) CloseHandle(errFile);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (ok == 0) {
    CloseHandle(writeEnd);
    if (outRead != nullptr) CloseHandle(outRead);
    error = spawnError;
    return nullptr;
  }
  auto child = std::unique_ptr<ChildProcess>(new ChildProcess());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  child->os_ = std::make_unique<Os>();
  child->os_->process = pi.hProcess;
  child->os_->stdinWrite = writeEnd;
  child->os_->stdoutRead = outRead;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job != nullptr) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    if (AssignProcessToJobObject(job, pi.hProcess) != 0) {
      child->os_->job = job;
    } else {
      CloseHandle(job);
    }
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  return child;
}

ChildProcess::~ChildProcess() {
  if (!os_) return;
  if (!os_->exited) kill();
  if (os_->stdinWrite != nullptr) CloseHandle(os_->stdinWrite);
  if (os_->stdoutRead != nullptr) CloseHandle(os_->stdoutRead);
  if (os_->process != nullptr) CloseHandle(os_->process);
  if (os_->job != nullptr) CloseHandle(os_->job);
}

bool ChildProcess::write(std::span<const std::uint8_t> bytes) noexcept {
  if (os_->stdinWrite == nullptr) return false;
  std::size_t off = 0;
  while (off < bytes.size()) {
    const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - off, 16U << 20U));
    DWORD wrote = 0;
    if (WriteFile(os_->stdinWrite, bytes.data() + off, chunk, &wrote, nullptr) == 0) return false;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    off += wrote;
  }
  return true;
}

int ChildProcess::finish() noexcept {
  if (os_->stdinWrite != nullptr) {
    CloseHandle(os_->stdinWrite);
    os_->stdinWrite = nullptr;
  }
  if (!os_->exited) {
    WaitForSingleObject(os_->process, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(os_->process, &code);
    os_->code = static_cast<int>(code);
    os_->exited = true;
  }
  return os_->code;
}

void ChildProcess::kill() noexcept {
  if (!os_ || os_->exited) return;
  TerminateProcess(os_->process, 1);
  WaitForSingleObject(os_->process, 5000);
  os_->exited = true;
  os_->code = -1;
}

long ChildProcess::read_stdout(std::span<std::uint8_t> into) noexcept {
  if (!os_ || os_->stdoutRead == nullptr || into.empty()) return -1;
  DWORD got = 0;
  const DWORD want = static_cast<DWORD>(std::min<std::size_t>(into.size(), 1U << 20U));
  if (ReadFile(os_->stdoutRead, into.data(), want, &got, nullptr) == 0) {
    return GetLastError() == ERROR_BROKEN_PIPE ? 0 : -1;  // the child closed its end: end of stream
  }
  return static_cast<long>(got);
}

#else  // POSIX

struct ChildProcess::Os {
  pid_t pid = -1;
  int stdinWrite = -1;
  int stdoutRead = -1;
  bool exited = false;
  int code = -1;
};

std::unique_ptr<ChildProcess> ChildProcess::spawn(const std::string& exe, const std::vector<std::string>& args,
                                                  const std::string& stderrPath, std::string& error,
                                                  bool captureStdout) {
  std::array<int, 2> fds{-1, -1};
  if (pipe(fds.data()) != 0) {
    error = std::string("pipe: ") + std::strerror(errno);  // NOLINT(concurrency-mt-unsafe)
    return nullptr;
  }
  (void)fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  std::array<int, 2> out{-1, -1};
  if (captureStdout) {
    if (pipe(out.data()) != 0) {
      error = std::string("pipe: ") + std::strerror(errno);  // NOLINT(concurrency-mt-unsafe)
      close(fds[0]);
      close(fds[1]);
      return nullptr;
    }
    (void)fcntl(out[0], F_SETFD, FD_CLOEXEC);
  }
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, fds[0], 0);
  posix_spawn_file_actions_addclose(&fa, fds[0]);
  if (captureStdout) {
    posix_spawn_file_actions_adddup2(&fa, out[1], 1);
    posix_spawn_file_actions_addclose(&fa, out[1]);
  } else {
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  }
  posix_spawn_file_actions_addopen(&fa, 2, stderrPath.empty() ? "/dev/null" : stderrPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  std::vector<std::string> storage;
  storage.reserve(args.size() + 1);
  storage.push_back(exe);
  for (const auto& a : args) storage.push_back(a);
  std::vector<char*> argv;
  argv.reserve(storage.size() + 1);
  for (auto& s : storage) argv.push_back(s.data());
  argv.push_back(nullptr);
  pid_t pid = -1;
  const int rc = posix_spawnp(&pid, exe.c_str(), &fa, nullptr, argv.data(), environ);
  posix_spawn_file_actions_destroy(&fa);
  close(fds[0]);
  if (out[1] >= 0) close(out[1]);
  if (rc != 0) {
    close(fds[1]);
    if (out[0] >= 0) close(out[0]);
    error = rc == ENOENT ? "starting the encoder: the executable was not found"
                         : std::string("starting the encoder: ") + std::strerror(rc);  // NOLINT(concurrency-mt-unsafe)
    return nullptr;
  }
  auto child = std::unique_ptr<ChildProcess>(new ChildProcess());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  child->os_ = std::make_unique<Os>();
  child->os_->pid = pid;
  child->os_->stdinWrite = fds[1];
  child->os_->stdoutRead = out[0];
  return child;
}

ChildProcess::~ChildProcess() {
  if (!os_) return;
  if (!os_->exited) kill();
  if (os_->stdinWrite >= 0) close(os_->stdinWrite);
  if (os_->stdoutRead >= 0) close(os_->stdoutRead);
}

bool ChildProcess::write(std::span<const std::uint8_t> bytes) noexcept {
  std::size_t off = 0;
  while (off < bytes.size()) {
    const ssize_t n = ::write(os_->stdinWrite, bytes.data() + off, bytes.size() - off);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    off += static_cast<std::size_t>(n);
  }
  return true;
}

int ChildProcess::finish() noexcept {
  if (os_->stdinWrite >= 0) {
    close(os_->stdinWrite);
    os_->stdinWrite = -1;
  }
  if (!os_->exited) {
    int status = 0;
    while (waitpid(os_->pid, &status, 0) < 0 && errno == EINTR) {
    }
    os_->code = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
    os_->exited = true;
  }
  return os_->code;
}

void ChildProcess::kill() noexcept {
  if (!os_ || os_->exited) return;
  ::kill(os_->pid, SIGKILL);
  int status = 0;
  (void)waitpid(os_->pid, &status, 0);
  os_->exited = true;
  os_->code = -1;
}

long ChildProcess::read_stdout(std::span<std::uint8_t> into) noexcept {
  if (!os_ || os_->stdoutRead < 0 || into.empty()) return -1;
  for (;;) {
    const ssize_t n = ::read(os_->stdoutRead, into.data(), into.size());
    if (n < 0 && errno == EINTR) continue;
    return static_cast<long>(n);
  }
}

#endif

}  // namespace premation::exporter
