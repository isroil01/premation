# N-API addon (node-addon-api) over include/motion, built by cmake-js:
#
#     cd native/bindings/napi
#     npm install
#     npx cmake-js compile                      # Node headers, default toolchain
#     npx cmake-js compile --runtime electron --runtime-version <ver>
#
# cmake-js points CMake at THIS directory, so when it is the top-level source
# the core is pulled in with add_subdirectory(../..) (tests and bench off).
# When the root CMakeLists includes it instead (MOTION_BUILD_NAPI=ON) the core
# already exists and only the addon target is defined — that path needs the
# CMAKE_JS_* variables cmake-js would have set, so it is for IDEs, not builds.
#
# Process placement (§2): this module is loaded by the export process and the
# worker-engine host. It is never required from the editor's renderer.

cmake_minimum_required(VERSION 3.25)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(motion_napi LANGUAGES CXX)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
  set(CMAKE_CXX_EXTENSIONS OFF)
  set(MOTION_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(MOTION_BUILD_BENCH OFF CACHE BOOL "" FORCE)
  set(MOTION_BUILD_NAPI OFF CACHE BOOL "" FORCE)  # we ARE the napi build; no recursion
  add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. ${CMAKE_BINARY_DIR}/motion_native)
endif()

if(NOT DEFINED CMAKE_JS_INC)
  message(FATAL_ERROR "CMAKE_JS_INC is not set: build this directory with `npx cmake-js compile`, not plain cmake.")
endif()

# node-addon-api ships headers only; find them through the package installed
# next to this file (npm install in bindings/napi).
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
  RESULT_VARIABLE NODE_ADDON_API_RESULT
)
if(NOT NODE_ADDON_API_RESULT EQUAL 0 OR NODE_ADDON_API_DIR STREQUAL "")
  message(FATAL_ERROR "node-addon-api not found: run `npm install` in native/bindings/napi first.")
endif()

add_library(motion_napi SHARED motion_napi.cpp ${CMAKE_JS_SRC})
set_target_properties(motion_napi PROPERTIES PREFIX "" SUFFIX ".node")

# The Node and node-addon-api headers are SYSTEM includes: our -Werror set is
# for our code, not for warnings inside napi-inl.h.
target_include_directories(motion_napi SYSTEM PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_compile_definitions(motion_napi PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS)
target_link_libraries(motion_napi PRIVATE motion::eval motion::options ${CMAKE_JS_LIB})

# Windows: Node/Electron resolve the addon's imports from the host executable
# at load time; cmake-js hands us a .def to build the delay-load import lib.
# MSVC's lib.exe is used for the /def step even under clang-cl (it is on PATH
# whenever the VS environment is — which clang-cl needs anyway for the SDK);
# llvm-lib is the fallback.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  find_program(MOTION_LIB_EXE NAMES lib llvm-lib)
  if(NOT MOTION_LIB_EXE)
    set(MOTION_LIB_EXE ${CMAKE_AR})
  endif()
  execute_process(
    COMMAND ${MOTION_LIB_EXE} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS}
  )
endif()
