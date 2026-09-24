// System fonts through fontconfig (Linux), matched as Chromium's canvas does.
//
// Chromium on Linux resolves a CSS family with Skia's
// SkFontConfigInterfaceDirect::matchFamilyName (in the browser's font
// service): the family + style through FcConfigSubstitute / FcDefaultSubstitute,
// FcFontSort, the first scalable readable font — accepted only when one of its
// family names is the post-substitution family, the requested family, or a
// metric-compatible replacement (Arial ↔ Liberation Sans …), or when the
// request is a generic "sans" / "serif" / "monospace". Anything else is a miss,
// and Blink tries the next family in the list. This file is that algorithm.
// The only file that talks to fontconfig (the native FFI rule).

#include "system_fonts.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>

#if defined(PREMATION_HAVE_FONTCONFIG)
#include <fontconfig/fontconfig.h>
#include <unistd.h>

#include <memory>
#include <mutex>
#endif

namespace premation::raster {
namespace {

bool iequals(std::string_view a, std::string_view b) {
  return a.size() == b.size() && std::ranges::equal(a, b, [](char x, char y) {
           return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
         });
}

// SkFontConfigInterface_direct.cpp kFontEquivMap (first entry wins, as its lookup does).
enum class Equiv : std::uint8_t { other, sans, serif, mono, symbol, pgothic, gothic, pmincho, mincho, simsun, nsimsun, simhei, pmingliu, mingliu, pmingliuhk, mingliuhk, cambria, calibri };
constexpr std::array<std::pair<Equiv, std::string_view>, 68> kEquiv{{
    {Equiv::sans, "Arial"},
    {Equiv::sans, "Arimo"},
    {Equiv::sans, "Liberation Sans"},
    {Equiv::serif, "Times New Roman"},
    {Equiv::serif, "Tinos"},
    {Equiv::serif, "Liberation Serif"},
    {Equiv::mono, "Courier New"},
    {Equiv::mono, "Cousine"},
    {Equiv::mono, "Liberation Mono"},
    {Equiv::symbol, "Symbol"},
    {Equiv::symbol, "Symbol Neu"},
    {Equiv::pgothic, "MS PGothic"},
    {Equiv::pgothic, "\xef\xbc\xad\xef\xbc\xb3 \xef\xbc\xb0\xe3\x82\xb4\xe3\x82\xb7\xe3\x83\x83\xe3\x82\xaf"},
    {Equiv::pgothic, "Noto Sans CJK JP"},
    {Equiv::pgothic, "IPAPGothic"},
    {Equiv::pgothic, "MotoyaG04Gothic"},
    {Equiv::gothic, "MS Gothic"},
    {Equiv::gothic, "\xef\xbc\xad\xef\xbc\xb3 \xe3\x82\xb4\xe3\x82\xb7\xe3\x83\x83\xe3\x82\xaf"},
    {Equiv::gothic, "Noto Sans Mono CJK JP"},
    {Equiv::gothic, "IPAGothic"},
    {Equiv::gothic, "MotoyaG04GothicMono"},
    {Equiv::pmincho, "MS PMincho"},
    {Equiv::pmincho, "\xef\xbc\xad\xef\xbc\xb3 \xef\xbc\xb0\xe6\x98\x8e\xe6\x9c\x9d"},
    {Equiv::pmincho, "Noto Serif CJK JP"},
    {Equiv::pmincho, "IPAPMincho"},
    {Equiv::pmincho, "MotoyaG04Mincho"},
    {Equiv::mincho, "MS Mincho"},
    {Equiv::mincho, "\xef\xbc\xad\xef\xbc\xb3 \xe6\x98\x8e\xe6\x9c\x9d"},
    {Equiv::mincho, "Noto Serif CJK JP"},
    {Equiv::mincho, "IPAMincho"},
    {Equiv::mincho, "MotoyaG04MinchoMono"},
    {Equiv::simsun, "Simsun"},
    {Equiv::simsun, "\xe5\xae\x8b\xe4\xbd\x93"},
    {Equiv::simsun, "Noto Serif CJK SC"},
    {Equiv::simsun, "MSung GB18030"},
    {Equiv::simsun, "Song ASC"},
    {Equiv::nsimsun, "NSimsun"},
    {Equiv::nsimsun, "\xe6\x96\xb0\xe5\xae\x8b\xe4\xbd\x93"},
    {Equiv::nsimsun, "Noto Serif CJK SC"},
    {Equiv::nsimsun, "MSung GB18030"},
    {Equiv::nsimsun, "N Song ASC"},
    {Equiv::simhei, "Simhei"},
    {Equiv::simhei, "\xe9\xbb\x91\xe4\xbd\x93"},
    {Equiv::simhei, "Noto Sans CJK SC"},
    {Equiv::simhei, "MYingHeiGB18030"},
    {Equiv::simhei, "MYingHeiB5HK"},
    {Equiv::pmingliu, "PMingLiU"},
    {Equiv::pmingliu, "\xe6\x96\xb0\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94"},
    {Equiv::pmingliu, "Noto Serif CJK TC"},
    {Equiv::pmingliu, "MSung B5HK"},
    {Equiv::mingliu, "MingLiU"},
    {Equiv::mingliu, "\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94"},
    {Equiv::mingliu, "Noto Serif CJK TC"},
    {Equiv::mingliu, "MSung B5HK"},
    {Equiv::pmingliuhk, "PMingLiU_HKSCS"},
    {Equiv::pmingliuhk, "\xe6\x96\xb0\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94_HKSCS"},
    {Equiv::pmingliuhk, "Noto Serif CJK TC"},
    {Equiv::pmingliuhk, "MSung B5HK"},
    {Equiv::mingliuhk, "MingLiU_HKSCS"},
    {Equiv::mingliuhk, "\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94_HKSCS"},
    {Equiv::mingliuhk, "Noto Serif CJK TC"},
    {Equiv::mingliuhk, "MSung B5HK"},
    {Equiv::cambria, "Cambria"},
    {Equiv::cambria, "Caladea"},
    {Equiv::calibri, "Calibri"},
    {Equiv::calibri, "Carlito"},
}};

Equiv equiv_of(std::string_view name) {
  for (const auto& [cls, n] : kEquiv) {
    if (iequals(n, name)) return cls;
  }
  return Equiv::other;
}

}  // namespace

std::string linux_generic_family(std::string_view family) {
  // Chromium's default font prefs on Linux (chrome/app/resources locale
  // settings: IDS_STANDARD/SERIF/SANS_SERIF/FIXED/CURSIVE/FANTASY_FONT_FAMILY);
  // system-ui is the desktop's UI font, which fontconfig's "sans" names.
  if (iequals(family, "system-ui") || iequals(family, "-apple-system")) return "sans";
  if (iequals(family, "sans-serif")) return "Arial";
  if (iequals(family, "serif")) return "Times New Roman";
  if (iequals(family, "monospace")) return "Monospace";
  if (iequals(family, "cursive")) return "Comic Sans MS";
  if (iequals(family, "fantasy")) return "Impact";
  return std::string(family);
}

std::string blink_alternate_family(std::string_view family) {
  if (iequals(family, "Courier")) return "Courier New";
  if (iequals(family, "Courier New")) return "Courier";
  if (iequals(family, "Times")) return "Times New Roman";
  if (iequals(family, "Times New Roman")) return "Times";
  if (iequals(family, "Arial")) return "Helvetica";
  if (iequals(family, "Helvetica")) return "Arial";
  return {};
}

std::optional<std::string> resolve_system_family(std::string_view cssFamily, int weight, bool italic) {
  const std::string family = linux_generic_family(cssFamily);
  if (auto hit = match_system_family(family, weight, italic)) return hit;
  const std::string alt = blink_alternate_family(family);
  if (alt.empty()) return std::nullopt;
  return match_system_family(alt, weight, italic);
}

bool is_metric_compatible_replacement(std::string_view a, std::string_view b) {
  const Equiv ca = equiv_of(a);
  return ca != Equiv::other && ca == equiv_of(b);
}

#if defined(PREMATION_HAVE_FONTCONFIG)

namespace {

/// SkFontConfigInterface_direct.cpp IsFallbackFontAllowed.
bool is_fallback_font_allowed(std::string_view family) {
  return iequals(family, "sans") || iequals(family, "serif") || iequals(family, "monospace");
}

struct PatternFree {
  void operator()(FcPattern* p) const noexcept { FcPatternDestroy(p); }
};
struct FontSetFree {
  void operator()(FcFontSet* s) const noexcept { FcFontSetDestroy(s); }
};
struct ObjectSetFree {
  void operator()(FcObjectSet* s) const noexcept { FcObjectSetDestroy(s); }
};
using Pattern = std::unique_ptr<FcPattern, PatternFree>;
using FontSetPtr = std::unique_ptr<FcFontSet, FontSetFree>;
using ObjectSet = std::unique_ptr<FcObjectSet, ObjectSetFree>;

/// fontconfig's config is shared global state and not thread-safe to query
/// concurrently on older versions (Skia's FCLocker).
std::mutex& fc_mutex() {
  static std::mutex m;
  return m;
}

const char* string_of(FcPattern* p, const char* object, int id = 0) {
  FcChar8* s = nullptr;
  return FcPatternGetString(p, object, id, &s) == FcResultMatch ? reinterpret_cast<const char*>(s) : nullptr;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): FcChar8 is UTF-8
}

/// SkFontConfigInterface_direct.cpp valid_pattern.
bool valid_pattern(FcPattern* p) {
  FcBool scalable = FcFalse;
  if (FcPatternGetBool(p, FC_SCALABLE, 0, &scalable) != FcResultMatch || scalable == FcFalse) return false;
  const char* file = string_of(p, FC_FILE);
  return file != nullptr && access(file, R_OK) == 0;
}

int fc_weight_from_css(int weight) { return FcWeightFromOpenType(std::clamp(weight, 1, 1000)); }

}  // namespace

