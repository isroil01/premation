/**
 * Reel Intro (9:16) — a vertical social intro: kicker pill + big stacked
 * headline + handle, over a coloured backdrop with an accent glow. Exposed:
 * four texts + two colours.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addShape, addText, addGradientShape, radialFill, liveKf, type SetKf } from './builders';

const CW = 1080, CH = 1920, CX = CW / 2, CY = CH / 2;

export function layoutReelIntro(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Reel Intro');
  addShape(g, 'tpl_bg', rootId, CX, CY, CW, CH, '#111827');
  addGradientShape(g, 'tpl_glow', rootId, CX, CY + 40, 1200, 1200,
    radialFill(0.5, 0.5, 1, [[0, '#f472b644'], [0.6, '#f472b61a'], [1, '#f472b600']]));
  addShape(g, 'tpl_pill', rootId, CX, CY - 220, 300, 76, '#f472b6');
  addText(g, 'tpl_kicker', rootId, 'NEW DROP', CX, CY - 220, 34, 800, '#111827');
  addText(g, 'tpl_line1', rootId, 'BIG', CX, CY - 40, 210, 900, '#ffffff');
  addText(g, 'tpl_line2', rootId, 'NEWS', CX, CY + 150, 210, 900, '#f472b6');
  addText(g, 'tpl_handle', rootId, '@yourhandle', CX, CY + 430, 40, 500, '#9ca3af');
}

export function animateReelIntro(set: SetKf): void {
  set('tpl_glow', 'opacity', 0, 0, 'easeOut'); set('tpl_glow', 'opacity', 1, 100, 'easeOut');
  set('tpl_pill', 'scaleX', 0.1, 0, 'easeOut'); set('tpl_pill', 'scaleX', 0.7, 1, 'easeOut');
  set('tpl_kicker', 'opacity', 0.3, 0, 'easeOut'); set('tpl_kicker', 'opacity', 0.8, 100, 'easeOut');
  set('tpl_line1', 'y', 0.4, CY + 20, 'easeOut'); set('tpl_line1', 'y', 1, CY - 40, 'easeOut');
  set('tpl_line1', 'opacity', 0.4, 0, 'easeOut'); set('tpl_line1', 'opacity', 1, 100, 'easeOut');
  set('tpl_line2', 'y', 0.7, CY + 210, 'easeOut'); set('tpl_line2', 'y', 1.3, CY + 150, 'easeOut');
  set('tpl_line2', 'opacity', 0.7, 0, 'easeOut'); set('tpl_line2', 'opacity', 1.3, 100, 'easeOut');
  set('tpl_handle', 'opacity', 1.4, 0, 'easeOut'); set('tpl_handle', 'opacity', 2, 100, 'easeOut');
}

export function buildReelIntro(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutReelIntro(defaultSceneGraph, rootId);
  animateReelIntro(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#111827' });
  bumpScene();
}

export const reelIntroTemplate: TemplateDefinition = {
  id: 'reel-intro',
  name: 'Reel Intro',
  aspect: '9:16',
  width: CW,
  height: CH,
  description: 'A vertical social intro with a kicker pill and a bold two-line headline.',
  layout: layoutReelIntro,
  build: buildReelIntro,
  animate: animateReelIntro,
  previewTime: 1.8,
  fields: [
    { id: 'kicker', label: 'Kicker', kind: 'text', group: 'Text', default: 'NEW DROP',
      target: { nodeId: 'tpl_kicker', componentType: 'Text', prop: 'content' } },
    { id: 'line1', label: 'Headline line 1', kind: 'text', group: 'Text', default: 'BIG',
      target: { nodeId: 'tpl_line1', componentType: 'Text', prop: 'content' } },
    { id: 'line2', label: 'Headline line 2', kind: 'text', group: 'Text', default: 'NEWS',
      target: { nodeId: 'tpl_line2', componentType: 'Text', prop: 'content' } },
    { id: 'handle', label: 'Handle', kind: 'text', group: 'Text', default: '@yourhandle',
      target: { nodeId: 'tpl_handle', componentType: 'Text', prop: 'content' } },
    { id: 'accentColor', label: 'Accent colour', kind: 'color', group: 'Colours', default: '#f472b6',
      target: { nodeId: 'tpl_pill', componentType: 'Style', prop: 'fill' } },
    { id: 'background', label: 'Background', kind: 'color', group: 'Colours', default: '#111827',
      target: { nodeId: 'tpl_bg', componentType: 'Style', prop: 'fill' } },
  ],
};
