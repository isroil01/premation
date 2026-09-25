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
    src/render/frame_cache.cpp
    src/render/render_thread.cpp
    src/render/vram_ffi.cpp
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
  message(STATUS "premation-engine: Dawn not found — building engine_core, its tests, the fuzzer and premation-engine-headless only")
endif()

# premation-engine-headless: the engine process without Dawn — the same pipes,
# core loop and Session, frames always simulated (as --no-gpu). For the
# cross-engine replay (crossEngine.test.ts, PREMATION_ENGINE_PATH=<it>) on
# machines and CI jobs without the vcpkg `engine` feature. Never shipped.
add_executable(premation-engine-headless
  src/main.cpp
  src/engine_process.cpp
  src/os_ffi.cpp
  src/io/pipe_ffi.cpp
  src/io/framed_writer.cpp
)
target_include_directories(premation-engine-headless PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/io)
target_compile_definitions(premation-engine-headless PRIVATE PREMATION_ENGINE_HEADLESS=1)
target_link_libraries(premation-engine-headless PRIVATE engine_core engine_plugins motion::options)
if(WIN32)
  target_link_libraries(premation-engine-headless PRIVATE winmm)
  target_compile_definitions(premation-engine-headless PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
endif()

# ── tests ───────────────────────────────────────────────────────────────────
if(MOTION_BUILD_TESTS)
  find_package(Catch2 3 CONFIG REQUIRED)
  add_executable(engine_tests
    tests/test_framing.cpp
    tests/test_session.cpp
    tests/test_paint_strokes.cpp
    tests/test_paths.cpp
    tests/test_expression_controls.cpp
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
    add_executable(engine_gpu_tests tests/test_render.cpp tests/test_render_graph_gpu.cpp tests/test_frame_cache.cpp)
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
  src/core/fields.cpp
  src/core/rig.cpp
  src/core/controls.cpp
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
  src/core/handlers_native.cpp
  src/core/handlers_optional.cpp
  src/core/handlers_precompose.cpp
  src/core/handlers_properties.cpp
  src/core/handlers_strokes.cpp
  src/core/handlers_paths.cpp
  src/core/json.cpp
  src/core/layer_clone.cpp
  src/core/meta.cpp
  src/core/model.cpp
  src/core/native_effects.cpp
  src/core/parenting.cpp
  src/core/particle_props.cpp
  src/core/plugin_props.cpp
  src/core/props.cpp
  src/core/ptree.cpp
  src/core/queries.cpp
  src/core/readmodel.cpp
  src/core/scene.cpp
  src/core/scene_build.cpp
  src/core/strokes.cpp
  src/core/timeline.cpp
  src/core/worldxf.cpp
)
target_sources(engine_core PRIVATE ${ENGINE_DOC_SOURCES})
target_link_libraries(engine_core PUBLIC motion::expr motion::transform motion::jsmath)
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
)
target_include_directories(engine_plugins PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/plugins ${CMAKE_CURRENT_SOURCE_DIR}/../sdk/include)
target_link_libraries(engine_plugins PUBLIC engine_core Threads::Threads PRIVATE ${CMAKE_DL_LIBS} motion::options)
if(MSVC)
  target_compile_options(engine_plugins PRIVATE /bigobj)
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
endif()

# engine_scene_core: the scene builder's GPU- and raster-free ports — rigs
# (rig_mesh + the document bridge), extrusion geometry (extrude_mesh,
# trace_bitmap). engine_scene builds on it; the cross-engine rig parity test
# runs against it without Skia or Dawn.
add_library(engine_scene_core STATIC
  src/scene/rig_mesh.cpp
  src/scene/rig_bridge.cpp
  src/scene/extrude_mesh.cpp
  src/scene/trace_bitmap.cpp
  src/scene/primitive_mesh.cpp
  src/scene/camera3d_port.cpp
  src/scene/lights3d.cpp
  src/scene/env_light.cpp
  src/scene/readers.cpp  # the node readers (Color.fromHex for the light shading)
)
target_include_directories(engine_scene_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/scene)
target_link_libraries(engine_scene_core PUBLIC engine_core motion::jsmath PRIVATE motion::options)
if(MSVC)
  target_compile_options(engine_scene_core PRIVATE /bigobj)
