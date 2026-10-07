/**
 * The inspector's section registry — ONE ordered list, read top to bottom.
 *
 * ## Why a registry and not a function
 *
 * `InspectorContent` used to be a 280-line `if (kind === …) items.push({…})`
 * chain, with the section's markup, its title, its icon, its default-open
 * decision and its applicability all written at the same place. Three things
 * followed from that, all of them bad:
 *
 *   • the order was implicit in the source order, so "where does Material go"
 *     could only be answered by reading the whole function;
 *   • the search keywords lived in a SEPARATE map keyed by section id, so a
 *     new section was searchable only if someone remembered a second file;
 *   • nothing outside that function could enumerate the sections — which is
 *     why no test could ask "is every section in this directory reachable".
 *
 * A section is now a row: `{id, title, icon, appliesTo, Component, keywords}`.
 * The order of THIS ARRAY is the order on screen. `inspectorSectionsFor()`
 * filters it; `InspectorContent` renders the result and knows nothing about
 * layer kinds.
 *
 * ## One list, no sub-tabs (2026-09-15)
 *
 * For a while these rows were split across Transform · Style · Layer ·
 * Animation sub-tabs. Measured with a plain shape selected, "Layer" opened on
 * a DISABLED Pathfinder and an audio-waveform generator, and "Animation" held
 * only Modifiers and the Audio Driver — tabs mostly full of what did not apply.
 * The panel is one scrolling accordion again, and the lesson of the first
 * merge (a wall of eight open headers) is handled differently this time: a
 * section that does not apply to the SELECTION is not drawn at all
 * (`appliesTo`, `appliesToSelection`), and everything past how the layer looks
 * starts collapsed.
 *
 * `category` survives on each row, and `InspectorCategory` is still exported,
 * only because the persisted `inspectorTab` preference is typed on the same
 * values and deleting a store field is a migration for nothing. Nothing on
 * screen reads either.
 *
 * ## The order, and why it is that order
 *
 * After Effects' layer property order (2026-10-07, owner decision: "how After
 * Effects does it"): the shortlist you pinned; what the layer is made of (AE's
 * Text / Contents); Masks, then Effects, then Transform — the order AE applies
 * them in and lists them in; the per-kind options AE puts after Transform
 * (Camera Options, Light Options); then Layer Styles, Geometry Options and
 * Material Options, as in AE's timeline. After those, the things AE keeps
 * outside a layer's property list: pathfinder and the audio waveform, blending
 * and switches, the motion tools, and last the one project-scoped row, version
 * history.
 *
 * ## Ids are NOT unique, on purpose
 *
 * `custom` is shared by the camera, light, particle, audio and plugin-layer
 * sections — their `appliesTo` predicates are mutually exclusive, so at most
 * one is ever live. The id is the key into the user's persisted open/closed
 * preference (`preferenceStore.inspectorSections`), and collapsing "Camera
 * settings" then selecting a light should find Light settings collapsed too:
 * it is the same slot in the same place holding the same kind of thing. Giving
 * them separate ids would silently reset that preference for every user.
 */

import type { ComponentType } from 'react';
import type { IconName } from '@components/Icon';
import { documentMirror } from '@stores/documentMirror';
import { trackRefIn } from '@core/mirror/trackIndex';
import { canBe3DLayer, inspectorKindOf, is3DLayer, isAbstractLayer, layerExists } from './inspectorMirror';

