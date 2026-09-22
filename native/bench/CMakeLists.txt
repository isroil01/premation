# Google Benchmark. Run: build/<preset>/bench/motion_bench --benchmark_min_time=1s
# JSON for the CI ratchet (later): --benchmark_format=json --benchmark_out=…

find_package(benchmark CONFIG REQUIRED)

add_executable(motion_bench bench_eval.cpp)
target_link_libraries(motion_bench PRIVATE
  motion::eval
  motion::options
  benchmark::benchmark_main
)
