/**
 * subjectPanelPrefsStore — which groups of Properties ▸ Subject the user has
 * folded (Edge, Tracking, Create, Styles). A preference about the person, not
 * the project: it persists to localStorage and never enters the document.
 */

import { create } from 'zustand';

const KEY = 'motion_editor_subject_panel_v1';

function readClosed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface SubjectPanelPrefsStore {
  /** The folded groups, by id. */
  closed: string[];
  toggle: (group: string) => void;
}

export const useSubjectPanelPrefsStore = create<SubjectPanelPrefsStore>((set, get) => ({
  closed: readClosed(),
  toggle: (group) => {
    const s = get().closed;
    const closed = s.includes(group) ? s.filter((g) => g !== group) : [...s, group];
    try {
      localStorage.setItem(KEY, JSON.stringify(closed));
    } catch {
      /* a private window keeps it for the session */
    }
    set({ closed });
  },
}));
