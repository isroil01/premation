// guarded_call — the OS half of plugin crash isolation (guard.hpp).
#include "guard.hpp"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// windows.h first
#include <malloc.h>  // _resetstkoflw

namespace premation::plugins {
namespace {

int take_code(unsigned long code, unsigned long* out) {
  *out = code;
  return EXCEPTION_EXECUTE_HANDLER;
}

/// The frame that holds __try: no object with a destructor may live here.
/// SEH is the only way to catch a fault in-process on Windows; -Wpedantic
/// calls __try/__except a language extension, which is the point here.
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token"
#endif
bool seh_call(GuardedFn fn, void* ctx, unsigned long* code) {
  __try {
    fn(ctx);
    return true;
  } __except (take_code(GetExceptionCode(), code)) {
    return false;
  }
}
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

FaultKind kind_of(unsigned long code) {
  switch (code) {
    case EXCEPTION_ACCESS_VIOLATION:
    case EXCEPTION_IN_PAGE_ERROR:
    case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
    case EXCEPTION_DATATYPE_MISALIGNMENT:
    case EXCEPTION_GUARD_PAGE: return FaultKind::access_violation;
    case EXCEPTION_STACK_OVERFLOW: return FaultKind::stack_overflow;
    case EXCEPTION_INT_DIVIDE_BY_ZERO:
    case EXCEPTION_INT_OVERFLOW:
    case EXCEPTION_FLT_DIVIDE_BY_ZERO:
    case EXCEPTION_FLT_INVALID_OPERATION: return FaultKind::divide_by_zero;
    case EXCEPTION_ILLEGAL_INSTRUCTION:
    case EXCEPTION_PRIV_INSTRUCTION: return FaultKind::illegal_instruction;
    case 0xE06D7363UL: return FaultKind::cpp_exception;  // MSVC C++ exception ('msc')
    default: return FaultKind::other;
  }
}

}  // namespace

Fault guarded_call(GuardedFn fn, void* ctx) {
  unsigned long code = 0;
  if (seh_call(fn, ctx, &code)) return {};
  // After an overflow the guard page is gone; put it back or the next overflow
  // on this thread kills the process outright.
  if (code == EXCEPTION_STACK_OVERFLOW) (void)_resetstkoflw();
  return {kind_of(code), static_cast<std::uint32_t>(code)};
}

}  // namespace premation::plugins

#else  // POSIX

#include <csetjmp>
#include <csignal>
#include <cstddef>
#include <mutex>
#include <vector>

namespace premation::plugins {
namespace {

// Per thread: where a fault inside a guarded call jumps back to.
thread_local sigjmp_buf* t_jump = nullptr;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): per-thread guard state
thread_local volatile std::sig_atomic_t t_signal = 0;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
thread_local std::vector<char> t_altstack;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the handler's stack

constexpr int kSignals[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
struct sigaction g_previous[4];  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables, cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
std::once_flag g_installed;      // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

void on_fault(int sig, siginfo_t* /*info*/, void* /*uctx*/) {
  if (t_jump != nullptr) {
    t_signal = sig;
    siglongjmp(*t_jump, 1);  // NOLINT(cert-err52-cpp): the only way back from a synchronous fault
  }
  // A fault outside any guarded call is the engine's own: restore the previous
  // disposition and let it take its normal course.
  for (std::size_t i = 0; i < 4; ++i) {
    if (kSignals[i] == sig) sigaction(sig, &g_previous[i], nullptr);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  raise(sig);
}

void install() {
  struct sigaction sa {};
  sa.sa_sigaction = &on_fault;
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  for (std::size_t i = 0; i < 4; ++i) sigaction(kSignals[i], &sa, &g_previous[i]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
}

/// A stack overflow faults ON the exhausted stack; the handler runs on this one.
void ensure_altstack() {
  if (!t_altstack.empty()) return;
  constexpr std::size_t kBytes = 256 * 1024;
  t_altstack.resize(kBytes);
  stack_t ss{};
  ss.ss_sp = t_altstack.data();
  ss.ss_size = kBytes;
  ss.ss_flags = 0;
  sigaltstack(&ss, nullptr);
}

FaultKind kind_of(int sig) {
  switch (sig) {
    case SIGSEGV:
    case SIGBUS: return FaultKind::access_violation;  // a stack overflow is a SIGSEGV here too
    case SIGFPE: return FaultKind::divide_by_zero;
    case SIGILL: return FaultKind::illegal_instruction;
    default: return FaultKind::other;
  }
}

}  // namespace

Fault guarded_call(GuardedFn fn, void* ctx) {
  std::call_once(g_installed, install);
  ensure_altstack();
  sigjmp_buf buf;
  sigjmp_buf* const previous = t_jump;
  t_jump = &buf;
  if (sigsetjmp(buf, 1) == 0) {  // NOLINT(cert-err52-cpp): see on_fault
    fn(ctx);
    t_jump = previous;
    return {};
  }
  t_jump = previous;
  const int sig = t_signal;
  return {kind_of(sig), static_cast<std::uint32_t>(sig)};
}

}  // namespace premation::plugins

#endif

namespace premation::plugins {

std::string_view to_string(FaultKind k) noexcept {
  switch (k) {
    case FaultKind::none: return "none";
    case FaultKind::access_violation: return "access violation";
    case FaultKind::stack_overflow: return "stack overflow";
    case FaultKind::divide_by_zero: return "divide by zero";
    case FaultKind::illegal_instruction: return "illegal instruction";
    case FaultKind::cpp_exception: return "C++ exception";
    case FaultKind::hang: return "hang (watchdog)";
    default: return "fault";
  }
}

}  // namespace premation::plugins
