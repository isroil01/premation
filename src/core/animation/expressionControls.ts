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
import {
  CONTROL_PREFIX,
  CONTROL_KIND_PREFIX,
  CONTROL_SPECS,
  controlSpecOf,
  nextFreeControlName,
  type ControlKind,
} from '@core/engine/controlSpecs';

export { CONTROL_PREFIX, CONTROL_KIND_PREFIX, type ControlKind };

/**
 * Control KINDS (the table is `@core/engine/controlSpecs`, shared with both
 * engines: a control is the API group `effects/ctrl_<name>`).
 *
 * Every kind stores a NUMBER, because that is what `ctrl(name)` resolves to and
 * what the keyframe engine animates — the kind only decides how the value is
 * presented and what range it is clamped to. A colour control is three numeric
 * controls (`name.r/.g/.b`), matching how colours are keyframed everywhere else
 * in the editor rather than inventing a second colour representation.
 *
 * The kind is stored alongside the value as `ctrlkind_<name>`, so an existing
 * project's sliders keep working: no kind recorded means Slider.
 *
 * Adding / removing / renaming a control is the engine's `addPropertyGroup`
 * (parent `effects`, the kind's match name) / `removePropertyGroups` /
 * `renamePropertyGroup` on `effects/ctrl_<name>`.
 *
 * CONTROL_COMPONENTS: the sub-properties a kind expands into, appended to the
 * control's name.
 */
export const CONTROL_COMPONENTS: Record<ControlKind, readonly string[]> = Object.fromEntries(
  CONTROL_SPECS.map((s) => [s.kind, s.components]),
) as Record<ControlKind, readonly string[]>;

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
  return nextFreeControlName(controlSpecOf(kind), listControls().map((c) => c.name));
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
