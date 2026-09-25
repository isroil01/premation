// Colour LUT effects for the scene builder (D2w) — the C++ twin of
//
//   colorLut.ts          LUT_BUILDERS (Levels, Curves, Posterize, Exposure, Lumetri,
//                        Colour Balance, Gamma/Pedestal/Gain) + buildChannelLut,
//                        applyChannelLut, lutStripByte, sampleChannelLutAsUploaded
//   aeRoundSevenLuts.ts  Color Offset, Threshold RGB, Cineon Converter
//   cubeLut.ts           the stored `.cube` table (fromStoredLut), applyLutToImageData
//   AppTextureProvider   setLut (the 256×1 `lut:<id>` strip) and setCubeLut (the
//                        `cubelut:<id>` slice strip)
//
// Tables are float32 in 0..255 like the TypeScript's Float32Array, built with
// V8's Math (motion::js), so every table — and so every strip byte — is the
// TypeScript's exactly.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "frame_build.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// ChannelLut: 256-entry output tables (0..255, float32), one per channel.
struct ChannelLut {
  std::array<float, 256> r{};
  std::array<float, 256> g{};
  std::array<float, 256> b{};
};

/// `isLutEffect(type)` — the LUT_BUILDERS membership.
[[nodiscard]] bool is_lut_effect_type(std::string_view type);

/// `buildChannelLut(effects)`: the enabled LUT effects composed in order; nullopt
/// when there is none.
[[nodiscard]] std::optional<ChannelLut> build_channel_lut(const std::vector<Json>& effects);

/// `sampleChannelLutAsUploaded(lut, rgb)` — a uniform colour through the strip,
/// the way the LUT shader samples it (display-referred 0..1 in and out).
[[nodiscard]] std::array<double, 3> sample_channel_lut_as_uploaded(const ChannelLut& lut, const std::array<double, 3>& rgb);

/// A parsed `.cube` LUT (CubeLut), rehydrated from the effect's stored `lut` param.
struct CubeLut {
  int size = 0;    ///< 3D edge (0 for a 1D LUT)
  int size1d = 0;  ///< 1D entry count (0 for a 3D LUT)
  std::vector<float> data;  ///< interleaved RGB, float32 like the TypeScript's Float32Array
  std::array<double, 3> domainMin{0, 0, 0};
  std::array<double, 3> domainMax{1, 1, 1};
};

/// `readCubeLutParam(e)` (fromStoredLut(e.params.lut)).
[[nodiscard]] std::optional<CubeLut> read_cube_lut_param(const Json& e);

/// The texture requests MotionRendererBackend feeds for a layer's colour LUTs:
/// `lut:<id>` when a per-channel LUT effect is enabled, `cubelut:<id>` for the
/// first enabled Apply Color LUT whose table parses. Appended to `out`.
void append_lut_textures(const RLayer& l, std::vector<TextureRequest>& out);

/// The `apply-color-lut` chain entry extractSpatialEffects writes (nullopt when
/// the stored table does not parse — the TypeScript then omits the entry).
[[nodiscard]] std::optional<api::RenderEffect> apply_color_lut_entry(const Json& e, const Json& params, const RLayer& l);

/// gradeUniformColor's LUT half: `rgb` (after the colour matrix) through the
/// layer's composed per-channel LUT; unchanged when it has none.
[[nodiscard]] std::array<double, 3> grade_uniform_lut(const RLayer& l, const std::array<double, 3>& rgb);

}  // namespace premation::scene
