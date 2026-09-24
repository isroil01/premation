/*
 * Premation native plugin SDK — basic types, versioning, error codes.
 *
 * The SDK is a C ABI (C99 headers, usable from C and C++). Nothing crosses it
 * but plain structs, integers, doubles and pointers the host owns; no C++
 * exceptions, no STL types, no allocator mismatch (memory the plugin must hand
 * back is a host HANDLE, see pr_host.h). docs/PLUGIN_SDK.md is the guide.
 *
 * Versioning (docs/PLUGIN_SDK.md "Versioning"):
 *   PR_SDK_VERSION_MAJOR  bumped on any breaking change; a host loads only
 *                         plugins built against its own major.
 *   PR_SDK_VERSION_MINOR  bumped when something is ADDED: new selectors, new
 *                         param types, new host callbacks (appended to the end
 *                         of PrHostSuite), new trailing struct fields. Every
 *                         struct starts with `struct_size`; a field past the
 *                         size the other side reported does not exist.
 *   Values of every enum below are forever; a removed value is never reused.
 */
#ifndef PREMATION_SDK_PR_TYPES_H
#define PREMATION_SDK_PR_TYPES_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PR_SDK_VERSION_MAJOR 1
#define PR_SDK_VERSION_MINOR 0
/** (major << 16) | minor — what PrInData.host_sdk_version and PrPluginInfo.sdk_version carry. */
#define PR_SDK_VERSION ((uint32_t)((PR_SDK_VERSION_MAJOR << 16) | PR_SDK_VERSION_MINOR))
#define PR_SDK_VERSION_MAJOR_OF(v) ((uint32_t)(v) >> 16)
#define PR_SDK_VERSION_MINOR_OF(v) ((uint32_t)(v)&0xFFFFu)

/** A plugin's own version: PR_VERSION(1, 2, 3). */
#define PR_VERSION(major, minor, patch) ((uint32_t)(((major)&0xFFu) << 24 | ((minor)&0xFFu) << 16 | ((patch)&0xFFFFu)))

#if defined(_WIN32)
#define PR_EXPORT __declspec(dllexport)
#define PR_CALL __cdecl
#else
#define PR_EXPORT __attribute__((visibility("default")))
#define PR_CALL
#endif

/* ── errors ────────────────────────────────────────────────────────────────
 * Every selector and every host callback returns a PrErr. A plugin that fails
 * returns non-zero and may put a NUL-terminated explanation in
 * PrOutData.return_msg; the host records it on the layer (layerErrors) and
 * renders the layer as if the effect were off. */
typedef int32_t PrErr;
#define PR_ERR_NONE 0
#define PR_ERR_OUT_OF_MEMORY 1
#define PR_ERR_INTERNAL 2          /* the plugin (or host) hit a bug */
#define PR_ERR_INVALID_PARAM 3     /* a bad argument / parameter value */
#define PR_ERR_INVALID_CALLBACK 4  /* a host callback used outside its selector */
#define PR_ERR_UNSUPPORTED 5       /* the selector / world depth / feature is not implemented */
#define PR_ERR_INTERRUPTED 6       /* abort_requested() said stop; not an error to report */
#define PR_ERR_BAD_VERSION 7       /* incompatible SDK version */
#define PR_ERR_NOT_FOUND 8         /* a checkout / handle that does not exist */

/** Size of PrOutData.return_msg (bytes, including the terminating NUL). */
#define PR_MAX_MESSAGE 512

/** Opaque host memory block (pr_host.h handle_*). 0 = none. */
typedef uint64_t PrHandle;

/** Opaque per-call host context: pass it back to every PrHostSuite callback. */
typedef struct PrHost PrHost;

/** Time: every time is an integer count of PR_TIME_SCALE ticks per second (flicks:
 *  exact for every standard and NTSC frame rate — the engine API's own unit). */
#define PR_TIME_SCALE 705600000u

typedef struct PrRect {
  int32_t left, top, right, bottom; /* half-open: [left, right) × [top, bottom) */
} PrRect;

typedef struct PrPoint2 {
  double x, y;
} PrPoint2;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_TYPES_H */
