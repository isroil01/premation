// fontFaceVariants.ts featureSettingsString (E3): the CSS font-feature-settings
// a text layer's OpenType options ask for, "" at defaults. The TS can only
// apply it through an alias FontFace (Chromium's canvas has no
// fontFeatureSettings); the C++ canvas shapes with HarfBuzz and takes it
// directly (Canvas2D::setFontFeatureSettings) when CanvasOptions::aliasFaces is on.
#pragma once

#include <algorithm>
#include <array>
#include <cstdio>
#include <string>
#include <vector>

namespace premation::raster {

[[nodiscard]] inline std::string feature_settings_string(bool ligaturesOff, bool discretionaryLigatures, bool contextualAlternatesOff,
                                                         std::vector<int> stylisticSets) {
  std::vector<std::string> parts;
  if (ligaturesOff) {
    parts.emplace_back("'liga' 0");
    parts.emplace_back("'clig' 0");
  }
  if (discretionaryLigatures) parts.emplace_back("'dlig' 1");
  if (contextualAlternatesOff) parts.emplace_back("'calt' 0");
  // [...new Set(sets.filter(1..20 integers))].sort((a, b) => a - b)
  std::erase_if(stylisticSets, [](int n) { return n < 1 || n > 20; });
  std::ranges::sort(stylisticSets);
  const auto dup = std::ranges::unique(stylisticSets);
  stylisticSets.erase(dup.begin(), dup.end());
  for (const int n : stylisticSets) {
    std::array<char, 16> buf{};
    (void)std::snprintf(buf.data(), buf.size(), "'ss%02d' 1", n);  // NOLINT(cppcoreguidelines-pro-type-vararg)
    parts.emplace_back(buf.data());
  }
  std::string out;
  for (const auto& p : parts) out += (out.empty() ? "" : ", ") + p;
  return out;
}

}  // namespace premation::raster
