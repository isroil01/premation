/*
 * Premation native plugin ABI — version 1.
 *
 * ── What this file is ────────────────────────────────────────────────────────
 *
 * The contract between the editor and a COMPILED plugin. A native plugin is an
 * N-API addon (node-addon-api, or a Rust/C++ cdylib behind an N-API shim) that
 * the editor loads into a separate process and calls for the work a script
 * cannot do fast enough: decoders, trackers, solvers, big pixel kernels.
 *
 * It is deliberately five symbols. After Effects' SDK is a single entry point
 * dispatching on a command selector, OFX's is two; both have survived twenty
 * years of hosts because the surface a binary has to get right is tiny and
 * everything else travels as DATA. The same choice is made here: everything
 * interesting is in the request and response objects, which can grow without
 * changing a single signature.
 *
 * ── The process model, stated up front ───────────────────────────────────────
 *
 * The addon does NOT run in the editor. It runs in an Electron
 * `utilityProcess` of its own, one per plugin, started on first use and stopped
 * when idle. What follows from that, and what an author should design around:
 *
 *   • Crashing kills your process, not the editor. The frame still renders,
 *     with your effect skipped, and the host restarts you with backoff.
 *   • Blocking is fine and expected. `motion_plugin_render` is SYNCHRONOUS:
 *     take the whole core, take the whole call. The host holds a hard timeout
 *     and kills the process if you exceed it, so do not sit on a mutex waiting
 *     for something that may not arrive.
 *   • There is no editor API in your process. No document, no scene graph, no
 *     GPU device. You are a function over the bytes you are handed.
 *   • Threads inside your process are yours. Declare `threadSafety` so the host
 *     knows whether it may have two calls in flight at once.
 *
 * ── Versioning ───────────────────────────────────────────────────────────────
 *
 * MAJOR changes break compiled addons; the host refuses a mismatch by number,
 * naming both versions, rather than calling a function whose stack frame it
 * does not agree about. MINOR adds fields; a host accepts an addon built
 * against its own MINOR or an older one, and refuses a NEWER one — an addon
 * built for minor 3 expects request fields a minor-0 host does not send, and
 * the honest answer is "update the app", not a struct full of zeroes.
 *
 * ── Where the other half lives ───────────────────────────────────────────────
 *
 *   src/abi.ts                    the same contract as TypeScript types
 *   example/                      a working addon and its two build files
 *   README.md                     how to build one, per platform
 *   docs/PLUGINS.md § Native tier the manifest block and the trust gate
 *
 * These numbers are mirrored, not shared, in three places the build cannot make
 * import one another: here, `src/abi.ts`, `src/core/plugins/native/nativeAbi.ts`
 * (renderer) and `electron/pluginNativeAbi.ts` (main). `nativeAbiPinned.test.ts`
 * fails if any of them drifts.
 */

#ifndef MOTION_PLUGIN_ABI_H
#define MOTION_PLUGIN_ABI_H

