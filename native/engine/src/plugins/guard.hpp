// Per-call crash guard for plugin code (G1, docs/PLUGIN_SDK.md "Crash isolation").
//
// guarded_call runs `fn(ctx)` and turns a hardware fault inside it — access
// violation, stack overflow, integer divide by zero, illegal instruction — into
// a returned Fault instead of a dead process. Windows: structured exception
// handling (__try / __except) around the call, with the stack guard page
// restored after an overflow (_resetstkoflw). POSIX: SIGSEGV / SIGBUS / SIGFPE /
// SIGILL handlers on an alternate signal stack that siglongjmp back to the
// guard. Both live in guard_ffi.cpp (OS FFI).
//
// C++ exceptions a plugin throws across the C ABI are caught by the caller's
// trampoline (`catch (...)`), not here; on Windows an exception that gets past
// it still lands here as a fault.
//
// What a guard cannot contain (documented, and why the engine is also a
// supervised process): a plugin that corrupts the engine's heap without
// faulting, calls abort()/exit(), or hangs. The crash journal (journal.hpp)
// quarantines such a plugin after the engine restarts; the watchdog
// (host.cpp) catches hangs.
#pragma once

#include <cstdint>
#include <string_view>

namespace premation::plugins {

enum class FaultKind : std::uint8_t {
  none,
  access_violation,
  stack_overflow,
  divide_by_zero,
  illegal_instruction,
  cpp_exception,
  hang,
  other,
};

struct Fault {
  FaultKind kind = FaultKind::none;
  std::uint32_t code = 0;  ///< the OS exception code / signal number
  explicit operator bool() const noexcept { return kind != FaultKind::none; }
};

using GuardedFn = void (*)(void* ctx);

/// Run fn(ctx); a hardware fault inside it is returned, never propagated.
/// Re-entrant per thread (a guarded call may itself make guarded calls).
/// Not `noexcept` on purpose: on Windows a C++ exception is an SEH exception,
/// and the guard must see it before any terminate() a noexcept frame implies.
[[nodiscard]] Fault guarded_call(GuardedFn fn, void* ctx);

[[nodiscard]] std::string_view to_string(FaultKind k) noexcept;

}  // namespace premation::plugins
