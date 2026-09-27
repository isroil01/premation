// http_post.hpp on macOS / Linux: libcurl (the system's on macOS, the
// distribution's libcurl on Linux — found by CMake's FindCURL; not a vcpkg
// port). The transfer runs on the job's worker thread; the progress callback
// polls the job's cancel flag.
#include "http_post.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <string>

namespace premation::jobs {

namespace {

struct Easy {
  CURL* h = curl_easy_init();
  Easy() = default;
  ~Easy() {
    if (h != nullptr) curl_easy_cleanup(h);
  }
  Easy(const Easy&) = delete;
  Easy& operator=(const Easy&) = delete;
  Easy(Easy&&) = delete;
  Easy& operator=(Easy&&) = delete;
};

struct Slist {
  curl_slist* h = nullptr;
  Slist() = default;
  ~Slist() {
    if (h != nullptr) curl_slist_free_all(h);
  }
  Slist(const Slist&) = delete;
  Slist& operator=(const Slist&) = delete;
  Slist(Slist&&) = delete;
  Slist& operator=(Slist&&) = delete;
};

struct Sink {
  std::string* body = nullptr;
  bool tooLarge = false;
};

std::size_t on_data(char* ptr, std::size_t size, std::size_t n, void* user) {
  auto* sink = static_cast<Sink*>(user);
  const std::size_t bytes = size * n;
  if (sink->body->size() + bytes > 64U * 1024U * 1024U) {
    sink->tooLarge = true;
    return 0;
  }
  sink->body->append(ptr, bytes);
  return bytes;
}

int on_progress(void* user, curl_off_t /*dlt*/, curl_off_t /*dln*/, curl_off_t /*ult*/, curl_off_t /*uln*/) {
  const auto* cancelled = static_cast<const std::function<bool()>*>(user);
  return (*cancelled && (*cancelled)()) ? 1 : 0;
}

bool global_init() {
  static const bool ok = curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
  return ok;
}

}  // namespace

bool http_available() noexcept { return true; }

bool http_post(const HttpPost& req, HttpResponse& out, std::string& error, const std::function<bool()>& cancelled) {
  if (!global_init()) {
    error = "the HTTP library could not start";
    return false;
  }
  Easy easy;
  if (easy.h == nullptr) {
    error = "the HTTP library could not start";
    return false;
  }
  Slist headers;
  for (const auto& [name, value] : req.headers) {
    const std::string line = name + ": " + value;
    curl_slist* next = curl_slist_append(headers.h, line.c_str());
    if (next == nullptr) {
      error = "out of memory";
      return false;
    }
    headers.h = next;
  }
  out.body.clear();
  Sink sink{&out.body, false};
  (void)curl_easy_setopt(easy.h, CURLOPT_URL, req.url.c_str());
  (void)curl_easy_setopt(easy.h, CURLOPT_POST, 1L);
  (void)curl_easy_setopt(easy.h, CURLOPT_POSTFIELDS, reinterpret_cast<const char*>(req.body.data()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  (void)curl_easy_setopt(easy.h, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(req.body.size()));
  (void)curl_easy_setopt(easy.h, CURLOPT_HTTPHEADER, headers.h);
  // No redirects: the credential goes to the host named and nowhere else.
  (void)curl_easy_setopt(easy.h, CURLOPT_FOLLOWLOCATION, 0L);
  (void)curl_easy_setopt(easy.h, CURLOPT_TIMEOUT, static_cast<long>(std::max(1, req.timeoutSeconds)));
  (void)curl_easy_setopt(easy.h, CURLOPT_NOSIGNAL, 1L);
  (void)curl_easy_setopt(easy.h, CURLOPT_WRITEFUNCTION, &on_data);
  (void)curl_easy_setopt(easy.h, CURLOPT_WRITEDATA, &sink);
  (void)curl_easy_setopt(easy.h, CURLOPT_NOPROGRESS, 0L);
  (void)curl_easy_setopt(easy.h, CURLOPT_XFERINFOFUNCTION, &on_progress);
  (void)curl_easy_setopt(easy.h, CURLOPT_XFERINFODATA, &cancelled);
  const CURLcode rc = curl_easy_perform(easy.h);
  if (rc == CURLE_ABORTED_BY_CALLBACK) {
    error = "cancelled";
    return false;
  }
  if (sink.tooLarge) {
    error = "the response is too large";
    return false;
  }
  if (rc != CURLE_OK) {
    error = curl_easy_strerror(rc);
    return false;
  }
  long status = 0;
  (void)curl_easy_getinfo(easy.h, CURLINFO_RESPONSE_CODE, &status);
  out.status = static_cast<int>(status);
  return true;
}

}  // namespace premation::jobs
