# A plugin for Premation, built against the SDK release artifact.
#
#   cmake -B build -DCMAKE_PREFIX_PATH=/path/to/premation-sdk
#   cmake --build build --config Release
#   → build/plugins/invert/{premation-plugin.json, <binary>}
cmake_minimum_required(VERSION 3.25)
project(invert_plugin LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)

find_package(PremationSdk 1.0 REQUIRED)
premation_add_plugin(invert SOURCES src/invert.cpp MANIFEST premation-plugin.json)
target_include_directories(invert PRIVATE ${PREMATION_SDK_TOOLS_DIR}/samples/common)
