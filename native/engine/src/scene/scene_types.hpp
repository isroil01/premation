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
  /// A precomp container: its inner layers (present = container).
  std::optional<std::vector<RLayer>> precompLayers;
  std::optional<double> sourceTime;
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
  std::optional<double> skew, skewAxis;
  std::optional<double> backdropBlur;
  std::optional<ResolvedGlass> glass;
  // ── media ──
  std::optional<std::string> src;
  std::optional<std::string> assetId;
  std::optional<std::array<double, 4>> uvRect;
  bool premultipliedSource = false;
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
  /// 'snapshot' (the build threw) or 'unported' (a feature not in the C++ port yet).
  std::string stage;
  std::string message;
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
};

/// SnapshotComp (buildSnapshot.ts) — comp-level inputs.
struct SnapshotComp {
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
  /// SnapshotComp.camera3dMode: 'active', an ortho axis view, or `camera:<id>`.
  std::string camera3dMode = "active";
  /// SnapshotComp.customViewCamera (a custom 3D view; replaces the scene camera).
  std::optional<motion::xf::Camera> customViewCamera;
  /// SnapshotComp.draft3d.
  bool draft3d = false;
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
