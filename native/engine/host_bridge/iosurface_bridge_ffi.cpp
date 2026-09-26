// premation-host-bridge.node — the one piece of native code Electron main loads
// for the engine viewport on macOS (route C, docs/VIEWPORT_ROUTE.md).
//
// Electron's sharedTexture.importSharedTexture wants `handle: { ioSurface }`:
// a Buffer holding an IOSurfaceRef that is valid in THE CALLING PROCESS. The
// engine creates the slot surfaces (native/engine/src/shared_texture_ffi_mac.cpp)
// and announces their IOSurfaceIDs on the frame channel; this module turns an
// id into a retained, process-local reference and back:
//
//   const s = bridge.lookup(id, width, height)   // null when the id does not
//                                                // resolve or the size differs
//   s.handle   Buffer(8): the IOSurfaceRef pointer, native byte order
//   s.id       the IOSurfaceID it was looked up by
//   bridge.release(s)                            // CFRelease, exactly once;
//                                                // later calls are no-ops
//
// A surface whose JS object is collected without release() is released by the
// finalizer. Nothing else crosses: no pixels, no engine state — this is an OS
// handle shim, not engine code in the UI process (CLAUDE.md).
//
// Written against the C N-API (node_api.h, ABI-stable): one binary loads in
// any Electron / Node that has N-API 8, with no rebuild per Electron version.
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>

#include <node_api.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>

namespace {

struct Surface {
  IOSurfaceRef ref = nullptr;
  Surface() = default;
  explicit Surface(IOSurfaceRef r) : ref(r) {}
  ~Surface() { drop(); }
  Surface(const Surface&) = delete;
  Surface& operator=(const Surface&) = delete;
  Surface(Surface&&) = delete;
  Surface& operator=(Surface&&) = delete;
  void drop() noexcept {
    if (ref != nullptr) CFRelease(ref);
    ref = nullptr;
  }
};

void finalize_surface(napi_env /*env*/, void* data, void* /*hint*/) {
  // Owned by the JS object since napi_wrap; reclaimed here.
  const std::unique_ptr<Surface> owned(static_cast<Surface*>(data));
}

napi_value undefined(napi_env env) {
  napi_value v = nullptr;
  napi_get_undefined(env, &v);
  return v;
}

napi_value null_value(napi_env env) {
  napi_value v = nullptr;
  napi_get_null(env, &v);
  return v;
}

bool get_u32(napi_env env, napi_value v, std::uint32_t& out) {
  napi_valuetype t = napi_undefined;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number) return false;
  return napi_get_value_uint32(env, v, &out) == napi_ok;
}

// lookup(id: number, width?: number, height?: number): { handle: Buffer, id: number } | null
napi_value lookup(napi_env env, napi_callback_info info) {
  std::size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return null_value(env);
  std::uint32_t id = 0;
  if (argc < 1 || !get_u32(env, argv[0], id) || id == 0) {
    napi_throw_type_error(env, nullptr, "lookup(id): id must be a non-zero IOSurfaceID");
    return nullptr;
  }
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  if (argc >= 3) {
    (void)get_u32(env, argv[1], width);
    (void)get_u32(env, argv[2], height);
  }
  // IOSurfaceLookup is deprecated with kIOSurfaceIsGlobal (see shared_texture_ffi_mac.cpp).
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
  auto surface = std::make_unique<Surface>(IOSurfaceLookup(id));
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
  if (surface->ref == nullptr) return null_value(env);
  // An id is a name that can be recycled once the engine frees its surface:
  // a size mismatch means this is not the slot that was announced.
  if ((width != 0 && IOSurfaceGetWidth(surface->ref) != width) ||
      (height != 0 && IOSurfaceGetHeight(surface->ref) != height)) {
    return null_value(env);
  }

  napi_value obj = nullptr;
  if (napi_create_object(env, &obj) != napi_ok) return null_value(env);
  void* bytes = nullptr;
  napi_value handle = nullptr;
  if (napi_create_buffer(env, sizeof(IOSurfaceRef), &bytes, &handle) != napi_ok) return null_value(env);
  IOSurfaceRef raw = surface->ref;
  std::memcpy(bytes, &raw, sizeof(raw));
  napi_value idValue = nullptr;
  napi_create_uint32(env, id, &idValue);
  napi_set_named_property(env, obj, "handle", handle);
  napi_set_named_property(env, obj, "id", idValue);
  if (napi_wrap(env, obj, surface.get(), finalize_surface, nullptr, nullptr) != napi_ok) return null_value(env);
  (void)surface.release();  // the wrap's finalizer owns it now
  return obj;
}

// release(surface): drop the reference now (idempotent).
napi_value release(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) return undefined(env);
  void* data = nullptr;
  if (napi_unwrap(env, argv[0], &data) != napi_ok || data == nullptr) return undefined(env);
  static_cast<Surface*>(data)->drop();
  return undefined(env);
}

napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"lookup", nullptr, lookup, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"release", nullptr, release, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
