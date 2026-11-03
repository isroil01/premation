// The engine's own frame description, built from ITS document (D2w,
// docs/NATIVE_CORE_PLAN.md): the C++ port of the TypeScript
//
//   buildSnapshot   src/core/rendering/buildSnapshot.ts   document + t → RenderSnapshot
//   snapshotToFrameScene  src/core/rendering/snapshotToFrameScene.ts   → FrameScene
//
// `RLayer` is RenderLayer (src/core/rendering/RenderBackend.ts) for the fields
// this port carries. The paint / geometry / text sub-objects the rasters read
// (fill paints, strokes, masks, runs, text extras…) stay the document's own
// JSON (js::Json), passed through exactly as the TypeScript passes them, so the
// E3 painters (native/engine/src/raster) receive the same drawable the TS
// rasterizer did.
//
// Everything here is plain data: no GPU, no fonts, no clock. A frame is a pure
// function of (document, composition, time, settings) — CLAUDE.md determinism.
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"
#include "transform.hpp"

namespace premation::scene {

namespace api = premation::api;
using js::Json;

/// RenderLayer.kind.
enum class LayerKind : std::uint8_t { shape, text, image, video };

/// RenderLayer.deformedMesh — the puppet / skeleton mesh (rig_mesh.cpp), in
/// CENTRED local pixels; snapshotToFrameScene normalises it to the unit quad.
struct DeformedMeshData {
  std::vector<float> vertices;               ///< x, y, u, v per vertex
  std::vector<std::uint16_t> triangles;
  std::optional<std::vector<float>> depth;   ///< overlap depth per vertex (absent = flat)
};

/// MotionSample (RenderBackend.ts).
struct MotionSample {
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, opacity = 1;
  std::optional<std::array<double, 6>> matrix;
  /// AE parity 4.2: a 3D layer's world matrix at this sample (column-major), so
  /// the renderer can draw the sample on the depth-tested path.
  std::optional<std::array<double, 16>> world3d;
  /// A 3D comp card's projected corners at this sample (RenderLayer MotionSample.quad).
  std::optional<std::array<double, 8>> quad;
};

/// RenderLayer.precompScene3d — a sealed comp instance's own 3D frame (its camera,
/// lights and environment), in the INNER comp's world and pixels.
struct PrecompScene3D {
  api::RenderCamera3D camera3d;
  std::vector<api::RenderLight3D> lights3d;
  std::optional<api::RenderEnvMap> envMap;
  std::optional<api::RenderFog> fog;  ///< AE parity 4.8
};

/// TrackMatte (effects/matte.ts).
struct Matte {
  bool luma = false;
  bool inverted = false;
  std::optional<std::string> sourceId;
};

/// ResolvedGlass (effects/glassResolve.ts): the Glass layer style at one frame
/// (colours as the stored hex, angles in degrees — the renderable converts).
struct ResolvedGlass {
  double blur = 0, saturation = 0;
  std::string tintColor;
  double tintOpacity = 0, refraction = 0, edgeWidth = 0, chromaticAberration = 0;
  std::string rimColor;
  double rimOpacity = 0, rimWidth = 0, rimAngle = 0, specularAngle = 0, specularIntensity = 0, specularFalloff = 0,
         grain = 0;
  /// Liquid glass (stream D L4): 0 edge (the original), 1 dome, 2 luma, 3 another layer (`bumpLayerId`).
  int bumpSource = 0;
  double thickness = 24, ior = 1.5, dispersion = 0, caustic = 0, fresnel = 0;
  std::string bumpLayerId;
};

/// RenderLayer.light — a light layer's screen-blended glow quad.
struct LightWash {
  std::string color;
  double intensity = 100;
  double radius = 500;
  double screenRadius = 500;
  std::string type = "point";
  double cone = 45;
  double coneFeather = 50;
  bool pool = false;
};

/// RenderLayer.extrudedMesh.ranges[i] — one draw range of an extruded / primitive mesh.
struct MeshRange3D {
  api::RenderMeshRole role = api::RenderMeshRole::front;
  std::uint32_t first = 0;
  std::uint32_t count = 0;
  std::string fill;  ///< the range colour as the snapshot names it (graded by the frame build)
  double gain = 1;
  bool textured = false;
  bool paintTextured = false;
};

/// RenderLayer.extrudedMesh — the mesh a 3D solid draws (extrusion, primitive).
struct ExtrudedMeshData {
  /// Key + vertex / index bytes + index format (ranges left empty; see `ranges`).
  api::RenderExtrudedMesh geometry;
  std::vector<MeshRange3D> ranges;
  /// The gradient plate the paint-textured wall ranges sample (paint:<id>): the
  /// layer box filled edge to edge with its fillPaint (absent = none).
  struct Paint {
    std::string key;
    Json fillPaint;
    std::string fill;
    double width = 0, height = 0;
  };
  std::optional<Paint> paint;
  /// An imported model's PBR maps: texture key (`pbrmap:<id>:<n|m|o|e>`, named
  /// in geometry.pbr) → the image it is fed from (`gltf:<modelKey>#<image>`).
  std::vector<std::pair<std::string, std::string>> mapSources;
};

/// One of a layer's subjects at the layer's time (core/subjects.hpp): its stored matte frame
/// and its live edge (layer/subjects), applied when the matte is read (scene_textures.cpp).
struct SubjectPart {
  std::string id;
  std::string src;
  /// Temporal smoothing: the neighbouring stored frames mixed in, with their weights (the
  /// frame itself carries the rest).
  std::vector<std::pair<std::string, double>> blend;
  double feather = 0;   ///< px, a Gaussian of the edge
  double choke = 0;     ///< px, + shrinks the subject, − grows it
  double contrast = 0;  ///< 0–1, steepens the soft edge
  bool invert = false;
  /// Hidden in the Subjects panel, or outside the range it was tracked over: it covers nothing now.
  bool hidden = false;
  /// Stream B5: the stored frames playback reaches next (their `src`, in time order), for the
  /// texture feed to decode ahead of the playhead — like footage read-ahead. Empty when not playing.
  std::vector<std::string> ahead;
  /// Neutral: the stored picture as it is.
  [[nodiscard]] bool plain() const { return blend.empty() && feather <= 0 && choke == 0 && contrast <= 0 && !invert && !hidden; }
};

/// RenderLayer — the fields the port carries (see the header note).
struct RLayer {
  std::string id;
  LayerKind kind = LayerKind::shape;
  std::string blend = "normal";
  bool preserveTransparency = false;
  /// LayerMask `{paths: [...]}` (undefined = none).
  Json mask;
  std::optional<Matte> matte;
  std::optional<std::string> matteSourceId;
  bool isMatteSource = false;
  bool isAdjustment = false;
  bool draft = false;  ///< quality === 'draft'
  /// Continuous Rasterization (RenderLayer.continuousRaster): vector content re-rasterizes
  /// at its scale past the clamped tier ladder.
  bool continuousRaster = false;
  /// A precomp container: its inner layers (present = container).
  std::optional<std::vector<RLayer>> precompLayers;
  /// AE's Preserve Resolution When Nested on the container's composition: its
  /// layers rasterise at their own size, not at the container's scale.
  bool preserveResolution = false;
  /// A sealed comp instance's own 3D frame (see PrecompScene3D).
  std::optional<PrecompScene3D> precompScene3d;
  /// A 3D comp CARD: the card's projected corners (TL, TR, BR, BL; comp px).
  std::optional<std::array<double, 8>> quad3d;
  std::optional<double> sourceTime;
  /// A layer inside a sealed nested comp: that comp's time at this frame (the source time
  /// its instance was built at; comp_instance.cpp). Unset = the frame's own comp.
  std::optional<double> compSeconds;
  /// RenderLayer.frameBlend: the two source frames bracketing sourceTime and the
  /// sub-frame weight toward the second (video only; mode mix | pixelMotion).
  struct FrameBlend {
    double a = 0, b = 0, weight = 0;
    std::string mode;
  };
  std::optional<FrameBlend> frameBlend;
  std::vector<MotionSample> motionSamples;
  std::optional<std::array<double, 8>> cornerPin;
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
  double anchorX = 0, anchorY = 0;
  std::optional<std::array<double, 6>> matrix;
  double depth = 0;
  double opacity = 1;
  double width = 0, height = 0;
  std::optional<std::string> fill;
  Json fillPaint;   ///< FillPaint | undefined
  Json fillPaints;  ///< FillPaint[] | undefined
  Json stroke;      ///< Stroke | undefined
  Json strokes;     ///< Stroke[] | undefined
  std::optional<std::string> color;
  bool visible = true;
  std::string primitive = "rect";  ///< rect | ellipse | path
  double cornerRadius = 0;
  std::optional<std::array<double, 4>> cornerRadii;
  std::optional<std::array<double, 2>> cornerRadiusScale;
  Json pathPoints;  ///< BezierPoint[] | undefined
  Json subpaths;    ///< Subpath[] | undefined
  bool pathOpen = false;
  // ── text ──
  std::optional<std::string> text;
  double fontSize = 48;
  std::optional<std::string> fontFamily, fontWeight, fontStyle, align, textTransform, fontVariant, verticalAlign;
  std::optional<double> fontWidth, fontSlant, letterSpacing, lineHeight, paragraphSpacing;
  /// Tracking in 1/1000 em; `letterSpacing` already holds it at `fontSize` (runs re-resolve it at theirs).
  std::optional<double> tracking;
  std::optional<double> verticalScale, horizontalScale, baselineShift, textStrokeWidth;
  std::optional<bool> strokeOverFill;
  std::optional<std::string> textStroke;
  Json textExtras;  ///< TextExtras | undefined
  Json runs;        ///< RichRun[] | undefined
  Json glyphs;      ///< GlyphTransform[] | undefined
  Json textPath;    ///< | undefined
  Json paint;       ///< PaintConfig | undefined (paint_port.cpp)
  Json fontAxes;    ///< | undefined
  Json textStrokePaint;
  // ── compositing ──
  /// The resolved effect stack (Effect[], params sampled at t). Empty = none.
  std::vector<Json> effects;
  std::optional<double> fillOpacity;
  /// E4: this layer's stack runs on the render graph's GPU chain instead of a
  /// CPU bake — set by native_frame_of when the view renders on a device and
  /// gpu_effect_route(layer) holds (effects_port.hpp). layer_is_baked is false
  /// for such a layer, so every bake-dependent choice (padding, `__baked`,
  /// texture keys, LUT / mask routing) follows from this one flag.
  bool gpuEffects = false;
  std::optional<double> skew, skewAxis;
  std::optional<double> backdropBlur;
  std::optional<ResolvedGlass> glass;
  // ── media ──
  std::optional<std::string> src;
  std::optional<std::string> assetId;
  /// Use Proxies: the item's proxy file, decoded in place of `src` (which the
  /// texture feed falls back to when the proxy does not open). Set only when
  /// BuildContext::useProxies and the file exists; the layer's box, timing and
  /// interpretation stay the original's.
  std::optional<std::string> proxySrc;
  /// A content-aware fill frame (a still `data:` URL) standing in for the footage.
  std::optional<std::string> contentAwareFillSrc;
  /// The Object Matte frame (setLayerMatte) nearest the layer's time, when an
  /// effect reads it as a matte (effects_spatial.hpp reads_own_object_matte)
  /// instead of it standing in for the footage.
  std::optional<std::string> objectMatteSrc;
  /// The stored subject matte frame nearest the layer's time, whatever reads it
  /// (a layer set Behind this subject reads it through `subjectReferenced`).
  std::optional<std::string> subjectSrc;
  /// Another layer of the stack is Behind this layer's subject: the matte frame
  /// is requested as a texture (object_matte_key) for that layer's cut.
  bool subjectReferenced = false;
  /// The layer's visible subjects now (hidden ones left out), in panel order.
  std::vector<SubjectPart> subjects;
  /// The subsets of `subjects` other layers are Behind (layer/behindSubjects; empty = all), each a texture.
  std::vector<std::vector<std::string>> subjectSubsets;
  /// Behind Subject (layer/behindSubject): the footage layer whose subject this
  /// layer is hidden behind — it shows only outside that layer's subject matte.
  /// Cleared when that layer has no subject at this time.
  std::optional<std::string> behindSubject;
  /// Which of that layer's subjects are in front of this one (layer/behindSubjects; empty = all of them).
  std::vector<std::string> behindSubjects;
  /// Behind Subject's softness (layer/behindSubjectSoftness, px): the subject's edge feathered where it covers this layer.
  double behindSubjectSoftness = 0;
  /// Behind Subject's choke (layer/behindSubjectChoke, px): the subject's edge shrunk (+) or grown (−)
  /// where it covers this layer, so a soft edge's halo does not hide the text. 0 = as stored.
  double behindSubjectChoke = 0;
  std::optional<std::array<double, 4>> uvRect;
  bool premultipliedSource = false;
  /// Interpret Footage > Color > Assign Profile: the input space over the file's own tags.
  std::optional<api::RenderColorSpace> colorProfile;
  /// Interpret Footage ▸ Remove Pulldown (buildSnapshot `pulldownSource`): the
  /// 3:2 phase (0–4) the frames are rebuilt from fields with.
  std::optional<int> pulldownSource;
  /// Interpret Footage ▸ Fields without pulldown (`fieldsSource`): the field
  /// kept, 'u' upper / 'l' lower (the other is rebuilt); 0 = progressive.
  char fieldsSource = 0;
  // ── rigs ──
  std::optional<DeformedMeshData> deformedMesh;
  // ── 3D (threed_port.cpp) ──
  /// The layer's 4×4 world matrix (column-major) for the depth-tested path.
  std::optional<std::array<double, 16>> world3d;
  /// Per-quad Lambert gain (Accepts Lights).
  std::optional<std::array<double, 3>> lighting;
  /// Per-fragment material (the snapshot's `shade3d`; quadGain is added by the frame build).
  std::optional<api::RenderShade3D> shade3d;
  bool castsShadow3d = false;
  /// Only ever false (a receiver that refuses shadows).
  std::optional<bool> acceptsShadows3d;
  /// A particle emitter's resolved config (RenderLayer.particles; particle_port.cpp).
  Json particles;
  /// A light layer's glow wash (RenderLayer.light).
  std::optional<LightWash> light;
  /// A 3D solid's mesh. shared_ptr: the vertex bytes are immutable once built and
  /// every copy of the layer (shadows, the depth sort's moves) shares them.
  std::shared_ptr<const ExtrudedMeshData> extrudedMesh;
  /// RenderLayer.flatFacet: a facet of a larger body (no SDF edge coverage).
  bool flatFacet = false;
  // ── port bookkeeping ──
  /// Features this layer uses that the C++ port does not produce yet (the
  /// explicit fallback: reported per layer, never silently dropped).
  std::vector<std::string> unported;
};

struct LayerError {
  std::string layerId;
  std::string layerName;
  /// 'snapshot' (the build threw), 'unported' (a feature not in the C++ port:
  /// the frame draws without it and an export refuses the frame), or 'warning'
  /// (the frame draws without something it could not resolve — a missing
  /// plugin, an unreadable sky asset, a rig on an unreachable image …; the
  /// viewer says so and an export completes, listing it).
  std::string stage;
  std::string message;
  /// Stage `expression`: the API path of the property whose expression failed
  /// (`transform/position`, `effects/<id>/<param>`…); empty otherwise.
  std::string path{};
};

/// RenderSnapshot — the fields the port carries.
struct Snapshot {
  double width = 1920, height = 1080;
  std::string background = "#101014";
  bool transparent = false;
  double time = 0;
  double fps = 30;
  std::vector<RLayer> layers;
  std::vector<LayerError> layerErrors;
  // ── 3D (threed_port.cpp; present only when a layer has world3d) ──
  std::optional<api::RenderCamera3D> camera3d;
  std::vector<api::RenderLight3D> lights3d;
  std::optional<api::RenderSsao> ssao;
  std::optional<api::RenderEnvMap> envMap;
  std::optional<api::RenderFog> fog;                       ///< AE parity 4.8
  std::optional<api::RenderShadowCatcher> shadowCatcher;   ///< AE parity 4.3
  std::optional<api::RenderRendererSettings> renderer;     ///< Composition Settings ▸ Renderer (U3): DOF rings, MSAA
};

/// SnapshotComp (buildSnapshot.ts) — comp-level inputs.
struct SnapshotComp {  // NOLINT(bugprone-exception-escape): MSVC's std::map allocates a sentinel when moved
  double width = 1920, height = 1080;
  std::string background = "#101014";
  bool transparent = false;
  double globalLightAngle = 90, globalLightAltitude = 45;
  std::optional<double> durationSeconds;
  bool forExport = false;
  /// The composition root (a node id).
  std::string rootId;
  /// Comp instance recursion (MAX_COMP_DEPTH).
  std::vector<std::string> compStack;
  /// SnapshotComp.compOverrides: the Essential Properties the owning instance hands
  /// its sealed pass (`<origNodeId>/<prop>` → value).
  std::map<std::string, Json, std::less<>> compOverrides;
  /// The walk's frame rate when it is not the root comp's own: a nested pass runs
  /// on the host timeline's rate, as the TypeScript's single timeline does.
  std::optional<double> fps;
  /// SnapshotComp.camera3dMode: 'active', an ortho axis view, or `camera:<id>`.
  std::string camera3dMode = "active";
  /// SnapshotComp.customViewCamera (a custom 3D view; replaces the scene camera).
  std::optional<motion::xf::Camera> customViewCamera;
  /// SnapshotComp.draft3d.
  bool draft3d = false;
  /// A viewer's transparency grid (setViewport `transparencyGrid`): the root
  /// comp draws a checkerboard where it is transparent instead of its
  /// background. Viewer-only — never in an export, a thumbnail or a precomp.
  bool transparencyGrid = false;
  /// Its cell in comp px: 16 SCREEN px at the viewer's zoom, to the nearest power
  /// of two (AE's grid does not zoom with the picture); 0 = 16 comp px.
  double transparencyGridCell = 0;
  /// The comp's Enable Frame Blending switch (absent = on): off gates every layer's.
  bool frameBlending = true;
};

/// MotionBlurConfig (effects/motionBlur.ts).
struct MotionBlurCfg {
  bool enabled = false;
  double shutterAngle = 180;
  double shutterPhase = -90;
  double samples = 8;
  double adaptiveSampleLimit = 128;
  double fps = 30;
};

}  // namespace premation::scene
