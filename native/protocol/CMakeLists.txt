# premation_protocol — the engine API structs + codec generated from
# packages/engine-api/schema (docs/ENGINE_API.md). A SEPARATE CMake project
# from native/CMakeLists.txt so it builds and tests on its own, with no vcpkg
# dependencies at all:
#
#     node native/protocol/build.mjs            configure + build + test (+ bench)
#
# or by hand:  cmake --preset windows-clang-cl && cmake --build --preset windows-clang-cl
#              && ctest --preset windows-clang-cl
#
# The warning set and -ffp-contract=off come from ../cmake/warnings.cmake, the
# same motion::options every native target links (read, not modified, here).

cmake_minimum_required(VERSION 3.25)

project(PremationProtocol
  VERSION 1.0.0
  DESCRIPTION "Premation engine API: generated structs and canonical binary codec"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(PROTOCOL_BUILD_TESTS "Build the round-trip test" ON)
option(PROTOCOL_BUILD_BENCH "Build the codec benchmark" ON)

include(${CMAKE_CURRENT_SOURCE_DIR}/../cmake/warnings.cmake)
include(${CMAKE_CURRENT_SOURCE_DIR}/../cmake/sanitizers.cmake)

add_library(premation_protocol STATIC generated/engine_api.cpp)
add_library(premation::protocol ALIAS premation_protocol)
target_include_directories(premation_protocol PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/generated)
target_link_libraries(premation_protocol PRIVATE motion::options)
if(MSVC)
  # One translation unit holds ~300 structs and a 118-alternative variant.
  target_compile_options(premation_protocol PRIVATE /bigobj)
endif()

if(PROTOCOL_BUILD_TESTS)
  enable_testing()
  add_executable(protocol_tests tests/test_protocol.cpp)
  target_link_libraries(protocol_tests PRIVATE premation::protocol motion::options)
  add_test(NAME protocol_tests COMMAND protocol_tests)
endif()

if(PROTOCOL_BUILD_BENCH)
  add_executable(protocol_bench bench/bench_protocol.cpp)
  target_link_libraries(protocol_bench PRIVATE premation::protocol motion::options)
endif()
