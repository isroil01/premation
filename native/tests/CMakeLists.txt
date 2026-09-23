# Catch2 v3 suite. `ctest --preset <name>` runs it; the executable itself
# takes Catch2's own filters (`motion_tests "[golden]"`).

find_package(Catch2 3 CONFIG REQUIRED)

add_executable(motion_tests
  test_abi.cpp
  test_eval.cpp
  test_jsmath.cpp
  test_expr.cpp
  test_transform.cpp
)

# test_eval.cpp reaches into eval.hpp (the internal half) for the easing
# functions; the C ABI tests go through include/motion only.
target_include_directories(motion_tests PRIVATE ${PROJECT_SOURCE_DIR}/libs/motion_eval)

target_link_libraries(motion_tests PRIVATE
  motion::eval
  motion::jsmath
  motion::expr
  motion::transform
  motion::options
  Catch2::Catch2WithMain
)

# The expression goldens nest 1 500 parentheses and 512-deep evaluations (the
# TypeScript's limits). That fits Windows' default 1 MB main-thread stack in a
# normal build but not with ASan's inflated frames; Linux/macOS default to 8 MB.
if(MSVC)
  target_link_options(motion_tests PRIVATE /STACK:16777216)
endif()

# A plain add_test rather than catch_discover_tests: discovery runs the binary
# at build time, which under TSan/ASan on a shared runner is one more thing to
# go wrong for no gain at this size.
add_test(NAME motion_tests COMMAND motion_tests --reporter compact)
