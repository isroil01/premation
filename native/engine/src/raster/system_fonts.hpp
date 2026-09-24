// System font discovery for FontSet::add_system_family on Linux (E3):
// fontconfig, matched the way Chromium's canvas resolves a family there
// (Skia's SkFontConfigInterfaceDirect::matchFamilyName). Skia-free — the
// fontconfig calls live in system_fonts_ffi.cpp; Windows keeps DirectWrite in
// fonts_ffi.cpp, macOS (CoreText) is not ported.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::raster {

/// One installed face of a family.
struct SystemFace {
  std::string family;  // the installed family name fontconfig reports first
  std::string file;
  int ttcIndex = 0;
  int weight = 400;  // CSS / OpenType weight
  bool italic = false;
};

/// Blink's default font for a CSS generic family on Linux (Chromium's
/// default font prefs: serif → Times New Roman, sans-serif → Arial, monospace →
/// Monospace …, system-ui → fontconfig's sans-serif); other names unchanged.
[[nodiscard]] std::string linux_generic_family(std::string_view family);

/// Skia's IsMetricCompatibleReplacement: `a` and `b` are the same
/// metric-compatible group (Arial / Liberation Sans, Times New Roman /
/// Liberation Serif, MS Gothic / IPAGothic …), case-insensitively.
[[nodiscard]] bool is_metric_compatible_replacement(std::string_view a, std::string_view b);

/// The installed family fontconfig resolves `family` to, accepted only when
/// Chromium would accept it: the family itself, the family fontconfig's strong
/// aliases name, a metric-compatible replacement, or any match for the
/// generic names "sans" / "serif" / "monospace". nullopt: not installed (the
/// canvas then falls back to the next family in its list), or no fontconfig.
[[nodiscard]] std::optional<std::string> match_system_family(std::string_view family, int weight = 400, bool italic = false);

/// Blink's FontCache::AlternateFamilyName: Arial <-> Helvetica, Courier <->
/// Courier New, Times <-> Times New Roman: the name Blink retries when a family
/// is not found. "" when none.
[[nodiscard]] std::string blink_alternate_family(std::string_view family);

/// What a canvas `font` family resolves to on Linux Chromium: the generic
/// mapping (linux_generic_family), match_system_family, then one retry with
/// the Blink alternate name. The installed family, or nullopt (a miss).
[[nodiscard]] std::optional<std::string> resolve_system_family(std::string_view cssFamily, int weight = 400, bool italic = false);

/// Every scalable installed face whose family is `installedFamily` (as
/// match_system_family returned it), sorted (style, weight, file) so the
/// registration order does not depend on fontconfig's cache order.
[[nodiscard]] std::vector<SystemFace> list_system_faces(std::string_view installedFamily);

/// True when this build can discover system fonts (fontconfig linked).
[[nodiscard]] bool system_fonts_available() noexcept;

}  // namespace premation::raster
