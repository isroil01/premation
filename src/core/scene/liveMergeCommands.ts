/**
 * Live Merge Paths as engine commands (B5, docs/ENGINE_API.md §15.6).
 *
 * `planLiveMerge` (mergePaths.ts) decides the result layer from the selection;
 * this sends it as ONE batch — the result built off-document and pasted where
 * the first operand sits, then every operand marked `layer/booleanOperand`
 * (sampled by the result, not painted) and hidden (`setLayerSwitches`). One
 * undo entry, replayable from the command log in either engine. The Workspace
 * and Scene menus, the command palette and the AI's `merge_paths` all send it.
 */

import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { buildLayerFragment } from '@core/engine/offDocument';
import { compOfLayer } from '@core/engine/doc';
import { planLiveMerge, type MergeOp } from './mergePaths';

export interface LiveMergeBatch {
  /** The composition the result lands in. */
  comp: string;
  /** pasteLayers of the result, then the operand flags and switches. */
  commands: Command[];
  /** The operands, in selection order. */
  sourceIds: string[];
}

/** The operand half of the batch: flag every source as an operand, then hide it from paint. */
export function liveMergeOperandCommands(sourceIds: readonly string[]): Command[] {
  if (sourceIds.length === 0) return [];
  return [
    {
      type: 'setProperties',
      writes: sourceIds.map((layer) => ({ prop: { layer, path: 'layer/booleanOperand' }, value: { kind: 'bool', value: true } })),
    } as Command,
    { type: 'setLayerSwitches', layers: [...sourceIds], patch: { visible: false } } as Command,
  ];
}

/**
 * The selection's live boolean `op` as commands, or null when fewer than two
 * closed shape paths are selected (or they do not overlap for the op). The
 * pasteLayers result (the batch's first) carries the result layer's new id.
 */
export function liveMergeBatch(op: MergeOp): LiveMergeBatch | null {
  const plan = planLiveMerge(op);
  if (!plan) return null;
  const comp = compOfLayer(plan.sourceIds[0]!);
  if (!comp) return null;
  const built = buildLayerFragment(comp, () => { defaultSceneGraph.addChild(plan.parentId, plan.node); });
  if (!built) return null;
  return {
    comp,
    sourceIds: plan.sourceIds,
    commands: [
      { type: 'pasteLayers', comp, fragment: built.fragment, index: built.index, ...(built.parent ? { parent: built.parent } : {}) } as Command,
      ...liveMergeOperandCommands(plan.sourceIds),
    ],
  };
}

/** The result layer's id from the batch's results (pasteLayers comes first). */
export function liveMergeResultId(results: readonly unknown[]): string | null {
  return (results[0] as { layers?: string[] } | undefined)?.layers?.[0] ?? null;
}
