// Document media sources as file paths (scene_textures.hpp `file_url_path`),
// in the scene core so the GPU-free readers (the model registry) share it.
#include <cctype>
#include <string>
#include <string_view>

#include "media_paths.hpp"

namespace premation::scene {

/// `file:///C:/x%20y.mp4` → `C:/x y.mp4`; the desktop app's `local-file://C:/…`,
/// `local-file://C/…` and `local-file:///C:/…` (electron/localFileUrl.ts) likewise;
/// anything else unchanged.
std::string file_url_path(std::string_view src) {
  std::string_view rest;
  if (src.starts_with("file://")) {
    rest = src.substr(7);
  } else if (src.starts_with("local-file://")) {
    rest = src.substr(13);
    // local-file://C/Users/… — Chromium parsed the drive's colon as an empty port.
    if (rest.size() >= 2 && std::isalpha(static_cast<unsigned char>(rest[0])) != 0 && rest[1] == '/') {
      std::string fixed;
      fixed.push_back(rest[0]);
      fixed.push_back(':');
      fixed.append(rest.substr(1));
      return file_url_path("file:///" + fixed);
    }
  } else {
    return std::string(src);
  }
  const std::size_t q = rest.find_first_of("?#");
  if (q != std::string_view::npos) rest = rest.substr(0, q);
  if (rest.starts_with('/') && rest.size() > 2 && rest[2] == ':') rest.remove_prefix(1);  // /C:/…
  std::string out;
  for (std::size_t i = 0; i < rest.size(); ++i) {
    if (rest[i] == '%' && i + 2 < rest.size()) {
      const auto hexv = [](char c) {
        return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      };
      const int hi = hexv(rest[i + 1]);
      const int lo = hexv(rest[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(rest[i]);
  }
  return out;
}

}  // namespace premation::scene
