# MOTION_SANITIZE → instrumentation on motion::options (compile AND link).
#
#   none        the default
#   asan-ubsan  AddressSanitizer + UndefinedBehaviorSanitizer, every report is
#               fatal (-fno-sanitize-recover=all) so CI cannot go green on a
#               logged-and-ignored finding
#   tsan        ThreadSanitizer (exclusive with ASan by construction)
#
# The presets `linux-clang-asan`, `linux-clang-tsan`, `macos-clang-asan` and
# `macos-clang-tsan` set this. clang-cl supports ASan only; the Windows job
# does not run sanitizers (the plan gates them on Linux + macOS).

set(MOTION_SANITIZE "none" CACHE STRING "none | asan-ubsan | tsan")
set_property(CACHE MOTION_SANITIZE PROPERTY STRINGS none asan-ubsan tsan)

if(MOTION_SANITIZE STREQUAL "none")
  # nothing
elseif(MOTION_SANITIZE STREQUAL "asan-ubsan")
  if(MSVC)
    message(WARNING "clang-cl supports AddressSanitizer only; UBSan is skipped on Windows.")
    target_compile_options(motion_options INTERFACE /fsanitize=address)
    target_link_options(motion_options INTERFACE /fsanitize=address)
  else()
    target_compile_options(motion_options INTERFACE
      -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
    target_link_options(motion_options INTERFACE -fsanitize=address,undefined)
  endif()
elseif(MOTION_SANITIZE STREQUAL "tsan")
  if(MSVC)
    message(FATAL_ERROR "ThreadSanitizer is not available with clang-cl; use the Linux or macOS preset.")
  endif()
  target_compile_options(motion_options INTERFACE -fsanitize=thread -fno-omit-frame-pointer)
  target_link_options(motion_options INTERFACE -fsanitize=thread)
else()
  message(FATAL_ERROR "MOTION_SANITIZE must be none, asan-ubsan or tsan (got '${MOTION_SANITIZE}')")
endif()
