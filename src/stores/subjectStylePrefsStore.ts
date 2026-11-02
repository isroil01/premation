/**
 * subjectStylePrefsStore — the user's own subject styles: which presets are
 * favourites (shown first on the shelf), the slider / swatch each was last
 * used at, and the styles saved under a name (a preset at chosen settings).
 *
 * A preference about the person, not the project: it persists to
 * localStorage, and nothing in it enters the document (the styles applied
 * are ordinary effects on the layer).
 */

import { create } from 'zustand';
import type { StyleParams } from '@layout/Workspace/subjectStylePresets';

const KEY = 'motion_editor_subject_styles_v1';

export interface SavedSubjectStyle {
  id: string;
  name: string;
  /** The preset it is made from (`SUBJECT_STYLES` id). */
  preset: string;
  params: StyleParams;
}

interface Stored {
  favourites: string[];
  params: Record<string, StyleParams>;
  saved: SavedSubjectStyle[];
}

const EMPTY: Stored = { favourites: [], params: {}, saved: [] };

function isParams(v: unknown): v is StyleParams {
  return !!v && typeof v === 'object' && typeof (v as StyleParams).intensity === 'number' && typeof (v as StyleParams).color === 'string';
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<Stored>;
    const params: Record<string, StyleParams> = {};
    for (const [id, p] of Object.entries(v.params ?? {})) if (isParams(p)) params[id] = p;
    return {
      favourites: Array.isArray(v.favourites) ? v.favourites.filter((x): x is string => typeof x === 'string') : [],
      params,
      saved: Array.isArray(v.saved)
        ? v.saved.filter((s): s is SavedSubjectStyle => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.preset === 'string' && isParams(s.params))
        : [],
    };
  } catch {
    return EMPTY;
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* a private window keeps it for the session */
  }
}

export interface SubjectStylePrefsStore extends Stored {
  toggleFavourite: (preset: string) => void;
  setParams: (preset: string, params: StyleParams) => void;
  saveStyle: (name: string, preset: string, params: StyleParams) => SavedSubjectStyle;
  renameSaved: (id: string, name: string) => void;
  removeSaved: (id: string) => void;
}

let seq = 0;

export const useSubjectStylePrefsStore = create<SubjectStylePrefsStore>((set, get) => {
  const commit = (patch: Partial<Stored>): void => {
    const s = get();
    const next: Stored = { favourites: patch.favourites ?? s.favourites, params: patch.params ?? s.params, saved: patch.saved ?? s.saved };
    write(next);
    set(next);
  };
  return {
    ...readStored(),
    toggleFavourite: (preset) => {
      const f = get().favourites;
      commit({ favourites: f.includes(preset) ? f.filter((x) => x !== preset) : [...f, preset] });
    },
    setParams: (preset, params) => commit({ params: { ...get().params, [preset]: params } }),
    saveStyle: (name, preset, params) => {
      const style: SavedSubjectStyle = { id: `style_${Date.now().toString(36)}_${(seq++).toString(36)}`, name: name.trim() || preset, preset, params: { ...params } };
      commit({ saved: [...get().saved, style] });
      return style;
    },
    renameSaved: (id, name) => commit({ saved: get().saved.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s)) }),
    removeSaved: (id) => commit({ saved: get().saved.filter((s) => s.id !== id) }),
  };
});
