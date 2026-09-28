// The OS-independent half of the font catalogue (font_catalog.hpp): the cache,
// sorting, the listFonts filter, CSS font matching over the catalogue, and the
// generic-family defaults. The enumeration itself is per OS, in the *_ffi files.
#include "font_catalog.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <map>
#include <mutex>
#include <span>
#include <tuple>
#include <utility>

#include "system_fonts.hpp"

namespace premation::raster {
namespace {

std::string lower(std::string_view s) {
  std::string out(s);
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

bool contains_ci(std::string_view hay, std::string_view needleLower) {
  if (needleLower.empty()) return true;
  return lower(hay).find(needleLower) != std::string::npos;
}

/// CSS Fonts 4 §5.2 step 4 (font-weight): how far `have` is from `want`, as a
/// sortable key — the faces the algorithm tries first get the smallest key.
double weight_distance(double want, double have) {
  if (have == want) return 0.0;
  constexpr double kFar = 10000.0;  // "the other direction" always loses to "this direction"
  if (want >= 400.0 && want <= 500.0) {
    // Try want..500 ascending, then below want descending, then above 500 ascending.
    if (have > want && have <= 500.0) return have - want;
    if (have < want) return kFar + (want - have);
    return 2 * kFar + (have - 500.0);
  }
  if (want < 400.0) {
    // Lighter first (descending), then heavier (ascending).
    if (have < want) return want - have;
    return kFar + (have - want);
  }
  // want > 500: heavier first (ascending), then lighter (descending).
  if (have > want) return have - want;
  return kFar + (want - have);
}

}  // namespace

std::string tag_string(std::uint32_t tag) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; ++i) {
    const auto c = static_cast<unsigned char>((tag >> (8U * static_cast<unsigned>(3 - i))) & 0xFFU);
    s[static_cast<std::size_t>(i)] = (c >= 0x20 && c < 0x7F) ? static_cast<char>(c) : ' ';
  }
  return s;
}

void sort_catalog(std::vector<CatalogFace>& faces) {
  std::ranges::sort(faces, [](const CatalogFace& a, const CatalogFace& b) {
    const std::string fa = lower(a.family);
    const std::string fb = lower(b.family);
    return std::tie(fa, a.stretch, a.weight, a.italic, a.style, a.postScriptName, a.path, a.ttcIndex) <
           std::tie(fb, b.stretch, b.weight, b.italic, b.style, b.postScriptName, b.path, b.ttcIndex);
  });
  // The same face reached twice (an OS listing a file under two collections).
  const auto dups = std::ranges::unique(faces, [](const CatalogFace& a, const CatalogFace& b) {
    return a.family == b.family && a.postScriptName == b.postScriptName && a.path == b.path && a.ttcIndex == b.ttcIndex &&
           a.style == b.style;
  });
  faces.erase(dups.begin(), dups.end());
}

const std::vector<CatalogFace>& system_font_catalog() {
  // Enumerating every installed face costs tens of milliseconds to seconds
  // (CoreText / DirectWrite / fontconfig); fonts installed while the engine
  // runs appear after a restart, as they do in the page.
  static std::once_flag once;
  static std::vector<CatalogFace> catalog;
  std::call_once(once, [] {
    catalog = detail::enumerate_system_fonts();
    sort_catalog(catalog);
  });
  return catalog;
}

#if defined(_WIN32) || defined(__APPLE__)
namespace {
/// detail::unlisted_family_faces, remembered per family (resolution runs per text layer).
const std::vector<CatalogFace>& unlisted_faces(const std::string& family) {
  // A node-based map: a reference handed out stays valid while others are added.
  static std::mutex m;
  static std::map<std::string, std::vector<CatalogFace>, std::less<>> cache;
  const std::string key = lower(family);
  const std::scoped_lock lock(m);
  if (const auto it = cache.find(key); it != cache.end()) return it->second;
  std::vector<CatalogFace> faces = detail::unlisted_family_faces(family);
  for (CatalogFace& f : faces) f.hidden = true;
  sort_catalog(faces);
  return cache.emplace(key, std::move(faces)).first->second;
}
}  // namespace
#endif

