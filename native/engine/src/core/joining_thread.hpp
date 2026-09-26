// A std::thread that joins when it is destroyed or reassigned — the part of
// std::jthread the engine uses, without it. Apple clang's libc++ still gates
// std::jthread / std::stop_token behind -fexperimental-library, so the engine
// never names them; a worker that must stop early is told so by its own flag
// under its own mutex (see effects/thread_pool.cpp).
#pragma once

#include <thread>
#include <type_traits>
#include <utility>

namespace premation {

class JoiningThread {
 public:
  JoiningThread() noexcept = default;

  template <class F, class... Args,
            class = std::enable_if_t<!std::is_same_v<std::remove_cvref_t<F>, JoiningThread>>>
  explicit JoiningThread(F&& f, Args&&... args) : t_(std::forward<F>(f), std::forward<Args>(args)...) {}

  ~JoiningThread() { join(); }

  JoiningThread(const JoiningThread&) = delete;
  JoiningThread& operator=(const JoiningThread&) = delete;
  JoiningThread(JoiningThread&& o) noexcept = default;
  /// Joins the thread this one held before taking `o`'s (as std::jthread does).
  JoiningThread& operator=(JoiningThread&& o) noexcept {
    if (this != &o) {
      join();
      t_ = std::move(o.t_);
    }
    return *this;
  }

  [[nodiscard]] bool joinable() const noexcept { return t_.joinable(); }
  void join() {
    if (t_.joinable()) t_.join();
  }

 private:
  std::thread t_;
};

}  // namespace premation
