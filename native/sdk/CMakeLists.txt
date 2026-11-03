# Premation native plugin SDK (G1, docs/PLUGIN_SDK.md).
#
#   premation_sdk     the public headers (include/premation_sdk) as an INTERFACE
#                     target — all a plugin needs to build.
#   sample plugins    one MODULE per sample, each laid out as an installable
#                     BUNDLE: <build>/plugins/<name>/{premation-plugin.json, binary}
#                     — the folder layout the engine's plugin scan loads
#                     (PREMATION_PLUGIN_PATH / --plugins), and what the host tests use.
#
#     ripple    CPU effect, smart render, 8/16/32 bpc, threaded rows
#     rings     generator with sequence data and a button (USER_CHANGED_PARAM); SDK 1.1 overlay + panel (ui/)
#     grademap  SDK 1.1 STRING / CURVE / GRADIENT / FILE params (a 1D .cube LUT via get_asset_bytes)
#     checkout  layer checkouts: another layer (Layer Displace — on the GPU too
#               where Dawn's headers are), own layer at other times (Time Echo)
#     distribute / ppmio / ppmseq / statspanel   SDK 1.2 plugins that are not effects: a command,
#               an importer, an output module, a panel (docs/PLUGIN_SDK.md "Commands" …)
#     model3d   SDK 1.2 Element 3D class: a glTF model through the comp camera and lights, motion
#               blur, scene-depth occlusion, an overlay handle and a material panel (GPU with Dawn's
#               headers, CPU always); its test assets in samples/model3d/models
#     grade     GPU effect (SMART_RENDER_GPU on the engine's Dawn device) + CPU
#               fallback — needs Dawn's headers, so only with the `engine` feature
#     fxkit     two effects written once in WGSL (fxkit/, docs/PLUGIN_SDK.md "fxkit"): the GPU path
#               is the WGSL, the CPU path its generated C++ twin; gen/ is committed and
#               `node fxkit/fxkit.mjs samples/fxkit --check` holds it to fx/*.fx

add_library(premation_sdk INTERFACE)
target_include_directories(premation_sdk INTERFACE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>)
target_compile_features(premation_sdk INTERFACE cxx_std_20)
add_library(premation::sdk ALIAS premation_sdk)

# ── The SDK release artifact (AE parity 2.2, docs/PLUGIN_STORE.md) ──────────
#   cmake --install <build> --component sdk --prefix premation-sdk
# lays out what a plugin author downloads from a release:
#   include/premation_sdk/*.h                   the headers
#   lib/cmake/PremationSdk/                     find_package(PremationSdk) →
#                                               premation::sdk + premation_add_plugin()
#   bin/premation-plugins[.exe]                 list / render / crash-check a bundle
#                                               (installed by engine/CMakeLists.txt)
#   share/premation-sdk/{pack,sign}-plugin.mjs  package + sign for the store
#   share/premation-sdk/create-premation-plugin.mjs  start a plugin project (effect / fx / command)
#   share/premation-sdk/fxkit/                  WGSL → C++ twin generator + runtime (premation_add_fx_plugin)
#   share/premation-sdk/samples/                the sample plugins (+ common/sample_util.hpp)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
set_target_properties(premation_sdk PROPERTIES EXPORT_NAME sdk)
install(TARGETS premation_sdk EXPORT PremationSdkTargets COMPONENT sdk)
install(DIRECTORY include/premation_sdk DESTINATION ${CMAKE_INSTALL_INCLUDEDIR} COMPONENT sdk)
install(EXPORT PremationSdkTargets NAMESPACE premation:: DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PremationSdk COMPONENT sdk)
file(READ include/premation_sdk/pr_types.h _pr_types)
string(REGEX MATCH "#define PR_SDK_VERSION_MAJOR +([0-9]+)" _ ${_pr_types})
set(_sdk_major ${CMAKE_MATCH_1})
string(REGEX MATCH "#define PR_SDK_VERSION_MINOR +([0-9]+)" _ ${_pr_types})
set(_sdk_minor ${CMAKE_MATCH_1})
write_basic_package_version_file(${CMAKE_CURRENT_BINARY_DIR}/PremationSdkConfigVersion.cmake
  VERSION ${_sdk_major}.${_sdk_minor} COMPATIBILITY SameMajorVersion ARCH_INDEPENDENT)
