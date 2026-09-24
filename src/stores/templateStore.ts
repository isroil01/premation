/**
 * Template store — the active fill-in-the-blanks template and its field values.
 * `apply` builds a template's scene and seeds the value map from field defaults;
 * `setField` writes the change through the engine API (templateFieldEdits.ts —
 * the caller's `send` puts it in a typing / scrub gesture) and keeps the value
 * map in sync so the panel's controls stay live.
 */

import { create } from 'zustand';
import type { TemplateDefinition } from '@core/template/templateTypes';
import { getTemplate } from '@core/template/registry';
import { readTemplateFieldValue, writeTemplateField } from '@core/template/templateFields';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import { useCompositionStore } from '@stores/compositionStore';
import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { liveKf } from '@core/template/templates/builders';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { buildLayerFragment } from '@core/engine/offDocument';
import { layerIdsOfComp } from '@core/engine/doc';
import { compTime } from '@core/engine/propRefs';
import { hexToColor } from '@core/engine/model';
import { isMediaField, templateFieldCommands } from '@layout/Templates/templateFieldEdits';
import { getTime } from './playbackClockStore';
import { useSelectionStore } from './selectionStore';

/** Where a field's commands go: a gesture of the caller's control, else one `edit`. */
export type TemplateFieldSend = (label: string, cmds: Command[]) => void;

const editNow: TemplateFieldSend = (label, cmds) => { void edit(label, cmds); };

interface TemplateState {
  /** The template currently loaded for fill-in editing, or null (gallery view). */
  active: TemplateDefinition | null;
  /** Current value per field id (controlled-input source of truth). */
  values: Record<string, string | number>;
  /**
   * Replace the active composition's contents with a template (one undo
   * entry): its layers go, the template's comp settings and layers come in.
   */
  apply: (id: string) => Promise<void>;
  /** Enter fill-in mode for the CURRENT composition using the fields the user
   *  authored on it (no rebuild — the scene already exists). No-op if none. */
  previewAuthored: () => void;
  /**
   * Write one field (one undo entry, or into the caller's gesture through
   * `send`). A field the engine does not address is left as it is.
   */
  setField: (fieldId: string, value: string | number, send?: TemplateFieldSend) => void;
  /** Leave fill-in mode (back to the gallery); the built scene stays as-is. */
  exit: () => void;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  active: null,
  values: {},
  apply: async (id) => {
    const t = getTemplate(id);
    if (!t) return;
    // B3z: ONE gesture = one undo entry, through the engine. The legacy
    // `build()` cleared the WHOLE scene graph (every composition's layers) and
    // wrote the comp record; here the ACTIVE composition's layers are deleted,
    // the template's settings sent as `setCompositionSettings`, and its layout +
    // choreography built off-document and pasted (offDocument.ts). The build
    // needs the emptied comp (its layers carry fixed `tpl_*` ids), so it runs
    // between the two steps of the gesture.
    const comp = activeCompRootId();
    const label = `Apply ${t.name}`;
    const client = engine();
    const opened = await client.beginGesture(label);
    if (!opened.ok) {
      reportEngineError(label, opened.error);
      return;
    }
    let fields = t.fields;
    const run = async (): Promise<boolean> => {
      const old = layerIdsOfComp(comp);
      if (old.length > 0) {
        const del = await client.batch(label, [{ type: 'deleteLayers', layers: old } as Command]);
        if (!del.ok) { reportEngineError(label, del.error); return false; }
      }
      let built;
      try {
        built = buildLayerFragment(comp, () => {
          (t.layout as (g: typeof defaultSceneGraph, rootId: string) => void)(defaultSceneGraph, comp);
          t.animate?.(liveKf);
        });
      } catch (err) {
        reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
        return false;
      }
      const cmds: Command[] = [];
      if (t.settings) {
        cmds.push({
          type: 'setCompositionSettings', comp,
          patch: {
            width: t.width, height: t.height,
            frameRate: { num: t.settings.fps, den: 1 },
            duration: compTime(t.settings.durationSeconds),
            background: hexToColor(t.settings.background),
          },
        } as Command);
      }
      if (built) cmds.push({ type: 'pasteLayers', comp, fragment: built.fragment, index: 0 } as Command);
      const res = await client.batch(label, cmds);
      if (!res.ok) { reportEngineError(label, res.error); return false; }
      if (built) {
        // The fields target the template's authored ids; the engine minted new ones.
        const ids = ((res.value.at(-1) as { layers?: string[] } | undefined)?.layers) ?? [];
        const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]!]));
        fields = t.fields.map((f) => (map.has(f.target.nodeId) ? { ...f, target: { ...f.target, nodeId: map.get(f.target.nodeId)! } } : f));
        useSelectionStore.getState().set([]);
      }
      return true;
    };
    const ok = await run();
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
    if (!ok) return;

    const values: Record<string, string | number> = {};
    for (const f of fields) values[f.id] = f.default;
    set({ active: { ...t, fields }, values });
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
  setField: (fieldId, value, send = editNow) => {
    const t = get().active;
    const field = t?.fields.find((f) => f.id === fieldId);
    if (!field) return;
    const cmds = templateFieldCommands(field, value, getTime());
    if (cmds) {
      send(`Edit ${field.label}`, cmds);
    } else if (isMediaField(field)) {
      // B3-gap: import from bytes + a fitted source swap — a media slot fill is a picked browser `File` (a blob URL, no path:
      // no import from bytes) plus a reframe to the slot rect (`replaceLayerSource` has no fit).
      writeTemplateField(field, value);
    } else {
      return;
    }
    set((s) => ({ values: { ...s.values, [fieldId]: value } }));
  },
  exit: () => set({ active: null, values: {} }),
}));
