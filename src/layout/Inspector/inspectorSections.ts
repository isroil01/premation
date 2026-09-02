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
 * ## The order, and why it is that order
 *
 * It is the natural flow of editing: where the thing is (transform), what it is
 * made of (material, primitive), what KIND of thing it is and how it looks
 * (the per-kind sections, appearance, pathfinder), how it relates to its
 * neighbours (align), and finally the collapsed advanced tail (compositing,
 * layer styles, modifiers, audio driver).
 *
 * ## Ids are NOT unique, on purpose
 *
 * `custom` is shared by the camera, light, particle, audio and plugin-layer
 * sections — their `appliesTo` predicates are mutually exclusive, so at most
 * one is ever live. The id is the key into the user's persisted open/closed
 * preference (`preferenceStore.inspectorSections`), and collapsing "Camera
 * Settings" then selecting a light should find Light Settings collapsed too:
 * it is the same slot in the same place holding the same kind of thing. Giving
 * them separate ids would silently reset that preference for every user.
 */

import type { ComponentType } from 'react';
import type { IconName } from '@components/Icon';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { nodeMorphTargetCount } from '@core/scene/modelMorph';
import { findLayerKind } from '@core/plugins/layerKindRegistry';
import { splitKind } from '@core/plugins/layerKindSchema';

import { AppearanceSection } from './AppearanceSection';
import { AudioControls } from './AudioControls';
import { AudioDriverSection, hasAudioDriverSection } from './AudioDriverSection';
import { CameraSection } from './CameraSection';
import { CompositingSection } from './CompositingSection';
import { CustomLayerSection } from './CustomLayerSection';
import { Ik3DSection, isIk3DTip } from './Ik3DSection';
import { LightSection } from './LightSection';
import { MaterialSection, hasMaterialSection } from './MaterialSection';
import { MediaSection } from './MediaSection';
import { ModelSection } from './ModelSection';
import { ModifierStackSection, hasModifierStackSection } from './ModifierStackSection';
import { ParticleSection } from './ParticleSection';
import { PathOpsSection } from './PathOpsSection';
import { PrimitiveSection, hasPrimitiveSection } from './PrimitiveSection';
import { ShapeEffects } from './ShapeEffects';
import { SvgSection } from './SvgSection';
import { TextAnimatorControls } from './TextAnimatorControls';
import {
  LayerStylesWithPresetsSection,
  NullInfoSection,
  PrecompGroupSection,
  TransformWithThreeDSection,
} from './inspectorSectionParts';

/** Resolved per node, because two of them genuinely vary by layer. */
type PerNode<T> = T | ((nodeId: string) => T);

export type InspectorCategory = 'all' | 'layout' | 'style' | 'content' | 'motion';

