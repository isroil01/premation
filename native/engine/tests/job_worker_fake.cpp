// A stand-in for `premation-engine --job-worker FILE` (test_job_worker.cpp):
// the real worker loop (job_worker.cpp worker_main) over fake works —
//   count   answers how many requests this process has served (reuse / restart)
//   echo    answers its input, after one progress line
//   sleep   waits input.ms (checking its control every 20 ms: a cancel ends it early), then answers
//   hang    waits input.ms without ever looking at its control (a work stuck inside a model call)
//   tick    input.n progress lines 100 ms apart, then answers (a long walk)
//   crash   dies without a word (exit 3), as a model runtime crash would
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

#include "child_job.hpp"
#include "job_worker.hpp"
#include "json.hpp"

namespace jobs = premation::jobs;
namespace js = premation::js;

int main(int argc, char** argv) {
  if (argc < 3 || std::string(argv[1]) != "--job-worker") return 64;
  static int served = 0;
  jobs::register_child_work("count", [](const std::string&, jobs::JobControl&) {
    ++served;
    return "{\"served\":" + std::to_string(served) + "}";
  });
  jobs::register_child_work("echo", [](const std::string& in, jobs::JobControl& c) {
    ++served;
    c.progress(0.5, "half");
    return in;
  });
  jobs::register_child_work("sleep", [](const std::string& in, jobs::JobControl& c) {
    ++served;
    const std::optional<js::Json> j = js::parse(in);
    const double ms = j && j->at("ms").is_number() ? j->at("ms").num() : 100;
    const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(ms));
    while (std::chrono::steady_clock::now() < until && !c.cancelled()) std::this_thread::sleep_for(std::chrono::milliseconds(20));
    return std::string("{\"slept\":true}");
  });
  jobs::register_child_work("hang", [](const std::string& in, jobs::JobControl&) {
    ++served;
    const std::optional<js::Json> j = js::parse(in);
    const double ms = j && j->at("ms").is_number() ? j->at("ms").num() : 100;
    std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<long long>(ms)));
    return std::string("{\"hung\":true}");
  });
  jobs::register_child_work("tick", [](const std::string& in, jobs::JobControl& c) {
    ++served;
    const std::optional<js::Json> j = js::parse(in);
    const int n = j && j->at("n").is_number() ? static_cast<int>(j->at("n").num()) : 5;
    for (int i = 0; i < n && !c.cancelled(); ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      c.progress(static_cast<double>(i + 1) / n, "tick");
    }
    return std::string("{\"ticked\":true}");
  });
  jobs::register_child_work("crash", [](const std::string&, jobs::JobControl&) -> std::string {
    std::cout.flush();
    std::_Exit(3);
  });
  return jobs::worker_main(argv[2], std::cin, std::cout);
}
