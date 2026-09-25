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
#     rings     generator with sequence data and a button (USER_CHANGED_PARAM)
#     checkout  layer checkouts: another layer (Layer Displace — on the GPU too
#               where Dawn's headers are), own layer at other times (Time Echo)
#     grade     GPU effect (SMART_RENDER_GPU on the engine's Dawn device) + CPU
#               fallback — needs Dawn's headers, so only with the `engine` feature

add_library(premation_sdk INTERFACE)
target_include_directories(premation_sdk INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(premation_sdk INTERFACE cxx_std_20)
add_library(premation::sdk ALIAS premation_sdk)

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
endfunction()

premation_sample_plugin(ripple samples/ripple/ripple.cpp)
premation_sample_plugin(rings samples/rings/rings.cpp)
premation_sample_plugin(checkout samples/checkout/checkout.cpp)

# The GPU samples call WebGPU through the proc table the host hands over, so
# they link no Dawn — they need only the headers (webgpu.h, dawn_proc_table.h).
find_package(Dawn CONFIG QUIET)
if(TARGET dawn::webgpu_dawn)
  premation_sample_plugin(grade samples/grade/grade.cpp)
  target_include_directories(grade PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_include_directories(checkout PRIVATE $<TARGET_PROPERTY:dawn::webgpu_dawn,INTERFACE_INCLUDE_DIRECTORIES>)
  target_compile_definitions(checkout PRIVATE PRS_SAMPLE_GPU)
endif()
