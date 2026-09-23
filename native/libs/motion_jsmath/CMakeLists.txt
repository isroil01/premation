# motion_jsmath — JavaScript Math + Number<->String semantics, bit for bit with
# V8 (fdlibm port, exact number formatting/parsing). Below motion_expr and
# motion_transform, which must compute sin/cos/atan2/hypot exactly as the
# TypeScript engine running on V8 does.

add_library(motion_jsmath STATIC
  fdlibm.cpp
  numconv.cpp
)
add_library(motion::jsmath ALIAS motion_jsmath)
target_include_directories(motion_jsmath PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(motion_jsmath PUBLIC cxx_std_20)
target_link_libraries(motion_jsmath PRIVATE motion::options)
