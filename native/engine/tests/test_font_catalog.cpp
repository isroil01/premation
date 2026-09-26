// The installed-font catalogue (raster/font_catalog.hpp): CSS font matching and
// the listFonts filter over synthetic faces (deterministic everywhere), then the
// real OS enumeration — CoreText / DirectWrite / fontconfig — where it exists.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include "font_catalog.hpp"

using namespace premation::raster;

namespace {

CatalogFace face(std::string family, double weight, bool italic, std::string ps, double stretch = 100.0) {
  CatalogFace f;
  f.family = std::move(family);
  f.weight = weight;
  f.italic = italic;
  f.postScriptName = std::move(ps);
  f.stretch = stretch;
  return f;
}

std::string ps_of(const std::optional<CatalogFace>& f) { return f ? f->postScriptName : "(none)"; }

}  // namespace

TEST_CASE("font catalogue: CSS weight matching (CSS Fonts 4 §5.2)", "[fonts]") {
  const std::vector<CatalogFace> faces = {
      face("Inter", 100, false, "Inter-Thin"),   face("Inter", 300, false, "Inter-Light"),
      face("Inter", 400, false, "Inter-Regular"), face("Inter", 600, false, "Inter-SemiBold"),
      face("Inter", 900, false, "Inter-Black"),  face("Inter", 400, true, "Inter-Italic"),
  };
  CHECK(ps_of(match_face(faces, "inter", 400, false)) == "Inter-Regular");  // family is case-insensitive
  // 400–500: up to 500 first, then lighter (descending), then heavier.
  CHECK(ps_of(match_face(faces, "Inter", 500, false)) == "Inter-Regular");
  // Below 400: lighter first, then heavier.
  CHECK(ps_of(match_face(faces, "Inter", 200, false)) == "Inter-Thin");
  CHECK(ps_of(match_face(faces, "Inter", 350, false)) == "Inter-Light");
  // Above 500: heavier first, then lighter.
  CHECK(ps_of(match_face(faces, "Inter", 700, false)) == "Inter-Black");
  CHECK(ps_of(match_face(faces, "Inter", 950, false)) == "Inter-Black");
  // Style before weight: italic wanted, the one italic wins over a closer weight.
  CHECK(ps_of(match_face(faces, "Inter", 900, true)) == "Inter-Italic");
  CHECK_FALSE(match_face(faces, "Roboto", 400, false).has_value());
}

TEST_CASE("font catalogue: normal width before any condensed or expanded face", "[fonts]") {
  const std::vector<CatalogFace> faces = {
      face("Sys", 400, false, "Sys-Condensed", 75), face("Sys", 700, false, "Sys-Bold", 100),
      face("Sys", 400, false, "Sys-Expanded", 125), face("Sys", 400, false, "Sys-Regular", 100),
  };
  CHECK(ps_of(match_face(faces, "Sys", 400, false)) == "Sys-Regular");
  const std::vector<CatalogFace> narrowOnly = {face("N", 400, false, "N-Cond", 75), face("N", 400, false, "N-Wide", 150)};
  CHECK(ps_of(match_face(narrowOnly, "N", 400, false)) == "N-Cond");  // narrower first for normal
}

TEST_CASE("font catalogue: the listFonts filter and the catalogue order", "[fonts]") {
  std::vector<CatalogFace> faces = {
      face("Zeta Sans", 700, false, "ZetaSans-Bold"), face("alpha Serif", 400, false, "AlphaSerif-Regular"),
      face("Zeta Sans", 400, false, "ZetaSans-Regular"), face(".Hidden UI", 400, false, ".HiddenUI"),
  };
  faces.back().hidden = true;
  faces[0].style = "Bold";
  sort_catalog(faces);
  REQUIRE(faces.size() == 4);
  CHECK(faces[0].family == ".Hidden UI");
  CHECK(faces[1].family == "alpha Serif");  // case-insensitive family order
  CHECK(faces[2].postScriptName == "ZetaSans-Regular");
  CHECK(filter_fonts(faces, "").size() == 3);  // hidden faces are never listed
  CHECK(filter_fonts(faces, "ZETA").size() == 2);
  CHECK(filter_fonts(faces, "bold").size() == 1);  // the style name
  CHECK(filter_fonts(faces, "alphaserif").size() == 1);  // the PostScript name
  CHECK(filter_fonts(faces, "hidden").empty());
  // A hidden face still resolves (macOS system-ui).
  CHECK(match_face(faces, ".Hidden UI", 400, false).has_value());
}

TEST_CASE("font catalogue: OpenType tags", "[fonts]") {
  CHECK(tag_string(0x77676874U) == "wght");
  CHECK(tag_string(0x6F70737AU) == "opsz");
}

TEST_CASE("font catalogue: the OS enumeration", "[fonts][system]") {
  const std::vector<CatalogFace>& all = system_font_catalog();
#if defined(_WIN32) || defined(__APPLE__)
  REQUIRE_FALSE(all.empty());
#else
  if (all.empty()) SKIP("no fontconfig, or no fonts installed");
#endif
  for (const CatalogFace& f : all) {
    CHECK_FALSE(f.family.empty());
    CHECK(f.weight >= 1.0);
    CHECK(f.weight <= 1000.0);
  }
  // Already in catalogue order, duplicates removed: sorting again changes nothing.
  std::vector<CatalogFace> again = all;
  sort_catalog(again);
  REQUIRE(again.size() == all.size());
  for (std::size_t i = 0; i < all.size(); ++i) CHECK(again[i].postScriptName == all[i].postScriptName);
#if defined(__APPLE__)
  // Blink's macOS defaults resolve, including the families macOS hides from lists.
  CHECK(resolve_system_font("sans-serif", 400, false).has_value());  // Helvetica
  CHECK(resolve_system_font("serif", 400, false).has_value());       // Times (unlisted)
  CHECK(resolve_system_font("system-ui", 400, false).has_value());   // .AppleSystemUIFont (hidden)
  const std::optional<CatalogFace> bold = resolve_system_font("Helvetica", 700, false);
  REQUIRE(bold.has_value());
  CHECK(bold->weight == 700.0);
  // Helvetica.ttc: the bold face is not index 0, and the index is found by name.
  CHECK(collection_index(bold->path, bold->postScriptName) > 0);
#elif defined(_WIN32)
  CHECK(resolve_system_font("sans-serif", 400, false).has_value());  // Arial
  const std::optional<CatalogFace> arial = resolve_system_font("Arial", 700, false);
  REQUIRE(arial.has_value());
  CHECK(arial->weight == 700.0);
  CHECK_FALSE(arial->path.empty());
  CHECK(std::find(arial->scripts.begin(), arial->scripts.end(), "Latn") != arial->scripts.end());
#endif
  CHECK_FALSE(resolve_system_font("No Such Family 7f3a", 400, false).has_value());
}
