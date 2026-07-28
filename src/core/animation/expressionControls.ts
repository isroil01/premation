/**
 * Expression controls (MG capability 3) — named slider values a user attaches
 * to any layer and references from ANY expression via `ctrl('name')`. The AE
 * equivalent is the Slider Control effect: one slider drives many properties,
 * which is how users invent their own rigs.
 *
 * Storage follows the threeD.ts pattern: a control is a plain numeric prop
 * `ctrl_<name>` on the layer's Transform component, so the NodeInspector
 * automatically renders a keyframeable, undoable row for it — controls animate
 * through the exact same command path as x/y/rotation.
 *
 * Lookup is global-by-name (first layer that carries the prop wins), so an
 * expression anywhere can read a slider that lives on a Null controller.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene } from '@core/scene/sceneDerive';
import { bumpScene } from '@stores/sceneStore';
import { defaultAnimation, type AnimationEngine } from '@motion/animation';

export const CONTROL_PREFIX = 'ctrl_';

/**
 * Control KINDS.
 *
 * Every kind stores a NUMBER, because that is what `ctrl(name)` resolves to and
 * what the keyframe engine animates — the kind only decides how the value is
 * presented and what range it is clamped to. A colour control is three numeric
 * controls (`name.r/.g/.b`), matching how colours are keyframed everywhere else
 * in the editor rather than inventing a second colour representation.
 *
 * The kind is stored alongside the value as `ctrlkind_<name>`, so an existing
 * project's sliders keep working: no kind recorded means Slider.
 */
export type ControlKind = 'slider' | 'angle' | 'point' | 'color' | 'checkbox' | 'dropdown' | 'layer';

export const CONTROL_KIND_PREFIX = 'ctrlkind_';

/** The sub-properties a kind expands into, appended to the control's name. */
export const CONTROL_COMPONENTS: Record<ControlKind, readonly string[]> = {
  slider: [''],
  angle: [''],
  checkbox: [''],
  // A dropdown stores its selected INDEX; a layer control stores the index of
  // the referenced layer in the comp. Both are numbers so both animate.
  dropdown: [''],
  layer: [''],
  point: ['.x', '.y'],
  color: ['.r', '.g', '.b'],
};

/** Sensible starting value per kind (per component, in order). */
const CONTROL_DEFAULTS: Record<ControlKind, readonly number[]> = {
  slider: [50],
  angle: [0],
  checkbox: [0],
  dropdown: [0],
  layer: [0],
  point: [0, 0],
  color: [255, 255, 255],
};

function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

/** All controls in the scene: [{ nodeId, name, value }]. */
export function listControls(): Array<{ nodeId: string; name: string; value: number }> {
  const out: Array<{ nodeId: string; name: string; value: number }> = [];
  for (const node of flattenScene(defaultSceneGraph)) {
    const t = transformComponent(node);
    if (!t) continue;
    for (const [key, v] of Object.entries(t.props)) {
      if (key.startsWith(CONTROL_PREFIX) && typeof v === 'number') {
        out.push({ nodeId: node.id, name: key.slice(CONTROL_PREFIX.length), value: v });
      }
    }
  }
  return out;
}

/** Next free auto-name for a kind ("Slider 1", "Angle 2", …). */
export function nextControlName(kind: ControlKind = 'slider'): string {
  const taken = new Set(listControls().map((c) => c.name));
  const base = kind === 'slider' ? 'Slider'
    : kind === 'angle' ? 'Angle'
    : kind === 'point' ? 'Point'
    : kind === 'color' ? 'Color'
    : kind === 'checkbox' ? 'Checkbox'
    : kind === 'dropdown' ? 'Dropdown'
    : 'Layer';
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    // A point control owns `name.x`/`name.y`, so the BASE name must be free
    // even though nothing is stored under it directly.
    if (![...taken].some((t) => t === name || t.startsWith(`${name}.`))) return name;
  }
}

/**
 * Add a control of any kind. Writes one numeric prop per component plus the
 * kind marker, and returns the base name.
 */
export function addControl(nodeId: string, kind: ControlKind, name?: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return null;
  const finalName = (name ?? nextControlName(kind)).trim();
  const parts = CONTROL_COMPONENTS[kind];
  const defaults = CONTROL_DEFAULTS[kind];
  parts.forEach((suffix, i) => {
    defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_PREFIX + finalName + suffix, defaults[i] ?? 0);
  });
  defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_KIND_PREFIX + finalName, kind);
  bumpScene();
  return finalName;
}

/** The kind of a named control ('slider' when unrecorded — pre-kind projects). */
export function controlKind(nodeId: string, name: string): ControlKind {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  const k = t?.props[CONTROL_KIND_PREFIX + name];
  return typeof k === 'string' && k in CONTROL_COMPONENTS ? (k as ControlKind) : 'slider';
}

/** Remove a control of any kind, including every component it owns. */
export function removeControl(nodeId: string, name: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return;
  const kind = controlKind(nodeId, name);
  for (const suffix of CONTROL_COMPONENTS[kind]) {
    defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_PREFIX + name + suffix, undefined);
  }
  defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_KIND_PREFIX + name, undefined);
  bumpScene();
}

/**
 * Add a named slider control to a layer (default value 50). The inspector
 * picks it up as a keyframeable row automatically. Returns the name used.
 */
export function addSliderControl(nodeId: string, name?: string, value = 50): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return null;
  const finalName = (name ?? nextControlName()).trim();
  defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_PREFIX + finalName, value);
  bumpScene();
  return finalName;
}

/** Remove a control from a layer (drops its prop; any tracks become inert). */
export function removeSliderControl(nodeId: string, name: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformComponent(node) : undefined;
  if (!node || !t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, CONTROL_PREFIX + name, undefined);
  bumpScene();
}

/**
 * Resolve `ctrl('name')` at time `t`: the control's animated value when it has
 * keyframes, else its static prop value, else 0. Bound into the animation
 * engine at boot (see Providers) the same way the audio provider is.
 */
const resolving = new Set<string>();

export function controlValue(name: string, t: number, engine: AnimationEngine = defaultAnimation): number {
  if (resolving.has(name)) return 0; // a control referencing itself resolves to 0
  const prop = CONTROL_PREFIX + name;
  resolving.add(name);
  try {
    for (const node of flattenScene(defaultSceneGraph)) {
      const tc = transformComponent(node);
      const base = tc?.props[prop];
      if (typeof base !== 'number') continue;
      return engine.sample(node.id, prop, t) ?? base;
    }
    return 0;
  } finally {
    resolving.delete(name);
  }
}
