/**
 * Template fields — the app's take on After Effects' Essential Graphics / MOGRT
 * model. A template is a fully-authored composition (design + animation locked)
 * plus a curated list of EXPOSED FIELDS: the only things an end-user may change
 * (a headline, a subtitle, an accent colour…). Everything else stays fixed.
 *
 * A field points at ONE prop on ONE node's component (`Text.content`,
 * `Style.fill`, …). Editing a field writes straight through the existing scene
 * graph (`writeProp`) and re-renders — no new render path. See templateFields.ts
 * for the read/write and templates/ for authored definitions.
 */

/** The kinds of value an exposed field can hold (drives the panel control).
 *  'image' holds a URL string written to the target's `src` (swap the picture). */
export type TemplateFieldKind = 'text' | 'color' | 'number' | 'image';

/** Which prop on which node a field edits. Resolved to a concrete componentId
 *  at write time (by componentType), so authors don't hand-track component ids. */
export interface TemplateFieldTarget {
  /** Stable node id authored by the template's build. */
  nodeId: string;
  /** Component type carrying the prop — e.g. 'Text', 'Style', 'Transform'. */
  componentType: string;
  /** Prop key on that component — e.g. 'content', 'fill', 'fontSize'. */
  prop: string;
}

/** One user-editable slot in a template. */
export interface TemplateField {
  /** Stable id, unique within the template. */
  id: string;
  /** Human label shown in the fill-in panel. */
  label: string;
  kind: TemplateFieldKind;
  target: TemplateFieldTarget;
  /** Default value (also what the template ships authored with). */
  default: string | number;
  /** Optional grouping header in the panel (e.g. 'Text', 'Colours'). */
  group?: string;
}

/** A ready template: an authored scene + its exposed fields. */
export interface TemplateDefinition {
  id: string;
  name: string;
  description?: string;
  /** Aspect hint for the gallery card (e.g. '16:9', '9:16', '1:1'). */
  aspect?: string;
  /** Composition size the template is authored at (drives thumbnail aspect). */
  width: number;
  height: number;
  /** Build this template's NODES (root + layers, with the stable ids the fields
   *  target) into the given graph. Pure structure — no animation, no store
   *  writes — so it can render into a throwaway graph for a thumbnail. */
  layout: (graph: import('@core/scene/SceneGraph').default) => void;
  /** Clears the live scene graph, runs layout into it, applies the animation,
   *  sets the composition and bumps the scene. */
  build: () => void;
  /** The template's motion, defined ONCE against an abstract keyframe setter so
   *  the SAME choreography drives the live apply (build → liveKf) AND the
   *  isolated gallery-card animation (a throwaway preview engine). Node ids match
   *  those authored by `layout`. Omit for a static template. */
  animate?: (set: import('./templates/builders').SetKf) => void;
  /** Representative time (seconds) for the still poster frame on the card. */
  previewTime?: number;
  /** The only things the end-user may change. */
  fields: TemplateField[];
}
