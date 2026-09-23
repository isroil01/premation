# motion_eval — keyframe sampling (N1). Bottom of the library order:
# motion_kernels → motion_eval; nothing here depends on another motion lib.
#
# Static: the N-API addon and the WASM module each link it into their own
# binary. There is no shared-library form, so nothing depends on symbol
# visibility rules across platforms (MOTION_API is a no-op on Windows without
# MOTION_BUILD_SHARED).

add_library(motion_eval STATIC
  eval.cpp
  motion_eval.cpp
  motion_abi.cpp
)
add_library(motion::eval ALIAS motion_eval)

target_include_directories(motion_eval
  PUBLIC  ${PROJECT_SOURCE_DIR}/include   # the C ABI, for every consumer
  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}     # eval.hpp, internal
)

target_compile_features(motion_eval PUBLIC cxx_std_20)
target_link_libraries(motion_eval PRIVATE motion::options)

# The libraries above motion_eval in the §3 order. Added from here (rather
# than the top-level CMakeLists) so each new library lands without touching
# the workspace file; the binary dirs mirror libs/<name>.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../motion_jsmath ${CMAKE_CURRENT_BINARY_DIR}/../motion_jsmath)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../motion_expr ${CMAKE_CURRENT_BINARY_DIR}/../motion_expr)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../motion_transform ${CMAKE_CURRENT_BINARY_DIR}/../motion_transform)
