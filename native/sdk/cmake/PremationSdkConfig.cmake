# find_package(PremationSdk) — the Premation native plugin SDK (docs/PLUGIN_SDK.md).
#
#   find_package(PremationSdk 1.0 REQUIRED)
#   premation_add_plugin(glow
#     SOURCES glow.cpp
#     MANIFEST premation-plugin.json)
#
# builds `glow` as a module and lays it out as an installable BUNDLE at
# <build>/plugins/glow/{premation-plugin.json, <binary>} — the folder
# premation-engine loads and scripts/pack-plugin.mjs packs. The binary is
# named the way the manifest's `binary` keys expect: libX.dylib on macOS,
# X.dll on Windows, libX.so on Linux.

include(CMakeFindDependencyMacro)
include("${CMAKE_CURRENT_LIST_DIR}/PremationSdkTargets.cmake")

get_filename_component(_premation_sdk_prefix "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
set(PREMATION_SDK_TOOLS_DIR "${_premation_sdk_prefix}/share/premation-sdk")
find_program(PREMATION_PLUGINS_TOOL premation-plugins HINTS "${_premation_sdk_prefix}/bin" NO_DEFAULT_PATH)

function(premation_add_plugin name)
  cmake_parse_arguments(PARSE_ARGV 1 arg "" "MANIFEST" "SOURCES")
  if(NOT arg_SOURCES OR NOT arg_MANIFEST)
    message(FATAL_ERROR "premation_add_plugin(${name} SOURCES … MANIFEST premation-plugin.json)")
  endif()
  add_library(${name} MODULE ${arg_SOURCES})
  target_link_libraries(${name} PRIVATE premation::sdk)
  set(_dir ${CMAKE_BINARY_DIR}/plugins/${name})
  set_target_properties(${name} PROPERTIES
    OUTPUT_NAME ${name}
    LIBRARY_OUTPUT_DIRECTORY $<1:${_dir}>
    RUNTIME_OUTPUT_DIRECTORY $<1:${_dir}>
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON)
  if(APPLE)
    set_target_properties(${name} PROPERTIES PREFIX "lib" SUFFIX ".dylib")
  elseif(WIN32)
    set_target_properties(${name} PROPERTIES PREFIX "" SUFFIX ".dll")
  else()
    set_target_properties(${name} PROPERTIES PREFIX "lib" SUFFIX ".so")
  endif()
  configure_file(${arg_MANIFEST} ${_dir}/premation-plugin.json COPYONLY)
  set_property(TARGET ${name} PROPERTY PREMATION_BUNDLE_DIR ${_dir})
endfunction()

# fxkit (docs/PLUGIN_SDK.md "Writing effects in WGSL: fxkit"):
#
#   premation_add_fx_plugin(myfx PROJECT ${CMAKE_CURRENT_SOURCE_DIR})
#
# PROJECT holds fxkit.json and fx/*.fx. When Node is found, the build regenerates
# PROJECT/gen/* and PROJECT/premation-plugin.json from them first; without Node it
# builds the committed gen/. Pass DAWN_INCLUDE_DIR (webgpu.h, dawn_proc_table.h) for
# the GPU path; without it the plugin renders on its CPU twin only.
set(PREMATION_FXKIT_DIR "${PREMATION_SDK_TOOLS_DIR}/fxkit")
find_program(PREMATION_NODE node)

function(premation_add_fx_plugin name)
  cmake_parse_arguments(PARSE_ARGV 1 arg "" "PROJECT;DAWN_INCLUDE_DIR" "")
  if(NOT arg_PROJECT)
    message(FATAL_ERROR "premation_add_fx_plugin(${name} PROJECT <dir with fxkit.json and fx/>)")
  endif()
  set(_gen ${arg_PROJECT}/gen/fx_gen.hpp)
  if(PREMATION_NODE)
    # Once now, so the manifest exists for premation_add_plugin; then on every build that
    # changed an .fx (the custom command below), with the manifest re-copied after the link.
    execute_process(COMMAND ${PREMATION_NODE} ${PREMATION_FXKIT_DIR}/fxkit.mjs ${arg_PROJECT}
      RESULT_VARIABLE _fxkit_rc OUTPUT_VARIABLE _fxkit_out ERROR_VARIABLE _fxkit_err)
    if(NOT _fxkit_rc EQUAL 0)
      message(FATAL_ERROR "fxkit (${name}):\n${_fxkit_err}${_fxkit_out}")
    endif()
    file(GLOB _fx CONFIGURE_DEPENDS ${arg_PROJECT}/fx/*.fx)
    add_custom_command(OUTPUT ${_gen} ${arg_PROJECT}/gen/lib.inc ${arg_PROJECT}/premation-plugin.json
      COMMAND ${PREMATION_NODE} ${PREMATION_FXKIT_DIR}/fxkit.mjs ${arg_PROJECT}
      DEPENDS ${_fx} ${arg_PROJECT}/fxkit.json ${PREMATION_FXKIT_DIR}/fxkit.mjs
      COMMENT "fxkit: ${name}"
      VERBATIM)
  elseif(NOT EXISTS ${_gen})
    message(FATAL_ERROR "premation_add_fx_plugin(${name}): no Node to run fxkit.mjs and no committed ${_gen}")
  endif()
  premation_add_plugin(${name} SOURCES ${PREMATION_FXKIT_DIR}/fxkit_plugin.cpp ${_gen} MANIFEST ${arg_PROJECT}/premation-plugin.json)
  target_include_directories(${name} PRIVATE ${arg_PROJECT})
  get_target_property(_bundle ${name} PREMATION_BUNDLE_DIR)
  add_custom_command(TARGET ${name} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${arg_PROJECT}/premation-plugin.json ${_bundle}/premation-plugin.json
    VERBATIM)
  # The CPU twin must run the WGSL's maths: nothing fused behind the generator's back.
  if(MSVC)
    target_compile_options(${name} PRIVATE /utf-8 /EHsc /bigobj /clang:-ffp-contract=off)
  else()
    target_compile_options(${name} PRIVATE -ffp-contract=off)
  endif()
  if(arg_DAWN_INCLUDE_DIR)
    target_include_directories(${name} PRIVATE ${arg_DAWN_INCLUDE_DIR})
    target_compile_definitions(${name} PRIVATE FXKIT_GPU=1)
  endif()
endfunction()
