/**
 * The After Effects project, decoded.
 *
 * This is the shape `aepRead.ts` produces and `aepPlan.ts` consumes: a faithful
 * model of what the `.aep` says, in AE's own vocabulary and AE's own units —
 * seconds, degrees, AE percentages, AE's y-down comp space with the origin at
 * the top-left. Nothing here is translated into this editor's terms. That
 * happens exactly once, in the planner, which is what keeps "did we read the
 * file right?" and "did we map it right?" two separable questions with two
 * separable test suites.
 *
 * Properties keep their AE match names (`ADBE Position`, `ADBE Opacity`,
 * `ADBE Gaussian Blur 2`). A match name is stable across AE versions and
 * across UI languages, which is why it — and not the display name — is what
 * the mapping tables key on.
 */

// ── Items ───────────────────────────────────────────────────────────

export type AepItemKind = 'folder' | 'comp' | 'footage';

export interface AepItemBase {
  /** AE's project-wide item id — what a layer's `sourceId` points at. */
  id: number;
  name: string;
  kind: AepItemKind;
  /** AE label-colour index (0 = none). */
  label: number;
  /** Folder path from the project root, e.g. `['Assets', 'Logos']`. */
  folder: readonly string[];
}

export interface AepFolder extends AepItemBase {
  kind: 'folder';
}

export interface AepComp extends AepItemBase {
  kind: 'comp';
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  pixelAspect: number;
  /** 0–255 per channel, as AE stores it. */
  background: { r: number; g: number; b: number };
  displayStartTime: number;
  workAreaStart: number;
  /** `Infinity` when AE's "to the end" sentinel is set. */
  workAreaEnd: number;
  motionBlur: boolean;
  shutterAngle: number;
  shutterPhase: number;
  motionBlurSamplesPerFrame: number;
  motionBlurAdaptiveSampleLimit: number;
  frameBlending: boolean;
  hideShyLayers: boolean;
  draft3d: boolean;
  /**
   * Keyframe times are stored as integer counts of this unit, NOT as seconds
   * — `fps * 256 * timeScale`, e.g. 24576 for 24 fps. Carried on the comp
   * because a keyframe deep inside a layer has no other way to reach it.
   */
  internalTimebase: number;
  /** Top layer first, exactly as AE stacks them. */
  layers: AepLayer[];
}

export type AepFootageKind = 'file' | 'solid' | 'placeholder';

export interface AepFootage extends AepItemBase {
  kind: 'footage';
  footageKind: AepFootageKind;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  pixelAspect: number;
  /** Absolute path as AE last saw it. Absent for solids and placeholders. */
  path?: string;
  /** AE recorded the file as missing when the project was saved. */
  missingAtSave: boolean;
  /** Solid colour, 0–1 per channel. */
  solidColor?: { r: number; g: number; b: number };
  /** AE's 4-char source-format code (`png!`, `MOoV`, `Soli`, …). */
  sourceFormat: string;
  hasAudio: boolean;
  /** Still images have no duration of their own; AE gives them a default. */
  isStill: boolean;
}

export type AepItem = AepFolder | AepComp | AepFootage;

// ── Layers ──────────────────────────────────────────────────────────

export type AepLayerKind = 'av' | 'light' | 'camera' | 'text' | 'shape' | 'model' | 'mesh';

export type AepTrackMatte = 'none' | 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';

export interface AepLayer {
  id: number;
  name: string;
  kind: AepLayerKind;
  /** 1-based, top layer = 1 — AE's own layer numbering. */
  index: number;
  /** Item id of the layer's source, or 0 when it has none. */
  sourceId: number;
  /** Layer id of the parent, or 0 when unparented. */
  parentId: number;
  inPoint: number;
  outPoint: number;
  /** Where the source's frame 0 sits on the comp timeline; can be negative. */
  startTime: number;
  /** Time stretch as a percentage — 100 is no stretch, negative reverses. */
  stretch: number;
  enabled: boolean;
  solo: boolean;
  shy: boolean;
  locked: boolean;
  threeD: boolean;
  adjustment: boolean;
  guide: boolean;
  nullLayer: boolean;
  collapseTransformation: boolean;
  motionBlur: boolean;
  frameBlending: boolean;
  effectsActive: boolean;
  audioEnabled: boolean;
  environmentLayer: boolean;
  /** AE blending-mode name, already resolved from the stored index. */
  blendingMode: string;
  trackMatte: AepTrackMatte;
  /** Layer id supplying the matte (AE 23+ stores it explicitly). */
  matteLayerId?: number;
  label: number;
  /** 0 none, 1 along path, 2 toward camera/point of interest, 3 chars toward camera. */
  autoOrient: number;
  /** Light kind for `kind: 'light'` — AE's stored index. */
  lightType?: number;
  /** The layer's whole property tree, rooted at its transform group's parent. */
  properties: AepPropertyGroup;
  /** Masks, in AE's own order — first in the list is first in the stack. */
  masks: AepMask[];
}

export type AepMaskMode = 'none' | 'add' | 'subtract' | 'intersect' | 'lighten' | 'darken' | 'difference';

/**
 * One mask.
 *
 * Its outline and its animatable channels live in `properties` like any other
 * group; what is lifted out here is the part AE keeps OUTSIDE the property tree
 * in a `mkif` chunk — the mode, the inversion, the swatch colour — because
 * nothing in the property model has anywhere to put them.
 */
export interface AepMask {
  name: string;
  mode: AepMaskMode;
  inverted: boolean;
  locked: boolean;
  /** Outline swatch, 0–255 per channel. */
  color: { r: number; g: number; b: number };
  shape?: AepShape;
  properties: AepPropertyGroup;
}

