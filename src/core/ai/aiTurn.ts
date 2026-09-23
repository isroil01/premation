/**
 * Run a list of AI tool calls as ONE turn, without a model — what a library
 * emitter, a deterministic recipe, an automation or a test does
 * (NATIVE_CORE_PLAN §5 B5). Same registry, same transaction as `runAgent`:
 * one engine gesture labelled `label`, rolled back if any call throws or
 * `rollbackOnFailure` sees a failed result.
 */

import type { EngineClient } from '@motion/engine-api';
import type { ToolResult } from '@motion/ai-tools';
import { getAiRegistry } from './AgentLoop';
import { createToolContext } from './toolContext';
import { beginAiTransaction, type AiTurnOutcome } from './aiTransaction';

export interface ToolTurnCall {
  name: string;
  args: unknown;
}

export interface ToolTurnResult {
  results: ToolResult[];
  outcome: AiTurnOutcome;
  rolledBack: boolean;
}

export async function runToolTurn(
  label: string,
  calls: readonly ToolTurnCall[],
  opts: { client?: EngineClient; rollbackOnFailure?: boolean; signal?: AbortSignal } = {},
): Promise<ToolTurnResult> {
  const tx = await beginAiTransaction(label, opts.client ? { client: opts.client } : {});
  const ctx = createToolContext(opts.signal ?? new AbortController().signal, undefined, tx.session);
  const reg = getAiRegistry();
  const results: ToolResult[] = [];
  try {
    for (const c of calls) {
      const r = await reg.execute(c.name, c.args, ctx);
      results.push(r);
      if (!r.ok && opts.rollbackOnFailure) {
        await tx.rollback();
        return { results, outcome: { kind: 'empty', gaps: tx.session.legacyGaps }, rolledBack: true };
      }
    }
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return { results, outcome: await tx.commit(), rolledBack: false };
}
