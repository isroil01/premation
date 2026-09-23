# motion_transform — layer transforms, parent chains, 3D compose, the camera
# (packages/scene/src/utils/{matrix,matrix4,project3d}.ts and the
# src/core/scene composition around them). C ABI: include/motion/motion_transform.h.
# Depends on motion_jsmath: sin/cos/tan/atan/atan2/hypot must be V8's.

add_library(motion_transform STATIC
  transform.cpp
  motion_transform.cpp
)
add_library(motion::transform ALIAS motion_transform)
target_include_directories(motion_transform
  PUBLIC ${PROJECT_SOURCE_DIR}/include ${CMAKE_CURRENT_SOURCE_DIR}
)
target_compile_features(motion_transform PUBLIC cxx_std_20)
target_link_libraries(motion_transform PUBLIC motion::jsmath motion::eval PRIVATE motion::options)
