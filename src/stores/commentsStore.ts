/**
 * Comments (spec §Collaboration V1) — feedback anchored to a layer and a
 * timecode. Persisted locally so review notes survive reloads. Clicking a
 * comment jumps the editor to that layer and time.
 */

import { create } from 'zustand';

export interface Comment {
  id: string;
  nodeId: string;
  nodeName: string;
  time: number;
  text: string;
  at: number;
}

interface CommentsStore {
  comments: Comment[];
  add: (c: Omit<Comment, 'id' | 'at'>) => void;
  remove: (id: string) => void;
}

const KEY = 'motion-editor.comments';

function load(): Comment[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(comments: Comment[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(comments));
  } catch {
    /* ignore quota / disabled storage */
  }
}

let seq = 0;

export const useCommentsStore = create<CommentsStore>((set, get) => ({
  comments: load(),
  add: (c) => {
    const comment: Comment = { ...c, id: `c_${Date.now()}_${(seq += 1)}`, at: Date.now() };
    const next = [comment, ...get().comments];
    persist(next);
    set({ comments: next });
  },
  remove: (id) => {
    const next = get().comments.filter((c) => c.id !== id);
    persist(next);
    set({ comments: next });
  },
}));
