/**
 * Lower Third (16:9) — a name + role strip that slides in from the left, the
 * classic broadcast caption. Exposed: two texts + two colours.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addShape, addText, addGradientShape, linearFill, liveKf, type SetKf } from './builders';

const CW = 1920, CH = 1080;
const BAR_X = 540, BAR_Y = CH - 210;

export function layoutLowerThird(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Lower Third');
  addShape(g, 'tpl_bg', rootId, CW / 2, CH / 2, CW, CH, '#0b1020');
  addGradientShape(g, 'tpl_sheen', rootId, BAR_X, BAR_Y, 820, 168,
    linearFill(0, [[0, '#ffffff14'], [1, '#ffffff00']]));
  addShape(g, 'tpl_bar', rootId, BAR_X, BAR_Y, 780, 156, '#635bff');
  addShape(g, 'tpl_tick', rootId, 150, BAR_Y, 12, 156, '#22d3ee');
  addText(g, 'tpl_name', rootId, 'Jane Doe', BAR_X, BAR_Y - 28, 58, 800, '#ffffff', 'center');
  addText(g, 'tpl_role', rootId, 'Product Designer', BAR_X, BAR_Y + 42, 30, 500, '#c7d2fe', 'center');
}

export function animateLowerThird(set: SetKf): void {
  set('tpl_bar', 'x', 0.1, BAR_X - 960, 'easeOut'); set('tpl_bar', 'x', 0.8, BAR_X, 'easeOut');
  set('tpl_bar', 'opacity', 0.1, 0, 'easeOut'); set('tpl_bar', 'opacity', 0.5, 100, 'easeOut');
  set('tpl_sheen', 'x', 0.1, BAR_X - 960, 'easeOut'); set('tpl_sheen', 'x', 0.8, BAR_X, 'easeOut');
  set('tpl_sheen', 'opacity', 0.1, 0, 'easeOut'); set('tpl_sheen', 'opacity', 0.6, 100, 'easeOut');
  set('tpl_tick', 'opacity', 0.2, 0, 'easeOut'); set('tpl_tick', 'opacity', 0.7, 100, 'easeOut');
  set('tpl_tick', 'scaleY', 0.2, 0, 'easeOut'); set('tpl_tick', 'scaleY', 0.7, 1, 'easeOut');
  set('tpl_name', 'opacity', 0.5, 0, 'easeOut'); set('tpl_name', 'opacity', 1, 100, 'easeOut');
  set('tpl_name', 'x', 0.5, BAR_X - 26, 'easeOut'); set('tpl_name', 'x', 1, BAR_X, 'easeOut');
  set('tpl_role', 'opacity', 0.7, 0, 'easeOut'); set('tpl_role', 'opacity', 1.2, 100, 'easeOut');
}

export function buildLowerThird(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutLowerThird(defaultSceneGraph, rootId);
  animateLowerThird(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#0b1020' });
  bumpScene();
}

export const lowerThirdTemplate: TemplateDefinition = {
  id: 'lower-third',
  name: 'Lower Third',
  aspect: '16:9',
  width: CW,
  height: CH,
  description: 'A broadcast name-and-role caption that slides in from the left.',
  layout: layoutLowerThird,
  build: buildLowerThird,
  animate: animateLowerThird,
  previewTime: 1.3,
  fields: [
    { id: 'name', label: 'Name', kind: 'text', group: 'Text', default: 'Jane Doe',
      target: { nodeId: 'tpl_name', componentType: 'Text', prop: 'content' } },
    { id: 'role', label: 'Role', kind: 'text', group: 'Text', default: 'Product Designer',
      target: { nodeId: 'tpl_role', componentType: 'Text', prop: 'content' } },
    { id: 'barColor', label: 'Bar colour', kind: 'color', group: 'Colours', default: '#635bff',
      target: { nodeId: 'tpl_bar', componentType: 'Style', prop: 'fill' } },
    { id: 'accentColor', label: 'Accent tick', kind: 'color', group: 'Colours', default: '#22d3ee',
      target: { nodeId: 'tpl_tick', componentType: 'Style', prop: 'fill' } },
  ],
};
