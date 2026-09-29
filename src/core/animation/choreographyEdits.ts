/**
 * Choreography as ENGINE edits (Animate In / Out / Stagger, Animate on Beats).
 *
 * In the app the C++ engine owns the document and the page holds a replica
 * that only follows it (ownedEngineClient.ts). The choreography planners
 * (choreography.ts) write the page's scene graph and animation stores, so run
 * directly they changed only the replica: nothing was saved, rendered or
 * exported. Here they are run OFF-DOCUMENT and their result is sent to the
 * engine, as ONE gesture (one undo entry, restore included):
 *
 *   1. plan    the whole build (restore + installs + keyframes) runs against a
 *              scratch copy of the replica and is thrown away; it tells which
 *              STRUCTURAL installs the build needs — a Blur effect (the
 *              scratch id is kept, `addEffect.id`, so the keyframe paths line
 *              up), a text animator, the 3D switch.
 *   2. install those are sent as engine commands; the replica follows (every
 *              edit is forwarded), so the build now finds them in place.
 *   3. keys    the build runs off-document again, reusing the installs, and
 *              its keyframe changes are translated to `setKeyframes` /
 *              `setAnimated` (assistantKeyframeCommands) and sent as one batch.
 *
 * No React (src/core).
 */

import type { Command, EngineError } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { offDocument } from '@core/engine/offDocument';
import { assistantKeyframeCommands } from '@core/engine/assistantKeys';
import { catalogFor } from '@core/engine/props';
import { fieldValue, memberWrites, paths, values as apiValues } from '@core/engine/propRefs';
import { reportEngineError } from '@core/engine/uiEdits';
import { is3DEnabled } from '@core/scene/threeD';
import type { ChoreoInstall, StaticRestore } from './choreography';

/** What a choreography build returns: at least the installs it used, per node. */
export interface ChoreographyBuild {
  readonly installs: Readonly<Record<string, ChoreoInstall>>;
  /** Static values to put back on properties the build left un-animated. */
  readonly statics?: readonly StaticRestore[];
}

/** `setProperties` for the statics, members of one property merged. */
function staticCommands(statics: readonly StaticRestore[]): Command[] {
  const byNode = new Map<string, Record<string, number>>();
  for (const s of statics) byNode.set(s.nodeId, { ...byNode.get(s.nodeId), [s.prop]: s.value });
  const writes = [...byNode].flatMap(([node, patch]) => memberWrites(node, patch, 0) ?? []);
  return writes.length > 0 ? [{ type: 'setProperties', writes } as Command] : [];
}

interface Needs {
  effects: Array<{ layer: string; id: string; type: string }>;
  animators: string[];
  threeD: string[];
}

type Part = { components?: Array<{ type: string; props: Record<string, unknown> }> } | undefined;

function effectsOf(part: Part): Array<{ id: string; type: string }> {
  const list = part?.components?.find((c) => c.type === 'fx')?.props.effects;
  return Array.isArray(list) ? (list as Array<{ id: string; type: string }>) : [];
}

function animatorCountOf(part: Part): number {
  for (const c of part?.components ?? []) {
    const a = c.props.__animators;
    if (Array.isArray(a)) return a.length;
  }
  return 0;
}

