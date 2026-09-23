// The built-in passes and the default graph (rendergraph/passes/index.ts).
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string_view>

#include "graph.hpp"

namespace premation::rg {

inline constexpr std::string_view kSceneColor = "scene-color";
inline constexpr std::string_view kLayerTarget = "layer-target";
inline constexpr std::string_view kBlur1 = "blur-target1";
inline constexpr std::string_view kBlur2 = "blur-target2";
inline constexpr std::string_view kBlur3 = "blur-target3";
inline constexpr std::string_view kMatteTarget = "matte-target";
inline constexpr std::string_view kBackdropHalf1 = "backdrop-half1";
inline constexpr std::string_view kBackdropHalf2 = "backdrop-half2";
inline constexpr std::string_view kDofTarget = "dof-target";
inline constexpr std::string_view kPluginOrigin = "plugin-origin";
inline constexpr std::string_view kGeneratorTarget = "generator-target";
inline constexpr std::string_view kFxHist = "fx-hist";
inline constexpr std::string_view kFxLut = "fx-lut";
inline constexpr std::array<std::string_view, 4> kPrecompTargets = {"precomp-target-0", "precomp-target-1",
                                                                    "precomp-target-2", "precomp-target-3"};
inline constexpr std::uint32_t kBackdropDownscale = 2;
inline constexpr std::uint32_t kMsaaSamples = 4;

/// clear → background → composition → effect (scene-colour blit to the surface),
/// with every transient target the TS graph declares. EffectPass is always on:
/// intermediates stay linear until its encode blit (LINEAR_INTERMEDIATE_STORAGE).
std::unique_ptr<RenderGraph> build_default_graph();

std::unique_ptr<RenderPass> make_clear_pass();
std::unique_ptr<RenderPass> make_background_pass();
std::unique_ptr<RenderPass> make_composition_pass();
std::unique_ptr<RenderPass> make_effect_pass();

}  // namespace premation::rg
