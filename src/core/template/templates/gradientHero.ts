/**
 * Gradient Hero (16:9) — a full-bleed gradient backdrop with an eyebrow, an
 * oversized two-line headline and a CTA pill. Exposed: three texts + accent.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import type { TemplateDefinition } from '../templateTypes';
import { addRoot, addShape, addText, addGradientShape, linearFill, radialFill, liveKf, type SetKf } from './builders';

const CW = 1920, CH = 1080, CX = CW / 2, CY = CH / 2;

export function layoutGradientHero(g: SceneGraph, rootId = 'tpl_root'): void {
  addRoot(g, rootId, 'Gradient Hero');
  addGradientShape(g, 'tpl_bg', rootId, CX, CY, CW, CH, linearFill(125, [[0, '#3b0764'], [0.5, '#1e1b4b'], [1, '#0b1020']]));
  addGradientShape(g, 'tpl_glow', rootId, CX + 380, CY - 220, 1200, 1000,
    radialFill(0.5, 0.5, 1, [[0, '#22d3ee33'], [1, '#22d3ee00']]));
  addText(g, 'tpl_eyebrow', rootId, 'INTRODUCING', CX, CY - 250, 34, 800, '#22d3ee');
  addText(g, 'tpl_head1', rootId, 'Build something', CX, CY - 110, 128, 800, '#ffffff');
  addText(g, 'tpl_head2', rootId, 'unforgettable', CX, CY + 40, 128, 800, '#c4b5fd');
  addShape(g, 'tpl_cta', rootId, CX, CY + 250, 340, 96, '#22d3ee');
  addText(g, 'tpl_ctaLabel', rootId, 'Get started', CX, CY + 250, 38, 700, '#06121a');
}

export function animateGradientHero(set: SetKf): void {
  set('tpl_glow', 'opacity', 0, 0, 'easeOut'); set('tpl_glow', 'opacity', 1.2, 100, 'easeOut');
  set('tpl_eyebrow', 'opacity', 0.1, 0, 'easeOut'); set('tpl_eyebrow', 'opacity', 0.6, 100, 'easeOut');
  set('tpl_eyebrow', 'y', 0.1, CY - 230, 'easeOut'); set('tpl_eyebrow', 'y', 0.6, CY - 250, 'easeOut');
  set('tpl_head1', 'opacity', 0.3, 0, 'easeOut'); set('tpl_head1', 'opacity', 0.9, 100, 'easeOut');
  set('tpl_head1', 'y', 0.3, CY - 70, 'easeOut'); set('tpl_head1', 'y', 0.9, CY - 110, 'easeOut');
  set('tpl_head2', 'opacity', 0.5, 0, 'easeOut'); set('tpl_head2', 'opacity', 1.1, 100, 'easeOut');
  set('tpl_head2', 'y', 0.5, CY + 80, 'easeOut'); set('tpl_head2', 'y', 1.1, CY + 40, 'easeOut');
  set('tpl_cta', 'opacity', 1, 0, 'easeOut'); set('tpl_cta', 'opacity', 1.4, 100, 'easeOut');
  set('tpl_cta', 'scaleX', 1, 0.7, 'easeOut'); set('tpl_cta', 'scaleX', 1.5, 1, 'easeOut');
  set('tpl_cta', 'scaleY', 1, 0.7, 'easeOut'); set('tpl_cta', 'scaleY', 1.5, 1, 'easeOut');
  set('tpl_ctaLabel', 'opacity', 1.2, 0, 'easeOut'); set('tpl_ctaLabel', 'opacity', 1.6, 100, 'easeOut');
}

export function buildGradientHero(): void {
  const rootId = activeCompRootId();
  defaultSceneGraph.clear();
  layoutGradientHero(defaultSceneGraph, rootId);
  animateGradientHero(liveKf);
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: 5, background: '#0b1020' });
  bumpScene();
}

export const gradientHeroTemplate: TemplateDefinition = {
  id: 'gradient-hero',
  name: 'Gradient Hero',
  aspect: '16:9',
  width: CW,
  height: CH,
  description: 'A full-bleed gradient hero with eyebrow, big two-line headline and CTA.',
  layout: layoutGradientHero,
  build: buildGradientHero,
  animate: animateGradientHero,
  previewTime: 1.7,
  fields: [
    { id: 'eyebrow', label: 'Eyebrow', kind: 'text', group: 'Text', default: 'INTRODUCING',
      target: { nodeId: 'tpl_eyebrow', componentType: 'Text', prop: 'content' } },
    { id: 'head1', label: 'Headline line 1', kind: 'text', group: 'Text', default: 'Build something',
      target: { nodeId: 'tpl_head1', componentType: 'Text', prop: 'content' } },
    { id: 'head2', label: 'Headline line 2', kind: 'text', group: 'Text', default: 'unforgettable',
      target: { nodeId: 'tpl_head2', componentType: 'Text', prop: 'content' } },
    { id: 'cta', label: 'Button label', kind: 'text', group: 'Text', default: 'Get started',
      target: { nodeId: 'tpl_ctaLabel', componentType: 'Text', prop: 'content' } },
    { id: 'accentColor', label: 'Accent colour', kind: 'color', group: 'Colours', default: '#22d3ee',
      target: { nodeId: 'tpl_cta', componentType: 'Style', prop: 'fill' } },
  ],
};