/** Engine commands for the installs, run one by one (a text animator's ids are the engine's). */
async function install(label: string, needs: Needs, animatorPatch: AnimatorPatch): Promise<void> {
  const client = engine();
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: EngineError }): T => {
    if (!r.ok) throw r.error;
    return r.value;
  };
  for (const e of needs.effects) {
    must(await client.execute({ type: 'addEffect', layers: [e.layer], effect: e.type, params: [], id: e.id }));
  }
  if (needs.threeD.length > 0) must(await client.execute({ type: 'setLayerSwitches', layers: needs.threeD, patch: { threeD: true } }));
  for (const layer of needs.animators) {
    const added = must(await client.execute({
      type: 'addPropertyGroup', layer, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator',
      init: Object.entries(animatorPatch.props).map(([p, v]) => ({ path: `props/${p}`, value: apiValues.scalar(v) })),
    })) as { groups?: string[] };
    const animatorId = (added.groups?.[0] ?? '').split('/')[2] ?? '';
    // The new animator's range selector, asked of the engine (its id is the engine's).
    const selBase = `${paths.animatorGroup(animatorId)}/selectors/`;
    const tree = await client.query({ type: 'getPropertyTree', layer, path: `${paths.animatorGroup(animatorId)}/selectors`, depth: 0 });
    const selPath = tree.ok ? tree.value.nodes.find((n) => n.path.startsWith(selBase) && !n.path.slice(selBase.length).includes('/'))?.path : undefined;
    if (!selPath) continue;
    const cat = catalogFor(layer);
    const cmds: Command[] = [];
    for (const [k, raw] of Object.entries(animatorPatch.selector)) {
      const path = `${selPath}/${k}`;
      const b = cat.byPath.get(path);
      const value = b ? fieldValue(b, raw) : typeof raw === 'number' ? apiValues.scalar(raw) : null;
      if (value) cmds.push({ type: 'setProperty', prop: { layer, path }, value });
    }
    if (cmds.length > 0) must(await client.batch(label, cmds));
  }
}

/** A new text animator's values (the char_cascade rig, choreography.ts installFor). */
export interface AnimatorPatch {
  props: Record<string, number>;
  selector: Record<string, string | number>;
}

export const CASCADE_ANIMATOR: AnimatorPatch = {
  props: { opacity: 0, y: 16, scale: 88 },
  selector: { basedOn: 'characters', shape: 'rampUp', start: 0, end: 100 },
};

/**
 * Run a choreography `build` as ONE engine gesture named `label` (see the file
 * header). `build(installs)` must be synchronous and write only the scene
 * graph / animation of `layers`; `installs` is undefined on the planning run
 * and the planning run's installs on the final one. Resolves to the final
 * run's value, or null when nothing was sent (nothing to do, or refused —
 * toasted).
 */
export async function choreographyEngineEdit<T extends ChoreographyBuild>(
  label: string,
  layers: readonly string[],
  build: (installs: Readonly<Record<string, ChoreoInstall>> | undefined) => T,
): Promise<T | null> {
  let needs: Needs;
  let planned: T;
  try {
    [planned, needs] = offDocument(() => build(undefined), ({ value, before, after }) => {
      const n: Needs = { effects: [], animators: [], threeD: [] };
      for (const layer of layers) {
        const was = before.get(`node:${layer}`) as Part;
        const now = after.get(`node:${layer}`) as Part;
        const had = new Set(effectsOf(was).map((e) => e.id));
        for (const e of effectsOf(now)) if (!had.has(e.id)) n.effects.push({ layer, id: e.id, type: e.type });
        if (animatorCountOf(now) > animatorCountOf(was)) n.animators.push(layer);
        if (was && now && !is3DEnabled(was as SceneNode) && is3DEnabled(now as SceneNode)) n.threeD.push(layer);
      }
      return [value, n] as [T, Needs];
    });
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let result: T | null = null;
  try {
    await install(label, needs, CASCADE_ANIMATOR);
    // The replica follows every edit; the keyframe build must see the installs.
    await engineIdle();
    const plan = assistantKeyframeCommands(layers, () => build(planned.installs), { allowNodeChanges: true });
    const cmds = [...plan.cmds, ...staticCommands(plan.value.statics ?? [])];
    if (cmds.length > 0) {
      const res = await client.batch(label, cmds);
      if (!res.ok) throw res.error;
    }
    result = plan.value;
  } catch (err) {
    result = null;
    const e = err as Partial<EngineError>;
    reportEngineError(label, e.code ? (err as EngineError) : { code: 'internal', message: err instanceof Error ? err.message : String(err) });
  }
  const closed = await client.endGesture(opened.value.gesture, result !== null);
  if (!closed.ok) reportEngineError(label, closed.error);
  return result;
}
