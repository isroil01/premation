/**
 * The scene script: what a model writes in author mode.
 *
 * It is a description of a composition in the engine's own vocabulary — layer
 * kinds, transform and paint properties, effects by catalog type, keyframes
 * with real easings — grouped into beats. It is NOT a template parameter set:
 * nothing in it is filled in by the compiler. Every colour, size, position,
 * font, ease and duration the piece shows is one the script states.
 *
 * ## Time
 *
 * Inside a beat every time is BEAT-LOCAL seconds: 0 is the beat's start. Keys,
 * a layer's `inSec` / `outSec` and a text animator's sweep all use it. The
 * compiler adds the beat's start. A revised beat can then move without its
 * keys being rewritten, and the model reasons about one beat at a time.
 *
 * `globals` (layers that span the whole piece: a backdrop, grain) use
 * composition seconds.
 *
 * ## Order
 *
 * Layers are listed BACK TO FRONT: the first layer of a beat is the furthest
 * back. The compiler creates them in that order and every new layer lands on
 * top, so the list order is the stacking order.
 */

/** A hex colour (`#rrggbb` or `#rrggbbaa`), or a palette reference `$name`. */
export type Colour = string;

/** The engine's easing kinds, as `set_keyframes` takes them. */
export type Ease =
  | 'linear' | 'step' | 'ease' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier' | 'hold' | 'autoBezier' | 'continuousBezier';

export const EASES: readonly Ease[] = [
  'linear', 'step', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'bezier', 'hold', 'autoBezier', 'continuousBezier',
];

/** One keyframe. `t` is beat-local seconds (composition seconds on a global layer). */
export interface Key {
  t: number;
  v: number;
  /** Easing of the segment that STARTS at this key. */
  ease?: Ease;
  /** With `ease: "bezier"`: [x1, y1, x2, y2], x in 0..1, y may overshoot. */
  bezier?: [number, number, number, number];
}

/** Property path → keyframes, at least two per animated property. */
export type Keys = Record<string, Key[]>;

export interface GridSystem {
  columns: number;
  /** px between columns. */
  gutter: number;
  /** Outer margin, px. */
  margin: number;
  /** Vertical rhythm unit, px. */
  baseline: number;
}

/** A named type style the layers refer to by `typeStyle`. */
export interface TypeStyle {
  family?: string;
  weight?: number;
  /** px */
  size?: number;
  /** Letter spacing, px. */
  tracking?: number;
  /** Line height multiplier. */
  leading?: number;
}

export interface EffectSpec {
  /** Stable name within the layer; keyframes address `effect.<id>.<param>`. Defaults to `<type>` (suffixed on repeats). */
  id?: string;
  /** An `add_effect` type from the vocabulary. */
  type: string;
  /** Static parameter values by catalog key: numbers, hex colours, booleans, option labels. */
  params?: Record<string, number | string | boolean>;
  /** Animated numeric parameters by catalog key. */
  keys?: Keys;
}

export interface TextAnimatorSpec {
  basedOn?: 'characters' | 'words' | 'lines';
  shape?: 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth';
  start?: number;
  end?: number;
  offset?: number;
  x?: number;
  y?: number;
  scale?: number;
  scaleY?: number;
  rotation?: number;
  opacity?: number;
  tracking?: number;
  lineSpacing?: number;
  blur?: number;
  skew?: number;
  fillOpacity?: number;
  characterOffset?: number;
  color?: Colour;
  /** Sweep the range selector. Times beat-local. */
  sweep?: { from: number; to: number; fromOffset?: number; toOffset?: number; ease?: Ease; bezier?: [number, number, number, number] };
  /** Animated animator params (`offset`, `opacity`, `blur`, …). */
  keys?: Keys;
}

export interface TrimSpec {
  start?: number;
  end?: number;
  offset?: number;
  /** `start` / `end` / `offset` keyframes, percent. */
  keys?: Keys;
}

export interface RepeaterSpec {
  copies?: number;
  positionX?: number;
  positionY?: number;
  rotation?: number;
  scale?: number;
  anchorX?: number;
  anchorY?: number;
  startOpacity?: number;
  endOpacity?: number;
  /** `copies` / `offset` keyframes. */
  keys?: Keys;
}

export interface PathOpSpec {
  op: 'zigzag' | 'pucker' | 'twist' | 'roundCorners' | 'offset' | 'roughen' | 'wiggleTransform';
  amount?: number;
  detail?: number;
  wigglesPerSecond?: number;
  /** `amount` keyframes. */
  keys?: Keys;
}

export interface MaskSpec {
  shape: 'rectangle' | 'ellipse';
  mode?: 'add' | 'subtract' | 'intersect';
  width?: number;
  height?: number;
  feather?: number;
  opacity?: number;
  expansion?: number;
  inverted?: boolean;
}

export interface LightSpec {
  color?: Colour;
  intensity?: number;
  radius?: number;
  coneAngle?: number;
}

export interface GradientSpec {
  stops: Colour[];
  kind?: 'linear' | 'radial' | 'corners';
  angle?: number;
  centerX?: number;
  centerY?: number;
  radius?: number;
}

