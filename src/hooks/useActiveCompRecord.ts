/**
 * The active composition as the editor's composition RECORD
 * (`CompositionSettings`), from the document mirror (B4): what the page
 * renderer, the export form and the still-frame commands hand the TypeScript
 * engine's render seam (core/rendering/pageFrame). The default record when the
 * active tab names no composition. Same object until the settings change.
 */

import { useMemo } from 'react';
import type { CompositionSettings } from '@stores/projectStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { compRecordFromSettings } from '@core/mirror/compFacts';
import { activeCompIdNow, useActiveMirrorComp } from './useMirror';

export function useActiveCompRecord(): CompositionSettings {
  const comp = useActiveMirrorComp();
  return useMemo(() => (comp ? compRecordFromSettings(comp.id, comp.settings) : DEFAULT_COMPOSITION), [comp]);
}

/** The same, at call time (callbacks). */
export function activeCompRecordNow(): CompositionSettings {
  const id = activeCompIdNow();
  const s = id ? documentMirror().comp(id)?.settings : undefined;
  return s && id ? compRecordFromSettings(id, s) : DEFAULT_COMPOSITION;
}
