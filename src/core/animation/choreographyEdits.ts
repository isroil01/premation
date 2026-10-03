/**
 * Choreography as ENGINE edits (Animate In / Out / Stagger, Animate on Beats).
 *
 * The planners (choreography.ts) compute keyframes with the pre-API helpers;
 * here they run against a SCRATCH copy of the layers' stored keyframes
 * (core/engine/memberEdits.ts) and read the document through its mirror
 * (`mirrorFacts`) — the page replica is never touched. The result is sent to
 * the engine as ONE gesture (one undo entry, restore included):
 *
 *   1. keys     the build runs once to learn which composition times it keys
 *               (`keyTime`); the engine maps them onto each layer's keyframe
 *               axis (`mapLayerTime` `keyframeAxis`), and the build runs again
 *               on a fresh scratch with the answers.
 *   2. install  the structural changes the build declared (`needs`): a Blur
 *               effect with the caller-chosen id its keys already use, a text
 *               animator (appended, or re-set when re-used), the 3D switch.
 *   3. send     each layer's changed member lists as `setMemberKeyframes`, the
 *               statics the build puts back as `setProperties`.
 *
 * No React (src/core).
 */

import type { Command, EngineError, PropertyInfo } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { memberKeyframeCommands, runWithKeyTimes } from '@core/engine/memberEdits';
import { fieldValue, memberWrites, paths, values as apiValues } from '@core/engine/propRefs';
import { reportEngineError } from '@core/engine/uiEdits';
import { mirrorEffectHeaders } from '@core/mirror/effects';
import { uiKindOf } from '@core/mirror/layerKinds';
import { documentMirror } from '@stores/documentMirror';
import type { ChoreoEnv, ChoreoFacts, ChoreoInstall, ChoreoNeeds, StaticRestore } from './choreography';

/** What a choreography build returns: at least the installs it used, per node. */
export interface ChoreographyBuild {
  readonly installs: Readonly<Record<string, ChoreoInstall>>;
  /** Static values to put back on properties the build left un-animated. */
  readonly statics?: readonly StaticRestore[];
  /** Structural changes the keyframes need (planChoreography's `needs`). */
  readonly needs?: ChoreoNeeds;
}

/** The planner's view of the document, answered by the mirror. */
export function mirrorFacts(): ChoreoFacts {
  const m = documentMirror();
  return {
    kind: (id) => uiKindOf(m.layer(id)),
    name: (id) => m.layer(id)?.name ?? '',
    threeD: (id) => m.layer(id)?.switches.threeD === true,
    effects: (id) => mirrorEffectHeaders(m.tree(id)),
    animatorCount: (id) => m.tree(id)?.nodes.get('text/animators')?.children.length ?? 0,
  };
}

/** `setProperties` for the statics, members of one property merged. */
function staticCommands(statics: readonly StaticRestore[]): Command[] {
  const byNode = new Map<string, Record<string, number>>();
  for (const s of statics) byNode.set(s.nodeId, { ...byNode.get(s.nodeId), [s.prop]: s.value });
  const writes = [...byNode].flatMap(([node, patch]) => memberWrites(node, patch, 0) ?? []);
  return writes.length > 0 ? [{ type: 'setProperties', writes } as Command] : [];
}

/** A new text animator's values (the char_cascade rig, choreography.ts `installFor`). */
export interface AnimatorPatch {
  props: Record<string, number>;
  selector: Record<string, string | number>;
}

export const CASCADE_ANIMATOR: AnimatorPatch = {
  props: { opacity: 0, y: 16, scale: 88 },
  selector: { basedOn: 'characters', shape: 'rampUp', start: 0, end: 100 },
};

/** Engine commands for the installs, run one by one (a text animator's ids are the engine's). */
async function install(label: string, needs: ChoreoNeeds, animatorPatch: AnimatorPatch): Promise<void> {
  const client = engine();
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: EngineError }): T => {
    if (!r.ok) throw r.error;
    return r.value;
  };
  for (const e of needs.effects) {
    must(await client.execute({ type: 'addEffect', layers: [e.layer], effect: e.type, params: [], id: e.id }));
  }
  if (needs.threeD.length > 0) must(await client.execute({ type: 'setLayerSwitches', layers: needs.threeD, patch: { threeD: true } }));
  for (const a of needs.animators) {
    const layer = a.layer;
    let animatorPath: string | undefined;
    if (a.reuse) {
      const list = must(await client.query({ type: 'getPropertyTree', layer, path: 'text/animators', depth: 1 }));
      animatorPath = list.nodes.filter((n) => n.path.startsWith('text/animators/') && n.path.split('/').length === 3)[a.index]?.path;
    } else {
      const added = must(await client.execute({
        type: 'addPropertyGroup', layer, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator',
        init: Object.entries(animatorPatch.props).map(([p, v]) => ({ path: `props/${p}`, value: apiValues.scalar(v) })),
      })) as { groups?: string[] };
      animatorPath = added.groups?.[0];
    }
    if (!animatorPath) continue;
    const tree = must(await client.query({ type: 'getPropertyTree', layer, path: animatorPath, depth: 0 }));
    const byPath = new Map<string, PropertyInfo>(tree.nodes.map((n) => [n.path, n]));
    // The animator's range selector, asked of the engine (its id is the engine's).
    const selBase = `${animatorPath}/selectors/`;
    const selPath = tree.nodes.find((n) => n.path.startsWith(selBase) && !n.path.slice(selBase.length).includes('/'))?.path;
    const cmds: Command[] = [];
    // Only properties the animator has (a re-used one may have lost an optional property since).
    const put = (path: string, raw: string | number): void => {
      const info = byPath.get(path);
      const value = info ? fieldValue(info, raw) : null;
      if (value) cmds.push({ type: 'setProperty', prop: { layer, path }, value });
    };
    if (a.reuse) for (const [p, v] of Object.entries(animatorPatch.props)) put(`${animatorPath}/props/${p}`, v);
    if (selPath) for (const [k, raw] of Object.entries(animatorPatch.selector)) put(`${selPath}/${k}`, raw);
    if (cmds.length > 0) must(await client.batch(label, cmds));
  }
}

/**
 * Run a choreography `build` as ONE engine gesture named `label` (see the file
 * header). `build(env)` must be synchronous and deterministic, write only the
 * keyframes of `layers` (on `env.engine`) and report the structural changes
 * it needs in its result's `needs`. Resolves to the final run's value, or
 * null when nothing was sent (nothing to do, or refused — toasted).
 */
export async function choreographyEngineEdit<T extends ChoreographyBuild>(
  label: string,
  layers: readonly string[],
  build: (env: ChoreoEnv) => T,
): Promise<T | null> {
  let value: T;
  let cmds: Command[];
  let needs: ChoreoNeeds;
  try {
    const facts = mirrorFacts();
    const run = await runWithKeyTimes(layers, (scratch, keyTime) => build({ engine: scratch, facts, keyTime }));
    value = run.value;
    needs = value.needs ?? { effects: [], animators: [], threeD: [] };
    cmds = [...memberKeyframeCommands(run.scratch), ...staticCommands(value.statics ?? [])];
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
    if (cmds.length > 0) {
      const res = await client.batch(label, cmds);
      if (!res.ok) throw res.error;
    }
    result = value;
  } catch (err) {
    result = null;
    const e = err as Partial<EngineError>;
    reportEngineError(label, e.code ? (err as EngineError) : { code: 'internal', message: err instanceof Error ? err.message : String(err) });
  }
  const closed = await client.endGesture(opened.value.gesture, result !== null);
  if (!closed.ok) reportEngineError(label, closed.error);
  return result;
}