import { AppearanceSection, AppearancePresetAction } from './AppearanceSection';
import { TextSection, TextPresetAction, hasTextSection } from './TextSection';
import { EffectsSection, EffectsSectionActions, hasEffectsSection } from './EffectsSection';
import { AudioControls } from './AudioControls';
import { PinnedSection, hasPinnedSection } from './PinnedSection';
import { CameraSection } from './CameraSection';
import { CompositingSection } from './CompositingSection';
import { Ik3DSection, isIk3DTip } from './Ik3DSection';
import { LightSection } from './LightSection';
import { MaterialSection, MaterialPresetAction, hasMaterialSection } from './MaterialSection';
import { MediaSection } from './MediaSection';
import { mirrorMasksAt } from '@core/mirror/masks';
import { MasksSection, hasMasksSection } from './MasksSection';
import { CropSection, hasCropSection } from './CropSection';
import { PaintSection, hasPaintSection } from './PaintSection';
import { PuppetControls } from './PuppetControls';
import { isRiggableLayer } from '@core/mirror/layerKinds';
import { TrackMotionSection } from './TrackMotionSection';
import { ModelSection } from './ModelSection';
import { MotionToolsSection, hasMotionToolsSection } from './MotionToolsSection';
import { ParticleSection } from './ParticleSection';
import { PathOpsSection } from './PathOpsSection';
import { PolystarSection, hasPolystarSection } from './PolystarSection';
import { PrimitiveSection, hasPrimitiveSection } from './PrimitiveSection';
import { ShapeEffects } from './ShapeEffects';
import { SvgSection } from './SvgSection';
import { TextAnimatorControls } from './TextAnimatorControls';
import { VersionHistorySection, versionHistoryAvailable } from './VersionHistorySection';
import { TransformPresetAction } from './TransformSection';
import {
  LayerStylesWithPresetsSection,
  GeometryOptionsSection,
  NullInfoSection,
  PrecompGroupSection,
  TransformWithThreeDSection,
} from './inspectorSectionParts';

/** Resolved per node, because two of them genuinely vary by layer. */
type PerNode<T> = T | ((nodeId: string) => T);

/**
 * The groups the sections were once split into as Properties sub-tabs.
 *
 * NO LONGER DRIVES THE UI — see "One list, no sub-tabs" above. Kept because
 * `preferenceStore.inspectorTab` is persisted with these exact values.
 */
export type InspectorCategory = 'pinned' | 'transform' | 'style' | 'layer' | 'animation';

export interface InspectorSectionDef {
  /**
   * Accordion id AND the key into the persisted open/closed preference. Not
   * unique across the array — see the module note on `custom`.
   */
  id: string;
  title: PerNode<string>;
  icon?: PerNode<IconName>;
  /** The retired sub-tab this row belonged to. Not read by the UI. */
  category: InspectorCategory;
  /** Whether this section belongs on the given layer at all. */
  appliesTo: (nodeId: string) => boolean;
  /**
   * Whether the section belongs on the WHOLE selection, primary first — for a
   * section whose purpose needs several layers (Pathfinder combines two or
   * more shapes). Checked after `appliesTo`; absent means "yes".
   */
  appliesToSelection?: (nodeIds: ReadonlyArray<string>) => boolean;
  Component: ComponentType<{ nodeId: string }>;
  /** Optional actions component rendered on the right side of the section header row. */
  actions?: ComponentType<{ nodeId: string; nodeIds?: ReadonlyArray<string> }>;
  /**
   * Extra words the inspector's search box matches on, so searching "color"
   * reaches Appearance and "shadow" reaches Layer styles. Folded in from what
   * used to be a separate `SECTION_KEYWORDS` map living two files away.
   *
   * Keyframe motion is deliberately absent: that is the Graph editor, not a
   * property section.
   */
  keywords?: string;
  defaultOpen?: PerNode<boolean>;
  /**
   * Mount `Component` only while the section is open. For sections whose MOUNT
   * has side effects — Track Motion arms a canvas overlay.
   */
  mountOnOpen?: boolean;
}

/** Resolve a `PerNode` field for one layer. */
export function resolve<T>(value: PerNode<T>, nodeId: string): T {
  return typeof value === 'function' ? (value as (id: string) => T)(nodeId) : value;
}

/**
 * The layer's editor kind, from the document MIRROR (B4): `uiKindOf` of its
 * header (a plugin kind id for a plugin-provided generator layer). The
 * Properties panel re-renders on the selection's mirror keys, so a kind change
 * re-runs every predicate below.
 */
function kindOf(nodeId: string): string | null {
  return inspectorKindOf(nodeId);
}

/** Kinds with no spatial or visual presence of their own. */
function isAbstract(nodeId: string): boolean {
  return isAbstractLayer(nodeId);
}

/** Applied effects (the tree's `effects` group), from the mirror. */
function effectCount(nodeId: string): number {
  return documentMirror().tree(nodeId)?.nodes.get('effects')?.children.length ?? 0;
}

