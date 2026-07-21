/**
 * Quote Card (1:1) — a centred pull-quote over a soft gradient, with an oversized
 * quotation mark and an author line. Exposed: quote + author text + accent.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addText, addGradientShape, linearFill, radialFill, liveKf, type SetKf } from './builders';

const CW = 1080, CH = 1080, CX = CW / 2, CY = CH / 2;

export function layoutQuoteCard(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Quote Card');
  addGradientShape(g, 'tpl_bg', rootId, CX, CY, CW, CH, linearFill(135, [[0, '#1e1b4b'], [1, '#0b1020']]));
  addGradientShape(g, 'tpl_glow', rootId, CX, CY - 60, 1000, 900,
    radialFill(0.5, 0.5, 1, [[0, '#7c6cff33'], [1, '#7c6cff00']]));
  addText(g, 'tpl_mark', rootId, '“', CX, CY - 240, 260, 900, '#7c6cff');
  addText(g, 'tpl_quote', rootId, 'Design is intelligence\nmade visible.', CX, CY + 20, 72, 800, '#ffffff');
  addText(g, 'tpl_author', rootId, '— Alina Wheeler', CX, CY + 300, 34, 500, '#9aa3c0');
}

export function animateQuoteCard(set: SetKf): void {
  set('tpl_glow', 'opacity', 0, 0, 'easeOut'); set('tpl_glow', 'opacity', 1, 100, 'easeOut');
  set('tpl_mark', 'opacity', 0, 0, 'easeOut'); set('tpl_mark', 'opacity', 0.5, 100, 'easeOut');
  set('tpl_mark', 'scaleX', 0, 0.4, 'easeOut'); set('tpl_mark', 'scaleX', 0.6, 1, 'easeOut');
  set('tpl_mark', 'scaleY', 0, 0.4, 'easeOut'); set('tpl_mark', 'scaleY', 0.6, 1, 'easeOut');
  set('tpl_quote', 'opacity', 0.3, 0, 'easeOut'); set('tpl_quote', 'opacity', 1, 100, 'easeOut');
  set('tpl_quote', 'y', 0.3, CY + 60, 'easeOut'); set('tpl_quote', 'y', 1, CY + 20, 'easeOut');
  set('tpl_author', 'opacity', 0.9, 0, 'easeOut'); set('tpl_author', 'opacity', 1.5, 100, 'easeOut');
}

export function buildQuoteCard(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutQuoteCard(defaultSceneGraph, rootId);
  animateQuoteCard(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#0b1020' });
  bumpScene();
}

export const quoteCardTemplate: TemplateDefinition = {
  id: 'quote-card',
  name: 'Quote Card',
  aspect: '1:1',
  width: CW,
  height: CH,
  description: 'A centred pull-quote over a soft gradient with an author credit.',
  layout: layoutQuoteCard,
  build: buildQuoteCard,
  animate: animateQuoteCard,
  previewTime: 1.5,
  fields: [
    { id: 'quote', label: 'Quote', kind: 'text', group: 'Text', default: 'Design is intelligence\nmade visible.',
      target: { nodeId: 'tpl_quote', componentType: 'Text', prop: 'content' } },
    { id: 'author', label: 'Author', kind: 'text', group: 'Text', default: '— Alina Wheeler',
      target: { nodeId: 'tpl_author', componentType: 'Text', prop: 'content' } },
    { id: 'quoteColor', label: 'Quote colour', kind: 'color', group: 'Colours', default: '#ffffff',
      target: { nodeId: 'tpl_quote', componentType: 'Text', prop: 'fill' } },
    { id: 'accentColor', label: 'Mark colour', kind: 'color', group: 'Colours', default: '#7c6cff',
      target: { nodeId: 'tpl_mark', componentType: 'Text', prop: 'fill' } },
  ],
};
