// http_post.hpp for a build with no HTTP library (a Linux box without
// libcurl's headers): every request fails with that reason.
#include "http_post.hpp"

namespace premation::jobs {

bool http_available() noexcept { return false; }

bool http_post(const HttpPost& /*req*/, HttpResponse& /*out*/, std::string& error, const std::function<bool()>& /*cancelled*/) {
  error = "this engine build has no HTTP client (libcurl was not found when it was built)";
  return false;
}

}  // namespace premation::jobs
