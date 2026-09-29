/**
 * The page-history animation edits, sent to the ENGINE when it owns the
 * document (B4 round 8 — the owner-write bridge).
 *
 * In the app the C++ engine owns the document and the page's TypeScript engine
 * is its REPLICA (ownedEngineClient.ts): edits are forwarded owner → replica,
 * never the other way. A legacy writer that records through `recordAnimEdit`
 * (`runAnimEdit`, `captureAnimEdit` + record, `beginAnimEdit().commit`) changes
 * only the replica — nothing the engine saves, renders or exports.
 *
 * The bridge makes those writers reach the engine without touching each one:
 * the recorded change is taken back off the replica (`undo`), re-run
 * OFF-DOCUMENT and translated into API commands by the keyframe assistants'
 * translator (`assistantKeyframeCommands`: one `setKeyframes` / `setAnimated`
 * per changed property, member tracks folded into their property) plus a
 * `setExpression` per changed expression, and sent as ONE engine entry named
 * after the edit. The engine forwards the same commands to the replica, so the
 * two stay equal; undo is the engine's.
 *
 * What it cannot express (a track the API does not address) is reported and
 * left on the replica only — the owner-write audit (ownerWriteAudit.test.ts)
 * lists those.
 *
 * No React (src/core).
 */

import type { Command } from '@motion/engine-api';
import { setAnimEditBridge, setAnimEditRunBridge, type AnimEditCommand } from '@core/animation/animationCommands';
import { assistantKeyframeCommands } from './assistantKeys';
import { layerDiffCommands } from './layerDiffCommands';
import { isLayer } from './doc';
import { engineOwnsDocumentNow } from './engineOwnership';
import { propRefForTrack } from './propRefs';
import { edit, reportEngineError } from './uiEdits';

/** The expression changes of an edit as `setExpression` commands (after the keyframes). */
function expressionCommands(command: AnimEditCommand): Command[] {
  const out: Command[] = [];
  for (const c of command.trackChanges) {
    if (c.expressionAfter === undefined) continue;
    const before = c.expressionBefore ?? null;
    const after = c.expressionAfter ?? null;
    if (before?.src === after?.src && before?.enabled === after?.enabled) continue;
    const r = propRefForTrack(c.nodeId, c.prop);
    if (!r) continue;
    out.push({
      type: 'setExpression',
      prop: r.ref,
      source: after?.src ?? '',
      enabled: after?.enabled ?? true,
      ...(r.members.length > 1 ? { member: r.member } : {}),
    } as Command);
  }
  return out;
}

/** Take a recorded page edit to the engine. True when the edit is handled here (not pushed on the page history). */
export function bridgeAnimEdit(command: AnimEditCommand): boolean {
  if (!engineOwnsDocumentNow()) return false;
  const layers = [...new Set(command.trackChanges.map((c) => c.nodeId))].filter((id) => isLayer(id));
  if (layers.length === 0) return false;
  // Back to the state the engine has; the engine's commands bring the replica forward again.
  command.undo();
  let cmds: Command[];
  try {
    const plan = assistantKeyframeCommands(layers, () => command.execute());
    cmds = [...plan.cmds, ...expressionCommands(command)];
    if (plan.unaddressed.length > 0) {
      console.warn(`[engine] "${command.label}" wrote a track the engine does not address on ${plan.unaddressed.join(', ')}`);
    }
  } catch (err) {
    reportEngineError(command.label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return true;
  }
  if (cmds.length > 0) void edit(command.label, cmds);
  return true;
}

/**
 * `runAnimEdit(label, mutate)` when the engine owns the document: the whole
 * mutation off-document, its effect on existing layers sent as ONE engine
 * entry (layerDiffCommands.ts � keyframes, static values, expressions,
 * switches, parent, timing). What it cannot carry (a created layer, an item)
 * is reported; nothing of it is left on the replica alone.
 */
export function bridgeAnimRun(label: string, mutate: () => void): boolean {
  if (!engineOwnsDocumentNow()) return false;
  let plan;
  try {
    plan = layerDiffCommands(mutate);
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return true;
  }
  if (plan.unexpressed.length > 0) {
    console.warn(`[engine] "${label}" changed what the engine bridge cannot send (${plan.unexpressed.slice(0, 4).join(', ')})`);
  }
  if (plan.cmds.length > 0) void edit(label, plan.cmds);
  return true;
}

/** Install the bridge (the session's boot; idempotent). */
export function installAnimEditBridge(): void {
  setAnimEditBridge(bridgeAnimEdit);
  setAnimEditRunBridge(bridgeAnimRun);
}
