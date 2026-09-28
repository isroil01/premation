// The installed-font catalogue: what `listFonts` answers and how a family +
// weight + style resolves to one installed face, per OS —
//
//   macOS    CoreText       (font_catalog_ffi_mac.cpp)
//   Windows  DirectWrite    (font_catalog_ffi_win.cpp)
//   Linux    fontconfig     (font_catalog_ffi_linux.cpp; empty without it)
//
// Skia-free and GPU-free (engine_raster_core), so the document core's queries
// can use it through SessionOptions::systemFonts without linking the rasterizer.
// Rendering keeps its own per-OS registration (FontSet::add_system_family in
// fonts_ffi.cpp), which uses the same generic-family defaults as here.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::raster {

struct CatalogAxis {
  std::string tag;  // 'wght', 'wdth', …
  std::string name;
  double min = 0.0;
  double max = 0.0;
  double defaultValue = 0.0;
};

/// One installed face.
struct CatalogFace {
  std::string family;
  std::string style;           // "Bold Italic", as the OS names it
  std::string postScriptName;
  std::string path;            // the font file ("" when the OS does not say)
  int ttcIndex = 0;            // face index inside a collection (Windows, Linux; 0 on macOS)
  double weight = 400.0;       // CSS / OpenType weight, 1–1000
  double stretch = 100.0;      // CSS font-stretch, percent (100 = normal width)
  bool italic = false;         // italic or oblique
  /// OS-internal faces (macOS '.'-prefixed system UI fonts): resolvable, never listed.
  bool hidden = false;
  std::vector<CatalogAxis> axes;
  /// ISO 15924 scripts the face covers (by one representative code point each, kScriptSamples).
  std::vector<std::string> scripts;
};

/// A script and the code point that stands for it when asking a font for coverage.
struct ScriptSample {
  const char* script;
  char32_t codePoint;
};
inline constexpr std::array<ScriptSample, 16> kScriptSamples{{
    {"Latn", U'A'},     {"Grek", U'Ω'}, {"Cyrl", U'Ж'}, {"Armn", U'Ա'}, {"Hebr", U'א'},
    {"Arab", U'ا'}, {"Deva", U'क'}, {"Beng", U'অ'}, {"Taml", U'க'}, {"Thai", U'ก'},
    {"Geor", U'ა'}, {"Hang", U'가'}, {"Hira", U'あ'}, {"Kana", U'ア'}, {"Hani", U'一'},
    {"Ethi", U'ሀ'},
}};

/// Every installed face, enumerated once per process (thread-safe) and sorted
/// (family, weight, italic, style, postScriptName) so the order never depends
/// on the OS's enumeration order.
[[nodiscard]] const std::vector<CatalogFace>& system_font_catalog();

/// `listFonts{query}`: the listed (non-hidden) faces whose family, style or
/// PostScript name contains `query`, case-insensitively; "" = all.
[[nodiscard]] std::vector<CatalogFace> find_system_fonts(std::string_view query);

/// Font resolution: the installed face CSS font matching (CSS Fonts 4 §5.2)
/// picks for `family` at normal width, `weight` and `italic`, after the OS's generic-family
/// default (generic_family_default). nullopt when no such family is installed.
[[nodiscard]] std::optional<CatalogFace> resolve_system_font(std::string_view family, int weight = 400,
                                                             bool italic = false);

/// Every face (listed or not) of an installed family, as resolve_system_font
/// named it — what FontSet::add_system_family registers.
[[nodiscard]] std::vector<CatalogFace> system_family_faces(std::string_view installedFamily);

/// The index of the face whose PostScript name is `postScriptName` inside the
/// collection file `path` (.ttc / .otc), read from the files' `name` tables;
/// 0 for a single-face file or when it is not found. (CoreText does not report
/// collection indices; FreeType needs them.)
[[nodiscard]] int collection_index(const std::string& path, std::string_view postScriptName);

/// Blink's default family for a CSS generic name on this OS (sans-serif →
/// Arial on Windows, Helvetica on macOS, fontconfig's choice on Linux …);
/// other names come back unchanged.
[[nodiscard]] std::string generic_family_default(std::string_view family);

// ── the OS-independent halves, exposed for tests ────────────────────────────

/// find_system_fonts over a given list.
[[nodiscard]] std::vector<CatalogFace> filter_fonts(const std::vector<CatalogFace>& faces, std::string_view query);

/// resolve_system_font over a given list (no generic mapping).
[[nodiscard]] std::optional<CatalogFace> match_face(const std::vector<CatalogFace>& faces, std::string_view family,
                                                    int weight, bool italic);

/// The catalogue order (see system_font_catalog).
void sort_catalog(std::vector<CatalogFace>& faces);

/// A 4-byte OpenType tag ('wght') from its big-endian integer form.
[[nodiscard]] std::string tag_string(std::uint32_t tag);

namespace detail {
/// The OS enumeration (one *_ffi file per OS). Unsorted; may be empty.
[[nodiscard]] std::vector<CatalogFace> enumerate_system_fonts();
/// The faces of one family the enumeration leaves out, looked up by name
/// (macOS hides Times, Courier and the '.'-prefixed system UI family from
/// every font list but resolves them). Returned faces are `hidden`. Empty
/// where the enumeration is complete (Windows, Linux).
[[nodiscard]] std::vector<CatalogFace> unlisted_family_faces(std::string_view family);
}  // namespace detail

}  // namespace premation::raster
