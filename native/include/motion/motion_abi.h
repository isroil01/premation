/*
 * Premation native core — the ONE public C ABI, part 0: version + status.
 *
 * Every header in include/motion/ is plain C (C11) so that the same file is
 * consumed by the C++ libraries under native/libs, the Emscripten glue, the
 * N-API addon and, from phase N5 on, third-party native plugins. Rules, from
 * docs/NATIVE_CORE_PLAN.md §2:
 *
 *   • Plain-data structs and pointer+count spans at the boundary. No C++
 *     types, no callbacks that own memory, no hidden allocation.
 *   • No exceptions cross this boundary. Every function that can fail returns
 *     a `motion_status`; a human-readable reason is written into the caller's
 *     `motion_error` buffer when one is supplied (it may be NULL).
 *   • Pure functions over the data handed in. Nothing here keeps state.
 *
 * ── Versioning ───────────────────────────────────────────────────────────────
 * MAJOR changes break callers (a struct grew, an enum value moved). MINOR adds
 * functions or trailing fields; a caller built against an older MINOR keeps
 * working. `motion_abi_version()` packs both so a loader can refuse a binary
 * that does not match the headers it was compiled against.
 */

#ifndef MOTION_ABI_H
#define MOTION_ABI_H

/* This is a C header: typedef'd structs, #define'd constants, `(void)`
 * parameter lists and int-sized enums are the language, not a style lapse.
 * Silenced for the whole file (BEGIN/END lists must match exactly) so the
 * same clang-tidy checks keep firing on the C++ sources. */
// NOLINTBEGIN(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size)

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MOTION_ABI_VERSION_MAJOR 0
#define MOTION_ABI_VERSION_MINOR 2

/** (MAJOR << 16) | MINOR, so callers can compare a single integer. */
#define MOTION_ABI_VERSION_PACKED \
  ((uint32_t)(((uint32_t)MOTION_ABI_VERSION_MAJOR << 16u) | (uint32_t)MOTION_ABI_VERSION_MINOR))

/** Symbol export: the N-API and WASM shared objects hide everything else. */
#if defined(_WIN32)
#if defined(MOTION_BUILD_SHARED)
#define MOTION_API __declspec(dllexport)
#else
#define MOTION_API
#endif
#else
#define MOTION_API __attribute__((visibility("default")))
#endif

/** Outcome of every fallible ABI call. Values are stable; append only. */
typedef enum motion_status {
  MOTION_OK = 0,
  /** A pointer was NULL when it may not be, a count was zero, a number was
   *  NaN, an enum was out of its range, keyframes were not sorted. */
  MOTION_INVALID_ARG = 1,
  /** A value was well-formed but outside what this call supports (a batch
   *  larger than the output buffer, an index past the end). */
  MOTION_OUT_OF_RANGE = 2,
  /** Something the library did not expect: an exception it caught, an
   *  invariant it could not hold. Treat the output as unwritten. */
  MOTION_INTERNAL = 3
} motion_status;

/** Capacity of the error-message buffer, including the terminating NUL. */
#define MOTION_ERROR_MESSAGE_CAP 256

/**
 * Optional out-parameter carrying the reason for a non-OK status.
 *
 * Convention: every fallible function takes `motion_error* err` LAST. The
 * caller may pass NULL. On MOTION_OK the buffer is left untouched; on any
 * other status `message` is a NUL-terminated ASCII string (truncated to fit,
 * never unterminated). The library never allocates for it.
 */
typedef struct motion_error {
  char message[MOTION_ERROR_MESSAGE_CAP];
} motion_error;

/** The version the binary was built from — see MOTION_ABI_VERSION_PACKED. */
MOTION_API uint32_t motion_abi_version(void);

/** Stable, static, NUL-terminated name for a status ("OK", "INVALID_ARG", …).
 *  Unknown values return "UNKNOWN"; never NULL. */
MOTION_API const char* motion_status_name(motion_status status);

#ifdef __cplusplus
} /* extern "C" */
#endif

// NOLINTEND(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size)

#endif /* MOTION_ABI_H */
