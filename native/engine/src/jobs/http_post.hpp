// One HTTPS POST from a job's worker thread (the transcribe job's call to the
// user's speech provider). The OS call lives in http_post_ffi_win.cpp (WinHTTP)
// or http_post_ffi_curl.cpp (libcurl: macOS / Linux); a build with neither
// answers `false` with an error (http_post_ffi_none.cpp).
//
// Header VALUES may carry a credential: nothing here logs a header, the URL
// or the body, and the buffers are the caller's.
#pragma once

#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::jobs {

struct HttpResponse {
  int status = 0;
  std::string body;
};

struct HttpPost {
  /// `https://host[:port]/path` (plain `http://` is accepted for local test servers only).
  std::string url;
  /// name, value — e.g. {"Authorization", "Bearer …"}, {"Content-Type", "multipart/form-data; boundary=…"}.
  std::vector<std::pair<std::string, std::string>> headers;
  std::span<const std::uint8_t> body;
  /// Whole-request limit, seconds.
  int timeoutSeconds = 300;
};

/// Send `req`; true with `out` filled when a response arrived (any status),
/// false with `error` when there was none (no network, TLS failure, timeout,
/// cancelled). `cancelled` is polled while the request runs (may be empty).
bool http_post(const HttpPost& req, HttpResponse& out, std::string& error, const std::function<bool()>& cancelled);

/// Is there an HTTP implementation in this build?
[[nodiscard]] bool http_available() noexcept;

}  // namespace premation::jobs
