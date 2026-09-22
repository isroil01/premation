# Catch2 v3 suite. `ctest --preset <name>` runs it; the executable itself
# takes Catch2's own filters (`motion_tests "[golden]"`).

find_package(Catch2 3 CONFIG REQUIRED)

add_executable(motion_tests
  test_abi.cpp
  test_eval.cpp
)

# test_eval.cpp reaches into eval.hpp (the internal half) for the easing
# functions; the C ABI tests go through include/motion only.
target_include_directories(motion_tests PRIVATE ${PROJECT_SOURCE_DIR}/libs/motion_eval)

target_link_libraries(motion_tests PRIVATE
  motion::eval
  motion::options
  Catch2::Catch2WithMain
)

# A plain add_test rather than catch_discover_tests: discovery runs the binary
# at build time, which under TSan/ASan on a shared runner is one more thing to
# go wrong for no gain at this size.
add_test(NAME motion_tests COMMAND motion_tests --reporter compact)
