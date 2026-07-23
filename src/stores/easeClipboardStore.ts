import { create } from 'zustand';
import { defaultAnimation, parseKeyframeId, expandKeyframeProp } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';

export interface EaseClipboard {
  easing: 'linear' | 'bezier' | 'step';
  bezier?: [number, number, number, number];
  copied: boolean;
}

interface EaseClipboardActions {
  copyEase(kfId: string): void;
  pasteEase(kfIds: string[] | Set<string>): void;
  applyCustomBezier(kfIds: string[] | Set<string>, bezier: [number, number, number, number]): void;
}

export const useEaseClipboardStore = create<EaseClipboard & EaseClipboardActions>((set, get) => ({
  easing: 'linear',
  copied: false,

  copyEase: (kfId) => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;
    const props = expandKeyframeProp(ref.prop);
    const prop = props[0];
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

  pasteEase: (kfIds) => {
    const { easing, bezier, copied } = get();
    if (!copied) return;
    const idArray = Array.from(kfIds);
    if (idArray.length === 0) return;

    runAnimEdit('Paste keyframe easing', () => {
      for (const kfId of idArray) {
        const ref = parseKeyframeId(kfId);
        if (!ref) continue;
        const { nodeId, t } = ref;
        for (const prop of expandKeyframeProp(ref.prop)) {
          const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
          const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
          if (!kf) continue;
          
          defaultAnimation.setKeyframe(nodeId, prop, t, kf.value, easing);
          if (easing === 'bezier' && bezier) {
            defaultAnimation.setBezier(nodeId, prop, t, bezier);
          }
        }
      }
    });
  },

  applyCustomBezier: (kfIds, bezier) => {
    const idArray = Array.from(kfIds);
    if (idArray.length === 0) return;

    runAnimEdit('Apply Custom Easing Curve', () => {
      for (const kfId of idArray) {
        const ref = parseKeyframeId(kfId);
        if (!ref) continue;
        const { nodeId, t } = ref;
        for (const prop of expandKeyframeProp(ref.prop)) {
          const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
          const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
          if (!kf) continue;

          defaultAnimation.setKeyframe(nodeId, prop, t, kf.value, 'bezier');
          defaultAnimation.setBezier(nodeId, prop, t, bezier);
        }
      }
    });
  },
}));
