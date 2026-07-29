/**
 * Title Card (16:9) — a bold centered headline + subtitle over a soft accent
 * glow and an animated underline. Exposed fields: two texts + three colours.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addShape, addText, addGradientShape, radialFill, liveKf, type SetKf } from './builders';

const CW = 1920, CH = 1080, CX = CW / 2, CY = CH / 2;

/** Nodes only (graph-agnostic) — shared by build and the thumbnail. */
export function layoutTitleCard(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Title Card');
  addShape(g, 'tpl_bg', rootId, CX, CY, CW, CH, '#0e0e1c');
  addGradientShape(g, 'tpl_glow', rootId, CX, CY - 20, 1500, 1100,
    radialFill(0.5, 0.5, 1, [[0, '#635bff55'], [0.55, '#635bff22'], [1, '#635bff00']]));
  addText(g, 'tpl_headline', rootId, 'Your Headline Here', CX, CY - 40, 116, 800, '#ffffff');
  addShape(g, 'tpl_accent', rootId, CX, CY + 56, 150, 8, '#635bff');
  addText(g, 'tpl_subtitle', rootId, 'Your subtitle goes here', CX, CY + 128, 34, 400, '#9aa3c0');
}

/** Motion — one choreography shared by the live apply and the gallery preview. */
export function animateTitleCard(set: SetKf): void {
  set('tpl_glow', 'opacity', 0, 0, 'easeOut'); set('tpl_glow', 'opacity', 1, 100, 'easeOut');
  set('tpl_glow', 'scaleX', 0, 0.8, 'easeOut'); set('tpl_glow', 'scaleX', 1, 1, 'easeOut');
  set('tpl_glow', 'scaleY', 0, 0.8, 'easeOut'); set('tpl_glow', 'scaleY', 1, 1, 'easeOut');
  set('tpl_headline', 'opacity', 0, 0, 'easeOut'); set('tpl_headline', 'opacity', 0.8, 100, 'easeOut');
  set('tpl_headline', 'y', 0, CY - 4, 'easeOut'); set('tpl_headline', 'y', 0.8, CY - 40, 'easeOut');
  set('tpl_accent', 'scaleX', 0.3, 0, 'easeOut'); set('tpl_accent', 'scaleX', 1.1, 1, 'easeOut');
  set('tpl_subtitle', 'opacity', 0.5, 0, 'easeOut'); set('tpl_subtitle', 'opacity', 1.3, 100, 'easeOut');
}

export function buildTitleCard(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutTitleCard(defaultSceneGraph, rootId);
  animateTitleCard(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#0e0e1c' });
  bumpScene();
}

export const titleCardTemplate: TemplateDefinition = {
  id: 'title-card',
  name: 'Title Card',
  aspect: '16:9',
  width: CW,
  height: CH,
  description: 'A bold centered headline with subtitle and an animated accent bar.',
  layout: layoutTitleCard,
  build: buildTitleCard,
  animate: animateTitleCard,
  previewTime: 1.3,
  fields: [
    { id: 'headline', label: 'Headline', kind: 'text', group: 'Text', default: 'Your Headline Here',
      target: { nodeId: 'tpl_headline', componentType: 'Text', prop: 'content' } },
    { id: 'subtitle', label: 'Subtitle', kind: 'text', group: 'Text', default: 'Your subtitle goes here',
      target: { nodeId: 'tpl_subtitle', componentType: 'Text', prop: 'content' } },
    { id: 'headlineColor', label: 'Headline colour', kind: 'color', group: 'Colours', default: '#ffffff',
      target: { nodeId: 'tpl_headline', componentType: 'Text', prop: 'fill' } },
    { id: 'accentColor', label: 'Accent colour', kind: 'color', group: 'Colours', default: '#635bff',
      target: { nodeId: 'tpl_accent', componentType: 'Style', prop: 'fill' } },
    { id: 'background', label: 'Background', kind: 'color', group: 'Colours', default: '#0e0e1c',
      target: { nodeId: 'tpl_bg', componentType: 'Style', prop: 'fill' } },
  ],
};
