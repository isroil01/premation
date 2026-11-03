// A native plugin effect as a FrameScene chain entry (G1) — the tagged
// parameter bag (engine-api 96_render.eapi RenderEffect) the scene builder
// writes (scene_native_fx.cpp) and the render glue reads (render_glue.cpp):
//
//   type "native-plugin"
//   matchName, instance ("<layer>/<effect id>"), layerId      text
//   sequence                         text   the FLAT sequence data (base64, from the document)
//   compTime, layerTime, timeStep    number flicks
//   fps, layerW, layerH              number
//   draft                            flag
//   p.<key>                          one per document param, at the frame time:
//                                      number (slider / angle / point axis / popup)
//                                      flag (checkbox) · color [r,g,b,a] · text (layer id)
//                                      numbers (path: 6 per vertex) + p.<key>.closed flag
//                                      SDK 1.1: text (STRING) · numbers (CURVE: x,y in 0..1;
//                                      GRADIENT: 5 per stop) · text (FILE: the item id) with
//                                      p.<key>.path / .name text and .missing flag (encode_native_file)
//   a.<key>                          text   an arbitrary-data param's bytes (base64)
//
// SDK 1.1 (pr_scene.h), only for an effect that declared the matching
// PR_OUT_FLAG_USES_* (scene_finish.cpp writes them from the built frame):
//   compW, compH                     number the comp size (the default camera's film)
//   cam.has, cam.ortho, cam.dof      flag
//   cam.view, cam.proj               numbers 16, column-major
//   cam.eye                          numbers 3
//   cam.zoom, cam.focus, cam.aperture number
//   lights                           numbers, kLightStride per light (see encode_native_scene)
//   p.<key>.m                        numbers 16: a LAYER param's world matrix — layer px (0,0 top-left) → world px; scene_finish.cpp
//                                    writes it off the document. Without a document (a bare FrameScene) it is the
//                                    renderable's drawn model (its unit quad: renderable_world_matrix)
//
// SDK 1.2 (scene_finish.cpp writes them):
//   layerStart                       number flicks: comp time of layer time 0
//   layer3d, mb                      flag   a 3D layer · motion blur on for this render (comp + layer)
//   shutterAngle, shutterPhase       number degrees
//   mbSamples                        number the comp's samples per frame
//   reachPx                          number how far the effect draws past the layer (result_rect /
//                                           COMP_SPACE): grows a 3D layer's chain buffer (threed.cpp)
//   samples                          numbers [time, what] per checkout_time sample (layer flicks, PR_SAMPLE_*)
//   s<i>.p.<key>                     sample i's animatable param values (number / flag / color, as p.<key>)
//   s<i>.cam.*, s<i>.lights, s<i>.p.<key>.m   sample i's camera, lights and LAYER matrices (as above)
//   s<i>.dp.cam.view, s<i>.dp.cam.proj  PR_SAMPLE_SCENE_DEPTH: the comp camera at sample i (absent = the frame's)
//   s<i>.dp.ids, s<i>.dp.m           its 3D layers' renderable ids (text, one per line) and models (16 each)
//
// SDK 1.4 (T, scene_finish.cpp writes it):
//   simState                         text   a STATEFUL effect's state after this layer frame's SIM_STEP (base64)
//
// So a frame stays a pure function of the document: a plugin instance's state
// travels with the frame, never from a cache only this process has.
#pragma once

#include <optional>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "host.hpp"

namespace premation::plugins {

inline constexpr std::string_view kNativeFxType = "native-plugin";

/// Decode an entry for `spec` into `out` (values default to the declared ones).
void decode_native_fx(const api::RenderEffect& e, const EffectSpec& spec, RenderInputs& out);

/// Doubles per light in the `lights` entry.
inline constexpr std::size_t kLightStride = 18;

/// SDK 1.1: write the camera / lights / LAYER-param matrices `spec` declared it
/// reads (PR_OUT_FLAG_USES_*) from the built frame scene into the entry. They
/// become part of the entry, so a change to any of them re-renders the effect,
/// and nothing else does.
/// SDK 1.2: `camera` / `lights` (non-null) replace the frame's — a comp camera and lights the
/// frame does not carry because it has no 3D layer (a plugin on a 2D solid still sees them).
void encode_native_scene(api::RenderEffect& e, const EffectSpec& spec, const api::RenderFrameScene& scene,
                         const api::RenderCamera3D* camera = nullptr, const std::vector<api::RenderLight3D>* lights = nullptr);

/// A renderable's layer → world matrix as encode_native_scene reports it (its 3D model, else its
/// 2D model at z = 0; column-major 16), nullopt when it has neither.
[[nodiscard]] std::optional<std::vector<double>> renderable_world_matrix(const api::Renderable& r);
/// The renderable `id` in `list` or its precomps' children.
[[nodiscard]] const api::Renderable* find_renderable_in(const std::vector<api::Renderable>& list, std::string_view id);

/// SDK 1.2: one checkout_time sample as scene_finish.cpp evaluated it.
struct SampleWire {
  std::int64_t time = 0;  ///< layer flicks
  std::uint32_t what = 0;
  /// PR_SAMPLE_PARAMS: the effect's `p.<key>` entries at that time (native_effect_entry's form).
  std::vector<api::RenderEffectParam> params;
  /// PR_SAMPLE_CAMERA: the comp camera (absent = the comp's default view).
  std::optional<api::RenderCamera3D> camera;
  /// PR_SAMPLE_LIGHTS.
  std::vector<api::RenderLight3D> lights;
  /// PR_SAMPLE_LAYER_TRANSFORMS: LAYER param key → its world matrix (16, column-major).
  std::vector<std::pair<std::string, std::vector<double>>> matrices;
  /// PR_SAMPLE_SCENE_DEPTH: the 3D layers and the camera at that time.
  std::optional<DepthPose> depth;
};
/// Write the samples into the entry (`samples` + the `s<i>.` entries); sorted by time.
void encode_native_samples(api::RenderEffect& e, const EffectSpec& spec, std::vector<SampleWire> samples);

/// SDK 1.2: the scene a DRAW_OVERLAY / OVERLAY_DRAG request carries (doc::NativeScene) into `in` —
/// compW / compH, and the camera, lights and LAYER matrices `spec` declared it reads, in the forms
/// the render selectors get them (through a chain entry: the same conversions as a frame's).
void decode_overlay_scene(const doc::NativeScene& scene, const EffectSpec& spec, RenderInputs& in);

/// SDK 1.1: a FILE param resolved against the document (doc::native_file_of) into the
/// entry — the path is part of the entry, so a relink re-renders the effect.
void encode_native_file(api::RenderEffect& e, const doc::NativeActionRequest::File& f);

/// The layer id of a checkout at `time` (flicks): `<layer>@<time>` — the hidden
/// renderable the scene hook adds for checkouts at times other than the frame's.
[[nodiscard]] std::string checkout_renderable_id(std::string_view layerId, std::int64_t time);

}  // namespace premation::plugins
