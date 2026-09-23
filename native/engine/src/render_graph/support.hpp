// The D2 porting gate: which FrameScene features the C++ graph renders.
#pragma once

#include <string>
#include <vector>

#include "frame_scene.hpp"

namespace premation::rg {

/// Every feature `f` uses that the C++ render graph has not ported yet (empty = renderable).
[[nodiscard]] std::vector<std::string> unported_features(const api::RenderFrameFile& f);

}  // namespace premation::rg