export interface InspectorSectionDef {
  /**
   * Accordion id AND the key into the persisted open/closed preference. Not
   * unique across the array — see the module note on `custom`.
   */
  id: string;
  title: PerNode<string>;
  icon?: PerNode<IconName>;
  /** High-level domain category for the segmented domain filter rail. */
  category?: InspectorCategory;
  /** Whether this section belongs on the given layer at all. */
  appliesTo: (nodeId: string) => boolean;
  Component: ComponentType<{ nodeId: string }>;
  /**
   * Extra words the inspector's search box matches on, so searching "color"
   * reaches Appearance and "shadow" reaches Layer Styles. Folded in from what
   * used to be a separate `SECTION_KEYWORDS` map living two files away.
   *
   * Motion and effects are deliberately absent: those are the Graph and
   * Effects tabs, which are editors, not property sections.
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

function kindOf(nodeId: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeKind(node) : null;
}

/** Kinds with no spatial or visual presence of their own. */
function isAbstract(nodeId: string): boolean {
  const kind = kindOf(nodeId);
  return kind === 'camera' || kind === 'light' || kind === 'audio';
}

function isDrawable(nodeId: string): boolean {
  const kind = kindOf(nodeId);
  return kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video';
}

const isKind = (want: string) => (nodeId: string): boolean => kindOf(nodeId) === want;

/**
 * THE ORDER. Editing this array is editing the inspector.
 */
export const INSPECTOR_SECTIONS: readonly InspectorSectionDef[] = [
  // ── 1. Where it is ─────────────────────────────────────────────
  {
    id: 'transform',
    title: 'Transform',
    icon: 'move',
    category: 'layout',
    defaultOpen: true,
    keywords: 'position scale rotation opacity anchor size 3d',
    appliesTo: (id) => kindOf(id) !== 'audio',
    Component: TransformWithThreeDSection,
  },
  // ── 1b. What it is made of ─────────────────────────────────────
  // Its own section rather than a fourth nesting level inside the 3D switch:
  // shading model, the responses that model reads, shadows and the per-face
  // overrides are one subject, and the reusable material library needs a
  // surface of its own. Present only while the layer actually HAS a material —
  // i.e. it is 3D — so a flat layer's inspector is unchanged.
  {
    id: 'material',
    title: 'Material',
    icon: 'sphere',
    category: 'style',
    keywords: 'material shading reflectance shadow face metal rough',
    appliesTo: (id) => {
      const kind = kindOf(id);
      return kind !== 'group' && kind !== 'null' && hasMaterialSection(id);
    },
    Component: MaterialSection,
  },
  // ── 1c. What SHAPE it is (parametric primitive) ────────────────
  // Only for layers whose geometry is generated from numbers — a sphere,
  // cylinder, cone, torus, capsule or box. Beside Material because the two
  // answer the same question about a mesh layer ("what is this object"), and
  // above the content sections, which for a mesh primitive have nothing to
  // say: its quad never draws.
  {
    id: 'primitive3d',
    title: 'Primitive',
    icon: 'cube',
    category: 'content',
    defaultOpen: true,
    keywords: 'primitive sphere box cylinder cone torus capsule mesh',
    appliesTo: hasPrimitiveSection,
    Component: PrimitiveSection,
  },

  // ── 2. What kind of thing it is, and how it looks ──────────────
  // A plugin-provided layer kind. Its title and glyph come from the REGISTRY
  // entry when the plugin is installed, and from the stored kind id when it is
  // not — an inert layer still has to name itself.
  {
    id: 'custom',
    title: (id) => {
      const kind = kindOf(id) ?? '';
      return findLayerKind(kind)?.kind.label ?? splitKind(kind)?.kindId ?? 'Layer';
    },
    icon: (id) => (findLayerKind(kindOf(id) ?? '')?.kind.icon as IconName) ?? 'plugin',
    category: 'content',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: (id) => splitKind(kindOf(id) ?? '') !== null,
    Component: CustomLayerSection,
  },
  {
    id: 'custom',
    title: 'Camera Settings',
    icon: 'camera',
    category: 'content',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('camera'),
    Component: CameraSection,
  },
  {
    id: 'custom',
    title: 'Light Settings',
    icon: 'light',
    category: 'content',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('light'),
    Component: LightSection,
  },
  {
    id: 'custom',
    title: 'Particle Settings',
    icon: 'sparkles',
    category: 'content',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('particle'),
    Component: ParticleSection,
  },
  {
    id: 'custom',
    title: 'Audio Settings',
    icon: 'audio',
    category: 'content',
    defaultOpen: true,
    keywords: 'settings camera light particle audio volume',
    appliesTo: isKind('audio'),
    Component: AudioControls,
  },
  {
    id: 'svg',
    title: 'SVG Layer',
    icon: 'shape',
    category: 'content',
    defaultOpen: true,
    keywords: 'svg vector path import',
    appliesTo: isKind('svg'),
    Component: SvgSection,
  },
  {
    id: 'media',
    title: 'Media Settings',
    icon: 'image',
    category: 'content',
    defaultOpen: true,
    keywords: 'source trim speed fit crop volume',
    appliesTo: (id) => kindOf(id) === 'image' || kindOf(id) === 'video',
    Component: MediaSection,
  },
  {
    id: 'precomp',
    title: 'Pre-composition',
    icon: 'folder',
    category: 'content',
    defaultOpen: true,
    keywords: 'precompose group children focus',
    appliesTo: isKind('group'),
    Component: PrecompGroupSection,
  },
  {
    id: 'info',
    title: 'Null Object',
    icon: 'info',
    category: 'content',
    defaultOpen: true,
    keywords: 'null object controller',
    appliesTo: isKind('null'),
    Component: NullInfoSection,
  },
  {
    id: 'animators',
    title: 'Text Animators',
    icon: 'sparkles',
    category: 'content',
    defaultOpen: false,
    keywords: 'text animator range selector',
    appliesTo: isKind('text'),
    Component: TextAnimatorControls,
  },
  {
    id: 'appearance',
    // Text has no fill here — the character panel owns it — so the section is
    // honest about being stroke only.
    title: (id) => (kindOf(id) === 'text' ? 'Stroke' : 'Fill & Stroke'),
    icon: 'shape',
    category: 'style',
    defaultOpen: (id) => kindOf(id) !== 'text',
    keywords: 'fill stroke color gradient border outline',
    appliesTo: isDrawable,
    Component: AppearanceSection,
  },
  {
    id: 'pathOps',
    title: 'Pathfinder',
    icon: 'shape',
    category: 'content',
    // Open by default: it is a row of four buttons, and the whole point of
    // moving the booleans out of a right-click submenu was that you should not
    // have to go looking for them.
    defaultOpen: true,
    keywords: 'boolean union subtract intersect exclude merge paths knife',
    appliesTo: isKind('shape'),
    Component: PathOpsSection,
  },
  {
    // `geometry` is the id this slot has always carried, and it is the key into
    // every user's persisted open/closed choice — the TITLE was corrected to
    // what the section actually holds; the id cannot be.
    id: 'geometry',
    title: 'Audio Waveform',
    icon: 'audio',
    category: 'content',
    defaultOpen: false,
    keywords: 'path trim repeater round corners wiggle stroke',
    appliesTo: isKind('shape'),
    Component: ShapeEffects,
  },

  // ── 2b. Imported-model and 3D rigging groups ───────────────────
  // Both strictly conditional: a layer either carries blend shapes or it does
  // not, and either tips a 3D chain or it does not. The predicates live beside
  // the features so this list cannot answer the question differently from the
  // section itself.
  {
    id: 'morph',
    title: 'Morph Targets',
    icon: 'sparkles',
    category: 'content',
    defaultOpen: false,
    keywords: 'morph blend shape target model',
    appliesTo: (id) => {
      const node = defaultSceneGraph.getNode(id);
      return !!node && nodeMorphTargetCount(node) > 0;
    },
    Component: ModelSection,
  },
  {
    id: 'ik3d',
    title: '3D IK',
    icon: 'crosshair',
    category: 'motion',
    defaultOpen: false,
    keywords: 'ik inverse kinematics chain pose bake',
    appliesTo: isIk3DTip,
    Component: Ik3DSection,
  },

  // ── 3. Compositing & Switches ──────────────────────────────────
  {
    id: 'compositing',
    title: 'Compositing & Switches',
    icon: 'layers',
    category: 'motion',
    defaultOpen: false,
    // Four of the old SECTION_KEYWORDS entries — `compositing`, `layerSwitches`,
    // `parenting` and `time` — all named controls this ONE section holds. Three
    // of them were keyed on section ids that had not existed for months, so
    // searching "parent" or "remap" matched nothing at all.
    keywords:
      'blend mode matte track alpha luma preserve switches quality draft motion blur adjustment shutter '
      + 'parent link pick whip layer time remap stretch speed reverse freeze frame blend',
    appliesTo: (id) => !isAbstract(id) || kindOf(id) === 'camera' || kindOf(id) === 'light',
    Component: CompositingSection,
  },

  // ── 5. Layer Styles ────────────────────────────────────────────
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

  // ── Modifier stack ─────────────────────────────────────────────
  // Same gate as the Audio Driver below, for the same reason: any layer with an
  // animatable numeric property can carry a stack, so this is about PROPERTIES,
  // not about layer kind.
  {
    id: 'modifierStack',
    title: 'Modifiers',
    icon: 'sparkles',
    category: 'motion',
    keywords: 'modifier stack delay noise spring stagger',
    appliesTo: hasModifierStackSection,
    Component: ModifierStackSection,
  },

  // ── Audio-reactive driver ──────────────────────────────────────
  // Not gated on layer KIND either — any layer with an animatable numeric
  // property (a transform, an effect parameter, a control slider) can follow
  // the music.
  {
    id: 'audioDriver',
    title: 'Audio Driver',
    icon: 'audio',
    category: 'motion',
    keywords: 'audio driver react beat amplitude band music',
    appliesTo: hasAudioDriverSection,
    Component: AudioDriverSection,
  },
];

/** The sections that belong on one layer, in registry order, optionally filtered by category. */
export function inspectorSectionsFor(nodeId: string, category: InspectorCategory = 'all'): InspectorSectionDef[] {
  if (!defaultSceneGraph.getNode(nodeId)) return [];
  return INSPECTOR_SECTIONS.filter((s) => {
    if (category !== 'all' && s.category && s.category !== category) return false;
    return s.appliesTo(nodeId);
  });
}
