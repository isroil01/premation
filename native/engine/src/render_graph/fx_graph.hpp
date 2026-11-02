// Program X0 (docs/PROGRAM_DEEP_EFFECTS.md): the `fx-graph` chain entry — a
// multi-pass effect written as DATA by its packer (scene/fx_graph_writer.hpp)
// and run here, so a deep effect (a bloom pyramid, an anisotropic Kuwahara, a
// jump-flood fill) is a list of passes + WGSL, never bespoke chain code.
//
// The entry's params:
//   mats   text  the pass shaders, comma-separated builtin names (shaders/wgsl,
//                listed in materials.json "shaders"); each is drawn through a
//                dynamic material whose WGSL is `fxx-prelude` + the shader.
//   g      nums  the passes, each a 10-number header + its rows:
//                  op  arg  out  in0 in1 in2 in3  blend  flags  nrows  [rows × 4]
//                op 0 shader (arg = index into mats), 1 blur along x, 2 blur
//                along y (arg = sigma in layer px; reads in0), 3 copy in0,
//                4 the alpha distance field of in0 (fx_distance.hpp; arg =
//                its range in layer px): r = signed distance to the
//                1/2-contour in buffer texels (+ outside), g = the alpha.
//                flags bit 0: keep `out` (no clear); bit 1: the pass reads the
//                scene depth at binding 6.
//   out    num   the slot holding the result.
//   mapLayerId / mapLayerId2 / mapLayerId3  text  the layers MAP / MAP2 / MAP3 read.
//   dataKey text a frame texture for DATA (a table, a curve strip: floats
//                packed one per RGBA8 texel, 1024 a row — fxx-prelude fetchF).
//   maskKey0 / maskKey1  text  mask rasters (fxmask:…) for MASK0 / MASK1,
//                drawn through the layer's placement into the buffer's space.
//   tapId0..3  text  Program X1: the layer's time taps (hidden copies of it
//                at other times, placed where it is now — scene/deep_fx_scene.hpp)
//                for TAP0..TAP3.
//
// Slots: 0 IN (the chain's input, read only) · 1–3 A B C (the free pool
// targets; C falls back to X3 when the pool has two) · 4–7 X0–X3 (float data
// targets) · 8–9 H0 H1 (half resolution) · 10–11 Q0 Q1 (quarter) · 12–14 MAP
// MAP2 MAP3 (read only; with two or more maps, MAP lives in X3 and MAP2 in X2,
// so such a graph leaves those two alone) · 15 DATA (read only) · 16–17
// MASK0 MASK1 (read only) · 18 STRIP (a 256 × 1 target: a reduction's partials)
// · 19–22 TAP0..TAP3 (read only: the layer at other times) · 23–30 SIM0..SIM7
// (Program X2: a simulation's persistent state at its own resolution).
//
// Program X2 — a simulation: `simKey` (text, unique per layer + effect) with
// `simW` / `simH` (its resolution), `simFrame` (the frame to reach), `simHash`
// (its controls: a change starts it over), `simSub` (steps a frame), `simFps`,
// `simEvery` (checkpoint interval), `simState` (the SIM slots that ARE its
// state) and two pass lists in the graph's format — `simInit` (run once) and
// `simStep` (run `simSub` times a frame) — writing SIM slots only. A sim pass's
// target covers the LAYER box (uv 0..1 = layer px / lw, lh: view-independent),
// and its row 14 is (sim time, step dt, frame, substep). The executor keeps the
// state in persistent device targets with checkpoints, so any frame is the
// same function of the controls, reached in any order.
//
// Every shader pass gets: binding 1 = in0, 3 = in1, 4 = in2, 5 = in3 (an unset
// input = IN), the rows padded to 15, a `res` row (lw, lh, outW, outH), a
// `world` row (the comp px rect the buffer shows; zero on the 3D route) and
// the layer box (fxBox). A pass may not write a slot it reads. Anything malformed —
// an unknown shader, a slot out of range, a missing depth — runs nothing and
// the chain keeps its input (reliability: never a blank frame).
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>

#include "frame_scene.hpp"
#include "render_context.hpp"

namespace premation::rg {

inline constexpr int kFxgIn = 0;
inline constexpr int kFxgA = 1;
inline constexpr int kFxgB = 2;
inline constexpr int kFxgC = 3;
inline constexpr int kFxgX0 = 4;
inline constexpr int kFxgH0 = 8;
inline constexpr int kFxgQ0 = 10;
inline constexpr int kFxgMap = 12;
inline constexpr int kFxgData = 15;
inline constexpr int kFxgMask0 = 16;
inline constexpr int kFxgStrip = 18;
inline constexpr int kFxgTap0 = 19;
inline constexpr int kFxgSim0 = 23;
inline constexpr std::size_t kFxgSimSlots = 8;
/// Stream D (2026-11-02): 31 BACKDROP (read only) — the scene under the layer,
/// copied by the composition pass before the chain of a layer whose entry
/// carries `readsBackdrop` (Graph::backdrop()); transparent black otherwise
/// (a layer-space chain on the 3D route, an entry without the flag).
inline constexpr int kFxgBackdrop = 31;
inline constexpr int kFxgSlots = 32;
/// The mask rasters' targets (declared in passes.cpp).
inline constexpr std::array<std::string_view, 2> kFxMaskTargets = {"fx-mask-0", "fx-mask-1"};
/// The time taps' targets (declared in passes.cpp).
inline constexpr std::array<std::string_view, 4> kFxTapTargets = {"fx-tap-0", "fx-tap-1", "fx-tap-2", "fx-tap-3"};
/// Param rows a pass may carry (the prelude's `p` array).
inline constexpr std::size_t kFxgRows = 15;

struct FxGraphIO {
  TexRef in;
  std::string_view inName;
  /// The chain's free pool targets (f0, f1, f2; f2 may be empty).
  std::array<std::string_view, 3> free;
  Mat3 mvp;
  Rect targetUv;
  Rect fxBox;
  /// Layer px → buffer texels on the 3D route (FxSpace); in screen space
  /// (`screenSpace`) the graph measures it from the layer box instead, so a
  /// deep effect scales with its layer and the viewer's zoom, as in AE (an
  /// effect renders in layer space, before the layer's transform).
  double kx = 1;
  double ky = 1;
  bool screenSpace = true;
  /// The comp px the buffer shows (the viewport's visible world rect; a
  /// screen-space chain only) — every pass's `world` row.
  Rect world;
  /// Another layer drawn where it sits in the comp (empty = unavailable).
  std::function<TexRef(std::string_view id)> mapLayer;
  /// The scene depth (empty = unavailable: the 3D route, no 3D layers).
  std::function<TexRef()> depth;
  /// A mask raster by key drawn into `dest` in the buffer's space (empty = none).
  std::function<TexRef(std::string_view key, std::string_view dest)> maskInto;
  /// Stream D: the scene under the layer (BACKDROP), in the buffer's space; empty = unavailable.
  std::function<TexRef()> backdrop;
};

struct FxGraphResult {
  TexRef tex;
  std::string_view name;
};

/// Runs an `fx-graph` entry; nullopt = nothing drawn (`why` says what was wrong).
[[nodiscard]] std::optional<FxGraphResult> run_fx_graph(PassContext& ctx, const Fx& fx, const FxGraphIO& io, std::string& why);

/// The WGSL a graph shader compiles as (`fxx-prelude` + the shader); empty when unknown.
[[nodiscard]] const std::string& fx_graph_wgsl(std::string_view shader);

}  // namespace premation::rg
