// D3 colour management from the engine's own document (D2w): the project's
// colour settings → RenderView.colorManagement, and each texture's input
// interpretation → RenderTextureRef.inputSpace. After Effects' model
// (docs/NATIVE_CORE_PLAN.md §5, "D2 leftovers + D3"):
//
//   Project Settings ▸ Working Space   `ProjectSettings.workingSpace` (+ `ocioConfig`).
//       None, and the two spaces today's TS pipeline itself honours (linear sRGB,
//       ACEScg — the ColorMgmt mirror the TS producer renders with) with no OCIO
//       config, stay UNMANAGED: colorManagement absent, the TS pipeline byte for
//       byte (the golden gate). Every other working space, or any OCIO config,
//       is managed: compositing is linear light in that space's primaries
//       (AE's "Linearize Working Space", always on).
//   Viewer display                     `ColorMgmt.displayTransform`: sRGB, or the
//       ACES SDR output view on the sRGB display.
//   Output module                      RenderSettings.outputColorSpace on an export frame.
//   Interpret Footage ▸ Color          per texture: footage by what the file says
//       (media/yuv.hpp input_space_of — H.273 primaries/transfer), stills as sRGB,
//       authored text / shape rasters as sRGB (their colours are sRGB-authored);
//       masks and LUT strips are data and stay untagged.
//
// What the RenderColorSpace vocabulary cannot express (a Display P3 working
// space, PQ / HLG viewer transforms) leaves the frame on the TS pipeline and
// says so in `note` (surfaced as a frame-level error, never drawn wrong).
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "engine_api.hpp"

namespace premation::doc {
class Document;
}

namespace premation::scene {

struct ColorManagementChoice {
  std::optional<api::RenderColorManagement> management;
  /// Why a requested setting could not be honoured ('' = none).
  std::string note;
};

/// The frame's colour management from the document's settings; `outputColorSpace`
/// is the render-queue item's output module space on an export frame ('' = viewer).
[[nodiscard]] ColorManagementChoice color_management_of(const doc::Document& d, std::string_view outputColorSpace = {});

/// An output module / interpretation colour-space name ("sRGB", "Rec. 709",
/// "rec2020", "Linear sRGB", "ACEScg", "ACES2065-1", …) → RenderColorSpace.
[[nodiscard]] std::optional<api::RenderColorSpace> color_space_named(std::string_view name);

}  // namespace premation::scene
