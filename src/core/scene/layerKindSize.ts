/**
 * Fixed on-canvas size per layer kind (comp px).
 *
 * Shared with hit-testing and selection so the boxes match what the picture
 * draws. A layer with its own width and height uses those; this is the
 * fallback when it has neither.
 */

export const SIZE: Record<'shape' | 'text' | 'image' | 'video', { w: number; h: number }> = {
  shape: { w: 220, h: 220 },
  text: { w: 320, h: 80 },
  image: { w: 280, h: 180 },
  video: { w: 480, h: 270 },
};
