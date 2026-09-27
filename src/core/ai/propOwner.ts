/**
 * Pure reads shared by the AI facades (toolContext.ts) and the Lottie
 * importer's off-document context (src/core/lottie/lottieDocumentContext.ts):
 * which component a legacy prop name lives on, and where an un-placed layer
 * goes. No writes.
 */

import type { SceneNode } from '@core/types';

export const transformComponent = (node: SceneNode): SceneNode['components'][number] | undefined =>
  node.components.find((c) => c.type === 'Transform') ??
  node.components.find((c) => typeof (c.props as Record<string, unknown>).x === 'number');

/**
 * A non-overlapping default position for a layer the model didn't place.
 * Steps through a loose 3-column grid centred on the comp so N un-placed layers
 * spread out instead of stacking on one pixel.
 */
export function spreadPlacement(index: number, w: number, h: number): { x: number; y: number } {
  const cols = 3;
  const col = index % cols;
  const row = Math.floor(index / cols) % 3;
  return { x: w / 2 + (col - 1) * (w / 5), y: h / 2 + (row - 1) * (h / 5) };
}

/** The component a static write of `prop` lands on (the legacy routing rule). */
export function ownerOf(node: SceneNode, prop: string): SceneNode['components'][number] | undefined {
  const style = node.components.find((c) => c.type === 'Style');
  const text = node.components.find((c) => c.type === 'Text');
  // Route each prop to the component that actually owns it — writing
  // `content` onto the Transform would be silently accepted and ignored.
  return (
    // Everything typographic belongs to the Text component.
    prop === 'content' || prop === 'fontSize' || prop === 'fontWeight' ||
    prop === 'fontFamily' || prop === 'letterSpacing' || prop === 'lineHeight' ||
    prop === 'align' || prop === 'paragraphSpacing'
      ? text
      : prop === 'fill'
        // Shapes/solids carry fill on their Style; a text layer has NO Style
        // component — its colour lives as `fill` on the Text component.
        ? (style ?? text)
        : prop === 'opacity'
          ? (style ?? transformComponent(node))
          : transformComponent(node)
  );
}
