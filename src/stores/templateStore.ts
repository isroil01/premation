/**
 * Template store — the active fill-in-the-blanks template and its field values.
 * `apply` builds a template's scene and seeds the value map from field defaults;
 * `setField` writes the change through the scene graph (templateFields) and keeps
 * the value map in sync so the panel's controls stay live.
 */

import { create } from 'zustand';
import type { TemplateDefinition } from '@core/template/templateTypes';
import { getTemplate } from '@core/template/registry';
import { readTemplateFieldValue, writeTemplateField } from '@core/template/templateFields';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';

interface TemplateState {
  /** The template currently loaded for fill-in editing, or null (gallery view). */
  active: TemplateDefinition | null;
  /** Current value per field id (controlled-input source of truth). */
  values: Record<string, string | number>;
  apply: (id: string) => void;
  /** Enter fill-in mode for the CURRENT composition using the fields the user
   *  authored on it (no rebuild — the scene already exists). No-op if none. */
  previewAuthored: () => void;
  setField: (fieldId: string, value: string | number) => void;
  /** Leave fill-in mode (back to the gallery); the built scene stays as-is. */
  exit: () => void;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  active: null,
  values: {},
  apply: (id) => {
    const t = getTemplate(id);
    if (!t) return;
    t.build();
    // Bring the timeline in step with the freshly-built scene: match the comp's
    // fps/duration, then rebuild tracks/clips/keyframes from the scene (same
    // flow the example-scene loaders use). Without this the layers render but
    // the timeline stays empty.
    const c = useCompositionStore.getState();
    const tc = getTimelineController();
    tc.setFrameRate(c.fps);
    tc.setDurationSeconds(c.durationSeconds);
    tc.syncFromScene();
    bumpScene();

    const values: Record<string, string | number> = {};
    for (const f of t.fields) values[f.id] = f.default;
    set({ active: t, values });
  },
  previewAuthored: () => {
    const fields = readAuthoredFields();
    if (fields.length === 0) return;
    const values: Record<string, string | number> = {};
    for (const f of fields) {
      const current = readTemplateFieldValue(f);
      values[f.id] = (typeof current === 'string' || typeof current === 'number') ? current : f.default;
    }
    const comp = useCompositionStore.getState();
    set({
      active: {
        id: '__authored', name: 'This composition',
        width: comp.width, height: comp.height,
        layout: () => {}, build: () => {}, fields,
      },
      values,
    });
  },
  setField: (fieldId, value) => {
    const t = get().active;
    const field = t?.fields.find((f) => f.id === fieldId);
    if (!field) return;
    writeTemplateField(field, value);
    set((s) => ({ values: { ...s.values, [fieldId]: value } }));
  },
  exit: () => set({ active: null, values: {} }),
}));