install(FILES cmake/PremationSdkConfig.cmake ${CMAKE_CURRENT_BINARY_DIR}/PremationSdkConfigVersion.cmake
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PremationSdk COMPONENT sdk)
install(DIRECTORY samples/ DESTINATION ${CMAKE_INSTALL_DATADIR}/premation-sdk/samples COMPONENT sdk)
# fxkit: the WGSL → C++ twin generator, its runtime headers and plugin source (docs/PLUGIN_SDK.md "fxkit").
install(DIRECTORY fxkit/include/premation_fxkit DESTINATION ${CMAKE_INSTALL_INCLUDEDIR} COMPONENT sdk)
install(FILES fxkit/fxkit.mjs fxkit/prelude.wgsl fxkit/std.fx fxkit/src/fxkit_plugin.cpp
  DESTINATION ${CMAKE_INSTALL_DATADIR}/premation-sdk/fxkit COMPONENT sdk)
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/pack-plugin.mjs ${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/sign-plugin.mjs
              ${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/create-premation-plugin.mjs
  DESTINATION ${CMAKE_INSTALL_DATADIR}/premation-sdk COMPONENT sdk)

set(PREMATION_PLUGIN_BUNDLES ${CMAKE_BINARY_DIR}/plugins CACHE INTERNAL "Where the sample plugin bundles are laid out")

function(premation_sample_plugin name)
  add_library(${name} MODULE ${ARGN})
  target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/samples/common)
  target_link_libraries(${name} PRIVATE premation::sdk motion::options)
  set(_dir ${PREMATION_PLUGIN_BUNDLES}/${name})
  # $<1:…> keeps multi-config generators from appending a per-config folder:
  # the bundle is always <plugins>/<name>/.
  set_target_properties(${name} PROPERTIES
    OUTPUT_NAME ${name}
    LIBRARY_OUTPUT_DIRECTORY $<1:${_dir}>
    RUNTIME_OUTPUT_DIRECTORY $<1:${_dir}>
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON)
  # The manifests name libX.so / libX.dylib / X.dll.
  if(APPLE)
    set_target_properties(${name} PROPERTIES PREFIX "lib" SUFFIX ".dylib")
  elseif(WIN32)
    set_target_properties(${name} PROPERTIES PREFIX "" SUFFIX ".dll")
  else()
    set_target_properties(${name} PROPERTIES PREFIX "lib" SUFFIX ".so")
  endif()
  configure_file(${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/premation-plugin.json ${_dir}/premation-plugin.json COPYONLY)
  # SDK 1.1: a sample with a panel ships samples/<name>/ui/ as the bundle's ui/.
  file(GLOB _ui RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/ui ${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/ui/*)
  foreach(_f IN LISTS _ui)
    configure_file(${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/ui/${_f} ${_dir}/ui/${_f} COPYONLY)
  endforeach()
  # SDK 1.2: a sample's presets/*.json ship as the bundle's presets/.
  file(GLOB _presets RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/presets ${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/presets/*.json)
  foreach(_f IN LISTS _presets)
    configure_file(${CMAKE_CURRENT_SOURCE_DIR}/samples/${name}/presets/${_f} ${_dir}/presets/${_f} COPYONLY)
  endforeach()
endfunction()

premation_sample_plugin(ripple samples/ripple/ripple.cpp)
premation_sample_plugin(rings samples/rings/rings.cpp)
premation_sample_plugin(checkout samples/checkout/checkout.cpp)
premation_sample_plugin(particles samples/particles/particles.cpp)  # SDK 1.1: comp camera, lights, layer transforms; 1.2: trails + shutter blur (checkout_time), presets
premation_sample_plugin(grademap samples/grademap/grademap.cpp)    # SDK 1.1: STRING / CURVE / GRADIENT / FILE params
premation_sample_plugin(distribute samples/distribute/distribute.cpp)  # SDK 1.2: a command (Plugins menu), engine API edits
premation_sample_plugin(ppmio samples/ppmio/ppmio.cpp)              # SDK 1.2: a footage importer (.ppm / .pfm)
premation_sample_plugin(ppmseq samples/ppmseq/ppmseq.cpp)           # SDK 1.2: an output module (a .ppm sequence)
premation_sample_plugin(chartlayer samples/chartlayer/chartlayer.cpp)  # SDK 1.4: a plugin LAYER TYPE (manifest layerTypes) drawn by a generator
premation_sample_plugin(statspanel samples/statspanel/statspanel.cpp)  # SDK 1.2: a panel without an effect (+ a command)
premation_sample_plugin(silkwaves samples/silkwaves/silkwaves.cpp)  # Silk Waves: a looping silk/light generator (GPU with Dawn's headers, CPU always)

# fxkit: one module from samples/fxkit/fx/*.fx (generated into samples/fxkit/gen/).
premation_sample_plugin(fxkit fxkit/src/fxkit_plugin.cpp)
target_include_directories(fxkit PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/samples/fxkit ${CMAKE_CURRENT_SOURCE_DIR}/fxkit/include)

premation_sample_plugin(model3d samples/model3d/model3d.cpp)  # SDK 1.2: glTF, camera + lights, shutter blur, scene depth (S8)
foreach(_f box.glb box.gltf box.bin checker.png)
  configure_file(${CMAKE_CURRENT_SOURCE_DIR}/samples/model3d/models/${_f} ${PREMATION_PLUGIN_BUNDLES}/model3d/models/${_f} COPYONLY)
endforeach()

# The GPU samples call WebGPU through the proc table the host hands over, so
# they link no Dawn — they need only the headers (webgpu.h, dawn_proc_table.h).
find_package(Dawn CONFIG QUIET)
if(TARGET dawn::webgpu_dawn)
  premation_sample_plugin(grade samples/grade/grade.cpp)
  target_include_directories(grade PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_include_directories(checkout PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_compile_definitions(checkout PRIVATE PRS_SAMPLE_GPU)
  target_include_directories(model3d PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_compile_definitions(model3d PRIVATE PRS_SAMPLE_GPU)
  target_include_directories(silkwaves PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_compile_definitions(silkwaves PRIVATE PRS_SAMPLE_GPU)
  target_include_directories(fxkit PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_compile_definitions(fxkit PRIVATE FXKIT_GPU=1)
endif()
