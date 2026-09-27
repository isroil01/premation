// http_post.hpp on Windows: WinHTTP (the OS's own HTTP stack and its TLS —
// no bundled OpenSSL). Synchronous calls on the job's worker thread; a
// watcher closes the request handle when the job is cancelled, which ends
// the blocking call.
#include "http_post.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>

namespace premation::jobs {

namespace {

std::wstring widen(std::string_view s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<std::size_t>(n), L'\0');
  (void)MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

struct Handle {
  HINTERNET h = nullptr;
  Handle() = default;
  explicit Handle(HINTERNET x) : h(x) {}
  ~Handle() {
    if (h != nullptr) (void)WinHttpCloseHandle(h);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&&) = delete;
  Handle& operator=(Handle&&) = delete;
};

std::string last_error(const char* what) { return std::string(what) + " failed (WinHTTP error " + std::to_string(GetLastError()) + ")"; }

}  // namespace

bool http_available() noexcept { return true; }

bool http_post(const HttpPost& req, HttpResponse& out, std::string& error, const std::function<bool()>& cancelled) {
  const std::wstring url = widen(req.url);
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  std::wstring host(256, L'\0');
  std::wstring path(2048, L'\0');
  parts.lpszHostName = host.data();
  parts.dwHostNameLength = static_cast<DWORD>(host.size());
  parts.lpszUrlPath = path.data();
  parts.dwUrlPathLength = static_cast<DWORD>(path.size());
  if (WinHttpCrackUrl(url.c_str(), 0, 0, &parts) == FALSE) {
    error = "the request URL could not be read";
    return false;
  }
  host.resize(parts.dwHostNameLength);
  path.resize(parts.dwUrlPathLength);
  const bool tls = parts.nScheme == INTERNET_SCHEME_HTTPS;

  Handle session(WinHttpOpen(L"Premation-Engine/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                             WINHTTP_NO_PROXY_BYPASS, 0));
  if (session.h == nullptr) {
    // Windows before 8.1 has no AUTOMATIC_PROXY.
    session.h = WinHttpOpen(L"Premation-Engine/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  }
  if (session.h == nullptr) {
    error = last_error("WinHttpOpen");
    return false;
  }
  const int ms = std::max(1, req.timeoutSeconds) * 1000;
  (void)WinHttpSetTimeouts(session.h, ms, ms, ms, ms);
  Handle connect(WinHttpConnect(session.h, host.c_str(), parts.nPort, 0));
  if (connect.h == nullptr) {
    error = last_error("WinHttpConnect");
    return false;
  }
  HINTERNET request = WinHttpOpenRequest(connect.h, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                         tls ? WINHTTP_FLAG_SECURE : 0);
  if (request == nullptr) {
    error = last_error("WinHttpOpenRequest");
    return false;
  }
  // No redirects: the credential goes to the host named and nowhere else.
  DWORD redirect = WINHTTP_DISABLE_REDIRECTS;
  (void)WinHttpSetOption(request, WINHTTP_OPTION_DISABLE_FEATURE, &redirect, sizeof(redirect));

  // Cancel: close the request from a watcher (ends the blocking call). The
  // mutex makes exactly one side close it.
  std::mutex closeMu;
  bool closed = false;
  std::atomic<bool> finished{false};
  std::atomic<bool> wasCancelled{false};
  const auto close_request = [&] {
    const std::lock_guard<std::mutex> lock(closeMu);
    if (!closed) {
      (void)WinHttpCloseHandle(request);
      closed = true;
    }
  };
  std::thread watcher;
  if (cancelled) {
    watcher = std::thread([&] {
      while (!finished.load()) {
        if (cancelled()) {
          wasCancelled = true;
          close_request();
          return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
  }
  const auto done = [&](bool ok) {
    finished = true;
    if (watcher.joinable()) watcher.join();
    close_request();
    if (wasCancelled.load()) {
      error = "cancelled";
      return false;
    }
    return ok;
  };

  std::wstring headers;
  for (const auto& [name, value] : req.headers) headers += widen(name) + L": " + widen(value) + L"\r\n";
  if (req.body.size() > 0xFFFFFFFFULL) {
    error = "the request body is too large";
    return done(false);
  }
  const auto size = static_cast<DWORD>(req.body.size());
  // WinHttpSendRequest takes a non-const pointer it does not write through.
  void* body = const_cast<std::uint8_t*>(req.body.data());  // NOLINT(cppcoreguidelines-pro-type-const-cast)
  if (WinHttpSendRequest(request, headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
                         headers.empty() ? 0 : static_cast<DWORD>(-1L), body, size, size, 0) == FALSE) {
    error = wasCancelled.load() ? "cancelled" : last_error("sending the request");
    return done(false);
  }
  if (WinHttpReceiveResponse(request, nullptr) == FALSE) {
    error = wasCancelled.load() ? "cancelled" : last_error("receiving the response");
    return done(false);
  }
  DWORD status = 0;
  DWORD statusSize = sizeof(status);
  if (WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status,
                          &statusSize, WINHTTP_NO_HEADER_INDEX) == FALSE) {
    error = last_error("reading the response status");
    return done(false);
  }
  out.status = static_cast<int>(status);
  out.body.clear();
  for (;;) {
    DWORD avail = 0;
    if (WinHttpQueryDataAvailable(request, &avail) == FALSE) {
      error = wasCancelled.load() ? "cancelled" : last_error("reading the response");
      return done(false);
    }
    if (avail == 0) break;
    const std::size_t at = out.body.size();
    out.body.resize(at + avail);
    DWORD read = 0;
    if (WinHttpReadData(request, out.body.data() + at, avail, &read) == FALSE) {
      error = wasCancelled.load() ? "cancelled" : last_error("reading the response");
      return done(false);
    }
    out.body.resize(at + read);
    if (out.body.size() > 64U * 1024U * 1024U) {
      error = "the response is too large";
      return done(false);
    }
  }
  return done(true);
}

}  // namespace premation::jobs