// ── Properties ──────────────────────────────────────────────────────

export type AepInterpolation = 'linear' | 'bezier' | 'hold';

export interface AepKeyframe {
  /** Seconds, already converted out of the comp's internal timebase. */
  time: number;
  /** One number per dimension; colours arrive as `[r, g, b, a]` in 0–1. */
  value: number[];
  inInterpolation: AepInterpolation;
  outInterpolation: AepInterpolation;
  /**
   * AE's temporal ease, per dimension: `speed` in value-units per second and
   * `influence` as a 0–100 percentage of the segment's duration. Together they
   * ARE the bezier handle — see `aepEase.ts` for the conversion.
   */
  inSpeed: number[];
  inInfluence: number[];
  outSpeed: number[];
  outInfluence: number[];
  /** Spatial tangents, value-space offsets from `value` (position only). */
  inTangent?: number[];
  outTangent?: number[];
  temporalAutoBezier: boolean;
  temporalContinuous: boolean;
  spatialAutoBezier: boolean;
  spatialContinuous: boolean;
  roving: boolean;
}

/** One vertex of a mask/shape outline, in AE's layer space. */
export interface AepShapeVertex {
  x: number;
  y: number;
  /** Tangent handles, relative to the vertex — AE stores them that way. */
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface AepShape {
  closed: boolean;
  vertices: AepShapeVertex[];
}

export interface AepProperty {
  node: 'property';
  matchName: string;
  /** The name shown in AE, when the user renamed it. */
  name?: string;
  dimensions: number;
  isColor: boolean;
  isSpatial: boolean;
  isInteger: boolean;
  /** AE's own "this property has keyframes" flag. */
  animated: boolean;
  /** Static value; also the value every keyframed property falls back to. */
  value: number[];
  keyframes: AepKeyframe[];
  /** Outline data for mask/path properties. */
  shape?: AepShape;
  /** Source text, for `ADBE Text Document`. */
  text?: AepTextDocument;
  expression?: string;
  expressionEnabled: boolean;
  /**
   * The AE SDK `PF_ParamType` for an effect parameter — 3 angle, 4 checkbox,
   * 5 colour, 6 point, 7 popup, 10 slider. Absent outside an effect.
   *
   * It is what lets a generic mapping treat "the third slider" as a number and
   * "the popup" as an enum without a per-effect table for every plug-in ever
   * shipped.
   */
  controlType?: number;
}

export interface AepPropertyGroup {
  node: 'group';
  matchName: string;
  name?: string;
  children: AepPropertyNode[];
}

export type AepPropertyNode = AepProperty | AepPropertyGroup;

/**
 * What a text layer says, as much of it as is recoverable.
 *
 * AE stores a text layer's source in COS, its own binary object notation, and
 * the full grammar is far more than an importer needs. `aepText.ts` reads the
 * parts that change what you see — the string, the font, the size, the fill —
 * and leaves the rest, so a text layer arrives as text rather than as a warning.
 */
export interface AepTextDocument {
  text: string;
  font?: string;
  fontSize?: number;
  /** 0–1 per channel. */
  fillColor?: { r: number; g: number; b: number };
  justification?: 'left' | 'center' | 'right';
  tracking?: number;
  leading?: number;
  faux?: { bold?: boolean; italic?: boolean };
  /**
   * How many character-style runs the document had.
   *
   * More than one means the layer mixed styles per character and the import
   * flattened it to the first — the planner turns that into a warning instead
   * of quietly restyling someone's title card.
   */
  styleRuns: number;
}

// ── The project ─────────────────────────────────────────────────────

export interface AepProject {
  /** Every item, flattened, in project order. */
  items: AepItem[];
  comps: AepComp[];
  footage: AepFootage[];
  /** AE's stated version, when the header carried one. */
  aeVersion?: string;
  /** Anything the reader could not make sense of but chose to carry on past. */
  warnings: string[];
}

// ── Lookups ─────────────────────────────────────────────────────────

/** A direct child property/group of `group` by match name. */
export function findProp(group: AepPropertyGroup | undefined, matchName: string): AepPropertyNode | undefined {
  return group?.children.find((c) => c.matchName === matchName);
}

/** A direct child that is a leaf property. */
export function findLeaf(group: AepPropertyGroup | undefined, matchName: string): AepProperty | undefined {
  const found = findProp(group, matchName);
  return found?.node === 'property' ? found : undefined;
}

/** A direct child that is a group. */
export function findGroup(group: AepPropertyGroup | undefined, matchName: string): AepPropertyGroup | undefined {
  const found = findProp(group, matchName);
  return found?.node === 'group' ? found : undefined;
}

/**
 * Depth-first walk of a property tree.
 *
 * Effects hide several levels down (`ADBE Effect Parade` ▸ the effect ▸ its
 * params) and masks another way, so anything that wants "every property" says
 * so here rather than open-coding a fifth recursive walk.
 */
export function* walkProps(group: AepPropertyGroup): Generator<AepPropertyNode> {
  for (const child of group.children) {
    yield child;
    if (child.node === 'group') yield* walkProps(child);
  }
}

/**
 * A property's single number — its first dimension.
 *
 * Most AE scalars (`ADBE Opacity`, a blur radius) are 1-dimensional but are
 * still stored as an array, and `?? fallback` on `value[0]` is the line this
 * replaces everywhere.
 */
export const scalarOf = (prop: AepProperty | undefined, fallback = 0): number =>
  prop?.value[0] ?? fallback;
