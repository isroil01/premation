/**
 * LATENT numeric properties (B3z, ENGINE_API.md §15.9) — keyframeable numbers
 * a layer HAS before it stores them.
 *
 * The catalog lists a numeric component prop once some component stores it
 * (`propertyTree.ts componentPropRows`) or once it is animated. A property
 * that exists in After Effects' model but sits at its default without a stored
 * value — a light's Falloff Distance, a camera's Iris Rotation, a Style's
 * per-corner radius, a text layer's Stroke Width, Skew, a model's morph
 * weights, a gradient fill's Angle on a shape, a stroke's Taper widths — was
 * therefore not addressable: its first write or stopwatch fell back to a
 * pre-API writer. This table makes each of them an ordinary animatable member
 * binding while it is latent. Its static read is the property seam's (or the
 * registry default); its first static write lands on its HOME component
 * (never the Transform unless that is the home) — the seam writes it wherever
 * it already lives.
 *
 * DATA shared by both engines: the TypeScript catalog (`props.ts`
 * `addLatentBindings`) reads it directly, the C++ catalog (`props.cpp`) reads
 * the copy `crossEngineCatalog.test.ts` generates into catalog_data.inc. Row
 * ORDER is the order both engines add the bindings in, after the fields and
 * before the unclaimed tracks. A row whose member is already bound (a stored
 * or animated prop, a property-tree row) is skipped: the latent binding and
 * the stored one have the same API path (`apiPathFor(member, groupForProp)`),
 * so a property keeps its path when it becomes stored.
 *
 * Adding a row needs no engine code (like layerFieldSpecs.ts): add it, run
 * `GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog`, rebuild native.
 */

import type { LayerFieldWhen } from './layerFieldSpecs';

export interface LatentWhen extends LayerFieldWhen {
  /** The layer's primary fill paint (`fx.fill`) is of this type. */
  fillType?: 'linear' | 'radial';
}

export interface LatentPropSpec {
  /**
   * The member track (= the stored key). With `expand: 'strokes'` a
   * `StrokeTrackParam` (`taperStartWidth`), expanded to each enabled stroke's
   * track (`strokeTaperStartWidth`, `stroke.1.taperStartWidth`, …); with
   * `expand: 'morph'` the prefix `morph`, expanded to `morph0…morphN-1`.
   */
  member: string;
  /**
   * The component type(s) a first static write stores on when no component
   * carries the prop yet (the first of these the layer has). Empty: the static
   * seam owns the value (it lives inside a paint / the stroke stack) — a write
   * the seam cannot place is `notFound`.
   */
  home: readonly string[];
  when?: LatentWhen;
  /**
   * `strokes`: one binding per ENABLED stroke of the layer's stack (readNodeStrokes).
   * `morph`: one per morph target (modelMorph.ts `nodeMorphTargetCount`).
   */
  expand?: 'strokes' | 'morph';
}

const T = ['Transform'] as const;
const LIGHT: LatentWhen = { kinds: ['light'] };
const CAMERA: LatentWhen = { kinds: ['camera'] };
/** Layers with a 2-D/3-D Transform group of their own (not cameras, lights, audio). */
const TRANSFORMED: LatentWhen = { notKinds: ['camera', 'light', 'audio'] };

const rows = (members: readonly string[], home: readonly string[], when?: LatentWhen): LatentPropSpec[] =>
  members.map((member) => ({ member, home, ...(when ? { when } : {}) }));

export const LATENT_PROPS: readonly LatentPropSpec[] = [
  // ── Transform extras (AE: Skew / Skew Axis; Advanced Blending ▸ Fill Opacity) ──
  ...rows(['skew', 'skewAxis', 'fillOpacity'], T, TRANSFORMED),
  // ── Style corners (the Corners group of Fill & Stroke) ──
  ...rows(['cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL'], ['Style'], { component: 'Style' }),
  // ── A text layer's stroke width (Character ▸ Stroke Width) ──
  { member: 'strokeWidth', home: ['Text'], when: { component: 'Text' } },
  // ── Gradient fill geometry (AE Gradient Fill ▸ Start/End Point; stored inside the paint) ──
  { member: 'fillAngle', home: [], when: { fillType: 'linear' } },
  ...rows(['fillCenterX', 'fillCenterY', 'fillRadius'], [], { fillType: 'radial' }),
  // ── Shape strokes: the Taper widths and Wave amount rows the Stroke group always shows ──
  ...(['taperStartWidth', 'taperEndWidth', 'waveAmount'] as const).map(
    (member): LatentPropSpec => ({ member, home: [], when: { kinds: ['shape'] }, expand: 'strokes' }),
  ),
  // ── Light Options ──
  ...rows([
    'intensity', 'radius', 'falloffDistance', 'lightAngle', 'lightCone', 'lightConeFeather',
    'envRotation', 'envReflections', 'shadowDarkness', 'shadowDiffusion', 'shadowBias', 'shadowSoftness',
  ], T, LIGHT),
  // ── Camera Options ──
  ...rows([
    'focalLength', 'orbitYaw', 'orbitPitch', 'dofStrength', 'focusDistance', 'dofAperture', 'fStop',
    'irisBlades', 'irisRoundness', 'irisRotation', 'irisAspect',
    'highlightGain', 'highlightThreshold', 'highlightSaturation', 'diffractionFringe',
  ], T, CAMERA),
  // ── Model morph weights (morph0…morphN-1 on the mesh layer's Transform) ──
  { member: 'morph', home: T, when: { component: 'Model' }, expand: 'morph' },
  // ── B3z-a (worker B): a text layer's Tracking (letterSpacing px) and Leading
  //    (lineHeight ×) before the Text component stores them — text presets and
  //    the Character panel write them as `text/letterSpacing` / `text/lineHeight`,
  //    the paths they have once stored. ──
  ...rows(['letterSpacing', 'lineHeight'], ['Text'], { component: 'Text' }),
];
