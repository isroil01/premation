/**
 * Gallery previews of the full-scene templates: the ENGINE's picture of a
 * template's real scene (its own `layout` + `animate`, built into a throwaway
 * SceneGraph so the user's document is never touched), shown and played by the
 * shared preview controller (`previewController.ts`: a poster still per visible
 * card, the loop while the card is hovered).
 */

import type { TemplateDefinition } from './templateTypes';
import { mountPreview, type PreviewSpec } from './previewController';

/** The preview recipe of a template: its layout and choreography in its own composition size. */
export function templatePreviewSpec(template: TemplateDefinition): PreviewSpec {
  return {
    build: (g) => template.layout(g),
    animate: template.animate,
    // The template's own representative pose, when it names one.
    posterTime: template.previewTime,
    cacheKey: `template:${template.id}`,
    width: template.width,
    height: template.height,
    background: '#0e0e12',
  };
}

/**
 * Show a template on `canvas`: the engine's still of it, its animation playing
 * while the card is hovered or focused. Returns a stop to unmount.
 */
export function createTemplatePlayer(canvas: HTMLCanvasElement, template: TemplateDefinition): { stop: () => void } {
  return mountPreview(canvas, templatePreviewSpec(template));
}
