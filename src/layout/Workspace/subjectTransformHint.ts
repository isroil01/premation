/**
 * "I selected the person and tried to move it — the whole clip moved."
 *
 * A subject is a SELECTION inside its layer (After Effects' Object Matte is
 * the same): moving, scaling or rotating the layer moves the whole picture.
 * Photoshop and CapCut users expect the selection to lift out. So when a drag
 * starts moving, resizing or rotating a layer that has subjects, the editor
 * says what is happening and offers the one-click way to move only the
 * subject: Separate — its own layer (New Layer from Subject: a cut-out that
 * follows the tracked matte, with the subject's styles), selected, so the
 * same drag gesture next time moves only it.
 *
 * Told once per layer per session (a user who means to move the clip is not
 * nagged), never during Motion Sketch or for layers without subjects.
 */

import { onLayerTransformStart } from '@core/workspace/ports';
import { layerSubjects } from '@core/workspace/subjects';
import { objectMatteCard } from '@core/workspace/objectMatteEffect';
import { activeSubjectId } from '@stores/subjectStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { newLayerFromSubject } from './newLayerFromSubjectCommand';

const told = new Set<string>();

export function installSubjectTransformHint(): () => void {
  return onLayerTransformStart((ids, kind) => {
    if (ids.length !== 1) return;
    const layer = ids[0]!;
    if (told.has(layer)) return;
    const subjects = layerSubjects(layer);
    if (subjects.length === 0) return;
    // Already cut to its subject (a separated copy, or Remove Background): moving it moves only the subject.
    if (objectMatteCard(layer)?.enabled) return;
    told.add(layer);
    const subject = subjects.find((s) => s.id === activeSubjectId(layer)) ?? subjects[0]!;
    const what = kind === 'move'
      ? t('workspace.subjects.hintMoving', 'moving')
      : kind === 'resize' ? t('workspace.subjects.hintResizing', 'resizing') : t('workspace.subjects.hintRotating', 'rotating');
    useUIStore.getState().notify({
      level: 'info',
      message: t('workspace.subjects.transformHint', 'You are {what} the whole clip. To move or resize only {name}, separate it onto its own layer (it keeps its tracking and styles).', { what, name: subject.name }),
      durationMs: 9000,
      action: {
        label: t('workspace.subjects.separate', 'Separate {name}', { name: subject.name }),
        onSelect: () => { void newLayerFromSubject(layer, subject.id); },
      },
    });
  });
}
