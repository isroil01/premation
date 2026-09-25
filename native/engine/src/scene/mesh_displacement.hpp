// buildSnapshot's `displacedCarrierFor` over the engine's own document (D2w 3D
// leftovers): a mesh carrier's height displacement, with the height field
// resolved from what the document stores.
//
//   field key  = Material Options' heightMapAssetId ?? heightMapSrc (the TS key)
//   field src  = the asset's `src` (the document's asset list), else heightMapSrc
//   decode     = heightDisplacement.ts decode(): the image drawn into a canvas of
//                at most 256 px a side (the C++ Canvas2D, same smoothing), read
//                back straight, Rec.709 luma blended to 0.5 by alpha
//
// A src the engine cannot read — the harness's in-memory `prime:` fields, a
// session `blob:` URL, a relative path with no project folder — leaves the
// mesh undisplaced and says why (the caller reports it), where the TS would
// render the frame flat until its async decode lands.
//
// Fields are decoded once per key and file stamp (process-wide, like the TS
// cache); displace_mesh (height_displacement.hpp) does the geometry.
#pragma once

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "camera3d_port.hpp"
#include "engine_api.hpp"
#include "height_displacement.hpp"
#include "model.hpp"

namespace premation::scene {

struct DisplacedCarrier {
  std::string key;  ///< `<meshKey>|disp:<field>:<amount>:<subdivisions>`
  DisplacedMesh mesh;
};

/// The field for `key` read from `src`, or null with `why` set.
[[nodiscard]] std::shared_ptr<const HeightField> height_field_for(std::string_view key, std::string_view src, std::string& why);

/// displacedCarrierFor: nullopt when the material has no displacement (amount
/// 0 or no map — `why` empty) or the field cannot be read (`why` set).
[[nodiscard]] std::optional<DisplacedCarrier> displaced_carrier_for(const doc::Document& d, std::string_view meshKey,
                                                                    std::span<const float> vertices,
                                                                    std::span<const std::uint32_t> indices, const Material& mat,
                                                                    std::string& why);

/// The carrier's geometry bytes: vertices as is, indices always uint32 (the
/// TypeScript's displaced Uint32Array), ranges left to the caller.
void displaced_to_api(const DisplacedCarrier& c, api::RenderExtrudedMesh& out);

/// Drop the decoded fields (tests).
void clear_height_fields();

}  // namespace premation::scene
