# Premation native core — workspace (docs/NATIVE_CORE_PLAN.md §3).
#
# Configure through a preset, never by hand:
#     cmake --preset linux-clang        (macos-clang, windows-clang-cl, wasm, *-asan, *-tsan)
#     cmake --build --preset linux-clang
#     ctest --preset linux-clang
# or, from the repo root, `npm run native:configure|build|test` which picks the
# preset for this OS (scripts/native.mjs).
#
# Options
#   MOTION_BUILD_TESTS   Catch2 suite (needs vcpkg)              default ON
#   MOTION_BUILD_BENCH   Google Benchmark (needs vcpkg)          default ON
#   MOTION_BUILD_NAPI    node-addon-api module; normally built by cmake-js from
#                        bindings/napi instead (see that CMakeLists)   default OFF
#   MOTION_BUILD_WASM    Emscripten glue; the `wasm` preset turns it on  default OFF
#   MOTION_BUILD_ENGINE  premation-engine (Dawn); set together with
#                        VCPKG_MANIFEST_FEATURES=engine — the *-engine presets   default OFF
#   MOTION_SANITIZE      none | asan-ubsan | tsan                 default none

cmake_minimum_required(VERSION 3.25)

project(MotionNative
  VERSION 0.1.0
  DESCRIPTION "Premation native core: motion_eval and the libraries above it"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)   # clang-tidy reads build/<preset>/compile_commands.json
set(CMAKE_POSITION_INDEPENDENT_CODE ON) # the static libs end up inside .node / .wasm

option(MOTION_BUILD_TESTS "Build the Catch2 test suite" ON)
option(MOTION_BUILD_BENCH "Build the Google Benchmark executables" ON)
option(MOTION_BUILD_NAPI "Build the N-API module from the root build (needs cmake-js variables)" OFF)
option(MOTION_BUILD_WASM "Build the Emscripten module (needs the Emscripten toolchain)" OFF)
option(MOTION_BUILD_ENGINE "Build premation-engine (needs the vcpkg `engine` feature: Dawn)" OFF)

# One compiler everywhere (§2). Not fatal — a first-time contributor on a
# gcc-only box should get a warning, not a wall — but CI only ever runs Clang.
if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  message(WARNING "MotionNative is built and gated with Clang; you are using ${CMAKE_CXX_COMPILER_ID}. "
                  "Warnings and codegen may differ from CI.")
endif()

include(cmake/warnings.cmake)    # motion::options — flags every target links
include(cmake/sanitizers.cmake)  # MOTION_SANITIZE → more flags on motion::options

add_subdirectory(libs/motion_eval)

if(MOTION_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()

if(MOTION_BUILD_BENCH)
  add_subdirectory(bench)
endif()

if(MOTION_BUILD_WASM)
  add_subdirectory(bindings/wasm)
endif()

if(MOTION_BUILD_NAPI)
  add_subdirectory(bindings/napi)
endif()

if(MOTION_BUILD_ENGINE)
  add_subdirectory(engine)
endif()
