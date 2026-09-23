import { create } from 'zustand';
import { defaultAnimation, expandKeyframeProp, type BezierHandles, type EasingKind } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';
import { easeKeyframes, parseUiKey } from '@layout/Timeline/keyframeEdits';

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

/**
 * The legacy writer for keys the API cannot address alone (a lone member row
 * of a grouped property whose sibling is keyed at the same time — see
 * layout/Timeline/keyframeEdits.ts): same easing + handles, one entry.
 */
function legacyEase(label: string, kfIds: readonly string[], easing: EasingKind, bezier: BezierHandles | undefined): void {
  // B3-legacy: a key the API cannot address alone (keyframeEdits' file header).
  runAnimEdit(label, () => {
    for (const kfId of kfIds) {
      const ref = parseUiKey(kfId);
      if (!ref) continue;
      for (const prop of expandKeyframeProp(ref.prop)) {
        const kf = defaultAnimation.getTrackKeyframes(ref.nodeId, prop)?.find((k) => Math.abs(k.t - ref.t) < 1e-6);
        if (!kf) continue;
        // B3-legacy: see above.
        defaultAnimation.setKeyframe(ref.nodeId, prop, ref.t, kf.value, easing);
        // B3-legacy: see above.
        if (easing === 'bezier' && bezier) defaultAnimation.setBezier(ref.nodeId, prop, ref.t, bezier);
      }
    }
  });
  bumpScene();
}

export const useEaseClipboardStore = create<EaseClipboard & EaseClipboardActions>((set, get) => ({
  easing: 'linear',
  copied: false,

  copyEase: (kfId) => {
    const ref = parseUiKey(kfId);
    if (!ref) return;
    const prop = expandKeyframeProp(ref.prop)[0];
    if (!prop) return;

    const kfs = defaultAnimation.getTrackKeyframes(ref.nodeId, prop);
    const kf = kfs?.find((k) => Math.abs(k.t - ref.t) < 1e-6);
    if (!kf) return;

    set({
      easing: (kf.easing as 'linear' | 'bezier' | 'step') ?? 'linear',
      bezier: kf.bezier ? ([...kf.bezier] as [number, number, number, number]) : undefined,
      copied: true,
    });
  },

  // Through the engine (B3): `updateKeyframes` patches by engine key id
  // (`easeKeyframes`); the legacy writer only for keys the API cannot address.
  pasteEase: async (kfIds) => {
    const { easing, bezier, copied } = get();
    if (!copied) return;
    const ids = Array.from(kfIds);
    if (ids.length === 0) return;
    const label = 'Paste keyframe easing';
    const handles = easing === 'bezier' ? bezier : undefined;
    await easeKeyframes(ids, { easing: easing as EasingKind, ...(handles ? { bezier: handles } : {}) }, label,
      () => legacyEase(label, ids, easing as EasingKind, handles));
  },

  applyCustomBezier: async (kfIds, bezier) => {
    const ids = Array.from(kfIds);
    if (ids.length === 0) return;
    const label = 'Apply Custom Easing Curve';
    await easeKeyframes(ids, { easing: 'bezier', bezier }, label, () => legacyEase(label, ids, 'bezier', bezier));
  },
}));