std::vector<CatalogFace> filter_fonts(const std::vector<CatalogFace>& faces, std::string_view query) {
  const std::string q = lower(query);
  std::vector<CatalogFace> out;
  for (const CatalogFace& f : faces) {
    if (f.hidden) continue;
    if (contains_ci(f.family, q) || contains_ci(f.style, q) || contains_ci(f.postScriptName, q)) out.push_back(f);
  }
  return out;
}

std::vector<CatalogFace> find_system_fonts(std::string_view query) {
  return filter_fonts(system_font_catalog(), query);
}

std::optional<CatalogFace> match_face(const std::vector<CatalogFace>& faces, std::string_view family, int weight,
                                      bool italic) {
  const std::string fam = lower(family);
  const CatalogFace* best = nullptr;
  std::tuple<double, int, double> bestKey{};
  for (const CatalogFace& f : faces) {
    if (lower(f.family) != fam) continue;
    // §5.2 step 4: font-stretch first (normal: narrower faces before wider),
    // then font-style (italic wants italic, normal wants normal, each falls
    // back to the other), then font-weight.
    const double stretchMiss = f.stretch <= 100.0 ? 100.0 - f.stretch : 1000.0 + (f.stretch - 100.0);
    const int styleMiss = f.italic == italic ? 0 : 1;
    const std::tuple<double, int, double> key{stretchMiss, styleMiss,
                                              weight_distance(static_cast<double>(weight), f.weight)};
    if (best == nullptr || key < bestKey) {
      best = &f;
      bestKey = key;
    }
  }
  if (best == nullptr) return std::nullopt;
  return *best;
}

std::vector<CatalogFace> system_family_faces(std::string_view installedFamily) {
  const std::string fam = lower(installedFamily);
  std::vector<CatalogFace> out;
  for (const CatalogFace& f : system_font_catalog()) {
    if (lower(f.family) == fam) out.push_back(f);
  }
#if defined(_WIN32) || defined(__APPLE__)
  if (out.empty()) out = unlisted_faces(std::string(installedFamily));
#endif
  return out;
}

namespace {

// Big-endian reads at byte `at` of `b` (the callers check `at + 4` / `at + 2` <= b.size()).
std::uint32_t be32(std::span<const std::uint8_t> b, std::size_t at) {
  return (std::uint32_t{b[at]} << 24U) | (std::uint32_t{b[at + 1]} << 16U) | (std::uint32_t{b[at + 2]} << 8U) |
         std::uint32_t{b[at + 3]};
}
std::uint16_t be16(std::span<const std::uint8_t> b, std::size_t at) {
  return static_cast<std::uint16_t>((unsigned{b[at]} << 8U) | unsigned{b[at + 1]});
}

bool read_at(std::ifstream& in, std::uint64_t at, std::size_t n, std::vector<std::uint8_t>& out) {
  out.assign(n, 0);
  in.clear();
  in.seekg(static_cast<std::streamoff>(at));
  in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes
  return std::cmp_equal(in.gcount(), n);
}

/// nameID 6 (PostScript) of the sfnt whose table directory starts at `offset`.
std::string postscript_name_at(std::ifstream& in, std::uint64_t offset) {
  std::vector<std::uint8_t> b;
  if (!read_at(in, offset, 12, b)) return {};
  const std::uint16_t tables = be16(b, 4);
  if (!read_at(in, offset + 12, std::size_t{tables} * 16U, b)) return {};
  std::uint32_t nameOffset = 0;
  std::uint32_t nameLength = 0;
  for (std::uint16_t i = 0; i < tables; ++i) {
    const std::size_t rec = std::size_t{i} * 16U;
    if (be32(b, rec) == 0x6E616D65U) {  // 'name'
      nameOffset = be32(b, rec + 8);
      nameLength = be32(b, rec + 12);
      break;
    }
  }
  if (nameLength < 6 || nameLength > (1U << 20U)) return {};
  std::vector<std::uint8_t> name;
  if (!read_at(in, nameOffset, nameLength, name)) return {};
  const std::uint16_t count = be16(name, 2);
  const std::uint16_t strings = be16(name, 4);
  for (std::uint16_t i = 0; i < count; ++i) {
    const std::size_t r = 6 + std::size_t{i} * 12U;
    if (r + 12 > name.size()) break;
    const std::uint16_t platform = be16(name, r);
    const std::uint16_t nameId = be16(name, r + 6);
    const std::uint16_t len = be16(name, r + 8);
    const std::size_t at = std::size_t{strings} + be16(name, r + 10);
    if (nameId != 6 || at + len > name.size()) continue;
    std::string ps;
    if (platform == 3 || platform == 0) {
      for (std::size_t k = 0; k + 1 < len; k += 2) {  // UTF-16BE; PostScript names are ASCII
        const std::uint16_t cu = be16(name, at + k);
        if (cu < 0x80) ps.push_back(static_cast<char>(cu));
      }
    } else if (platform == 1) {
      ps.assign(name.begin() + static_cast<std::ptrdiff_t>(at), name.begin() + static_cast<std::ptrdiff_t>(at + len));  // Mac Roman ASCII
    } else {
      continue;
    }
    if (!ps.empty()) return ps;
  }
  return {};
}

}  // namespace