function isDrawable(nodeId: string): boolean {
  const kind = kindOf(nodeId);
  return kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video';
}

const isKind = (want: string) => (nodeId: string): boolean => kindOf(nodeId) === want;

/** Selected layers that are shape layers — Pathfinder's operands. */
function shapeCount(nodeIds: ReadonlyArray<string>): number {
  let n = 0;
  for (const id of nodeIds) if (kindOf(id) === 'shape') n += 1;
  return n;
}

/**
 * THE ORDER. Editing this array is editing the inspector.
 */
export const INSPECTOR_SECTIONS: readonly InspectorSectionDef[] = [
  // ── 0. The layer's own shortlist ────────────────────────────────
  // Present only while the layer has pins or promoted Essential Properties.
  {
    id: 'pinned',
    title: 'Pinned',
    icon: 'push-pin',
    category: 'pinned',
    defaultOpen: true,
    keywords: 'pinned essential favourite favorite shortlist',
    // Pins are `LayerInfo.pinned`; B4-gap: the Essential Properties (`__essentialProps`) — see PinnedSection.
    appliesTo: hasPinnedSection,
    Component: PinnedSection,
  },
  // ── 1. What the layer is made of (AE: Text / Contents) ──────────
  // The Text panel's character + paragraph controls, folded into Properties
  // (2026-09-15) so a text layer is edited in one place. The standalone Text
  // panel is now on demand and renders the same body (`TextSettingsBody`).
  {
    id: 'text',
    title: 'Text',
    icon: 'type',
    category: 'style',
    defaultOpen: true,
    keywords: 'text font family size leading tracking kerning character paragraph align justify indent',
    appliesTo: hasTextSection,
    Component: TextSection,
    actions: TextPresetAction,
  },
  {
    id: 'animators',
    title: 'Text animators',
    icon: 'sparkles',
    category: 'animation',
    defaultOpen: false,
    keywords: 'text animator range selector',
    appliesTo: isKind('text'),
    Component: TextAnimatorControls,
  },
  {
    id: 'appearance',
    // Text has no fill here — the Text section above owns it — so the section
    // is honest about being stroke only, and starts closed under it. On a
    // shape layer it is AE's Contents (fill, stroke, corners).
    title: (id) => (kindOf(id) === 'text' ? 'Stroke' : kindOf(id) === 'shape' ? 'Contents' : 'Appearance'),
    icon: 'shape',
    category: 'style',
    defaultOpen: (id) => kindOf(id) !== 'text',
    keywords: 'appearance fill stroke color gradient border outline',
    appliesTo: isDrawable,
    Component: AppearanceSection,
    actions: AppearancePresetAction,
  },
  {
    // Parametric Polygon / Star (AE's Polystar Path group): type, points,
    // rotation, radii and roundness — all keyframeable, recomputed per frame
    // before the path-operator chain. Present only on a layer that IS a
    // polystar, so every other shape's inspector is unchanged.
    id: 'polystar',
    title: 'Polystar',
    icon: 'shape',
    category: 'layer',
    defaultOpen: true,
    keywords: 'polystar polygon star points radius roundness',
    appliesTo: hasPolystarSection,
    Component: PolystarSection,
  },
  // Only for layers whose geometry is generated from numbers — a sphere,
  // cylinder, cone, torus, capsule or box. Its quad never draws, so for a mesh
  // primitive this IS the layer's content.
  {
    id: 'primitive3d',
    title: 'Primitive',
    icon: 'cube',
    category: 'layer',
    defaultOpen: true,
    keywords: 'primitive sphere box cylinder cone torus capsule mesh',
    appliesTo: hasPrimitiveSection,
    Component: PrimitiveSection,
  },
  {
    id: 'svg',
    title: 'SVG layer',
    icon: 'shape',
    category: 'layer',
    defaultOpen: true,
    keywords: 'svg vector path import',
    appliesTo: isKind('svg'),
    Component: SvgSection,
  },
  {
    id: 'precomp',
    title: 'Pre-composition',
    icon: 'folder',
    category: 'layer',
    defaultOpen: true,
    keywords: 'precompose group children focus',
    appliesTo: isKind('group'),
    Component: PrecompGroupSection,
  },
  {
    id: 'info',
    title: 'Null object',
    icon: 'info',
    category: 'layer',
    defaultOpen: true,
    keywords: 'null object controller',
    appliesTo: isKind('null'),
    Component: NullInfoSection,
  },
  // ── 2. Masks, then Effects (AE applies masks → effects → transform) ────
  // AE parity 5.4: the layer's masks (moved out of the Effects panel), above
  // Effects as in AE's layer properties. Open when the layer has masks.
  {
    id: 'masks',
    title: 'Masks',
    icon: 'mask-square',
    category: 'style',
    defaultOpen: (id) => mirrorMasksAt(documentMirror(), id, 0).length > 0,
    keywords: 'mask masks feather expansion mask path rectangle ellipse pen smart mask interpolation',
    appliesTo: hasMasksSection,
    Component: MasksSection,
  },
  // AE parity 5.6: Crop (a rectangle mask named "Crop"), Paint and Puppet,
  // surfaced in Properties instead of only in their own panels / tools.
  {
    id: 'crop',
    title: 'Crop',
    icon: 'mask-square',
    category: 'style',
    defaultOpen: false,
    keywords: 'crop trim edges inset left top right bottom',
    appliesTo: hasCropSection,
    Component: CropSection,
  },
  // The applied effect stack (AE's Effect Controls), folded into Properties
  // (2026-09-15); Effect Controls is on demand and renders the same body. Open
  // by default only when the layer already HAS effects: an open section that
  // says "No effects" on every plain shape is exactly the clutter this panel
  // was redesigned to remove, while the header's + stays one click away.
  // Adding an effect anywhere forces it open (`revealEffectsInProperties`).
  {
    id: 'effects',
    title: 'Effects',
    icon: 'magic-wand',
    category: 'style',
    defaultOpen: (id) => effectCount(id) > 0,
    keywords: 'effects effect stack fx blur glow color correction distort keying',
    appliesTo: hasEffectsSection,
    Component: EffectsSection,
    actions: EffectsSectionActions,
  },
  {
    id: 'paint',
    title: 'Paint',
    icon: 'brush',
    category: 'style',
    defaultOpen: true,
    keywords: 'paint brush stroke clone eraser',
    appliesTo: hasPaintSection,
    Component: PaintSection,
  },
  {
    id: 'puppet',
    title: 'Puppet',
    icon: 'puppet-pin',
    category: 'layer',
    defaultOpen: true,
    keywords: 'puppet pins mesh deform rig starch overlap bend advanced',
    appliesTo: (id) => isRiggableLayer(documentMirror().layer(id)) && !!documentMirror().tree(id)?.nodes.has('puppet'),
    Component: PuppetControls,
  },
  // ── 3. Transform ────────────────────────────────────────────────
  {
    id: 'transform',
    title: 'Transform',
    icon: 'move',
    category: 'transform',
    defaultOpen: true,
    keywords: 'position scale rotation opacity anchor size 3d',
    appliesTo: (id) => kindOf(id) !== 'audio',
    Component: TransformWithThreeDSection,
    actions: TransformPresetAction,
  },
  // ── 4. Per-kind options (AE: Camera Options, Light Options, …) ────
  // At most one or two of these apply to any layer, and each is that layer's
  // reason for existing, so they open by default and sit directly under
  // Transform.
  {
    id: 'custom',
    title: 'Camera Options',
    icon: 'camera',
    category: 'layer',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('camera'),
    Component: CameraSection,
  },
  {
    id: 'custom',
    title: 'Light Options',
    icon: 'light',
    category: 'layer',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('light'),
    Component: LightSection,
  },
  {
    id: 'custom',
    title: 'Particle settings',
    icon: 'sparkles',
    category: 'layer',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('particle'),
    Component: ParticleSection,
  },
  {
    id: 'custom',
    title: 'Audio settings',
    icon: 'audio',
    category: 'layer',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('audio'),
    Component: AudioControls,
  },
  {
    id: 'media',
    title: 'Media settings',
    icon: 'image',
    category: 'layer',
    defaultOpen: true,
    keywords: 'source trim speed fit crop volume',
    appliesTo: (id) => kindOf(id) === 'image' || kindOf(id) === 'video',
    Component: MediaSection,
  },
  {
    // AE parity 3.8: Track Motion in Properties, as AE's Tracker is reached from
    // the layer. The same section the Tracker panel shows; mounted only while
    // open, because mounting arms the viewport's track overlay.
    id: 'trackMotion',
    title: 'Track Motion',
    icon: 'crosshair',
    category: 'layer',
    defaultOpen: false,
    keywords: 'tracker track stabilize warp stabilizer planar mocha camera solve face roto object matte content-aware fill',
    appliesTo: (id) => kindOf(id) === 'image' || kindOf(id) === 'video',
    Component: TrackMotionSection,
    mountOnOpen: true,
  },
  // ── 5. Layer Styles, Geometry Options, Material Options (AE order) ────
  {
    id: 'layerStyles',
    title: 'Layer Styles',
    icon: 'sparkles',
    category: 'style',
    defaultOpen: false,
    keywords: 'shadow glow drop outer bevel layer style preset look saved',
    appliesTo: isDrawable,
    Component: LayerStylesWithPresetsSection,
  },
  {
    // AE's Geometry Options: the 3D Layer switch heads it (AE keeps that in a
    // timeline column), then Bevel Style / Bevel Depth / Hole Bevel Depth /
    // Extrusion Depth. Open by default once the layer is 3D.
    id: 'geometryOptions',
    title: 'Geometry Options',
    icon: 'cube',
    category: 'transform',
    defaultOpen: (id) => is3DLayer(id),
    keywords: '3d layer extrude extrusion depth bevel style hole geometry options',
    appliesTo: (id) => {
      const kind = kindOf(id);
      return kind !== 'group' && kind !== 'null' && canBe3DLayer(id);
    },
    Component: GeometryOptionsSection,
  },
  // Present only while the layer actually HAS a material — i.e. it is 3D — so a
  // flat layer's inspector is unchanged. Shading model, the responses that
  // model reads, shadows and the per-face overrides are one subject.
  {
    id: 'material',
    title: 'Material Options',
    icon: 'sphere',
    category: 'style',
    defaultOpen: true,
    keywords: 'material shading reflectance shadow face metal rough',
    appliesTo: (id) => {
      const kind = kindOf(id);
      return kind !== 'group' && kind !== 'null' && hasMaterialSection(id);
    },
    Component: MaterialSection,
    actions: MaterialPresetAction,
  },
  // ── 6. What can be done to its geometry ─────────────────────────
  {
    id: 'pathOps',
    title: 'Pathfinder',
    icon: 'shape',
    category: 'layer',
    defaultOpen: false,
    keywords: 'pathfinder boolean union subtract intersect exclude merge paths knife',
    appliesTo: isKind('shape'),
    // Every operation here needs TWO shapes. With one selected the section was
    // a disabled row of buttons over "Select two or more shape layers" — the
    // first thing a plain shape's old Layer tab showed, and it read as broken.
    // It appears the moment a second shape joins the selection.
    appliesToSelection: (ids) => shapeCount(ids) >= 2,
    Component: PathOpsSection,
  },
  {
    // `geometry` is the id this slot has always carried, and it is the key into
    // every user's persisted open/closed choice — the title follows what the
    // section holds (the shape audio-waveform generator); the id cannot.
    //
    // Not hidden on a shape with no waveform: this section's Add button is the
    // ONLY way to create one, so gating it on "has a waveform" would remove the
    // entry point. Collapsed instead.
    id: 'geometry',
    title: 'Audio waveform',
    icon: 'audio',
    category: 'layer',
    defaultOpen: false,
    keywords: 'audio waveform generate soundtrack bars music visualiser visualizer',
    appliesTo: isKind('shape'),
    Component: ShapeEffects,
  },
  // ── 7. How it composites ────────────────────────────────────────

  {
    id: 'compositing',
    title: 'Blending and switches',
    icon: 'layers',
    category: 'layer',
    defaultOpen: false,
    // Four of the old SECTION_KEYWORDS entries — `compositing`, `layerSwitches`,
    // `parenting` and `time` — all named controls this ONE section holds. Three
    // of them were keyed on section ids that had not existed for months, so
    // searching "parent" or "remap" matched nothing at all.
    keywords:
      'compositing blend mode matte track alpha luma preserve switches quality draft motion blur adjustment shutter '
      + 'parent link pick whip layer time remap stretch speed reverse freeze frame blend',
    appliesTo: (id) => !isAbstract(id) || kindOf(id) === 'camera' || kindOf(id) === 'light',
    Component: CompositingSection,
  },
  // ── 8. What drives it over time ─────────────────────────────────

  // The modifier stack and the audio driver, in one collapsed section. Not
  // gated on layer KIND: any layer with an animatable numeric property can
  // carry a stack or follow the music.
  {
    id: 'motionTools',
    title: 'Motion tools',
    icon: 'sparkles',
    category: 'animation',
    defaultOpen: false,
    keywords:
      'motion tools modifier stack delay noise spring stagger '
      + 'audio driver react beat amplitude band music',
    appliesTo: hasMotionToolsSection,
    Component: MotionToolsSection,
  },
  // Both strictly conditional: a layer either carries blend shapes or it does
  // not, and either tips a 3D chain or it does not. The predicates live beside
  // the features so this list cannot answer the question differently from the
  // section itself.
  {
    id: 'morph',
    title: 'Morph targets',
    icon: 'sparkles',
    category: 'animation',
    defaultOpen: false,
    keywords: 'morph blend shape target model',
    // A model's morph weights are catalog properties `morph0…morphN-1`.
    appliesTo: (id) => trackRefIn(documentMirror().tree(id), 'morph0') !== null,
    Component: ModelSection,
  },
  {
    id: 'ik3d',
    title: '3D IK',
    icon: 'crosshair',
    category: 'animation',
    defaultOpen: false,
    keywords: 'ik inverse kinematics chain pose bake',
    appliesTo: isIk3DTip,
    Component: Ik3DSection,
  },
  // ── Local version history ───────────────────────────────────────

  /*
   * The one PROJECT-scoped row in a layer-scoped list, and last for that
   * reason.
   *
   * It reads the open `.motion` bundle's snapshots, not the selected layer —
   * `appliesTo` ignores its argument, which is why it is here rather than
   * merged into another section. It earns the exception by being the only
   * surface local-first builds have for the version store: `VersionHistoryPanel`
   * is the CLOUD history and shows nothing without a server project. Outside a
   * local-first bundle `versionHistoryAvailable` is false and the row does not
   * appear, so the default build's inspector is unchanged.
   */
  {
    id: 'versionHistory',
    title: 'Version history',
    icon: 'history',
    category: 'layer',
    defaultOpen: false,
    keywords: 'version history snapshot restore revision checkpoint bundle',
    appliesTo: versionHistoryAvailable,
    Component: VersionHistorySection,
  },
];

