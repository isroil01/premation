/**
 * The history baseline at a LOAD boundary (boot, open, crash recovery) through
 * the engine: `clearHistory` (the shared stack emptied, the legacy recorder
 * re-baselined on the loaded document), then `addHistoryCheckpoint` — the
 * named entry that changes nothing ("Open", "Recovered") the History panel
 * shows as the starting point. Never lets history stop a document loading.
 */

import { engine } from './engineInstance';

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