bool system_fonts_available() noexcept { return true; }

std::optional<std::string> match_system_family(std::string_view family, int weight, bool italic) {
  const std::string fam(family);
  const std::lock_guard lock(fc_mutex());
  if (FcInit() == FcFalse) return std::nullopt;
  const Pattern pattern(FcPatternCreate());
  if (!pattern) return std::nullopt;
  FcPatternAddString(pattern.get(), FC_FAMILY, reinterpret_cast<const FcChar8*>(fam.c_str()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  FcPatternAddInteger(pattern.get(), FC_WEIGHT, fc_weight_from_css(weight));
  FcPatternAddInteger(pattern.get(), FC_WIDTH, FC_WIDTH_NORMAL);
  FcPatternAddInteger(pattern.get(), FC_SLANT, italic ? FC_SLANT_ITALIC : FC_SLANT_ROMAN);
  FcPatternAddBool(pattern.get(), FC_SCALABLE, FcTrue);
  FcConfigSubstitute(nullptr, pattern.get(), FcMatchPattern);
  FcDefaultSubstitute(pattern.get());
  const char* pc = string_of(pattern.get(), FC_FAMILY);
  const std::string postConfig = pc != nullptr ? pc : "";

  FcResult result = FcResultNoMatch;
  const FontSetPtr set(FcFontSort(nullptr, pattern.get(), FcFalse, nullptr, &result));
  if (!set) return std::nullopt;
  FcPattern* match = nullptr;
  for (int i = 0; i < set->nfont; ++i) {
    if (valid_pattern(set->fonts[i])) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      match = set->fonts[i];             // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      break;
    }
  }
  if (match == nullptr) return std::nullopt;
  if (!is_fallback_font_allowed(fam)) {
    bool acceptable = false;
    for (int id = 0; id < 255 && !acceptable; ++id) {
      const char* pm = string_of(match, FC_FAMILY, id);
      if (pm == nullptr) break;
      acceptable = iequals(postConfig, pm) || iequals(fam, pm) || is_metric_compatible_replacement(fam, pm);
    }
    if (!acceptable) return std::nullopt;
  }
  const char* first = string_of(match, FC_FAMILY);
  if (first == nullptr) return std::nullopt;
  return std::string(first);
}

std::vector<SystemFace> list_system_faces(std::string_view installedFamily) {
  std::vector<SystemFace> out;
  const std::string fam(installedFamily);
  const std::lock_guard lock(fc_mutex());
  if (FcInit() == FcFalse) return out;
  const Pattern pattern(FcPatternCreate());
  if (!pattern) return out;
  FcPatternAddString(pattern.get(), FC_FAMILY, reinterpret_cast<const FcChar8*>(fam.c_str()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  FcPatternAddBool(pattern.get(), FC_SCALABLE, FcTrue);
  const ObjectSet objects(FcObjectSetBuild(FC_FAMILY, FC_FILE, FC_INDEX, FC_WEIGHT, FC_SLANT, FC_SCALABLE, nullptr));
  const FontSetPtr set(FcFontList(nullptr, pattern.get(), objects.get()));
  if (!set) return out;
  for (int i = 0; i < set->nfont; ++i) {
    FcPattern* p = set->fonts[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (!valid_pattern(p)) continue;
    SystemFace f;
    const char* family = string_of(p, FC_FAMILY);
    f.family = family != nullptr ? family : fam;
    f.file = string_of(p, FC_FILE);
    int v = 0;
    if (FcPatternGetInteger(p, FC_INDEX, 0, &v) == FcResultMatch) f.ttcIndex = v & 0xFFFF;  // high bits: variable instance
    if (FcPatternGetInteger(p, FC_WEIGHT, 0, &v) == FcResultMatch) f.weight = FcWeightToOpenType(v);
    if (FcPatternGetInteger(p, FC_SLANT, 0, &v) == FcResultMatch) f.italic = v != FC_SLANT_ROMAN;
    out.push_back(std::move(f));
  }
  // FcFontList order is unspecified: sort for a deterministic registration order.
  std::ranges::sort(out, [](const SystemFace& a, const SystemFace& b) {
    return std::tie(a.italic, a.weight, a.file, a.ttcIndex) < std::tie(b.italic, b.weight, b.file, b.ttcIndex);
  });
  return out;
}

#else  // no fontconfig (Windows: DirectWrite in fonts_ffi.cpp; macOS: not ported)

bool system_fonts_available() noexcept { return false; }
std::optional<std::string> match_system_family(std::string_view /*family*/, int /*weight*/, bool /*italic*/) { return std::nullopt; }
std::vector<SystemFace> list_system_faces(std::string_view /*installedFamily*/) { return {}; }

#endif

}  // namespace premation::raster
