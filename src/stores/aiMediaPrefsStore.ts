/**
 * aiMediaPrefsStore — which model generated media uses when a call does not
 * name one. A preference about the person, not the project: it persists to
 * localStorage, and nothing in it enters the document.
 *
 * The video default is the free preview until the user picks a paid model in
 * Settings → Assistant → Media: generating footage costs money per clip, so it
 * starts only when someone has chosen to spend it.
 */

import { create } from 'zustand';
import { PREVIEW_VIDEO_MODEL, videoModel } from '@motion/ai-tools';

const KEY = 'motion_editor_ai_video_model';

function readStored(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v && videoModel(v) ? v : PREVIEW_VIDEO_MODEL;
  } catch {
    return PREVIEW_VIDEO_MODEL;
  }
}

export interface AiMediaPrefsStore {
  /** A `VIDEO_MODELS` id. */
  videoModel: string;
  setVideoModel: (id: string) => void;
}

export const useAiMediaPrefsStore = create<AiMediaPrefsStore>((set) => ({
  videoModel: readStored(),
  setVideoModel: (id) => {
    if (!videoModel(id)) return;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* a private window keeps it for the session */
    }
    set({ videoModel: id });
  },
}));