#ifdef __cplusplus
extern "C" {
#endif

/** Breaking version. A host that speaks a different MAJOR refuses to load. */
#define MOTION_PLUGIN_ABI_MAJOR 1

/** Additive version. A host refuses an addon whose MINOR is newer than its own. */
#define MOTION_PLUGIN_ABI_MINOR 0

/**
 * The single number `motion_plugin_abi_version` returns.
 *
 * Packed as `major * 1000 + minor` so it is one integer to return, to log and
 * to compare, and so a human reading `1000` in a crash report can see both
 * halves without a table. 1000 minors per major is more than this contract will
 * ever use.
 */
#define MOTION_PLUGIN_ABI_VERSION ((MOTION_PLUGIN_ABI_MAJOR) * 1000 + (MOTION_PLUGIN_ABI_MINOR))

#define MOTION_PLUGIN_ABI_MAJOR_OF(v) ((v) / 1000)
#define MOTION_PLUGIN_ABI_MINOR_OF(v) ((v) % 1000)

/*
 * ── The five exports ─────────────────────────────────────────────────────────
 *
 * Every one is a property on the module object N-API's `Init` populates, and
 * every one is a JavaScript function as far as the host is concerned. The names
 * are C identifiers because that is what they are in the source of every addon
 * that will implement them; they are exported under exactly these strings.
 *
 *   uint32 motion_plugin_abi_version(void)
 *
 *     Called FIRST, before anything else, and the only call made to an addon
 *     whose version has not been checked. Return MOTION_PLUGIN_ABI_VERSION.
 *     It must not allocate, must not read files and must not throw: a plugin
 *     that fails here fails while the host is still deciding whether it speaks
 *     the language.
 *
 *   object motion_plugin_register(object host)
 *
 *     Called once per process, after the version check. `host` carries
 *     `{ abi, app, appVersion, pluginId, pluginVersion, pluginDir }` —
 *     `pluginDir` is the absolute directory the package was loaded from, which
 *     is where models, LUTs and other payload live. Return `{ ok: true }`, or
 *     `{ ok: false, error: "..." }` to refuse the load with a message the user
 *     is shown. This is the AE `GLOBAL_SETUP` moment: read what is immutable,
 *     allocate what is shared, and write the only globals you will ever write.
 *
 *   object motion_plugin_describe(void)
 *
 *     What this addon implements. See `MotionNativeDescribe` in `src/abi.ts`
 *     for the fields; the ones that decide behaviour are `calls` (which of
 *     effect/generate/invoke you answer), `pixelFormat` (what you want pixels
 *     in) and `threadSafety` (whether the host may have two calls in flight).
 *     Must be cheap and must not depend on a frame — the host calls it once and
 *     caches it for the life of the process.
 *
 *   object motion_plugin_render(object request)
 *
 *     The work. `request.call` is "effect", "generate" or "invoke"; the rest of
 *     the object depends on which (see `MotionNativeRequest`). Synchronous.
 *     Return `{ ok: true, ... }` or `{ ok: false, error: "..." }` — a refusal is
 *     reported against your plugin by name and the frame goes out with the
 *     layer unchanged. THROWING is also handled, and is worse: it costs a
 *     stringification and tells the user less.
 *
 *     Pixel buffers arrive as typed arrays whose memory the host TRANSFERRED to
 *     this process; they are yours until you answer. Write your result into the
 *     `output` buffer you were handed and return it, or return `identity: true`
 *     to say you changed nothing, which lets the host skip the copy back.
 *
 *     SEQUENCE DATA. `request.state` is whatever you returned as `state` from
 *     this instance's previous frame, and it is AE's sequence data by another
 *     name: the place to keep the thing that was expensive to work out and did
 *     not change — a decoded LUT, a BVH, a flow field, a noise model. Omit
 *     `state` from your answer to keep what the host holds; return `null` to
 *     clear it. It is absent on the first frame, after a param your manifest
 *     named in `invalidateOn` changes, and after anything that restarts this
 *     process, so an addon that cannot rebuild from nothing will fail on
 *     somebody's second frame. It is a CACHE: it is never saved with the
 *     document, and the host may drop it at any moment.
 *
 *   void motion_plugin_dispose(void)
 *
 *     Called before the process exits normally — an idle timeout, a reload, a
 *     revocation. Free what you allocated in register. It is NOT called when
 *     the process is killed for hanging or crashing, so nothing whose absence
 *     would corrupt the user's disk may depend on it running.
 */

/** Convenience: the five names, so a shim can register them from one table. */
#define MOTION_PLUGIN_EXPORT_ABI_VERSION "motion_plugin_abi_version"
#define MOTION_PLUGIN_EXPORT_REGISTER    "motion_plugin_register"
#define MOTION_PLUGIN_EXPORT_DESCRIBE    "motion_plugin_describe"
#define MOTION_PLUGIN_EXPORT_RENDER      "motion_plugin_render"
#define MOTION_PLUGIN_EXPORT_DISPOSE     "motion_plugin_dispose"

/** `request.call` values. Strings on the wire; constants here to avoid typos. */
#define MOTION_PLUGIN_CALL_EFFECT   "effect"
#define MOTION_PLUGIN_CALL_GENERATE "generate"
#define MOTION_PLUGIN_CALL_INVOKE   "invoke"

/**
 * Pixel layouts an effect may ask for in `describe().pixelFormat`.
 *
 * `f32-premul` is the default and the one to prefer: 32-bit float premultiplied
 * RGBA is what the editor's GPU path and its CPU kernels both work in, so a
 * native fast path and its WGSL or JavaScript twin are the same arithmetic and
 * can be diffed pixel for pixel. The 8-bit layouts exist for addons wrapping a
 * library that only speaks bytes; the conversion happens in the plugin's own
 * process either way, so it costs the host nothing to offer them.
 */
#define MOTION_PLUGIN_PIXELS_F32_PREMUL    "f32-premul"
#define MOTION_PLUGIN_PIXELS_RGBA8_PREMUL  "rgba8-premul"
#define MOTION_PLUGIN_PIXELS_RGBA8_STRAIGHT "rgba8-straight"

/** `describe().threadSafety` — the same three words the JS tiers declare. */
#define MOTION_PLUGIN_THREAD_UNSAFE   "unsafe"
#define MOTION_PLUGIN_THREAD_INSTANCE "instance"
#define MOTION_PLUGIN_THREAD_FULL     "full"

#ifdef __cplusplus
}
#endif

#endif /* MOTION_PLUGIN_ABI_H */
