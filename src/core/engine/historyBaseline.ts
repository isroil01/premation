/**
 * The history baseline at a LOAD boundary (boot, open, crash recovery) through
 * the engine: `clearHistory` (the shared stack emptied), then
 * `addHistoryCheckpoint` — the
 * named entry that changes nothing ("Open", "Recovered") the History panel
 * shows as the starting point. Never lets history stop a document loading.
 */

import { resetHistory } from '@stores/historyStore';
import { engine, hasEngine, ownedEngine } from './engineInstance';

export async function baselineHistoryEdit(label: string): Promise<void> {
  try {
    const client = engine();
    const cleared = await client.execute({ type: 'clearHistory' });
    if (!cleared.ok) return;
    await client.execute({ type: 'addHistoryCheckpoint', label });
  } catch {
    /* no engine yet — nothing to baseline against */
  }
}

/**
 * `baselineHistoryEdit` for a synchronous load boundary: the app's stack is
 * emptied NOW (nothing can step back into the previous document from here),
 * and — when an engine is running — its clear + the named checkpoint follow
 * in request order. No engine is booted for it (headless callers).
 */
export function baselineHistoryNow(label: string): void {
  resetHistory();
  if (hasEngine() || ownedEngine() !== null) void baselineHistoryEdit(label);
}
