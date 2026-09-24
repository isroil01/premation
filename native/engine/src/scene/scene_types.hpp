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
#include <optional>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"

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