int collection_index(const std::string& path, std::string_view postScriptName) {
  if (path.empty() || postScriptName.empty()) return 0;
  std::ifstream in(path, std::ios::binary);
  std::vector<std::uint8_t> head;
  if (!in || !read_at(in, 0, 12, head) || be32(head, 0) != 0x74746366U) return 0;  // 'ttcf'
  const std::uint32_t fonts = be32(head, 8);
  if (fonts == 0 || fonts > 4096) return 0;
  std::vector<std::uint8_t> offsets;
  if (!read_at(in, 12, std::size_t{fonts} * 4U, offsets)) return 0;
  for (std::uint32_t i = 0; i < fonts; ++i) {
    if (postscript_name_at(in, be32(offsets, std::size_t{i} * 4U)) == postScriptName) {
      return static_cast<int>(i);
    }
  }
  return 0;
}

std::string generic_family_default(std::string_view family) {
#if defined(_WIN32) || defined(__APPLE__)
  const std::string l = lower(family);
#endif
#if defined(_WIN32)
  // Blink's renderer preferences on Windows (as FontSet::add_system_family).
  if (l == "system-ui" || l == "-apple-system") return "Segoe UI";
  if (l == "sans-serif") return "Arial";
  if (l == "serif") return "Times New Roman";
  if (l == "monospace") return "Consolas";
  if (l == "cursive") return "Comic Sans MS";
  if (l == "fantasy") return "Impact";
#elif defined(__APPLE__)
  // Blink's defaults on macOS; system-ui is the (hidden) system UI family.
  if (l == "system-ui" || l == "-apple-system") return ".AppleSystemUIFont";
  if (l == "sans-serif") return "Helvetica";
  if (l == "serif") return "Times";
  if (l == "monospace") return "Courier";
  if (l == "cursive") return "Apple Chancery";
  if (l == "fantasy") return "Papyrus";
#else
  return linux_generic_family(family);
#endif
  return std::string(family);
}

std::optional<CatalogFace> resolve_system_font(std::string_view family, int weight, bool italic) {
  const std::vector<CatalogFace>& faces = system_font_catalog();
#if !defined(_WIN32) && !defined(__APPLE__)
  // Linux: fontconfig decides which installed family a name means, exactly as
  // Chromium's font service does (system_fonts_ffi.cpp); then CSS matching
  // picks the face within it.
  const std::optional<std::string> installed = resolve_system_family(family, weight, italic);
  if (!installed) return std::nullopt;
  return match_face(faces, *installed, weight, italic);
#else
  const auto lookup = [&faces, weight, italic](const std::string& name) -> std::optional<CatalogFace> {
    if (auto hit = match_face(faces, name, weight, italic)) return hit;
    return match_face(unlisted_faces(name), name, weight, italic);
  };
  const std::string mapped = generic_family_default(family);
  if (auto hit = lookup(mapped)) return hit;
  // Blink retries once with the alternate name (Arial ↔ Helvetica, Courier ↔ Courier New, …).
  const std::string alt(blink_alternate_family(mapped));
  if (!alt.empty()) return lookup(alt);
  return std::nullopt;
#endif
}

}  // namespace premation::raster
