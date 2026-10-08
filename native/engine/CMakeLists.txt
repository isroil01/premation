# premation-engine — the engine process (docs/NATIVE_CORE_PLAN.md §5 C2).
#
#   engine_protocol   the generated engine-API codec (../protocol/generated) + the
#                     hand-written runtime (../protocol/include): wire, framing,
#                     frame channel
#   engine_core       document, history, evaluation (motion::eval), the protocol
#                     session + transport clock. No GPU, no OS calls: unit-tested,
#                     stress-tested and fuzzed on its own.
#   engine_gpu        Dawn device, compositor, render thread + frame-slot ring,
#                     shared textures (Windows NT handles, macOS IOSurfaces)
#   premation-host-bridge  (macOS) the N-API module Electron main loads to turn an
#                     announced IOSurfaceID into its own IOSurfaceRef (host_bridge/)
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
  src/core/session_jobs.cpp
  src/jobs/job_runner.cpp
  src/jobs/job_inputs.cpp
)  # the D1b document model adds its sources in its own block at the end
add_library(engine_core STATIC ${ENGINE_CORE_SOURCES})
target_include_directories(engine_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/core)
# Threads: the job runner's workers (src/jobs/job_runner.cpp).
find_package(Threads REQUIRED)
target_link_libraries(engine_core PUBLIC engine_protocol motion::eval Threads::Threads PRIVATE motion::options)
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
  # The renderer WGSL + material table (shaders/wgsl/*.wgsl, shaders/materials.json)
  # as C++: builtin_shaders.inc, materials.inc, renderer_wgsl.hpp.
  include(${CMAKE_CURRENT_SOURCE_DIR}/shaders/embed_wgsl.cmake)
  set(ENGINE_WGSL_GENERATED ${CMAKE_CURRENT_BINARY_DIR}/generated/shaders)
  premation_embed_wgsl(${ENGINE_WGSL_GENERATED})

  add_library(engine_gpu STATIC
    src/gpu.cpp
    src/os_ffi.cpp
    src/render/compositor.cpp
    src/render/frame_cache.cpp
    src/render/render_thread.cpp
    src/render/vram_ffi.cpp
  )
  # Route C's shared-texture ring, one implementation per OS (shared_texture_ffi.hpp).
  if(WIN32)
    target_sources(engine_gpu PRIVATE src/shared_texture_ffi.cpp)
    target_link_libraries(engine_gpu PUBLIC d3d11 dxgi winmm)
    target_compile_definitions(engine_gpu PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE PREMATION_SHARED_TEXTURE=1)
  elseif(APPLE)
    target_sources(engine_gpu PRIVATE src/shared_texture_ffi_mac.cpp)
    target_link_libraries(engine_gpu PUBLIC "-framework IOSurface" "-framework CoreFoundation")
    target_compile_definitions(engine_gpu PUBLIC PREMATION_SHARED_TEXTURE=1)
  else()
    # Linux: dmabuf slots need GBM (libgbm-dev); without it frames take the
    # route-A copy. UNVERIFIED on a Linux GPU box (docs/VERIFY_ON_TEST_MACHINE.md).
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
      pkg_check_modules(GBM IMPORTED_TARGET gbm)
    endif()
    if(GBM_FOUND)
      target_sources(engine_gpu PRIVATE src/shared_texture_ffi_linux.cpp)
      target_link_libraries(engine_gpu PUBLIC PkgConfig::GBM)
      target_compile_definitions(engine_gpu PUBLIC PREMATION_SHARED_TEXTURE=1 PREMATION_DMABUF=1)
    else()
      message(STATUS "premation-engine: GBM not found — the Linux viewport uses the route-A frame copy")
    endif()
  endif()
  target_include_directories(engine_gpu PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/render
    ${CMAKE_CURRENT_SOURCE_DIR}/shaders
    ${ENGINE_WGSL_GENERATED})
  target_link_libraries(engine_gpu PUBLIC engine_core dawn::webgpu_dawn PRIVATE motion::options)

  # D2: the render graph on Dawn — FrameScene (engine-api 96_render.eapi) in,
  # pixels out; WGSL + material table from shaders/wgsl + shaders/materials.json
  # (embedded above → builtin_shaders.inc, materials.inc).
  add_library(engine_render_graph STATIC
    src/render_graph/device.cpp
    src/render_graph/shader_library.cpp
    src/render_graph/render_context.cpp
    src/render_graph/passes.cpp
    src/render_graph/composition_pass.cpp
    src/render_graph/effect_chain.cpp
    src/render_graph/fx_distance.cpp
    src/render_graph/support.cpp
    src/render_graph/threed.cpp
    src/render_graph/scene_renderer.cpp
  )
  target_include_directories(engine_render_graph PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src/render_graph
    ${CMAKE_CURRENT_SOURCE_DIR}/shaders
    ${ENGINE_WGSL_GENERATED})
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
    src/cli_prepare.cpp
    src/io/pipe_ffi.cpp
    src/io/framed_writer.cpp
  )
  target_include_directories(premation-engine PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/io)
  # `--prepare` (cli_prepare.cpp): the CLI's document edits (reframe, transcribe, comps) in the engine.
  target_compile_definitions(premation-engine PRIVATE PREMATION_HAVE_PREPARE=1)
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
  message(STATUS "premation-engine: Dawn not found — building engine_core, its tests, the fuzzer and premation-engine-headless only")
endif()

