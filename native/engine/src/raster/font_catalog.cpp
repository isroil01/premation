// The OS-independent half of the font catalogue (font_catalog.hpp): the cache,
// sorting, the listFonts filter, CSS font matching over the catalogue, and the
// generic-family defaults. The enumeration itself is per OS, in the *_ffi files.
#include "font_catalog.hpp"

#include <algorithm>
#include <atomic>
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

namespace {

/// The catalogue as last read, and the OS list stamp it was read at. Enumerating
/// every installed face costs tens of milliseconds to seconds (CoreText /
/// DirectWrite / fontconfig), so it is read on first use and again only when
/// refresh_system_fonts sees the stamp move.
struct CatalogState {
  std::mutex m;
  std::shared_ptr<const std::vector<CatalogFace>> faces;
  std::optional<std::uint64_t> stamp;
  std::function<std::vector<CatalogFace>()> testEnumerate;
  std::function<std::uint64_t()> testStamp;
  /// detail::unlisted_family_faces per family (lower case), as resolution asked for them.
  std::map<std::string, std::vector<CatalogFace>, std::less<>> unlisted;
};

CatalogState& catalog_state() {
  static CatalogState s;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process's one font list, guarded by its mutex
  return s;
}

std::atomic<std::uint64_t> gGeneration{0};  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): refresh_system_fonts' change counter

std::uint64_t list_stamp_locked(const CatalogState& s) {
  return s.testStamp ? s.testStamp() : detail::system_fonts_list_stamp();
}

void read_faces_locked(CatalogState& s) {
  std::vector<CatalogFace> faces = s.testEnumerate ? s.testEnumerate() : detail::enumerate_system_fonts();
  sort_catalog(faces);
  s.faces = std::make_shared<const std::vector<CatalogFace>>(std::move(faces));
}

}  // namespace

std::shared_ptr<const std::vector<CatalogFace>> system_font_catalog() {
  CatalogState& s = catalog_state();
  const std::scoped_lock lock(s.m);
  if (!s.faces) {
    // The stamp first: a font installed during the enumeration moves the stamp
    // past this one, and the next refresh reads the list again.
    if (!s.stamp) s.stamp = list_stamp_locked(s);
    read_faces_locked(s);
  }
  return s.faces;
}

bool refresh_system_fonts() {
  CatalogState& s = catalog_state();
  const std::scoped_lock lock(s.m);
  const std::uint64_t now = list_stamp_locked(s);
  if (!s.stamp) {
    s.stamp = now;  // the first look: nothing was drawn from an older list
    return false;
  }
  if (now == *s.stamp) return false;
  s.stamp = now;
  s.unlisted.clear();
  if (s.faces) read_faces_locked(s);  // a catalogue never read stays lazy
  gGeneration.fetch_add(1, std::memory_order_acq_rel);
  return true;
}

std::uint64_t system_fonts_generation() noexcept { return gGeneration.load(std::memory_order_acquire); }

std::uint64_t system_fonts_stamp() {
  CatalogState& s = catalog_state();
  const std::scoped_lock lock(s.m);
  if (!s.stamp) s.stamp = list_stamp_locked(s);
  return *s.stamp;
}

void detail::set_system_fonts_source_for_test(std::function<std::vector<CatalogFace>()> enumerate,
                                              std::function<std::uint64_t()> stamp) {
  CatalogState& s = catalog_state();
  const std::scoped_lock lock(s.m);
  s.testEnumerate = std::move(enumerate);
  s.testStamp = std::move(stamp);
  s.faces.reset();
  s.stamp.reset();
  s.unlisted.clear();
}

#if defined(_WIN32) || defined(__APPLE__)
namespace {
/// detail::unlisted_family_faces, remembered per family (resolution runs per
/// text layer) until the installed fonts change. A copy: a refresh clears the cache.
std::vector<CatalogFace> unlisted_faces(const std::string& family) {
  CatalogState& s = catalog_state();
  const std::string key = lower(family);
  {
    const std::scoped_lock lock(s.m);
    if (const auto it = s.unlisted.find(key); it != s.unlisted.end()) return it->second;
  }
  // Asked of the OS outside the lock (a CoreText lookup per family name).
  std::vector<CatalogFace> faces = detail::unlisted_family_faces(family);
  for (CatalogFace& f : faces) f.hidden = true;
  sort_catalog(faces);
  const std::scoped_lock lock(s.m);
  return s.unlisted.try_emplace(key, std::move(faces)).first->second;
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
  return filter_fonts(*system_font_catalog(), query);
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
  const std::shared_ptr<const std::vector<CatalogFace>> held = system_font_catalog();
  for (const CatalogFace& f : *held) {
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

std::optional<WeightVariant> split_weight_variant(std::string_view family) {
  static constexpr std::array<std::pair<std::string_view, int>, 20> kWeights{{
      {"thin", 100},      {"hairline", 100},  {"extralight", 200}, {"ultralight", 200}, {"light", 300},
      {"semilight", 350}, {"demilight", 350}, {"regular", 400},    {"normal", 400},     {"book", 400},
      {"medium", 500},    {"semibold", 600},  {"demibold", 600},   {"bold", 700},       {"extrabold", 800},
      {"ultrabold", 800}, {"black", 900},     {"heavy", 900},      {"extrablack", 950}, {"ultrablack", 950},
  }};
  static constexpr std::array<std::string_view, 9> kWidths{"ultracondensed", "extracondensed", "condensed",
                                                           "semicondensed",  "narrow",         "semiexpanded",
                                                           "expanded",       "extraexpanded",  "ultraexpanded"};
  std::vector<std::string> words;
  for (std::size_t i = 0; i < family.size();) {
    const std::size_t end = std::min(family.find(' ', i), family.size());
    if (end > i) words.emplace_back(family.substr(i, end - i));
    i = end + 1;
  }
  // A width word may follow the weight ("SemiBold Condensed"); it stays in the family.
  std::string width;
  if (!words.empty() && std::ranges::find(kWidths, lower(words.back())) != kWidths.end()) {
    width = words.back();
    words.pop_back();
  }
  const auto weightOf = [](const std::string& w) -> std::optional<int> {
    for (const auto& [name, v] : kWeights) {
      if (name == w) return v;
    }
    return std::nullopt;
  };
  std::optional<int> weight;
  std::size_t used = 0;
  if (words.size() >= 3) {  // "Extra Light", "Semi Bold"
    weight = weightOf(lower(words[words.size() - 2]) + lower(words.back()));
    used = 2;
  }
  if (!weight && words.size() >= 2) {
    weight = weightOf(lower(words.back()));
    used = 1;
  }
  if (!weight) return std::nullopt;
  words.resize(words.size() - used);
  if (!width.empty()) words.push_back(width);
  WeightVariant out;
  out.weight = *weight;
  for (const auto& w : words) out.family += (out.family.empty() ? "" : " ") + w;
  return out;
}

std::optional<CatalogFace> resolve_system_font(std::string_view family, int weight, bool italic) {
  const std::shared_ptr<const std::vector<CatalogFace>> held = system_font_catalog();
  const std::vector<CatalogFace>& faces = *held;
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
#if defined(_WIN32)
  if (const auto v = split_weight_variant(mapped)) return match_face(faces, v->family, v->weight, italic);
#endif
  return std::nullopt;
#endif
}

}  // namespace premation::raster
