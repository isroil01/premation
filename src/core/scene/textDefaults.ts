import { useCompositionStore } from '@stores/compositionStore';

/**
 * The size a NEW text layer starts at, in comp pixels.
 *
 * It was a flat 32px. On a 1920×1080 comp that is a 3%-tall caption: the first
 * thing the Text tool produced was a word you had to zoom in to read, and every
 * title began with a trip to the Size field. Titles are what the tool is for,
 * so it starts at title size — ~9% of the comp's height (96px at 1080p, 64px at
 * 720p, 192px at 4K), snapped to a multiple of 4 so the field reads cleanly.
 * Floor 24: a tiny comp (an icon, a sticker) still gets legible type.
 */
export function defaultTextSize(): number {
  let h = 1080;
  try {
    const c = useCompositionStore.getState();
    if (typeof c.height === 'number' && c.height > 0) h = c.height;
  } catch {
    /* no store yet (a unit test building nodes directly) — 1080p's answer */
  }
  return Math.max(24, Math.round((h * 0.09) / 4) * 4);
}
