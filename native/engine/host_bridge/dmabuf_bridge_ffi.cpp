// premation-host-bridge.node on Linux — Electron main's half of the dmabuf
// viewport route (native/engine/src/shared_texture_ffi_linux.cpp).
//
// UNVERIFIED — written without a Linux box; CI compiles it (native.yml
// `engine` on ubuntu). docs/VERIFY_ON_TEST_MACHINE.md "platform-plumbing".
//
// The engine announces the dmabuf fd numbers of its slots as they are in ITS
// process. Main is the engine's parent, so (Linux ≥ 5.6, and Yama ptrace_scope
// ≤ 1) it may duplicate them into itself:
//
//   const fd = bridge.dupFd(enginePid, remoteFd)   // a new fd in this process, or null
//   bridge.closeFd(fd)                             // close a duplicate (idempotent for -1)
//
// The duplicate goes to Electron's sharedTexture.importSharedTexture as
// `nativePixmap.planes[0].fd`; main closes it when the ring is retired. No
// pixels and no engine state cross here: an OS-handle shim, as on macOS.
#include <node_api.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cstddef>
#include <cstdint>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434  // the generic syscall table (x86_64 and aarch64 alike)
#endif
#ifndef SYS_pidfd_getfd
#define SYS_pidfd_getfd 438
#endif

namespace {

napi_value null_value(napi_env env) {
  napi_value v = nullptr;
  napi_get_null(env, &v);
  return v;
}

napi_value undefined(napi_env env) {
  napi_value v = nullptr;
  napi_get_undefined(env, &v);
  return v;
}

bool get_i32(napi_env env, napi_value v, std::int32_t& out) {
  napi_valuetype t = napi_undefined;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number) return false;
  return napi_get_value_int32(env, v, &out) == napi_ok;
}

// dupFd(pid: number, fd: number): number | null
napi_value dup_fd(napi_env env, napi_callback_info info) {
  std::size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return null_value(env);
  std::int32_t pid = 0;
  std::int32_t remote = -1;
  if (argc < 2 || !get_i32(env, argv[0], pid) || !get_i32(env, argv[1], remote) || pid <= 0 || remote < 0) {
    napi_throw_type_error(env, nullptr, "dupFd(pid, fd): a process id and a descriptor number");
    return nullptr;
  }
  const long pidfd = syscall(SYS_pidfd_open, static_cast<long>(pid), 0L);
  if (pidfd < 0) return null_value(env);
  const long local = syscall(SYS_pidfd_getfd, pidfd, static_cast<long>(remote), 0L);
  (void)close(static_cast<int>(pidfd));
  if (local < 0) return null_value(env);
  napi_value out = nullptr;
  napi_create_int32(env, static_cast<std::int32_t>(local), &out);
  return out;
}

// closeFd(fd: number): void
napi_value close_fd(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) return undefined(env);
  std::int32_t fd = -1;
  if (get_i32(env, argv[0], fd) && fd >= 0) (void)close(fd);
  return undefined(env);
}

napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"dupFd", nullptr, dup_fd, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"closeFd", nullptr, close_fd, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