# premation-engine-headless: the engine process without Dawn — the same pipes,
# core loop and Session, frames always simulated (as --no-gpu). For the
# cross-engine replay (crossEngine.test.ts, PREMATION_ENGINE_PATH=<it>) on
# machines and CI jobs without the vcpkg `engine` feature. Never shipped.
add_executable(premation-engine-headless
  src/main.cpp
  src/engine_process.cpp
  src/cli_prepare.cpp  # `--prepare` too, so the CLI's replay / template / caption tests run without Dawn
  src/os_ffi.cpp
  src/io/pipe_ffi.cpp
  src/io/framed_writer.cpp
)
target_include_directories(premation-engine-headless PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/io)
target_compile_definitions(premation-engine-headless PRIVATE PREMATION_ENGINE_HEADLESS=1 PREMATION_HAVE_PREPARE=1)
target_link_libraries(premation-engine-headless PRIVATE engine_core engine_plugins motion::options)
if(WIN32)
  target_link_libraries(premation-engine-headless PRIVATE winmm)
  target_compile_definitions(premation-engine-headless PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
endif()

# ── premation-host-bridge (macOS): IOSurfaceID → IOSurfaceRef in Electron main ─
# Route C on macOS: Electron's sharedTexture takes an IOSurfaceRef local to
# main, so main resolves the ids the engine announces (host_bridge/). No Dawn,
# so it builds with the headless configuration too. Written against the C
# N-API: the headers of any Node ≥ 16 work, and the module is not tied to one
# Electron version. Lands beside premation-engine; electron-builder ships both.
#
# Linux: the same module name from host_bridge/dmabuf_bridge_ffi.cpp — main
# duplicates the engine's dmabuf fds with pidfd_getfd (UNVERIFIED; the route-A
# copy is used when it is missing).
if(NOT WIN32)
  option(PREMATION_HOST_BRIDGE "Build premation-host-bridge.node (macOS / Linux engine viewport)" ON)
endif()
if(NOT WIN32 AND PREMATION_HOST_BRIDGE)
  if(NOT NODE_API_INCLUDE_DIR)
    find_program(PREMATION_NODE_EXECUTABLE node)
    if(PREMATION_NODE_EXECUTABLE)
      get_filename_component(_node_bin "${PREMATION_NODE_EXECUTABLE}" REALPATH)
      get_filename_component(_node_bin "${_node_bin}" DIRECTORY)
      set(_node_hint "${_node_bin}/../include/node")
    endif()
    find_path(NODE_API_INCLUDE_DIR node_api.h HINTS ${_node_hint} "${CMAKE_SOURCE_DIR}/../node_modules/node-api-headers/include")
  endif()
  if(NODE_API_INCLUDE_DIR)
    if(APPLE)
      add_library(premation-host-bridge MODULE host_bridge/iosurface_bridge_ffi.cpp)
    else()
      add_library(premation-host-bridge MODULE host_bridge/dmabuf_bridge_ffi.cpp)
    endif()
    set_target_properties(premation-host-bridge PROPERTIES PREFIX "" SUFFIX ".node"
      LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
    target_include_directories(premation-host-bridge SYSTEM PRIVATE "${NODE_API_INCLUDE_DIR}")
    target_compile_definitions(premation-host-bridge PRIVATE NAPI_VERSION=8 NODE_GYP_MODULE_NAME=premation_host_bridge)
    target_link_libraries(premation-host-bridge PRIVATE motion::options)
    if(APPLE)
      target_link_libraries(premation-host-bridge PRIVATE "-framework IOSurface" "-framework CoreFoundation")
      # N-API symbols come from the loading process (Electron / node).
      target_link_options(premation-host-bridge PRIVATE -undefined dynamic_lookup)
    endif()
    # Linux: a MODULE may leave the N-API symbols undefined; the loader binds them.
  else()
    message(WARNING "premation-host-bridge: node_api.h not found (set NODE_API_INCLUDE_DIR) — "
                    "the engine viewport falls back to the route-A frame copy")
  endif()
endif()

# ── tests ───────────────────────────────────────────────────────────────────
if(MOTION_BUILD_TESTS)
  find_package(Catch2 3 CONFIG REQUIRED)
  add_executable(engine_tests
    tests/test_aep_import.cpp
    tests/test_bundle_io.cpp
    tests/test_collect_files.cpp
    tests/test_convert_layer.cpp
    tests/test_framing.cpp
    tests/test_session.cpp
    tests/test_b4_round2.cpp
    tests/test_b4_round3.cpp
    tests/test_b4_round5_text.cpp
    tests/test_b4_round5_rig.cpp
    tests/test_b4_round5_view.cpp
    tests/test_b4_round5_items.cpp
    tests/test_jobs.cpp
    tests/test_paint_strokes.cpp
    tests/test_paths.cpp
    tests/test_proxy_ownership.cpp
    tests/test_expression_controls.cpp
    tests/test_migrations.cpp
    tests/test_stress.cpp
    tests/test_render_graph.cpp
  )
  # engine_scene_core: the rig overlay (B4 round 5, tests/test_b4_round5_rig.cpp) — the tests link it, engine_core does not.
  target_link_libraries(engine_tests PRIVATE engine_core engine_rg_core engine_scene_core motion::options Catch2::Catch2WithMain)
  if(MSVC)
    target_compile_options(engine_tests PRIVATE /bigobj)
    target_compile_definitions(engine_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in test setup
  endif()
  add_test(NAME engine_tests COMMAND engine_tests --reporter compact)

  if(TARGET engine_gpu)
    add_executable(engine_gpu_tests tests/test_render.cpp tests/test_render_graph_gpu.cpp tests/test_frame_cache.cpp)
    target_link_libraries(engine_gpu_tests PRIVATE engine_gpu engine_render_graph motion::options Catch2::Catch2WithMain)
    if(MSVC)
      target_compile_options(engine_gpu_tests PRIVATE /bigobj)
    endif()
    add_test(NAME engine_gpu_tests COMMAND engine_gpu_tests --reporter compact)
    if(APPLE)
      target_sources(engine_gpu_tests PRIVATE tests/test_shared_texture_mac.cpp)
      target_link_libraries(engine_gpu_tests PRIVATE "-framework IOSurface" "-framework CoreFoundation")
    endif()
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
  include(CMakePushCheckState)
  set(_have_fuzzer OFF)
  if(MSVC)
    # clang-cl: CMake links with lld-link/link.exe, not the clang driver, so
    # the libFuzzer runtime is named explicitly.
    get_filename_component(_llvm_bin "${CMAKE_CXX_COMPILER}" DIRECTORY)
    file(GLOB _fuzzer_lib "${_llvm_bin}/../lib/clang/*/lib/windows/clang_rt.fuzzer-x86_64.lib")
    if(_fuzzer_lib)
      set(_have_fuzzer ON)
    endif()
  else()
    # Apple's clang ships no libFuzzer runtime (Homebrew / upstream LLVM do):
    # -fsanitize=fuzzer compiles but does not link. Probe a whole link.
    cmake_push_check_state(RESET)
    set(CMAKE_REQUIRED_FLAGS "-fsanitize=fuzzer")
    set(CMAKE_REQUIRED_LINK_OPTIONS "-fsanitize=fuzzer")
    set(CMAKE_REQUIRED_QUIET ON)
    check_cxx_source_compiles([=[
#include <cstddef>
#include <cstdint>
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t*, std::size_t) { return 0; }
]=] PREMATION_HAVE_LIBFUZZER)
    cmake_pop_check_state()
    if(PREMATION_HAVE_LIBFUZZER)
      set(_have_fuzzer ON)
    endif()
  endif()
  if(NOT _have_fuzzer)
    message(STATUS "premation-engine: ${CMAKE_CXX_COMPILER} has no libFuzzer runtime — engine_fuzz is not built")
  endif()
  if(_have_fuzzer)
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
target_sources(engine_rg_core PRIVATE src/render_graph/color/color_program.cpp src/render_graph/color/aces_ops.cpp)
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
#   catalog_data                     the property/effect catalog: catalog/*.json
#                                    (+ the schema's commands.json), embedded by
#                                    catalog/embed_catalog.cmake
include(${CMAKE_CURRENT_SOURCE_DIR}/catalog/embed_catalog.cmake)
set(ENGINE_CATALOG_GENERATED ${CMAKE_CURRENT_BINARY_DIR}/generated/catalog)
premation_embed_catalog(${ENGINE_CATALOG_GENERATED})
# A source property, so every target compiling catalog_data.cpp (engine_core,
# engine_fuzz) finds catalog_data.inc.
set_source_files_properties(src/core/catalog_data.cpp PROPERTIES INCLUDE_DIRECTORIES ${ENGINE_CATALOG_GENERATED})
set(ENGINE_DOC_SOURCES
  # After Effects .aep/.aepx import (importProject): pure byte parsing + the plan applier
  src/core/aep/aep_apply.cpp
  src/core/aep/aep_ease.cpp
  src/core/aep/aep_effects.cpp
  src/core/aep/aep_plan.cpp
  src/core/aep/aep_properties.cpp
  src/core/aep/aep_read.cpp
  src/core/aep/aep_text.cpp
  src/core/aep/aepx.cpp
  src/core/aep/cos.cpp
  src/core/aep/riff.cpp
  src/core/anim.cpp
  src/core/anim_json.cpp
  src/core/bundle_io.cpp
  src/core/catalog_data.cpp
  src/core/collect_files.cpp
  src/core/deflate_ffi.cpp
  src/core/docexpr.cpp
  src/core/docio.cpp
  src/core/engine_ctx.cpp
  src/core/events.cpp
  src/core/fields.cpp
  src/core/rig.cpp
  src/core/controls.cpp
  src/core/fxstate.cpp
  src/core/handlers_common.cpp
  src/core/handlers_comps.cpp
  src/core/handlers_dynamics.cpp
  src/core/handlers_groups.cpp
  src/core/handlers_items.cpp
  src/core/handlers_layers.cpp
  src/core/handlers_layers2.cpp
  src/core/handlers_convert.cpp
  src/core/handlers_layertime.cpp
  src/core/handlers_markers.cpp
  src/core/handlers_misc.cpp
  src/core/handlers_native.cpp
  src/core/handlers_optional.cpp
  src/core/handlers_precompose.cpp
  src/core/handlers_properties.cpp
  src/core/handlers_strokes.cpp
  src/core/handlers_paths.cpp
  src/core/layer_clone.cpp
  src/core/layer_geometry.cpp
  src/core/meta.cpp
  src/core/model.cpp
  src/core/native_effects.cpp
  src/core/overlay_geometry.cpp
  src/core/overlay_rig_pack.cpp
  src/core/parenting.cpp
  src/core/particle_props.cpp
  src/core/plugin_props.cpp
  src/core/presets_capture.cpp
  src/core/props.cpp
  src/core/ptree.cpp
  src/core/queries.cpp
  src/core/item_facts.cpp
  src/core/readmodel.cpp
  src/core/scene.cpp
  src/core/scene_build.cpp
  src/core/strokes.cpp
  src/core/timeline.cpp
  src/core/worldxf.cpp
)
# The JavaScript value type (src/core/json.hpp) on its own, a leaf: the test
# fixtures' re-bless mode (tests/parity_rebless.hpp) reads and writes JSON in
# test targets that do not link the document core.
add_library(engine_json STATIC src/core/json.cpp)
target_compile_features(engine_json PUBLIC cxx_std_20)
target_link_libraries(engine_json PUBLIC motion::jsmath PRIVATE motion::options)

target_sources(engine_core PRIVATE ${ENGINE_DOC_SOURCES})
target_link_libraries(engine_core PUBLIC engine_json)
target_link_libraries(engine_core PUBLIC motion::expr motion::transform motion::jsmath)
# B4 round 5: grapheme clusters (raster/text_unicode.cpp) — `text/styleRuns` reads
# migrate legacy code-point runs as richText.ts readRuns does (fields.cpp).
target_link_libraries(engine_core PRIVATE engine_raster_core)
# zlib: CRC-32 + DEFLATE for portable zips (core/deflate_ffi.cpp) and the export
# writers' PNG / zip entries — the one zlib binding, shared.
find_package(ZLIB REQUIRED)
target_link_libraries(engine_core PUBLIC ZLIB::ZLIB)
# ── G1: the native plugin SDK host (src/plugins, GPU-free half) ────────────
#   engine_plugins   manifest scan, module load (module_ffi), per-call crash
#                    guard (guard_ffi), the quarantine journal (journal_ffi), the
#                    worker pool for iterate callbacks, pixel-world conversion,
#                    and the effect-param wire — registered into the document
#                    through native_effects (engine_core). The public C ABI is
#                    ../sdk/include/premation_sdk; the samples are ../sdk/samples.
#                    Not yet called by premation-engine (G1 in progress).
find_package(Threads REQUIRED)
add_library(engine_plugins STATIC
  src/plugins/host.cpp
  src/plugins/manifest.cpp
  src/plugins/workers.cpp
  src/plugins/world_convert.cpp
  src/plugins/fx_wire.cpp
  src/plugins/module_ffi.cpp
  src/plugins/guard_ffi.cpp
  src/plugins/journal_ffi.cpp
  src/plugins/cpu_render.cpp
  src/plugins/entitlement.cpp  # Premation Cloud: the operator-signed token checked before a bundle loads
)
target_include_directories(engine_plugins PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/plugins ${CMAKE_CURRENT_SOURCE_DIR}/../sdk/include)
target_link_libraries(engine_plugins PUBLIC engine_core Threads::Threads PRIVATE ${CMAKE_DL_LIBS} motion::options)
if(MSVC)
  target_compile_options(engine_plugins PRIVATE /bigobj)
endif()

# listFonts answers from the installed-font catalogue (engine_process.cpp → font_catalog.hpp).
target_link_libraries(premation-engine-headless PRIVATE engine_raster_core)
if(TARGET premation-engine)
  target_link_libraries(premation-engine PRIVATE engine_raster_core)
endif()

# The engine process starts the host (--plugins / PREMATION_PLUGIN_PATH, engine_process.cpp).
if(TARGET premation-engine)
  target_link_libraries(premation-engine PRIVATE engine_plugins)
endif()
# engine_plugins_gpu: the render glue — the render graph's NativeEffectHost
# (read back / CPU render / upload, and SMART_RENDER_GPU on the engine's device).
if(TARGET engine_render_graph)
  add_library(engine_plugins_gpu STATIC src/plugins/render_glue.cpp)
  target_link_libraries(engine_plugins_gpu PUBLIC engine_plugins engine_render_graph dawn::webgpu_dawn PRIVATE motion::options)
  if(MSVC)
    target_compile_options(engine_plugins_gpu PRIVATE /bigobj)
  endif()
  # premation-render --plugins: native-plugin chain entries through the glue.
  target_link_libraries(premation-render PRIVATE engine_plugins_gpu)
  if(MOTION_BUILD_TESTS AND TARGET grade)
    # G1 on a real GPU: the grade sample's SMART_RENDER_GPU against its CPU twin
    # at 8/16/32 bpc through the render graph, GPU faults contained, and a
    # native-plugin FrameScene through premation-render (skipped without an adapter).
    add_executable(engine_plugins_gpu_tests tests/test_plugin_gpu.cpp)
    target_link_libraries(engine_plugins_gpu_tests PRIVATE engine_plugins_gpu motion::options Catch2::Catch2WithMain)
    target_include_directories(engine_plugins_gpu_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
    target_compile_definitions(engine_plugins_gpu_tests PRIVATE
      PREMATION_PLUGIN_BUNDLES="${PREMATION_PLUGIN_BUNDLES}"
      PREMATION_RENDER_TOOL="$<TARGET_FILE:premation-render>")
    add_dependencies(engine_plugins_gpu_tests premation-render grade checkout)
    if(MSVC)
      target_compile_options(engine_plugins_gpu_tests PRIVATE /bigobj)
      target_compile_definitions(engine_plugins_gpu_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
    endif()
    add_test(NAME engine_plugins_gpu_tests COMMAND engine_plugins_gpu_tests --reporter compact)
    if(WIN32 AND DEFINED _dxc_bin)
      add_custom_command(TARGET engine_plugins_gpu_tests POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dxc_bin}/dxcompiler.dll" "${_dxc_bin}/dxil.dll"
                "$<TARGET_FILE_DIR:engine_plugins_gpu_tests>"
        VERBATIM)
    endif()
  endif()
endif()

# engine_contours: vegas.ts extractAlphaContours, shared by the Vegas effect
# (engine_canvas_effects) and the image-alpha puppet mesh (engine_scene_core);
# contour_texture packs them for the GPU Vegas (E4, scene_textures.cpp).
add_library(engine_contours STATIC src/effects/alpha_contours.cpp src/effects/contour_texture.cpp)
target_include_directories(engine_contours PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/effects)
target_link_libraries(engine_contours PUBLIC motion::jsmath PRIVATE motion::options)

# engine_scene_core: the scene builder's GPU- and raster-free ports — rigs
# (rig_mesh + the document bridge), extrusion geometry (extrude_mesh,
# trace_bitmap). engine_scene builds on it; the cross-engine rig parity test
# runs against it without Skia or Dawn.
add_library(engine_scene_core STATIC
  src/scene/rig_mesh.cpp
  src/scene/rig_bridge.cpp
  src/scene/rig_overlay.cpp  # B4 round 5: the rig in the overlay push + getRigPose (rigOverlay.ts)
  src/scene/extrude_mesh.cpp
  src/scene/trace_bitmap.cpp
  src/scene/primitive_mesh.cpp
  src/scene/camera3d_port.cpp
  src/scene/lights3d.cpp
  src/scene/env_light.cpp
  src/scene/readers.cpp  # the node readers (Color.fromHex for the light shading)
  src/scene/height_displacement.cpp  # heightDisplacement.ts (D2w 3D leftovers)
  src/scene/gltf_model.cpp  # gltf.ts parse + modelMesh.ts entries + the model registry
  src/scene/media_paths.cpp  # file_url_path (shared with the texture feed)
  src/scene/styled_surface.cpp  # layerStyles.ts styledSurfaceFill (extrusion walls under overlays)
  src/scene/corner_pin.cpp  # cornerPin.ts + resolveCornerPin + Homography.ts
  src/scene/write_on_trail.cpp  # writeOnBrush.ts resolveWriteOnTrail (Write-on's dab history)
  src/scene/rigid_body.cpp  # rigidBody.ts + simulationCore.ts + physicsBodies.ts (layer physics)
  src/scene/model_deform.cpp  # modelMorph.ts + modelSkinning.ts (glTF morph targets, skinning)
  src/scene/pixel_motion.cpp  # pixelMotionFlow.ts + deinterlace.ts (footage pixel kernels)
  src/scene/extrusion_faces.cpp  # extrusion.ts extrusionGeometry (the fallback body faces)
  src/scene/alpha_mesh.cpp  # puppet.ts coverage mask + alphaMesh.ts (image-layer rig meshes)
  src/scene/frame_hit.cpp  # hitTest over a built frame's renderables
  src/scene/exr_read.cpp  # exr.ts decodeExr + exrToFloatRgba (EXR environment skies)
  src/scene/zlib_inflate_ffi.cpp  # the EXR reader's zlib inflate
)
target_include_directories(engine_scene_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/scene)
find_package(ZLIB REQUIRED)  # exr_read's inflate (zlib_inflate_ffi.cpp)
target_link_libraries(engine_scene_core PUBLIC engine_core engine_contours motion::jsmath PRIVATE motion::options ZLIB::ZLIB)
# The headless test engine answers rig queries too (engine_process.cpp).
target_link_libraries(premation-engine-headless PRIVATE engine_scene_core)
if(MSVC)
  target_compile_options(engine_scene_core PRIVATE /bigobj)
endif()
if(MOTION_BUILD_TESTS)
  # The rig block against buildSnapshot's meshes (tests/data/rig_parity.json,
  # src/core/rig/rigCrossEngine.test.ts).
  add_executable(engine_scene_core_tests tests/test_rig_parity.cpp tests/test_primitive_parity.cpp tests/test_extrude_parity.cpp tests/test_threed_parity.cpp
                                         tests/test_height_displacement_parity.cpp tests/test_gltf_model_parity.cpp
                                         tests/test_env_asset_parity.cpp tests/test_styled_surface_parity.cpp
                                         tests/test_corner_pin_parity.cpp tests/test_write_on_trail_parity.cpp
                                         tests/test_model_deform_parity.cpp tests/test_pixel_motion_parity.cpp
                                         tests/test_extrusion_faces_parity.cpp tests/test_alpha_mesh_parity.cpp
                                         tests/test_frame_hit.cpp tests/test_exr_read.cpp tests/test_rigid_body_parity.cpp)
  target_link_libraries(engine_scene_core_tests PRIVATE engine_scene_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_scene_core_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  add_test(NAME engine_scene_core_tests COMMAND engine_scene_core_tests --reporter compact)
endif()

# premation-plugins: list / render / crash-check plugins without an editor (tools/premation_plugins.cpp).
add_executable(premation-plugins tools/premation_plugins.cpp)
target_link_libraries(premation-plugins PRIVATE engine_plugins motion::options)
# Part of the SDK release artifact (native/sdk/CMakeLists.txt, `--component sdk`).
install(TARGETS premation-plugins RUNTIME DESTINATION bin COMPONENT sdk)
if(MSVC)
  target_compile_definitions(premation-plugins PRIVATE _CRT_SECURE_NO_WARNINGS)  # sscanf / getenv in argument parsing
endif()
if(MOTION_BUILD_TESTS)
  # The host against the SDK's sample bundles (native/sdk): load, render at
  # 8/16/32 bpc, sequence data, checkouts, the journal, crash isolation.
  add_executable(engine_plugins_tests tests/test_plugin_host.cpp tests/test_plugin_session.cpp tests/test_plugin_entitlement.cpp)
  target_link_libraries(engine_plugins_tests PRIVATE engine_plugins motion::options Catch2::Catch2WithMain)
  target_include_directories(engine_plugins_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  target_compile_definitions(engine_plugins_tests PRIVATE
    PREMATION_PLUGIN_BUNDLES="${PREMATION_PLUGIN_BUNDLES}"
    PREMATION_PLUGINS_TOOL="$<TARGET_FILE:premation-plugins>")
  add_dependencies(engine_plugins_tests premation-plugins ripple rings checkout)
  add_test(NAME engine_plugins_tests COMMAND engine_plugins_tests --reporter compact)
endif()

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
  target_link_options(premation-engine-headless PRIVATE ${_doc_stack})
  if(TARGET engine_tests)
    target_link_options(engine_tests PRIVATE ${_doc_stack})
  endif()
endif()
if(TARGET engine_tests)
  # The replay corpus (tests/data/replay_corpus.bin, dumped by crossEngine.test.ts).
  target_compile_definitions(engine_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
endif()
if(MOTION_BUILD_TESTS)
  # D1's exit: the replay corpus's evaluated values against the TypeScript
  # engine's, byte for byte (tests/data/d1_eval_parity.bin, written by
  # src/core/engine/__tests__/d1EvalParity.test.ts).
  add_executable(engine_d1_parity_tests tests/test_d1_eval_parity.cpp)
  target_link_libraries(engine_d1_parity_tests PRIVATE engine_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_d1_parity_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(MSVC)
    target_compile_options(engine_d1_parity_tests PRIVATE /bigobj)
    target_compile_definitions(engine_d1_parity_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in parity_fixture.hpp
  endif()
  if(WIN32)
    target_link_options(engine_d1_parity_tests PRIVATE ${_doc_stack})
  endif()
  add_test(NAME engine_d1_parity_tests COMMAND engine_d1_parity_tests --reporter compact)
  # F2's exit: the undo parity suite — the replay corpus with its history
  # probed after every request, then walked (undo/redo/jumps/gestures/
  # checkpoints/limit), against the TypeScript engine's, byte for byte
  # (tests/data/undo_parity.bin, written by
  # src/core/engine/__tests__/undoParity.test.ts).
  add_executable(engine_undo_parity_tests tests/test_undo_parity.cpp)
  target_link_libraries(engine_undo_parity_tests PRIVATE engine_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_undo_parity_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(MSVC)
    target_compile_options(engine_undo_parity_tests PRIVATE /bigobj)
    target_compile_definitions(engine_undo_parity_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in parity_fixture.hpp
  endif()
  if(WIN32)
    target_link_options(engine_undo_parity_tests PRIVATE ${_doc_stack})
  endif()
  add_test(NAME engine_undo_parity_tests COMMAND engine_undo_parity_tests --reporter compact)
endif()
if(TARGET engine_fuzz)
  # engine_fuzz compiles everything in (one static CRT, see above).
  set(_libs_dir ${CMAKE_CURRENT_SOURCE_DIR}/../libs)
  file(GLOB _doc_fuzz_expr ${_libs_dir}/motion_expr/*.cpp)
  target_sources(engine_fuzz PRIVATE ${ENGINE_DOC_SOURCES} src/core/json.cpp src/raster/text_unicode.cpp ${_doc_fuzz_expr}
                 ${_libs_dir}/motion_jsmath/fdlibm.cpp ${_libs_dir}/motion_jsmath/numconv.cpp
                 ${_libs_dir}/motion_transform/transform.cpp ${_libs_dir}/motion_transform/motion_transform.cpp)
  target_include_directories(engine_fuzz PRIVATE ${_libs_dir}/motion_expr ${_libs_dir}/motion_jsmath
                             ${_libs_dir}/motion_transform)
  target_link_libraries(engine_fuzz PRIVATE ZLIB::ZLIB Threads::Threads)  # core/deflate_ffi.cpp (C only: malloc/free across the CRT); the job runner
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

# ── E1: media — footage decode (src/media; kept in its own block) ────────────
#   engine_media_core  GPU-free, ffmpeg-free: frame index (+1 µs rule), time
#                      mapping (loop / posterize / stretch / pulldown / frame
#                      blending), decoded-frame LRU cache, Y'CbCr matrices
#   engine_media       ffmpeg (vcpkg `engine` feature): probe, demux, decode
#                      (hardware via d3d11va/videotoolbox/vaapi/nvdec, software
#                      fallback), MediaSystem (worker per source, latest-wins
#                      seeks, readahead). libav* only in decoder_ffi.cpp; D3D11
#                      only in d3d11_ffi.cpp
#   engine_media_gpu   Dawn: decoded frame → RGBA16F texture (planes uploaded
#                      as-is, or a hardware surface imported zero-copy) and the
#                      render graph's ExternalTextureSource for media hashes
#   premation-decode-bench   scrub latency / playback fps / CPU / memory
add_library(engine_media_core STATIC
  src/media/frame_index.cpp
  src/media/time_map.cpp
  src/media/frame_cache.cpp
  src/media/yuv.cpp
)
target_include_directories(engine_media_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/media)
target_compile_features(engine_media_core PUBLIC cxx_std_20)
target_link_libraries(engine_media_core PRIVATE motion::options)

find_package(FFMPEG QUIET)
if(FFMPEG_FOUND)
  add_library(engine_media STATIC src/media/decoder_ffi.cpp src/media/media_system.cpp)
  if(WIN32)
    target_sources(engine_media PRIVATE src/media/d3d11_ffi.cpp src/media/cuda_ffi.cpp)
    target_link_libraries(engine_media PRIVATE d3d11 dxgi)
    target_compile_definitions(engine_media PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  endif()
  target_include_directories(engine_media SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  target_link_directories(engine_media PUBLIC ${FFMPEG_LIBRARY_DIRS})
  # engine_core: the structured log only (media_hw_fallback events).
  target_link_libraries(engine_media PUBLIC engine_media_core ${FFMPEG_LIBRARIES} PRIVATE engine_core motion::options)
  target_compile_definitions(engine_media PUBLIC PREMATION_HAVE_MEDIA=1)
  if(TARGET engine_render_graph)
    add_library(engine_media_gpu STATIC src/media/frame_convert.cpp src/media/media_textures.cpp src/media/platform_ffi.cpp
                                        src/media/media_config.cpp)
    if(WIN32)
      target_compile_definitions(engine_media_gpu PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
      target_link_libraries(engine_media_gpu PRIVATE d3d11 dxgi d3d12 psapi)
    endif()
    target_link_libraries(engine_media_gpu PUBLIC engine_media engine_render_graph dawn::webgpu_dawn PRIVATE motion::options)
    add_executable(premation-decode-bench tools/premation_decode_bench.cpp)
    target_link_libraries(premation-decode-bench PRIVATE engine_media_gpu motion::options)
  endif()
else()
  message(STATUS "premation-engine: ffmpeg not found — media (E1) builds its GPU-free core only")
endif()
if(MOTION_BUILD_TESTS)
  add_executable(engine_media_tests tests/test_media.cpp)
  target_link_libraries(engine_media_tests PRIVATE engine_media_core motion::options Catch2::Catch2WithMain)
  if(TARGET engine_media)
    target_sources(engine_media_tests PRIVATE tests/test_media_decode.cpp tests/media_fixture_ffi.cpp
                                              tests/test_media_color.cpp tests/swscale_ref_ffi.cpp)
    target_include_directories(engine_media_tests SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(engine_media_tests PRIVATE engine_media)
    target_compile_definitions(engine_media_tests PRIVATE
      PREMATION_MEDIA_FIXTURES="${CMAKE_CURRENT_SOURCE_DIR}/../../src/core/video/__fixtures__")
  endif()
  if(TARGET engine_media_gpu)
    target_sources(engine_media_tests PRIVATE tests/test_media_gpu.cpp)
    target_link_libraries(engine_media_tests PRIVATE engine_media_gpu)
    if(WIN32 AND DEFINED _dxc_bin)
      add_custom_command(TARGET engine_media_tests POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_dxc_bin}/dxcompiler.dll" "${_dxc_bin}/dxil.dll"
                "$<TARGET_FILE_DIR:engine_media_tests>"
        VERBATIM)
    endif()
  endif()
  if(MSVC)
    target_compile_definitions(engine_media_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv / tmpnam in fixtures
  endif()
  add_test(NAME engine_media_tests COMMAND engine_media_tests --reporter compact)
endif()

# ── E3: text + vector rasterisation (src/raster; kept in its own block) ─────
#   engine_raster_core  Skia-free: JSON, CSS values (colour / font / filter),
#                       graphemes, line breaking + Intl word joins (ICU at run
#                       time, word_break_ffi), fontconfig families (Linux),
#                       optical-kerning math, the Canvas2D interface and the
#                       paint-stroke painter (paint_raster) that runs on it
#   engine_raster       the Canvas2D semantics on Skia's CPU raster backend
#                       (canvas_ffi), fonts (FreeType + woff2) + HarfBuzz shaping
#                       + SheenBidi (fonts_ffi), the recorded-call replayer and
#                       the painters ported from src/core/rendering/raster
#                       (vector_paint, text_paint). Skia / HarfBuzz / FreeType /
#                       SheenBidi / woff2 only in *_ffi.cpp (vcpkg `engine`).
#   premation-raster    parity harness (vs the TS rasters exported with each
#                       golden FrameScene) + the raster bench
add_library(engine_raster_core STATIC
  src/raster/json.cpp
  src/raster/css.cpp
  src/raster/text_unicode.cpp
  src/raster/line_break.cpp
  src/raster/optical_math.cpp
  src/raster/canvas.cpp           # the Canvas2D interface (Skia behind it: canvas_ffi)
  src/raster/paint_common.cpp
  src/raster/paint_raster.cpp     # paint strokes (paintRaster.ts), on any Canvas2D
  src/raster/mask_paint.cpp       # paintMaskMatte (mask.ts), on any Canvas2D
  src/raster/word_break_ffi.cpp   # ICU word break iterator, loaded from the OS at run time
  src/raster/system_fonts_ffi.cpp # fontconfig family matching + the Linux font catalogue
  src/raster/font_catalog.cpp     # listFonts + font resolution over the installed faces
  src/raster/svg_doc.cpp          # SVG documents: XML, CSS cascade, path / transform micro-syntax (D2w)
)
target_include_directories(engine_raster_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/raster)
target_compile_features(engine_raster_core PUBLIC cxx_std_20)
target_link_libraries(engine_raster_core PUBLIC motion::jsmath ${CMAKE_DL_LIBS} PRIVATE motion::options)
# The installed-font catalogue per OS (font_catalog.hpp).
if(WIN32)
  target_sources(engine_raster_core PRIVATE src/raster/font_catalog_ffi_win.cpp)
  target_link_libraries(engine_raster_core PRIVATE dwrite)
  target_compile_definitions(engine_raster_core PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
elseif(APPLE)
  target_sources(engine_raster_core PRIVATE src/raster/font_catalog_ffi_mac.cpp)
  target_link_libraries(engine_raster_core PUBLIC "-framework CoreText" "-framework CoreFoundation")
endif()
if(NOT WIN32 AND NOT APPLE)
  find_package(Fontconfig QUIET)
  if(TARGET Fontconfig::Fontconfig)
    target_link_libraries(engine_raster_core PRIVATE Fontconfig::Fontconfig)
    target_compile_definitions(engine_raster_core PRIVATE PREMATION_HAVE_FONTCONFIG=1)
  else()
    message(STATUS "premation-engine: fontconfig not found — FontSet::add_system_family finds no Linux system fonts")
  endif()
endif()

find_package(unofficial-skia CONFIG QUIET)
find_package(harfbuzz CONFIG QUIET)
find_package(SheenBidi CONFIG QUIET)
find_package(unofficial-brotli CONFIG QUIET)
find_library(PREMATION_WOFF2DEC woff2dec)
find_library(PREMATION_WOFF2COMMON woff2common)
if(TARGET unofficial::skia::skia AND TARGET harfbuzz::harfbuzz AND TARGET SheenBidi::SheenBidi AND PREMATION_WOFF2DEC)
  add_library(engine_raster STATIC
    src/raster/canvas_ffi.cpp
    src/raster/fonts_ffi.cpp
    src/raster/bidi_ffi.cpp
    src/raster/text_layout.cpp
    src/raster/canvas_replay.cpp
    src/raster/vector_paint.cpp
    src/raster/optical_kerning.cpp
    src/raster/text_paint.cpp
    src/raster/raster_source.cpp
    src/raster/svg_raster.cpp       # AppTextureProvider.rasterizeSvg's sizing (D2w)
    src/raster/svg_anim.cpp         # animated SVG: SMIL + CSS animations at the layer's source time
    src/raster/svg_render_ffi.cpp   # the SVG painter, after Blink's SVG painters (D2w)
  )
  target_link_libraries(engine_raster
    PUBLIC engine_raster_core motion::jsmath
    PRIVATE unofficial::skia::skia harfbuzz::harfbuzz SheenBidi::SheenBidi ${PREMATION_WOFF2DEC} ${PREMATION_WOFF2COMMON}
            unofficial::brotli::brotlidec unofficial::brotli::brotlicommon motion::options)
  target_compile_definitions(engine_raster PUBLIC PREMATION_HAVE_RASTER=1)
  if(MSVC)
    target_compile_options(engine_raster PRIVATE /bigobj)
  endif()

  add_executable(premation-raster tools/premation_raster.cpp)
  target_include_directories(premation-raster PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tools)
  target_link_libraries(premation-raster PRIVATE engine_raster engine_protocol motion::options)
  if(MSVC)
    target_compile_definitions(premation-raster PRIVATE _CRT_SECURE_NO_WARNINGS)
  endif()
else()
  message(STATUS "premation-engine: Skia / HarfBuzz / SheenBidi / woff2 not found — E3 builds its Skia-free core only")
endif()
if(MOTION_BUILD_TESTS)
  add_executable(engine_raster_tests tests/test_raster.cpp tests/test_raster_text_core.cpp tests/test_paint_raster.cpp
                 tests/test_svg_doc.cpp tests/test_font_catalog.cpp tests/test_mask_feather.cpp)
  target_link_libraries(engine_raster_tests PRIVATE engine_raster_core engine_json motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_raster_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(TARGET engine_raster)
    target_sources(engine_raster_tests PRIVATE tests/test_raster_canvas.cpp tests/test_svg_anim.cpp)
    target_link_libraries(engine_raster_tests PRIVATE engine_raster)
    target_compile_definitions(engine_raster_tests PRIVATE
      PREMATION_RASTER_FONTS="${CMAKE_CURRENT_SOURCE_DIR}/../../packages/render-tests/harness/fonts/fonts.json")
  endif()
  add_test(NAME engine_raster_tests COMMAND engine_raster_tests --reporter compact)
endif()

# ── E4: CPU effect kernels (src/effects; kept in its own block) ──────────────
#   engine_effects      the TS bake chain's pixel kernels, byte-exact ports,
#                       rows split over a std::jthread pool. No Skia, no GPU.
#   premation-effects   the kernel bench (TS side: tests/bench_effects_ts.mjs)
#   engine_effects_tests  parity vs tests/data/effect_kernel_parity.json
#                       (src/core/effects/nativeKernelCrossEngine.test.ts)
add_library(engine_effects STATIC
  src/effects/thread_pool.cpp
  src/effects/blur_kernels.cpp
  src/effects/noise_kernels.cpp
  src/effects/morph_kernels.cpp
  src/effects/stylize_kernels.cpp
  src/effects/advanced_blur_kernels.cpp
  src/effects/color_kernels.cpp
  src/effects/keying_kernels.cpp
  src/effects/keying_more_kernels.cpp
  src/effects/warp_more_kernels.cpp
  src/effects/distort_kernels.cpp
  src/effects/auto_color_kernels.cpp
  src/effects/transition_kernels.cpp
  src/effects/ae_stylize_kernels.cpp
  src/effects/ae_transitions_kernels.cpp
  src/effects/warp_kernels.cpp
  src/effects/ae_distort_kernels.cpp
  src/effects/round_seven_kernels.cpp
  src/effects/round_six_kernels.cpp
  src/effects/round_five_stylize_kernels.cpp
  src/effects/round_five_distort_kernels.cpp
  src/effects/round_five_transition_kernels.cpp
  src/effects/paint_kernels.cpp
  src/effects/generate_round_five_kernels.cpp
  src/effects/round_seven_distort_kernels.cpp
  src/effects/simulation_kernels.cpp
  src/effects/pattern_warp_lut_kernels.cpp
  src/effects/glow_beam_kernels.cpp
  src/effects/kernel_dispatch.cpp
  src/effects/kernel_dispatch_generate.cpp
)
target_include_directories(engine_effects PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/effects)
target_compile_features(engine_effects PUBLIC cxx_std_20)
target_link_libraries(engine_effects PUBLIC motion::jsmath PRIVATE motion::options)
# The canvas-drawn effects (fill, wipes, generators) on the raster module's
# Canvas2D interface — Skia-free here; Skia sits behind the interface.
add_library(engine_canvas_effects STATIC src/effects/canvas_effects.cpp src/effects/canvas_effects_generate.cpp)
target_include_directories(engine_canvas_effects PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(engine_canvas_effects PUBLIC engine_raster_core motion::jsmath PRIVATE engine_effects engine_contours motion::options)

# The bake CHAIN (effectBake.ts applyEffectChain): param mapping of the apply*
# wrappers, LUT / colour-matrix / CSS / procedural routes, fill opacity, the
# opacity + scoped-mask blend, on any Canvas2D. Skia-free.
add_library(engine_effect_chain STATIC src/effects/effect_chain.cpp src/effects/effect_apply.cpp src/effects/effect_color.cpp)
target_include_directories(engine_effect_chain PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/effects)
target_link_libraries(engine_effect_chain PUBLIC engine_effects engine_canvas_effects engine_raster_core motion::jsmath PRIVATE motion::options)

add_executable(premation-effects tools/premation_effects.cpp)
target_include_directories(premation-effects PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)  # recording_canvas.hpp: the --chain bench's CPU canvas
target_link_libraries(premation-effects PRIVATE engine_effect_chain engine_effects engine_raster_core motion::options)
if(MSVC)
  target_compile_definitions(premation-effects PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()

if(MOTION_BUILD_TESTS)
  add_executable(engine_effects_tests tests/test_effect_kernels.cpp tests/test_canvas_effects.cpp tests/test_effect_chain.cpp tests/test_color_grade.cpp tests/test_keying_more.cpp tests/test_warp_more.cpp)
  target_link_libraries(engine_effects_tests PRIVATE engine_effect_chain engine_effects engine_canvas_effects engine_raster_core engine_json motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_effects_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(MSVC)
    target_compile_definitions(engine_effects_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv
  endif()
  add_test(NAME engine_effects_tests COMMAND engine_effects_tests --reporter compact)
endif()

# ── E2: audio — decode, effects, mix, playback, the master clock (src/audio;
#    kept in its own block) ───────────────────────────────────────────────────
#   engine_audio_core  ffmpeg-free, device-free: the Web Audio node DSP (biquad,
#                      delay, PeriodicWave oscillator, compressor, wave shaper,
#                      partitioned convolver), the audioEffects.ts chains, the
#                      mixer (RenderPlan) + automation, the conformed-source
#                      store + peak pyramid, voice building (retime / nested),
#                      the master clock (DLL + playhead map), the realtime
#                      transport and the steady-clock NullDevice
#   engine_audio       + ffmpeg decode / swresample (audio_decode_ffi.cpp),
#                      miniaudio output (device_ffi.cpp; vcpkg `engine`), and
#                      AudioSystem (sources, conform workers, device, export)
#   premation-audio    bench / real-device smoke / render-to-WAV tool
find_package(Threads REQUIRED)
add_library(engine_audio_core STATIC
  src/audio/param_curve.cpp
  src/audio/automation.cpp
  src/audio/dsp_fft.cpp
  src/audio/dsp_filters.cpp
  src/audio/dsp_osc.cpp
  src/audio/dsp_dynamics.cpp
  src/audio/dsp_convolver.cpp
  src/audio/effects.cpp
  src/audio/source_store.cpp
  src/audio/peaks.cpp
  src/audio/mixer.cpp
  src/audio/voice_build.cpp
  src/audio/clock.cpp
  src/audio/realtime.cpp
  src/audio/device_null.cpp
)
target_include_directories(engine_audio_core
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/audio
  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../libs/motion_eval)  # eval.hpp: the sampler's C++ entry points
target_compile_features(engine_audio_core PUBLIC cxx_std_20)
target_link_libraries(engine_audio_core PUBLIC motion::eval Threads::Threads PRIVATE motion::jsmath motion::options)

if(FFMPEG_FOUND)
  add_library(engine_audio STATIC src/audio/audio_decode_ffi.cpp src/audio/audio_system.cpp)
  target_include_directories(engine_audio SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  target_link_directories(engine_audio PUBLIC ${FFMPEG_LIBRARY_DIRS})
  # ZLIB: the static ffmpeg's PNG / APNG / EXR decoders need it; the other
  # ffmpeg users get it through engine_core, the audio tools do not link that.
  target_link_libraries(engine_audio PUBLIC engine_audio_core ${FFMPEG_LIBRARIES} ZLIB::ZLIB PRIVATE motion::options)
  find_path(PREMATION_MINIAUDIO_INCLUDE miniaudio.h)
  if(PREMATION_MINIAUDIO_INCLUDE)
    target_sources(engine_audio PRIVATE src/audio/device_ffi.cpp)
    target_include_directories(engine_audio SYSTEM PRIVATE ${PREMATION_MINIAUDIO_INCLUDE})
    target_compile_definitions(engine_audio PUBLIC PREMATION_HAVE_MINIAUDIO=1)
    if(APPLE)
      target_link_libraries(engine_audio PRIVATE "-framework CoreAudio" "-framework AudioToolbox" "-framework CoreFoundation")
    elseif(UNIX)
      target_link_libraries(engine_audio PRIVATE ${CMAKE_DL_LIBS} m)
    endif()
  else()
    target_compile_definitions(engine_audio PUBLIC PREMATION_HAVE_MINIAUDIO=0)
    message(STATUS "premation-engine: miniaudio not found — audio plays through the steady-clock NullDevice")
  endif()
  add_executable(premation-audio tools/premation_audio.cpp)
  target_link_libraries(premation-audio PRIVATE engine_audio motion::options)
  if(MSVC)
    target_compile_definitions(premation-audio PRIVATE _CRT_SECURE_NO_WARNINGS)
  endif()
else()
  message(STATUS "premation-engine: ffmpeg not found — audio (E2) builds its decode-free core only")
endif()
if(MOTION_BUILD_TESTS)
  add_executable(engine_audio_tests tests/test_audio.cpp tests/test_audio_clock.cpp tests/test_audio_parity.cpp)
  target_link_libraries(engine_audio_tests PRIVATE engine_audio_core motion::jsmath motion::options Catch2::Catch2WithMain)
  # tests/parity_rebless.hpp: the audio test only uses its file helpers, but the
  # header's JSON half needs the value type.
  target_link_libraries(engine_audio_tests PRIVATE engine_json)
  target_compile_definitions(engine_audio_tests PRIVATE
    PREMATION_AUDIO_PARITY="${CMAKE_CURRENT_SOURCE_DIR}/tests/data/audio_parity.bin")
  if(TARGET engine_audio)
    target_sources(engine_audio_tests PRIVATE tests/test_audio_decode.cpp tests/audio_fixture_ffi.cpp
                   tests/media_fixture_ffi.cpp)
    target_include_directories(engine_audio_tests SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(engine_audio_tests PRIVATE engine_audio)
  endif()
  if(MSVC)
    target_compile_definitions(engine_audio_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # tmpnam / fopen in fixtures
  endif()
  add_test(NAME engine_audio_tests COMMAND engine_audio_tests --reporter compact)
endif()

# ── D2w: the engine renders ITS OWN document (src/scene; kept in its own block) ─
#   engine_scene      the scene builder — buildSnapshot + snapshotToFrameScene
#                     ported onto the D1b document (snapshot_build, frame_build,
#                     effects_port, readers), text measurement over the E3 fonts,
#                     and the texture feed (scene_textures: E3 rasters by content,
#                     E1 footage frames) the render graph samples through
#                     rg::ExternalTextureSource.
#   premation-scene   the parity gate (FrameScene built from each golden scene's
#                     project document vs the TS-exported one, rendered for the
#                     render-tests `native-scene` backend) + the frame-build bench
if(TARGET engine_raster AND TARGET engine_render_graph)
  add_library(engine_scene STATIC
    src/scene/effects_port.cpp
    src/scene/stamp_field.cpp
    src/scene/effects_spatial.cpp
    src/scene/effects_spatial_a.cpp
    src/scene/effects_spatial_b.cpp
    src/scene/layer_styles.cpp
    src/scene/path_ops.cpp
    src/scene/snapshot_build.cpp
    src/scene/threed_port.cpp
    src/scene/threed_frame.cpp
    src/scene/mesh_displacement.cpp
    src/scene/model_carrier.cpp
    src/scene/env_asset.cpp
    src/scene/scene_textures_model.cpp
    src/scene/light_wash.cpp
    src/scene/frame_build.cpp
    src/scene/text_measure.cpp
    src/scene/text_query.cpp        # B4 round 2: getTextLayout / getLayerBounds' text boxes over text_measure
    src/scene/scene_textures.cpp
    src/scene/image_decode_ffi.cpp
    src/scene/svg_layer.cpp
    src/scene/text_port.cpp
    src/scene/paint_port.cpp
    src/scene/native_scene.cpp
    src/scene/color_settings.cpp
    src/scene/glass_port.cpp
    src/scene/retime_port.cpp
    src/scene/extrusion_mesh.cpp
    src/scene/mesh_check.cpp
    src/scene/lut_port.cpp          # D2w effects: colour LUT strips (colorLut.ts, cubeLut.ts)
    src/scene/bake_chain.cpp        # D2w effects: a baked raster's mask + stack handed to engine_effect_chain
    src/scene/effect_handoff.cpp    #   the path / paint effects' resolved geometry (buildSnapshot)
    src/scene/text_outlines.cpp     # convertLayer: the font's own glyph outlines (fontOutlines.ts)
    src/scene/svg_shapes.cpp        # convertLayer: SVG document → editable parts (svgParser.ts, static)
    src/scene/per_char3d.cpp        # D2w 3D: per-character 3D text (perChar3D.ts layoutPerChar3D)
    src/scene/rig_coverage.cpp      # D1: image-layer rig coverage (imageAlphaCoverage.ts decode)
  src/scene/comp_instance.cpp     # D2w time/comp: nested + collapsed composition instances
  src/scene/precomp_frame.cpp     #   their frame side (sealed 3D scopes, the 3D card)
  src/scene/temporal_ghosts.cpp   #   Echo / Wide Time ghost copies
  src/scene/raw_world.cpp         #   raw-graph world transforms (points bound to nulls, cloner drivers)
  src/scene/threed_card.cpp       #   the 3D comp card (Scene3D::comp_card)
  src/scene/cloner_port.cpp       #   cloners (clonerPlan, expandCloners, the cascade)
  src/scene/particle_port.cpp     #   particle layers (sims, the Canvas2D field)
  src/scene/polygon_clipping.cpp  #   polygon-clipping (Martinez) + splaytree + orient2d, exact
  src/scene/merge_paths.cpp       #   live Merge Paths (mergePaths.ts)
  src/scene/layer_faces.cpp       #   getLayerFaces: face picking's extrusion faces (facePicking.ts)
    src/plugins/scene_native_fx.cpp
    src/plugins/scene_finish.cpp
  )
  target_include_directories(engine_scene PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/scene)
  target_include_directories(engine_scene PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../libs/motion_eval)  # eval.hpp: text selectors' ease (text_port.cpp)
  target_link_libraries(engine_scene PUBLIC engine_core engine_scene_core engine_plugins engine_raster engine_render_graph
                                            engine_effect_chain PRIVATE motion::options)
  if(WIN32)
    target_link_libraries(engine_scene PRIVATE windowscodecs ole32)  # WIC: still-image footage (image_decode_ffi.cpp)
  else()
    target_link_libraries(engine_scene PRIVATE unofficial::skia::skia)  # Skia's codecs: still-image footage (image_decode_ffi.cpp)
  endif()
  if(TARGET engine_media_gpu)
    target_link_libraries(engine_scene PUBLIC engine_media_gpu)
    target_compile_definitions(engine_scene PUBLIC PREMATION_HAVE_MEDIA=1)
    target_include_directories(engine_scene SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  endif()
  if(MSVC)
    target_compile_options(engine_scene PRIVATE /bigobj)
    target_compile_definitions(engine_scene PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in native_scene.cpp
  endif()

  add_executable(premation-scene tools/premation_scene.cpp)
  target_include_directories(premation-scene PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tools)
  target_link_libraries(premation-scene PRIVATE engine_scene motion::options)
  if(MSVC)
    target_compile_definitions(premation-scene PRIVATE _CRT_SECURE_NO_WARNINGS)
  endif()

  # engine_scene_tests: the scene builder's GPU-free units (colour settings,
  # the D4 frame cache) — the pixel parity is premation-scene's (render-tests).
  if(MOTION_BUILD_TESTS)
    add_executable(engine_scene_tests tests/test_scene_color.cpp tests/test_text_port_parity.cpp tests/test_bake_chain.cpp
                                      tests/test_threed_models.cpp tests/test_time_comp_parity.cpp tests/test_particle_parity.cpp
                                      tests/test_polygon_clipping_parity.cpp tests/test_cover_crop.cpp tests/test_source_text.cpp
                                      tests/test_rig_coverage.cpp tests/test_gpu_effect_route.cpp
                                      tests/test_text_outlines.cpp tests/test_svg_shapes.cpp
                                      tests/test_b4_round5_text_glyphs.cpp  # B4 round 5: getTextLayout.glyphs over the harness fonts
                                      tests/test_viewport_view.cpp  # setViewport view / customView → the snapshot's camera
                                      tests/test_layer_view.cpp  # setViewport layer: the Layer panel's one-layer walk
                                      tests/test_overlay_render_agreement.cpp)  # the overlay maths place a 3D layer where the frame drew it
    target_compile_definitions(engine_scene_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data"
      PREMATION_RASTER_FONTS="${CMAKE_CURRENT_SOURCE_DIR}/../../packages/render-tests/harness/fonts/fonts.json")
    target_link_libraries(engine_scene_tests PRIVATE engine_scene motion::options Catch2::Catch2WithMain)
    if(MSVC)
      target_compile_options(engine_scene_tests PRIVATE /bigobj)
      target_compile_definitions(engine_scene_tests PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv in parity_rebless.hpp
    endif()
    add_test(NAME engine_scene_tests COMMAND engine_scene_tests --reporter compact)
  endif()

  # engine_frames: the scene builder + render graph + audio wired into the
  # engine process (Session's FrameBuilder / MediaClock hooks, the render
  # thread's BuiltFrameDrawer). premation-engine uses it when present.
  if(TARGET engine_gpu AND TARGET premation-engine)
    add_library(engine_frames STATIC src/scene/engine_frames.cpp)
    target_link_libraries(engine_frames PUBLIC engine_scene engine_gpu engine_plugins_gpu PRIVATE motion::options)
    # getThumbnail encodes its still as PNG (png_write, GPU-free; defined below).
    target_link_libraries(engine_frames PRIVATE engine_export_core)
    if(TARGET engine_audio)
      target_link_libraries(engine_frames PUBLIC engine_audio)
      target_compile_definitions(engine_frames PRIVATE PREMATION_HAVE_AUDIO=1)
    endif()
    if(TARGET engine_media_gpu)
      target_include_directories(engine_frames SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
    endif()
    target_link_libraries(premation-engine PRIVATE engine_frames)
    target_compile_definitions(premation-engine PRIVATE PREMATION_HAVE_SCENE=1)
  endif()
else()
  message(STATUS "premation-engine: E3 raster or the render graph missing — the D2w scene builder is not built")
endif()
# The Session's scene / audio-clock hooks (session_hooks.hpp) are engine_core: tested with fakes.
if(MOTION_BUILD_TESTS AND TARGET engine_tests)
  target_sources(engine_tests PRIVATE tests/test_session_hooks.cpp tests/test_engine_queries.cpp)
endif()

# ── F1: export from the engine (src/export; kept in its own block) ──────────
#   engine_export_core   GPU-free: the job spec, the .motion bundle reader, the
#                        raw-pipe pixel conversion, the WAV writer, the encoder
#                        child process (child_process_ffi.cpp)
#   engine_export        the job: preflight over the scene builder, the
#                        multi-frame pipeline (build workers → render graph with
#                        several frames on the GPU → encoder), the audio mixdown
#                        (engine_frames' E2 program) — `premation-engine --export JOB`
#   premation-export-sink  test double for ffmpeg: copies stdin to its last argument
add_library(engine_export_core STATIC
  src/export/project_open.cpp
  src/export/child_process_ffi.cpp
  src/export/png_write.cpp
  src/export/jpeg_write.cpp
  src/export/zip_write.cpp)
target_include_directories(engine_export_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/export)
target_link_libraries(engine_export_core PUBLIC engine_core PRIVATE motion::options)
if(WIN32)
  target_compile_definitions(engine_export_core PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
  target_link_libraries(engine_export_core PRIVATE windowscodecs ole32)
endif()
add_executable(premation-export-sink tools/premation_export_sink.cpp)
target_link_libraries(premation-export-sink PRIVATE motion::options)
if(MSVC)
  target_compile_definitions(premation-export-sink PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
if(TARGET engine_frames)
  add_library(engine_export STATIC src/export/export_job.cpp)
  target_link_libraries(engine_export PUBLIC engine_export_core engine_frames engine_scene PRIVATE motion::options)
  if(TARGET engine_media_gpu)
    target_include_directories(engine_export SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  endif()
  if(MSVC)
    target_compile_options(engine_export PRIVATE /bigobj)
    target_compile_definitions(engine_export PRIVATE _CRT_SECURE_NO_WARNINGS)  # getenv (read before threads start)
  endif()
  target_link_libraries(premation-engine PRIVATE engine_export)
  target_compile_definitions(premation-engine PRIVATE PREMATION_HAVE_EXPORT=1)
endif()
if(MOTION_BUILD_TESTS)
  add_executable(engine_export_tests tests/test_export.cpp)
  target_link_libraries(engine_export_tests PRIVATE engine_export_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_export_tests PRIVATE
    PREMATION_EXPORT_SINK="$<TARGET_FILE:premation-export-sink>")
  add_dependencies(engine_export_tests premation-export-sink)
  if(MSVC)
    target_compile_definitions(engine_export_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
  endif()
  add_test(NAME engine_export_tests COMMAND engine_export_tests --reporter compact)
endif()
# ── Engine jobs (src/jobs; kept in its own block) ───────────────────────────
#   the runner + Session half is engine_core (jobs/job_runner, job_inputs,
#   core/session_jobs.cpp); here are the kinds:
#   engine_jobs_core   the pure analyses, decode- and GPU-free: audio
#                      (silences, amplitude, beats, detector, ducking, gate),
#                      scene detection, the render's encode args, the tracker
#                      + stabilizer, auto-trace, SAM pre/post-processing, and
#                      the track apply plans (document reads + commands)
#   engine_jobs        the kinds (kind_*.cpp), footage frames / sound
#                      (media_input_ffi.cpp: ffmpeg), the child-process job
#                      host (child_job.cpp), ONNX Runtime for SAM
#                      (sam_ort_ffi.cpp, vcpkg `engine` feature) — linked into
#                      premation-engine as PREMATION_HAVE_JOBS
add_library(engine_jobs_core STATIC
  src/jobs/audio_analysis.cpp
  src/jobs/scene_detect.cpp
  src/jobs/encode_args.cpp
  src/jobs/media_input.cpp
  src/jobs/tracking.cpp
  src/jobs/track_feature.cpp
  src/jobs/camera_track.cpp
  src/jobs/planar_track.cpp
  src/jobs/face_mesh.cpp
  src/jobs/matte_refine.cpp
  src/jobs/stabilize.cpp
  src/jobs/track_apply.cpp
  src/jobs/track_plans.cpp
  src/jobs/track_walk.cpp
  src/jobs/mask_sampling.cpp
  src/jobs/mask_fit.cpp
  src/jobs/camera_solve.cpp
  src/jobs/trace_bitmap.cpp
  src/jobs/sam_pipeline.cpp
  src/jobs/roto_matte.cpp
  src/jobs/content_aware.cpp
  src/jobs/content_aware_fill.cpp
  src/jobs/reframe_path.cpp
  src/jobs/saliency.cpp
  src/jobs/reframe_analyse.cpp
  src/jobs/transcribe.cpp
)
target_include_directories(engine_jobs_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/jobs)
target_link_libraries(engine_jobs_core PUBLIC engine_core engine_scene_core motion::jsmath PRIVATE motion::options)
if(MSVC)
  target_compile_options(engine_jobs_core PRIVATE /bigobj)
endif()

if(FFMPEG_FOUND AND TARGET engine_audio)
  add_library(engine_jobs STATIC
    src/jobs/media_input_ffi.cpp
    src/jobs/child_job.cpp
    src/jobs/job_kinds.cpp
    src/jobs/kind_audio.cpp
    src/jobs/kind_scene_detect.cpp
    src/jobs/kind_proxy.cpp
    src/jobs/kind_render.cpp
    src/jobs/kind_track_motion.cpp
    src/jobs/kind_track_apply.cpp
    src/jobs/kind_stabilize.cpp
    src/jobs/kind_auto_trace.cpp
    src/jobs/kind_roto_brush.cpp
    src/jobs/kind_content_aware.cpp
    src/jobs/kind_auto_reframe.cpp
    src/jobs/kind_dynamics_bake.cpp
    src/jobs/kind_rig_logo.cpp
    src/jobs/kind_transcribe.cpp
    src/jobs/child_export.cpp
    src/jobs/kind_object_matte.cpp
    src/jobs/sam_ort_ffi.cpp
    src/jobs/kind_camera_track.cpp
    src/jobs/kind_face_track.cpp
    src/jobs/face_ort_ffi.cpp
  )
  target_include_directories(engine_jobs SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  target_link_directories(engine_jobs PUBLIC ${FFMPEG_LIBRARY_DIRS})
  target_link_libraries(engine_jobs PUBLIC engine_jobs_core engine_audio engine_export_core ${FFMPEG_LIBRARIES} PRIVATE motion::options)
  # Still images (PNG frames of a child render, image footage): the OS codec the
  # renderer uses (scene/image_decode_ffi.cpp) — the vcpkg ffmpeg has no still decoders.
  if(TARGET engine_scene)
    target_link_libraries(engine_jobs PRIVATE engine_scene)
    target_compile_definitions(engine_jobs PRIVATE PREMATION_JOBS_HAVE_SCENE=1)  # the particle bake (particle_port.hpp)
  endif()
  find_package(onnxruntime CONFIG QUIET)
  if(onnxruntime_FOUND)
    target_link_libraries(engine_jobs PRIVATE onnxruntime::onnxruntime)
    target_compile_definitions(engine_jobs PRIVATE PREMATION_HAVE_ONNXRUNTIME=1)
  else()
    message(STATUS "premation-engine: onnxruntime not found — the object-matte job answers unsupported")
  endif()
  # The transcribe job's HTTPS call (http_post.hpp): WinHTTP on Windows, the
  # system libcurl elsewhere (macOS ships it; Linux: libcurl-dev), else a stub
  # that refuses with that reason.
  if(WIN32)
    target_sources(engine_jobs PRIVATE src/jobs/http_post_ffi_win.cpp)
    target_link_libraries(engine_jobs PRIVATE winhttp)
  else()
    find_package(CURL QUIET)
    if(CURL_FOUND)
      target_sources(engine_jobs PRIVATE src/jobs/http_post_ffi_curl.cpp)
      target_link_libraries(engine_jobs PRIVATE CURL::libcurl)
    else()
      target_sources(engine_jobs PRIVATE src/jobs/http_post_ffi_none.cpp)
      message(STATUS "premation-engine: libcurl not found — the transcribe job answers with a no-HTTP error")
    endif()
  endif()
  if(MSVC)
    target_compile_options(engine_jobs PRIVATE /bigobj)
    target_compile_definitions(engine_jobs PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
  endif()
  if(TARGET premation-engine)
    target_link_libraries(premation-engine PRIVATE engine_jobs)
    target_compile_definitions(premation-engine PRIVATE PREMATION_HAVE_JOBS=1)
  endif()
else()
  message(STATUS "premation-engine: ffmpeg or the audio decoder missing — engine jobs build their pure core only")
endif()

if(MOTION_BUILD_TESTS)
  add_executable(engine_jobs_tests tests/test_jobs_audio.cpp tests/test_jobs_trace.cpp tests/test_jobs_tracking.cpp tests/test_track_feature.cpp tests/test_camera_track.cpp tests/test_planar_track.cpp tests/test_matte_refine.cpp tests/test_face_mesh.cpp
                                 tests/test_jobs_round2.cpp tests/test_roto_matte.cpp tests/test_content_aware.cpp
                                 tests/test_reframe_path.cpp tests/test_saliency.cpp
                                 tests/test_reframe_analyse.cpp tests/test_job_retime.cpp
                                 tests/test_transcribe.cpp tests/test_mask_fit.cpp)
  target_link_libraries(engine_jobs_tests PRIVATE engine_jobs_core motion::options Catch2::Catch2WithMain)
  if(MSVC)
    target_compile_options(engine_jobs_tests PRIVATE /bigobj)
  endif()
  add_test(NAME engine_jobs_tests COMMAND engine_jobs_tests --reporter compact)
endif()

# ── 3D model import (AE parity 4.7; src/scene/model_*.cpp) ─────────────────
#   engine_model   the normalizer: any model the editor imports → one plain GLB
#                  (model_convert.hpp). GPU- and decode-free; the vendored
#                  meshoptimizer decoder and ufbx (native/third_party, compiled
#                  without the project's warning set — upstream code) plus,
#                  when vcpkg provides them, Draco and libktx.
enable_language(C)
set(PREMATION_THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)
add_library(premation_meshopt STATIC
  ${PREMATION_THIRD_PARTY}/meshoptimizer/vertexcodec.cpp
  ${PREMATION_THIRD_PARTY}/meshoptimizer/indexcodec.cpp
  ${PREMATION_THIRD_PARTY}/meshoptimizer/vertexfilter.cpp)
target_include_directories(premation_meshopt SYSTEM PUBLIC ${PREMATION_THIRD_PARTY}/meshoptimizer)
target_compile_features(premation_meshopt PRIVATE cxx_std_20)
add_library(premation_ufbx STATIC ${PREMATION_THIRD_PARTY}/ufbx/ufbx.c)
target_include_directories(premation_ufbx SYSTEM PUBLIC ${PREMATION_THIRD_PARTY}/ufbx)
set_target_properties(premation_meshopt premation_ufbx PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(NOT MSVC)
  target_compile_options(premation_ufbx PRIVATE -w)
  target_compile_options(premation_meshopt PRIVATE -w)
endif()

add_library(engine_model STATIC
  src/scene/model_convert.cpp
  src/scene/model_obj.cpp
  src/scene/model_usd.cpp
  src/scene/model_import_files.cpp
  src/scene/model_fbx_ffi.cpp
  src/scene/meshopt_ffi.cpp
  src/scene/model_codecs_none.cpp
)
target_include_directories(engine_model PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/scene)
target_link_libraries(engine_model PUBLIC engine_core engine_export_core PRIVATE premation_meshopt premation_ufbx motion::options)
find_package(draco CONFIG QUIET)
if(draco_FOUND)
  target_sources(engine_model PRIVATE src/scene/draco_ffi.cpp)
  target_link_libraries(engine_model PRIVATE draco::draco)
  target_compile_definitions(engine_model PRIVATE PREMATION_HAVE_DRACO=1)
else()
  message(STATUS "premation-engine: Draco not found — Draco-compressed glTF imports are refused with a message")
endif()
find_package(Ktx CONFIG QUIET)
if(Ktx_FOUND)
  target_sources(engine_model PRIVATE src/scene/ktx_ffi.cpp)
  target_link_libraries(engine_model PRIVATE KTX::ktx)
  target_compile_definitions(engine_model PRIVATE PREMATION_HAVE_KTX=1)
else()
  message(STATUS "premation-engine: libktx not found — KTX2 textures use their fallbacks or are refused")
endif()
if(MSVC)
  target_compile_options(engine_model PRIVATE /bigobj)
endif()
if(TARGET engine_jobs)
  target_sources(engine_jobs PRIVATE src/jobs/kind_model_import.cpp)
  target_link_libraries(engine_jobs PUBLIC engine_model)
endif()
if(MOTION_BUILD_TESTS)
  add_executable(engine_model_tests tests/test_model_convert.cpp)
  target_link_libraries(engine_model_tests PRIVATE engine_model engine_scene_core premation_meshopt motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_model_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  add_test(NAME engine_model_tests COMMAND engine_model_tests --reporter compact)
endif()

# ASan on Windows: the runtime DLL (cmake/sanitizers.cmake) next to every engine
# executable, as tests/CMakeLists.txt does for motion_tests — they all build
# into this directory, so ctest and a direct run find it.
if(MOTION_ASAN_RUNTIME_DIR)
  add_custom_target(engine_asan_runtime ALL
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${MOTION_ASAN_RUNTIME_DIR}/clang_rt.asan_dynamic-x86_64.dll" "${CMAKE_CURRENT_BINARY_DIR}"
    VERBATIM)
endif()