export interface ImageSpec {
  /** Subject and look, not layout. 8–2000 characters. */
  prompt: string;
  aspect?: 'square' | 'landscape' | 'portrait';
}

export interface SvgSpec {
  /** A complete, self-contained <svg> with a viewBox. */
  markup: string;
}

export interface VideoSpec {
  prompt: string;
  durationSec?: number;
  aspect?: 'landscape' | 'portrait' | 'square';
  model?: string;
  fit?: 'cover' | 'contain';
}

export type LayerKind =
  | 'shape' | 'text' | 'solid' | 'null' | 'camera' | 'light' | 'adjustment' | 'particle'
  | 'image' | 'svg' | 'gradient' | 'video';

export const LAYER_KINDS: readonly LayerKind[] = [
  'shape', 'text', 'solid', 'null', 'camera', 'light', 'adjustment', 'particle', 'image', 'svg', 'gradient', 'video',
];

/** What a layer is FOR. Advisory: the linters read it, the compiler does not. */
export type LayerRole = 'hero' | 'support' | 'ui' | 'ambient' | 'background';

export interface LayerSpec {
  /** Unique in the whole script. Also the handle later calls use. */
  id: string;
  kind: LayerKind;
  name: string;
  /** Another layer's id in the same beat (or a global's, on a global). */
  parent?: string;
  role?: LayerRole;
  /**
   * Globals only: `front` stacks the layer above every beat (grain, a
   * vignette, an adjustment that grades the whole piece); `back` (default)
   * below them (a backdrop).
   */
  stack?: 'back' | 'front';
  /** Beat-local bar. Defaults to the beat's bounds. */
  inSec?: number;
  outSec?: number;

  /** For kind=shape. */
  shape?: 'rect' | 'ellipse' | 'line' | 'star' | 'polygon';
  /** For kind=text. */
  text?: string;
  /** A key of the script's `type` styles; explicit fields below win over it. */
  typeStyle?: string;

  /**
   * Static (unanimated) properties by `create_layer` / `update_layer` name:
   * x, y, width, height, rotation, scale, scaleX, scaleY, opacity, z, … — see
   * the vocabulary card. Colours may be palette references.
   */
  props?: Record<string, number | string | boolean>;
  /** Track matte from another layer in the same beat. */
  matte?: { mode: 'alpha' | 'luma' | 'alpha-inv' | 'luma-inv'; source: string };

  keys?: Keys;
  expressions?: Record<string, string>;
  effects?: EffectSpec[];
  textAnimators?: TextAnimatorSpec[];
  trim?: TrimSpec;
  repeaters?: RepeaterSpec[];
  pathOps?: PathOpSpec[];
  masks?: MaskSpec[];
  light?: LightSpec;
  gradient?: GradientSpec;
  image?: ImageSpec;
  svg?: SvgSpec;
  video?: VideoSpec;
}

export interface BeatOutline {
  name: string;
  /** What the beat does for the piece, in a sentence. */
  purpose: string;
  /** Composition seconds. */
  startSec: number;
  endSec: number;
  /** Direction for the beat writer: staging, the hero, the motion idea. */
  notes?: string;
}

export interface Beat extends BeatOutline {
  layers: LayerSpec[];
}

/** The part of a script the DESIGN call writes. */
export interface ScriptHeader {
  title: string;
  /** The idea, in one sentence. */
  intent: string;
  durationSec: number;
  background: Colour;
  palette: Record<string, string>;
  grid: GridSystem;
  type: Record<string, TypeStyle>;
}

export interface SceneScript extends ScriptHeader {
  /** Layers that span the whole piece. Composition seconds. */
  globals: LayerSpec[];
  beats: Beat[];
}

/** What the DESIGN call returns: the header, the outline, and the globals. */
export interface DesignResult extends ScriptHeader {
  globals: LayerSpec[];
  beats: BeatOutline[];
}

// ── Compiler output ────────────────────────────────────────────────────

/** A tool call, as the registry executes it. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A call index range `[start, end)` in `CompiledScript.calls`. */
export interface CallRange {
  start: number;
  end: number;
}

export interface CompiledScript {
  calls: ToolCall[];
  /** The header and back globals: composition settings and the piece-wide layers behind the beats. */
  head: CallRange;
  /**
   * Front globals, under their own root (`TAIL_ROOT`). Replayed after any
   * beat is rebuilt, so a rebuilt beat still sits under the grain.
   */
  tail: CallRange;
  /** One range per beat, in beat order. Replaying a range rebuilds that beat. */
  byBeat: Array<CallRange & { beatIndex: number; rootId: string }>;
  /** Layer id → beat index (-1 for a global). */
  beatOfLayer: Map<string, number>;
  /** Everything the compiler had to repair, addressed to the model. */
  problems: string[];
}

/** One repair coercion made, with where. */
export interface Repair {
  /** `beats[2].layers[3].effects[0].type`, … */
  path: string;
  message: string;
}