/** The sections that belong on one layer, in registry order. */
export function inspectorSectionsFor(nodeId: string, category: InspectorCategory | 'all' = 'all'): InspectorSectionDef[] {
  if (!layerExists(nodeId)) return [];
  return INSPECTOR_SECTIONS.filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    return s.appliesTo(nodeId);
  });
}

/**
 * The sections the Properties panel draws for a selection, primary first: the
 * PRIMARY layer's sections, minus any whose `appliesToSelection` rejects the
 * selection as a whole.
 */
export function inspectorSectionsForSelection(nodeIds: ReadonlyArray<string>): InspectorSectionDef[] {
  const primary = nodeIds[0];
  if (!primary) return [];
  return inspectorSectionsFor(primary).filter((s) => !s.appliesToSelection || s.appliesToSelection(nodeIds));
}

/**
 * How many of `nodeIds` a section applies to.
 *
 * With several layers selected the panel draws the PRIMARY layer's sections
 * and edits all of them; a section only some of the selection has is still
 * shown (the primary has it) and badged "2 of 3" so the reach of an edit is
 * visible before it is made.
 */
export function sectionCoverage(def: InspectorSectionDef, nodeIds: ReadonlyArray<string>): number {
  let n = 0;
  for (const id of nodeIds) {
    if (layerExists(id) && def.appliesTo(id)) n += 1;
  }
  return n;
}
