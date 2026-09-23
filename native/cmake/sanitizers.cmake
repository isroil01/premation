# MOTION_SANITIZE → instrumentation on motion::options (compile AND link).
#
#   none        the default
#   asan-ubsan  AddressSanitizer + UndefinedBehaviorSanitizer, every report is
#               fatal (-fno-sanitize-recover=all) so CI cannot go green on a
#               logged-and-ignored finding
#   tsan        ThreadSanitizer (exclusive with ASan by construction)
#
# The presets `linux-clang-asan`, `linux-clang-tsan`, `macos-clang-asan`,
# `macos-clang-tsan` and `windows-clang-cl-asan` set this. clang-cl supports
# ASan only (no UBSan/TSan runtime for the MSVC target in this set-up).
#
# ── clang-cl (Windows) ──────────────────────────────────────────────────────
# Three things differ from the clang/gcc drivers, and each one broke the link:
#
#   1. CMake links with lld-link directly, not through the clang-cl driver, so
#      `/fsanitize=address` means nothing at link time and nothing pulls in the
#      runtime. The driver's own link line (`clang-cl -fsanitize=address -###`)
#      is reproduced instead: the DLL runtime import library, the
#      `__asan_seh_interceptor` include, and the whole dynamic-runtime thunk.
#      That is the /MD flavour, which is what the x64-windows-static-md triplet
#      and CMake's default MSVC runtime use.
#   2. vcpkg builds Catch2 (and benchmark) WITHOUT ASan. With ASan on, the MSVC
#      STL annotates std::string/std::vector and records that with
#      `#pragma detect_mismatch("annotate_string"/"annotate_vector", "1")`;
#      the uninstrumented Catch2 objects say "0", and lld-link refuses the mix.
#      `_DISABLE_STRING_ANNOTATION` / `_DISABLE_VECTOR_ANNOTATION` switch the
#      annotations off in OUR objects too, so every object agrees. The cost is
#      ASan's container-overflow check (reads past size() but inside
#      capacity()); heap/stack/global overflows, use-after-free and friends are
#      all still caught. The alternative — an ASan-built vcpkg triplet — would
#      need clang-cl as vcpkg's compiler (MSVC's own /fsanitize=address brings
#      MSVC's runtime, which cannot share a process with LLVM's).
#   3. The runtime is a DLL (clang_rt.asan_dynamic-x86_64.dll) in the clang
#      resource directory, which is not on PATH. MOTION_ASAN_RUNTIME_DIR is set
#      for the test CMakeLists to put on the tests' PATH.

set(MOTION_SANITIZE "none" CACHE STRING "none | asan-ubsan | tsan")
set_property(CACHE MOTION_SANITIZE PROPERTY STRINGS none asan-ubsan tsan)

if(MOTION_SANITIZE STREQUAL "none")
  # nothing
elseif(MOTION_SANITIZE STREQUAL "asan-ubsan")
  if(MSVC)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
      message(FATAL_ERROR "The Windows sanitizer preset is clang-cl only (CMAKE_CXX_COMPILER_ID is ${CMAKE_CXX_COMPILER_ID}).")
    endif()
    message(STATUS "clang-cl: AddressSanitizer only; UBSan is not available for the MSVC target here.")
    execute_process(
      COMMAND "${CMAKE_CXX_COMPILER}" /clang:-print-resource-dir
      OUTPUT_VARIABLE _motion_clang_resource_dir
      OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE _motion_rc)
    set(_motion_asan_dir "${_motion_clang_resource_dir}/lib/windows")
    if(NOT _motion_rc EQUAL 0 OR NOT EXISTS "${_motion_asan_dir}/clang_rt.asan_dynamic-x86_64.lib")
      message(FATAL_ERROR "ASan runtime not found under '${_motion_asan_dir}' (clang-cl /clang:-print-resource-dir). "
                          "Install the full LLVM package (winget install LLVM.LLVM).")
    endif()
    file(TO_CMAKE_PATH "${_motion_asan_dir}" MOTION_ASAN_RUNTIME_DIR)
    set(MOTION_ASAN_RUNTIME_DIR "${MOTION_ASAN_RUNTIME_DIR}" CACHE INTERNAL "Directory holding clang_rt.asan_dynamic-x86_64.dll")
    target_compile_options(motion_options INTERFACE -fsanitize=address /Oy-)
    target_compile_definitions(motion_options INTERFACE _DISABLE_STRING_ANNOTATION _DISABLE_VECTOR_ANNOTATION)
    target_link_options(motion_options INTERFACE
      "${MOTION_ASAN_RUNTIME_DIR}/clang_rt.asan_dynamic-x86_64.lib"
      "/INCLUDE:__asan_seh_interceptor"
      "/WHOLEARCHIVE:${MOTION_ASAN_RUNTIME_DIR}/clang_rt.asan_dynamic_runtime_thunk-x86_64.lib")
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
