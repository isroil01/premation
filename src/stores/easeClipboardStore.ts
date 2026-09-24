import { create } from 'zustand';
import type { EasingKind } from '@motion/animation';
import { memberKeyOf } from '@core/mirror/memberKeys';
import { resolveSelectionKey } from '@core/mirror/keySelection';
import { documentMirror } from '@stores/documentMirror';
import { easeKeyframes } from '@layout/Timeline/keyframeEdits';

export interface EaseClipboard {
  easing: 'linear' | 'bezier' | 'step';
  bezier?: [number, number, number, number];
  copied: boolean;
}

interface EaseClipboardActions {
  copyEase(kfId: string): void;
  /** One `updateKeyframes` entry ("Paste keyframe easing"); resolves when it has landed. */
  pasteEase(kfIds: string[] | Set<string>): Promise<void>;
  /** A saved curve onto keys (the ease library), one entry; resolves when it has landed. */
  applyCustomBezier(kfIds: string[] | Set<string>, bezier: [number, number, number, number]): Promise<void>;
}

export const useEaseClipboardStore = create<EaseClipboard & EaseClipboardActions>((set, get) => ({
  easing: 'linear',
  copied: false,

  copyEase: (kfId) => {
    // The key from the document mirror (B4), seen from the row's member (its ease, per dimension).
    const hit = resolveSelectionKey(documentMirror(), kfId);
    if (!hit?.ref) return;
    const kf = memberKeyOf(hit.ref, hit.key);

    set({
      easing: (kf.easing as 'linear' | 'bezier' | 'step') ?? 'linear',
      bezier: kf.bezier ? ([...kf.bezier] as [number, number, number, number]) : undefined,
      copied: true,
    });
  },

  // Through the engine (B3): `updateKeyframes` patches by engine key id (`easeKeyframes`).
  pasteEase: async (kfIds) => {
    const { easing, bezier, copied } = get();
    if (!copied) return;
    const ids = Array.from(kfIds);
    if (ids.length === 0) return;
    const label = 'Paste keyframe easing';
    const handles = easing === 'bezier' ? bezier : undefined;
    await easeKeyframes(ids, { easing: easing as EasingKind, ...(handles ? { bezier: handles } : {}) }, label);
  },

  applyCustomBezier: async (kfIds, bezier) => {
    const ids = Array.from(kfIds);
    if (ids.length === 0) return;
    const label = 'Apply Custom Easing Curve';
    await easeKeyframes(ids, { easing: 'bezier', bezier }, label);
  },
}));
