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
