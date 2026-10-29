/**
 * New Layer from Subject as the user runs it (Layer menu, right-click ▸
 * Subject, the subject chip): the edit, then the new layer selected, or a
 * message saying what is missing. The edit itself is newLayerFromSubject.ts.
 */

import { playheadSeconds } from '@core/timeline/timelineView';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { layerSubjects } from '@core/workspace/subjects';
import { activeSubjectId } from '@stores/subjectStore';
import { hasSubject, newLayerFromSubjectEdit, subjectPartsOf } from './newLayerFromSubject';

/** Whether `layer` has a subject to lift out, from what the mirror holds now (menus build synchronously). */
export function canMakeLayerFromSubject(layer: string | undefined): boolean {
  if (!layer) return false;
  const tree = documentMirror().tree(layer);
  return !!tree && hasSubject(subjectPartsOf(tree), tree);
}

/** Run it on `layer` and select the result. */
export async function newLayerFromSubject(
  layer: string,
  subject: string | null = layerSubjects(layer).length > 0 ? activeSubjectId(layer) : null,
): Promise<boolean> {
  const res = await newLayerFromSubjectEdit(layer, playheadSeconds(), subject);
  if (res.ok) {
    useSelectionStore.getState().set([res.layer]);
    return true;
  }
  if (res.reason === 'noSubject') {
    // Straight to the tool that makes one, as Text Behind does without a matte.
    useSelectionStore.getState().set([layer]);
    useUIStore.getState().setActiveTool('object-matte');
  }
  if (res.reason !== 'engine') useUIStore.getState().notify({ level: 'warning', message: res.message, durationMs: 3600 });
  return false;
}

/** The menu's run: the first selected layer. */
export function runNewLayerFromSubject(): void {
  const first = useSelectionStore.getState().ids[0];
  if (!first) {
    useUIStore.getState().notify({ level: 'warning', message: t('workspace.subjects.newLayerNoLayer', 'Select the layer the subject is on.'), durationMs: 3200 });
    return;
  }
  void newLayerFromSubject(first);
}
