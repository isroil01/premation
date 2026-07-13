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

/** Next free auto-name ("Slider 1", "Slider 2", …). */
export function nextControlName(): string {
  const taken = new Set(listControls().map((c) => c.name));
  for (let i = 1; ; i++) {
    const name = `Slider ${i}`;
    if (!taken.has(name)) return name;
  }
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
