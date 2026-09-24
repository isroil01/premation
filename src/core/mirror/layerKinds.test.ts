import type { LayerInfo, LayerKind } from '@motion/engine-api';
import { RIGGABLE_KINDS } from '@core/scene/rigLogo';
import { isRiggableLayer, uiKindOf } from './layerKinds';

const KINDS: LayerKind[] = [
  'null', 'solid', 'shape', 'rectangle', 'ellipse', 'polygon', 'path', 'text', 'image', 'sequence', 'video', 'audio',
  'svg', 'precomp', 'camera', 'light', 'group', 'component', 'particle', 'model3d', 'generator', 'adjustment',
];

test('isRiggableLayer is the twin of rigLogo.RIGGABLE_KINDS', () => {
  for (const kind of KINDS) {
    const layer = { kind, source: 'x' } as unknown as LayerInfo;
    expect(isRiggableLayer(layer)).toBe(RIGGABLE_KINDS.has(uiKindOf(layer)!));
  }
  expect(isRiggableLayer(undefined)).toBe(false);
  expect(isRiggableLayer({ kind: 'text' } as unknown as LayerInfo)).toBe(false);
  expect(isRiggableLayer({ kind: 'image' } as unknown as LayerInfo)).toBe(true);
});
