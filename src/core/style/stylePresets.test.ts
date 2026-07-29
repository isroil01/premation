import { STYLE_PRESETS, applyStylePreset, stylePreset } from './stylePresets';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeFills } from '@core/paint/fill';
import { getNodeStrokes } from '@core/paint/stroke';
import { getNodeLayerStyles } from '@core/effects/layerStyles';
import { getNodeBlend } from '@core/effects/blendMode';
import type { SceneNode } from '@core/types';

function addShape(id: string, fill = '#2b7eff'): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    ],
  } as unknown as SceneNode);
}

describe('style presets', () => {
  it('every preset produces at least one paint or stroke', () => {
    for (const p of STYLE_PRESETS) {
      const fills = p.fills('#2b7eff');
      const strokes = p.strokes?.('#2b7eff') ?? [];
      expect(fills.length + strokes.length).toBeGreaterThan(0);
    }
  });

  it('applies fills, strokes and layer styles to the node', () => {
    addShape('sp_glass');
    expect(applyStylePreset('sp_glass', 'glass')).toBe(true);
    expect(getNodeFills('sp_glass').length).toBe(2);          // base + rim ramp
    expect(getNodeStrokes('sp_glass').length).toBe(1);
    expect(getNodeLayerStyles('sp_glass').dropShadow?.enabled).toBe(true);
  });

  it('Sticker builds the double keyline as a real multi-stroke stack', () => {
    addShape('sp_sticker');
    applyStylePreset('sp_sticker', 'sticker');
    const strokes = getNodeStrokes('sp_sticker');
    expect(strokes.length).toBe(2);
    // Outer dark edge is wider than the white keyline drawn over it.
    expect(strokes[0]!.width).toBeGreaterThan(strokes[1]!.width);
  });

  // Regression: a preset must state a COMPLETE look. Applying Neon (blend
  // 'screen') and then another preset used to leave that blend behind, because
  // blend was only written when the incoming preset declared one.
  it('resets every axis, so a previous preset cannot bleed through', () => {
    addShape('sp_bleed');
    applyStylePreset('sp_bleed', 'neon');
    expect(getNodeBlend('sp_bleed')).toBe('screen');
    expect(getNodeStrokes('sp_bleed').length).toBe(1);

    applyStylePreset('sp_bleed', 'gradient-text');
    expect(getNodeBlend('sp_bleed')).toBe('normal');
    expect(getNodeStrokes('sp_bleed').length).toBe(0);
    expect(getNodeLayerStyles('sp_bleed').outerGlow).toBeUndefined();
  });

  it('uses the layer own fill as the accent so a look keeps the chosen colour', () => {
    addShape('sp_accent', '#ff0055');
    applyStylePreset('sp_accent', 'gradient-card');
    const fills = getNodeFills('sp_accent');
    expect(fills[0]!.type).toBe('linear');
    const serialized = JSON.stringify(fills[0]);
    expect(serialized.toLowerCase()).toContain('#ff0055');
  });

  it('unknown preset id is a no-op, not a throw', () => {
    addShape('sp_unknown');
    expect(applyStylePreset('sp_unknown', 'does-not-exist')).toBe(false);
  });

  it('stylePreset() looks presets up by id', () => {
    expect(stylePreset('neon')?.label).toBe('Neon');
    expect(stylePreset('nope')).toBeUndefined();
  });
});
