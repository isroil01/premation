/**
 * @motion/design-system — authored static design.
 *
 * Motion animates a design. Build a technique library against primitive
 * rectangles and you encode the wrong assumptions about what is being moved — so
 * this package comes first, and its output is what the technique library receives.
 *
 * Same purity contract as `@motion/ai-tools`: no DOM, no stores, no `@core`. It
 * emits `ToolCall[]` and executes nothing, which is what lets the backend
 * planner, the renderer and the tests all share one implementation.
 */

export {
  type Oklch,
  type Palette,
  type PaletteOptions,
  type HarmonyKind,
  ACCENT_AREA_LIMIT,
  DOMINANCE,
  RAMP_L_MAX,
  RAMP_L_MIN,
  buildPalette,
  contrast,
  enforceContrast,
  gradientStops,
  harmonize,
  hexToOklch,
  hexToRgb,
  isPureBlackOrWhite,
  luminance,
  mix,
  oklchToHex,
  ramp,
  requiredContrast,
  rgbToHex,
} from './color';

export {
  type GridSpec,
  type HAlign,
  type PlaceSpec,
  type Placement,
  type VAlign,
  CAP_HEIGHT_RATIO,
  MIN_NEGATIVE_SPACE,
  X_HEIGHT_RATIO,
  baselineRows,
  baselineY,
  columnLeft,
  columnWidth,
  contentWidth,
  grid,
  isOnGrid,
  negativeSpaceRatio,
  opticalCenterY,
  opticalLeftX,
  place,
  snapBaseline,
  spanCenterX,
  spanWidth,
} from './grid';

export {
  type FontSpec,
  type ScaleRatio,
  type TypePairing,
  type TypeRole,
  type TypeScaleOptions,
  type TypeStyle,
  MIN_SIZE_RATIO,
  MIN_WEIGHT_CONTRAST,
  SCALE_RATIOS,
  TYPE_PAIRINGS,
  baseSizeFor,
  breakLines,
  hasHierarchyContrast,
  isDisplaySize,
  pairing,
  scaleStep,
  tracking,
  typeStyle,
} from './type';

export {
  type Elevation,
  type ElevationOptions,
  type GlassSurface,
  type ShadowLayer,
  ambientOcclusion,
  elevation,
  glass,
  isSingleShadow,
  shadowColorFor,
} from './depth';

export {
  type BackgroundLight,
  type SurfaceStyle,
  type SurfaceTreatment,
  BASE_TREATMENT,
  backgroundLight,
  halation,
  isUntreated,
  treatment,
} from './surface';

export {
  type RadiusStep,
  type ShapeLanguage,
  type ShapeVocabulary,
  RADIUS_SCALE,
  hasUniformRadius,
  radius,
  shapeLanguage,
  strokeScale,
} from './shape';

export {
  type LookPack,
  type MotionSignature,
  type MotionVocabulary,
  type Pacing,
  type ResolveOptions,
  type ResolvedPack,
  LOOK_PACKS,
  lookPack,
  packAllows,
  packsFor,
  resolvePack,
} from './packs';

export {
  type ComposeContext,
  type ComposeResult,
  type LayoutTemplate,
  type SlotContent,
  type SlotDef,
  type SlotRole,
  COMPOSITION_BACKDROP_ID,
  COMPOSITION_SURFACE_ID,
  composeContext,
  emitText,
  layerId,
  resultNegativeSpace,
  textMetricsFor,
} from './compose';

export {
  type Candidate,
  type CandidateQuery,
  LAYOUT_TEMPLATES,
  availableRoles,
  briefFor,
  candidates,
  layoutTemplate,
  layoutTemplateIds,
  templatesForPack,
} from './registry';

export {
  type DesignFinding,
  type DesignRule,
  type LintLayer,
  type LintScene,
  type Severity,
  designScore,
  formatDesignFindings,
  lintDesign,
} from './lint';

export { type ToolCall, mk, mulberry32, pick, pickInt, shuffled } from './toolcall';

export { emitBackdrop, emitCompositionBackdrop, emitMedia, emitPanel, emitRule } from './templates/shared';

export {
  emitDepth,
  emitLitStage,
  emitTypeMask,
  type LitStage,
} from './stage';

export {
  GRAPHIC_DEVICES,
  deviceFor,
  devicesForPack,
  type DeviceContext,
  type GraphicDevice,
} from './devices';

export {
  DEVICES,
  device,
  fitDevice,
  type DeviceBox,
  type DeviceSpec,
} from './templates/device';
