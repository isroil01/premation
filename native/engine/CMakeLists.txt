# premation-engine — the engine process (docs/NATIVE_CORE_PLAN.md §5 C2).
#
#   engine_protocol   the generated engine-API codec (../protocol/generated) + the
#                     hand-written runtime (../protocol/include): wire, framing,
#                     frame channel
#   engine_core       document, history, evaluation (motion::eval), the protocol
#                     session + transport clock. No GPU, no OS calls: unit-tested,
#                     stress-tested and fuzzed on its own.
#   engine_gpu        Dawn device, compositor, render thread + frame-slot ring,
#                     shared textures (Windows)
#   premation-engine  the process: pipes, reader/writer threads, core loop
#   premation-viewport-proto   the C1 prototype (routes A, C, bench), kept so
#                     docs/VIEWPORT_ROUTE.md stays reproducible
#
# Dawn comes from the vcpkg `engine` feature (the *-engine presets). Without it
# (e.g. configuring an ASan preset with -DMOTION_BUILD_ENGINE=ON) only the
# GPU-free part is built — engine_core, its tests and the fuzzer — which is
# exactly what the sanitizer runs need.

set(PROTOCOL_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../protocol)
find_package(Dawn CONFIG QUIET)

# ── protocol ────────────────────────────────────────────────────────────────
add_library(engine_protocol STATIC ${PROTOCOL_DIR}/generated/engine_api.cpp)
target_include_directories(engine_protocol PUBLIC ${PROTOCOL_DIR}/include ${PROTOCOL_DIR}/generated)
target_compile_features(engine_protocol PUBLIC cxx_std_20)
target_link_libraries(engine_protocol PRIVATE motion::options)
if(MSVC)
  target_compile_options(engine_protocol PRIVATE /bigobj)  # ~300 structs, a 118-alternative variant
endif()

# ── core ────────────────────────────────────────────────────────────────────
set(ENGINE_CORE_SOURCES
  src/core/log.cpp
  src/core/document.cpp
  src/core/evaluate.cpp
  src/core/history.cpp
  src/core/session.cpp
)
add_library(engine_core STATIC ${ENGINE_CORE_SOURCES})
target_include_directories(engine_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/core)
target_link_libraries(engine_core PUBLIC engine_protocol motion::eval PRIVATE motion::options)
if(MSVC)
  target_compile_options(engine_core PRIVATE /bigobj)  # std::visit over the command union
endif()

# ── GPU + process ───────────────────────────────────────────────────────────
if(Dawn_FOUND)
  add_library(engine_gpu STATIC
    src/gpu.cpp
    src/os_ffi.cpp
    src/render/compositor.cpp
    src/render/render_thread.cpp
  )
  if(WIN32)
    target_sources(engine_gpu PRIVATE src/shared_texture_ffi.cpp)
    target_link_libraries(engine_gpu PUBLIC d3d11 dxgi winmm)
    target_compile_definitions(engine_gpu PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
  endif()
  target_include_directories(engine_gpu PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/render
    ${CMAKE_CURRENT_SOURCE_DIR}/shaders)
  target_link_libraries(engine_gpu PUBLIC engine_core dawn::webgpu_dawn PRIVATE motion::options)

  add_executable(premation-engine
    src/main.cpp
    src/engine_process.cpp
    src/io/pipe_ffi.cpp
    src/io/framed_writer.cpp
  )
  target_include_directories(premation-engine PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/io)
  target_link_libraries(premation-engine PRIVATE engine_gpu motion::options)

  add_executable(premation-viewport-proto proto/proto_main.cpp proto/scene.cpp proto/wire.cpp)
  target_include_directories(premation-viewport-proto PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/proto)
  target_link_libraries(premation-viewport-proto PRIVATE engine_gpu motion::options)

  if(WIN32 AND DEFINED VCPKG_INSTALLED_DIR AND DEFINED VCPKG_TARGET_TRIPLET)
    # Dawn's D3D12 backend LoadLibrary()s DXC at device creation, so vcpkg's
    # applocal step (which follows import tables) never copies it.
    set(_dxc_bin "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/bin")
    add_custom_command(TARGET premation-engine POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dxc_bin}/dxcompiler.dll" "${_dxc_bin}/dxil.dll"
              "$<TARGET_FILE_DIR:premation-engine>"
      VERBATIM)
  endif()
