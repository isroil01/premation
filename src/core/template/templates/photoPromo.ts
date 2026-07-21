/**
 * Photo Promo (16:9) — a swappable product/photo on the left in an accent frame,
 * with a headline + subhead + price on the right. Shows the image-swap field
 * kind. The image starts empty (a placeholder box) until the user picks one.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addShape, addText, addImage, addGradientShape, linearFill, liveKf, type SetKf } from './builders';

const CW = 1920, CH = 1080, CY = CH / 2;
const PHOTO_X = 620, PHOTO = 740;
const TEXT_X = 1180;

export function layoutPhotoPromo(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Photo Promo');
  addGradientShape(g, 'tpl_bg', rootId, CW / 2, CY, CW, CH,
    linearFill(120, [[0, '#141a2e'], [1, '#0b1020']]));
  addShape(g, 'tpl_frame', rootId, PHOTO_X, CY, PHOTO + 34, PHOTO + 34, '#635bff');
  addImage(g, 'tpl_photo', rootId, PHOTO_X, CY, PHOTO, PHOTO, '');
  addText(g, 'tpl_headline', rootId, 'New Arrival', TEXT_X + 260, CY - 78, 92, 800, '#ffffff', 'left');
  addText(g, 'tpl_sub', rootId, 'Describe your product in a line.', TEXT_X + 260, CY + 34, 30, 400, '#9aa3c0', 'left');
  addText(g, 'tpl_price', rootId, '$49', TEXT_X + 260, CY + 150, 64, 800, '#635bff', 'left');
}

export function animatePhotoPromo(set: SetKf): void {
  set('tpl_frame', 'scaleX', 0.1, 0.9, 'easeOut'); set('tpl_frame', 'scaleX', 0.7, 1, 'easeOut');
  set('tpl_frame', 'scaleY', 0.1, 0.9, 'easeOut'); set('tpl_frame', 'scaleY', 0.7, 1, 'easeOut');
  set('tpl_frame', 'opacity', 0.1, 0, 'easeOut'); set('tpl_frame', 'opacity', 0.6, 100, 'easeOut');
  set('tpl_photo', 'scaleX', 0.2, 0.9, 'easeOut'); set('tpl_photo', 'scaleX', 0.8, 1, 'easeOut');
  set('tpl_photo', 'scaleY', 0.2, 0.9, 'easeOut'); set('tpl_photo', 'scaleY', 0.8, 1, 'easeOut');
  set('tpl_photo', 'opacity', 0.2, 0, 'easeOut'); set('tpl_photo', 'opacity', 0.8, 100, 'easeOut');
  set('tpl_headline', 'x', 0.5, TEXT_X + 200, 'easeOut'); set('tpl_headline', 'x', 1.1, TEXT_X + 260, 'easeOut');
  set('tpl_headline', 'opacity', 0.5, 0, 'easeOut'); set('tpl_headline', 'opacity', 1.1, 100, 'easeOut');
  set('tpl_sub', 'opacity', 0.8, 0, 'easeOut'); set('tpl_sub', 'opacity', 1.4, 100, 'easeOut');
  set('tpl_price', 'opacity', 1.1, 0, 'easeOut'); set('tpl_price', 'opacity', 1.7, 100, 'easeOut');
}

export function buildPhotoPromo(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutPhotoPromo(defaultSceneGraph, rootId);
  animatePhotoPromo(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#0b1020' });
  bumpScene();
}

export const photoPromoTemplate: TemplateDefinition = {
  id: 'photo-promo',
  name: 'Photo Promo',
  aspect: '16:9',
  width: CW,
  height: CH,
  description: 'A swappable photo in an accent frame with headline, subhead and price.',
  layout: layoutPhotoPromo,
  build: buildPhotoPromo,
  animate: animatePhotoPromo,
  previewTime: 1.7,
  fields: [
    { id: 'photo', label: 'Photo', kind: 'image', group: 'Media', default: '',
      target: { nodeId: 'tpl_photo', componentType: 'Transform', prop: 'src' } },
    { id: 'headline', label: 'Headline', kind: 'text', group: 'Text', default: 'New Arrival',
      target: { nodeId: 'tpl_headline', componentType: 'Text', prop: 'content' } },
    { id: 'subhead', label: 'Subhead', kind: 'text', group: 'Text', default: 'Describe your product in a line.',
      target: { nodeId: 'tpl_sub', componentType: 'Text', prop: 'content' } },
    { id: 'price', label: 'Price', kind: 'text', group: 'Text', default: '$49',
      target: { nodeId: 'tpl_price', componentType: 'Text', prop: 'content' } },
    { id: 'accentColor', label: 'Frame colour', kind: 'color', group: 'Colours', default: '#635bff',
      target: { nodeId: 'tpl_frame', componentType: 'Style', prop: 'fill' } },
  ],
};
