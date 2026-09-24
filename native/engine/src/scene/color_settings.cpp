#include "color_settings.hpp"

#include <algorithm>
#include <array>
#include <utility>

#include "model.hpp"

namespace premation::scene {
namespace {

/// Lower-case letters and digits only: "Rec. 709" → "rec709", "ACES2065-1" → "aces20651".
std::string fold(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (const char c : s) {
    if (c >= 'A' && c <= 'Z') out.push_back(static_cast<char>(c - 'A' + 'a'));
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out.push_back(c);
  }
  return out;
}

/// The ACES 1.0 SDR output transform on the sRGB display (OCIO's built-in CG config).
constexpr std::string_view kAcesSdrView = "ACES 1.0 - SDR Video";

}  // namespace

std::optional<api::RenderColorSpace> color_space_named(std::string_view name) {
  using S = api::RenderColorSpace;
  static constexpr std::array<std::pair<std::string_view, S>, 16> kNames = {{
      {"srgb", S::srgb},
      {"srgbiec6196621", S::srgb},
      {"srgbiec61966", S::srgb},
      {"rec709", S::rec709},
      {"bt709", S::rec709},
      {"hdtvrec709", S::rec709},
      {"linearsrgb", S::linear_srgb},
      {"srgblinear", S::linear_srgb},
      {"linearrec709", S::linear_srgb},
      {"acescg", S::aces_cg},
      {"rec2020", S::rec2020},
      {"bt2020", S::rec2020},
      {"linearrec2020", S::linear_rec2020},
      {"rec2020linear", S::linear_rec2020},
      {"aces20651", S::aces2065},
      {"aces2065", S::aces2065},
  }};
  const std::string f = fold(name);
  if (f.empty()) return std::nullopt;
  for (const auto& [k, v] : kNames) {
    if (k == f) return v;
  }
  return std::nullopt;
}

ColorManagementChoice color_management_of(const doc::Document& d, std::string_view outputColorSpace) {
  using W = api::ColorWorkingSpace;
  using S = api::RenderColorSpace;
  ColorManagementChoice out;
  const api::ProjectSettings& ps = d.project();
  const doc::ColorMgmt& cm = d.color();
  const bool haveConfig = !ps.ocio_config.empty();
  // Unmanaged: None, and what today's TS pipeline renders itself (no config).
  if (ps.working_space == W::none) return out;
  if (!haveConfig && (ps.working_space == W::srgb_linear || ps.working_space == W::acescg)) return out;

  api::RenderColorManagement m;
  switch (ps.working_space) {
    case W::srgb:
    case W::srgb_linear:
    case W::rec709: m.working_space = S::linear_srgb; break;
    case W::rec2020: m.working_space = S::linear_rec2020; break;
    case W::acescg:
    case W::acescct: m.working_space = S::aces_cg; break;
    case W::display_p3:
      out.note = "the Display P3 working space has no RenderColorSpace yet: the frame uses the unmanaged pipeline";
      return out;
    case W::none: return out;
  }
  m.display_space = S::srgb;
  if (cm.displayTransform == "aces") {
    m.view = std::string(kAcesSdrView);
  } else if (cm.displayTransform == "pq" || cm.displayTransform == "hlg") {
    out.note = "the " + cm.displayTransform +
               " viewer transform has no RenderColorSpace display yet: the frame uses the unmanaged pipeline";
    return out;
  }
  if (!outputColorSpace.empty()) {
    if (const auto os = color_space_named(outputColorSpace)) {
      m.output_space = *os;
    } else {
      out.note = "output colour space '" + std::string(outputColorSpace) + "' is not a RenderColorSpace: the display space is used";
    }
  }
  if (haveConfig) m.ocio_config = ps.ocio_config;
  out.management = std::move(m);
  return out;
}

}  // namespace premation::scene