else()
  message(STATUS "premation-engine: Dawn not found — building engine_core, its tests and the fuzzer only")
endif()

# ── tests ───────────────────────────────────────────────────────────────────
if(MOTION_BUILD_TESTS)
  find_package(Catch2 3 CONFIG REQUIRED)
  add_executable(engine_tests
    tests/test_framing.cpp
    tests/test_session.cpp
    tests/test_stress.cpp
  )
  target_link_libraries(engine_tests PRIVATE engine_core motion::options Catch2::Catch2WithMain)
  if(MSVC)
    target_compile_options(engine_tests PRIVATE /bigobj)
    target_compile_definitions(engine_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in test setup
  endif()
  add_test(NAME engine_tests COMMAND engine_tests --reporter compact)

  if(TARGET engine_gpu)
    add_executable(engine_gpu_tests tests/test_render.cpp)
    target_link_libraries(engine_gpu_tests PRIVATE engine_gpu motion::options Catch2::Catch2WithMain)
    add_test(NAME engine_gpu_tests COMMAND engine_gpu_tests --reporter compact)
    if(WIN32 AND DEFINED _dxc_bin)
      add_custom_command(TARGET engine_gpu_tests POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dxc_bin}/dxcompiler.dll" "${_dxc_bin}/dxil.dll"
                "$<TARGET_FILE_DIR:engine_gpu_tests>"
        VERBATIM)
    endif()
  endif()
endif()

# ── libFuzzer target (Clang only) ───────────────────────────────────────────
# engine_fuzz feeds arbitrary bytes to the command-pipe framing + Session and
# to the frame-channel decoder. Everything it links is compiled with coverage
# instrumentation so libFuzzer can steer. Run:
#   engine_fuzz -max_total_time=300 -max_len=4096 <corpus dir>
option(MOTION_ENGINE_FUZZER "Build the libFuzzer protocol target when the compiler supports it" ON)
if(MOTION_ENGINE_FUZZER AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  include(CheckCXXSourceCompiles)
  if(MSVC)
    # clang-cl: CMake links with lld-link/link.exe, not the clang driver, so
    # the libFuzzer runtime is named explicitly.
    get_filename_component(_llvm_bin "${CMAKE_CXX_COMPILER}" DIRECTORY)
    file(GLOB _fuzzer_lib "${_llvm_bin}/../lib/clang/*/lib/windows/clang_rt.fuzzer-x86_64.lib")
  endif()
  if(NOT MSVC OR _fuzzer_lib)
    # motion_eval is compiled in (not linked) so everything shares one CRT:
    # the Windows libFuzzer runtime is static-CRT (/MT), the libraries are /MD.
    set(_eval_dir ${CMAKE_CURRENT_SOURCE_DIR}/../libs/motion_eval)
    add_executable(engine_fuzz tests/fuzz_protocol.cpp ${ENGINE_CORE_SOURCES} ${PROTOCOL_DIR}/generated/engine_api.cpp
                   ${_eval_dir}/eval.cpp ${_eval_dir}/motion_eval.cpp ${_eval_dir}/motion_abi.cpp)
    target_include_directories(engine_fuzz PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/core
      ${PROTOCOL_DIR}/include ${PROTOCOL_DIR}/generated
      ${CMAKE_CURRENT_SOURCE_DIR}/../include ${_eval_dir})
    target_link_libraries(engine_fuzz PRIVATE motion::options)
    if(MSVC)
      set_property(TARGET engine_fuzz PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
    endif()
    target_compile_definitions(engine_fuzz PRIVATE PREMATION_LIBFUZZER=1)
    if(MSVC)
      target_compile_options(engine_fuzz PRIVATE /bigobj -fsanitize=fuzzer)
      list(GET _fuzzer_lib 0 _fuzzer_lib0)
      target_link_libraries(engine_fuzz PRIVATE "${_fuzzer_lib0}")
    else()
      target_compile_options(engine_fuzz PRIVATE -fsanitize=fuzzer)
      target_link_options(engine_fuzz PRIVATE -fsanitize=fuzzer)
    endif()
  endif()
endif()
