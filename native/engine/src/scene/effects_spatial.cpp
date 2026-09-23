#include "effects_spatial.hpp"

namespace premation::scene {

// The branches live in two files (effects_spatial_a.cpp: snapshotToFrameScene.ts
// up to 'rolling-shutter'; effects_spatial_b.cpp: 'card-dance' onwards).
bool is_more_spatial(std::string_view type) { return spatial_a_handles(type) || spatial_b_handles(type); }

bool extract_more_spatial(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out) {
  return spatial_a(e, params, layer, out) || spatial_b(e, params, layer, out);
}

}  // namespace premation::scene
