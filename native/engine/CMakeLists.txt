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
  src/core/history.cpp
  src/core/session.cpp
)  # the D1b document model adds its sources in its own block at the end
add_library(engine_core STATIC ${ENGINE_CORE_SOURCES})
target_include_directories(engine_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/core)
target_link_libraries(engine_core PUBLIC engine_protocol motion::eval PRIVATE motion::options)
if(MSVC)
  target_compile_options(engine_core PRIVATE /bigobj)  # std::visit over the command union
endif()

# ── render graph, GPU-free half (D2): graph ordering + resource pools ───────
add_library(engine_rg_core STATIC src/render_graph/graph.cpp)
target_include_directories(engine_rg_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/render_graph)
target_compile_features(engine_rg_core PUBLIC cxx_std_20)
target_link_libraries(engine_rg_core PRIVATE motion::options)

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

  # D2: the render graph on Dawn — FrameScene (engine-api 96_render.eapi) in,
  # pixels out; WGSL + material table extracted verbatim from packages/renderer
  # (shaders/extract.mjs → builtin_shaders.inc, materials.inc).
  add_library(engine_render_graph STATIC
    src/render_graph/device.cpp
    src/render_graph/shader_library.cpp
    src/render_graph/render_context.cpp
    src/render_graph/passes.cpp
    src/render_graph/composition_pass.cpp
    src/render_graph/effect_chain.cpp
    src/render_graph/support.cpp
    src/render_graph/threed.cpp
    src/render_graph/scene_renderer.cpp
  )
  target_include_directories(engine_render_graph PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src/render_graph
    ${CMAKE_CURRENT_SOURCE_DIR}/shaders)
  target_link_libraries(engine_render_graph PUBLIC engine_rg_core engine_protocol dawn::webgpu_dawn PRIVATE motion::options)
  if(MSVC)
    target_compile_options(engine_render_graph PRIVATE /bigobj)
  endif()

  add_executable(premation-render tools/premation_render.cpp)
  target_include_directories(premation-render PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tools)
  target_link_libraries(premation-render PRIVATE engine_render_graph motion::options)

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
    # premation-render lands in the same directory; the copy above covers it.
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
    tests/test_render_graph.cpp
  )
  target_link_libraries(engine_tests PRIVATE engine_core engine_rg_core motion::options Catch2::Catch2WithMain)
  if(MSVC)
    target_compile_options(engine_tests PRIVATE /bigobj)
    target_compile_definitions(engine_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in test setup
  endif()
  add_test(NAME engine_tests COMMAND engine_tests --reporter compact)

  if(TARGET engine_gpu)
    add_executable(engine_gpu_tests tests/test_render.cpp tests/test_render_graph_gpu.cpp)
    target_link_libraries(engine_gpu_tests PRIVATE engine_gpu engine_render_graph motion::options Catch2::Catch2WithMain)
    if(MSVC)
      target_compile_options(engine_gpu_tests PRIVATE /bigobj)
    endif()
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

# ── D3 + D2 leftovers: colour management, float intermediates, mips, overlays ─
# (render_graph/color; kept in its own block, apart from the targets above)
#   color_program   GPU-free, OCIO-free op programs + their CPU twin → engine_rg_core
#                   (so the sanitizer presets test them without Dawn)
#   color_system    OCIO programs as render-graph passes → engine_render_graph
#   ocio_ffi        the only file that includes OpenColorIO (vcpkg `engine` feature)
target_sources(engine_rg_core PRIVATE src/render_graph/color/color_program.cpp)
if(TARGET engine_render_graph)
  target_sources(engine_render_graph PRIVATE src/render_graph/color/color_system.cpp)
  find_package(OpenColorIO CONFIG QUIET)
  if(OpenColorIO_FOUND)
    target_sources(engine_render_graph PRIVATE src/render_graph/color/ocio_ffi.cpp)
    target_link_libraries(engine_render_graph PRIVATE OpenColorIO::OpenColorIO)
    target_compile_definitions(engine_render_graph PUBLIC PREMATION_HAVE_OCIO=1)
  else()
    target_compile_definitions(engine_render_graph PUBLIC PREMATION_HAVE_OCIO=0)
    message(STATUS "premation-engine: OpenColorIO not found — colour-managed frames report not-ported")
  endif()
endif()
if(MOTION_BUILD_TESTS)
  target_sources(engine_tests PRIVATE tests/test_render_graph_color.cpp)
  if(TARGET engine_gpu_tests)
    target_sources(engine_gpu_tests PRIVATE tests/test_render_graph_gpu_d3.cpp)
  endif()
endif()

# ── D1b: the document model — the second implementation of the engine API ───
# (src/core; kept in its own block, apart from the targets above)
#   model/json/anim/timeline/scene   the TS document model (scene graph, anim
#                                    stores, timelines, comps, items)
#   handlers_*                       one family of edit commands each
#   props/meta/ptree/readmodel       the property catalog + read model
#   queries/events/docio             queries, change events, save/open
#   catalog_data                     registries generated from the TS
#                                    (crossEngineCatalog.test.ts)
set(ENGINE_DOC_SOURCES
  src/core/anim.cpp
  src/core/anim_json.cpp
  src/core/catalog_data.cpp
  src/core/docexpr.cpp
  src/core/docio.cpp
  src/core/engine_ctx.cpp
  src/core/events.cpp
  src/core/fxstate.cpp
  src/core/handlers_common.cpp
  src/core/handlers_comps.cpp
  src/core/handlers_groups.cpp
  src/core/handlers_items.cpp
  src/core/handlers_layers.cpp
  src/core/handlers_layers2.cpp
  src/core/handlers_layertime.cpp
  src/core/handlers_markers.cpp
  src/core/handlers_misc.cpp
  src/core/handlers_precompose.cpp
  src/core/handlers_properties.cpp
  src/core/json.cpp
  src/core/layer_clone.cpp
  src/core/meta.cpp
  src/core/model.cpp
  src/core/parenting.cpp
  src/core/props.cpp
  src/core/ptree.cpp
  src/core/queries.cpp
  src/core/readmodel.cpp
  src/core/scene.cpp
  src/core/scene_build.cpp
  src/core/timeline.cpp
  src/core/worldxf.cpp
)
target_sources(engine_core PRIVATE ${ENGINE_DOC_SOURCES})
target_link_libraries(engine_core PUBLIC motion::expr motion::transform motion::jsmath)
# anim.cpp samples keyframes through motion_eval's C++ entry points (eval.hpp,
# the same code its C ABI wraps) — in-process, so the ABI's copies are skipped.
target_include_directories(engine_core PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../libs/motion_eval)
if(WIN32)
  # The expression interpreter and the scene/property walks recurse; a deep
  # (fuzzed or user-authored) expression needs more than the 1 MB default.
  set(_doc_stack "LINKER:/STACK:16777216")
  if(TARGET premation-engine)
    target_link_options(premation-engine PRIVATE ${_doc_stack})
  endif()
  if(TARGET engine_tests)
    target_link_options(engine_tests PRIVATE ${_doc_stack})
  endif()
endif()
if(TARGET engine_tests)
  # The replay corpus (tests/data/replay_corpus.bin, dumped by crossEngine.test.ts).
  target_compile_definitions(engine_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
endif()
if(TARGET engine_fuzz)
  # engine_fuzz compiles everything in (one static CRT, see above).
  set(_libs_dir ${CMAKE_CURRENT_SOURCE_DIR}/../libs)
  file(GLOB _doc_fuzz_expr ${_libs_dir}/motion_expr/*.cpp)
  target_sources(engine_fuzz PRIVATE ${ENGINE_DOC_SOURCES} ${_doc_fuzz_expr}
                 ${_libs_dir}/motion_jsmath/fdlibm.cpp ${_libs_dir}/motion_jsmath/numconv.cpp
                 ${_libs_dir}/motion_transform/transform.cpp ${_libs_dir}/motion_transform/motion_transform.cpp)
  target_include_directories(engine_fuzz PRIVATE ${_libs_dir}/motion_expr ${_libs_dir}/motion_jsmath
                             ${_libs_dir}/motion_transform)
  if(WIN32)
    target_link_options(engine_fuzz PRIVATE ${_doc_stack})
  endif()
  if(MSVC)
    # clang-cl + the /MT libFuzzer runtime: the trace-cmp and indirect-calls
    # coverage hooks break C++ exception dispatch (a thrown-and-caught exception
    # aborts with exit 3 — trace-cmp reproduced with a 10-line target,
    # indirect-calls on a throw through a std::function). The document core
    # reports refusals by throwing EngineFail, so keep edge coverage only.
    target_compile_options(engine_fuzz PRIVATE -fno-sanitize-coverage=trace-cmp -fno-sanitize-coverage=indirect-calls)
    target_compile_definitions(engine_fuzz PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv/fopen in the harness
  endif()
endif()