endif()
if(MOTION_BUILD_TESTS)
  # The rig block against buildSnapshot's meshes (tests/data/rig_parity.json,
  # src/core/rig/rigCrossEngine.test.ts).
  add_executable(engine_scene_core_tests tests/test_rig_parity.cpp tests/test_primitive_parity.cpp tests/test_extrude_parity.cpp tests/test_threed_parity.cpp)
  target_link_libraries(engine_scene_core_tests PRIVATE engine_scene_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_scene_core_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  add_test(NAME engine_scene_core_tests COMMAND engine_scene_core_tests --reporter compact)
endif()

# premation-plugins: list / render / crash-check plugins without an editor (tools/premation_plugins.cpp).
add_executable(premation-plugins tools/premation_plugins.cpp)
target_link_libraries(premation-plugins PRIVATE engine_plugins motion::options)
if(MSVC)
  target_compile_definitions(premation-plugins PRIVATE _CRT_SECURE_NO_WARNINGS)  # sscanf / getenv in argument parsing
endif()
if(MOTION_BUILD_TESTS)
  # The host against the SDK's sample bundles (native/sdk): load, render at
  # 8/16/32 bpc, sequence data, checkouts, the journal, crash isolation.
  add_executable(engine_plugins_tests tests/test_plugin_host.cpp tests/test_plugin_session.cpp)
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
  src/raster/system_fonts_ffi.cpp # fontconfig family matching (Linux)
  src/raster/svg_doc.cpp          # SVG documents: XML, CSS cascade, path / transform micro-syntax (D2w)
)
target_include_directories(engine_raster_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/raster)
target_compile_features(engine_raster_core PUBLIC cxx_std_20)
target_link_libraries(engine_raster_core PUBLIC motion::jsmath ${CMAKE_DL_LIBS} PRIVATE motion::options)
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
                 tests/test_svg_doc.cpp)
  target_link_libraries(engine_raster_tests PRIVATE engine_raster_core motion::options Catch2::Catch2WithMain)
  target_compile_definitions(engine_raster_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
  if(TARGET engine_raster)
    target_sources(engine_raster_tests PRIVATE tests/test_raster_canvas.cpp)
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
target_link_libraries(engine_canvas_effects PUBLIC engine_raster_core motion::jsmath PRIVATE engine_effects motion::options)

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
  add_executable(engine_effects_tests tests/test_effect_kernels.cpp tests/test_canvas_effects.cpp tests/test_effect_chain.cpp)
  target_link_libraries(engine_effects_tests PRIVATE engine_effect_chain engine_effects engine_canvas_effects engine_raster_core motion::options Catch2::Catch2WithMain)
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
  target_link_libraries(engine_audio PUBLIC engine_audio_core ${FFMPEG_LIBRARIES} PRIVATE motion::options)
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
    src/scene/effects_spatial.cpp
    src/scene/effects_spatial_a.cpp
    src/scene/effects_spatial_b.cpp
    src/scene/layer_styles.cpp
    src/scene/path_ops.cpp
    src/scene/snapshot_build.cpp
    src/scene/threed_port.cpp
    src/scene/threed_frame.cpp
    src/scene/light_wash.cpp
    src/scene/frame_build.cpp
    src/scene/text_measure.cpp
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
    src/plugins/scene_native_fx.cpp
    src/plugins/scene_finish.cpp
  )
  target_include_directories(engine_scene PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/scene)
  target_include_directories(engine_scene PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../libs/motion_eval)  # eval.hpp: text selectors' ease (text_port.cpp)
  target_link_libraries(engine_scene PUBLIC engine_core engine_scene_core engine_plugins engine_raster engine_render_graph PRIVATE motion::options)
  if(WIN32)
    target_link_libraries(engine_scene PRIVATE windowscodecs ole32)  # WIC: still-image footage (image_decode_ffi.cpp)
  endif()
  if(TARGET engine_media_gpu)
    target_link_libraries(engine_scene PUBLIC engine_media_gpu)
    target_compile_definitions(engine_scene PUBLIC PREMATION_HAVE_MEDIA=1)
    target_include_directories(engine_scene SYSTEM PRIVATE ${FFMPEG_INCLUDE_DIRS})
  endif()
  if(MSVC)
    target_compile_options(engine_scene PRIVATE /bigobj)
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
    add_executable(engine_scene_tests tests/test_scene_color.cpp tests/test_text_port_parity.cpp)
    target_compile_definitions(engine_scene_tests PRIVATE PREMATION_ENGINE_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data")
    target_link_libraries(engine_scene_tests PRIVATE engine_scene motion::options Catch2::Catch2WithMain)
    if(MSVC)
      target_compile_options(engine_scene_tests PRIVATE /bigobj)
    endif()
    add_test(NAME engine_scene_tests COMMAND engine_scene_tests --reporter compact)
  endif()

  # engine_frames: the scene builder + render graph + audio wired into the
  # engine process (Session's FrameBuilder / MediaClock hooks, the render
  # thread's BuiltFrameDrawer). premation-engine uses it when present.
  if(TARGET engine_gpu AND TARGET premation-engine)
    add_library(engine_frames STATIC src/scene/engine_frames.cpp)
    target_link_libraries(engine_frames PUBLIC engine_scene engine_gpu engine_plugins_gpu PRIVATE motion::options)
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
  target_sources(engine_tests PRIVATE tests/test_session_hooks.cpp)
endif()
