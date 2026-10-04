/**
 * Text on a path is POINT text: an authored box width neither wraps nor sizes
 * it, and its selection extent is where the glyphs ride the curve.
 */

import type { SceneNode } from '@core/types';
import { readMeasuredTextStyle } from './measureText';
import { layoutText } from './textLayout';
import { applyTextPath, pathGlyphBounds } from './textPath';
import { arcTable } from '@core/scene/trimPath';

const ARC = {
  id: 'arc', mode: 'none', closed: false, feather: 0, opacity: 1, expansion: 0, inverted: false,
  points: [
    { x: -100, y: 0, inX: -100, inY: 0, outX: -100, outY: 0 },
    { x: 100, y: 0, inX: 100, inY: 0, outX: 100, outY: 0 },
  ],
};

function textNode(textProps: Record<string, unknown>, onPath: boolean): SceneNode {
  return {
    id: 't', name: 't', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 't_tr', type: 'Transform', props: { __kind: 'text', x: 200, y: 100, rotation: 0, scaleX: 1, scaleY: 1 } },
      { id: 't_t', type: 'Text', props: { content: 'along the path we go', fontSize: 20, fontFamily: 'Arial', lineHeight: 1.2, ...textProps } },
      ...(onPath
        ? [{ id: 't_fx', type: 'fx', props: { mask: { paths: [ARC] }, textPath: { pathId: 'arc', firstMargin: 0, reversed: false, perpendicular: true } } }]
        : []),
    ],
  } as unknown as SceneNode;
}

describe('text on a path is point text', () => {
  it('a box width does not reach the measured style (no wrap, no paragraph box)', () => {
    const style = readMeasuredTextStyle(textNode({ boxWidth: 60, boxHeight: 40 }, true))!;
    expect(style.boxWidth).toBeUndefined();
    expect(style.softBreakLines).toBeUndefined();
    expect(style.content).toBe('along the path we go');
  });

  it('path text without a box measures exactly as it always did; a box off the path still wraps', () => {
    expect(readMeasuredTextStyle(textNode({ boxWidth: 60 }, true))).toEqual(readMeasuredTextStyle(textNode({}, true)));
    expect(readMeasuredTextStyle(textNode({ boxWidth: 60 }, false))!.boxWidth).toBe(60);
  });

  it('pathGlyphBounds skips blanks and holds for turned glyphs', () => {
    const measure = (): number => 10;
    const laid = layoutText('a b', { fontSize: 20 }, measure, { boxWidth: 0 });
    const table = arcTable([{ x: 0, y: 0 }, { x: 0, y: 100 }], false);
    const placed = applyTextPath(laid, { table, firstMargin: 0, reversed: false, perpendicular: true });
    const b = pathGlyphBounds(placed)!;
    const r = Math.hypot(10, 20) / 2;
    // Two inked glyphs at arc 5 and 25 down a vertical path.
    expect(b.minY).toBeCloseTo(5 - r, 6);
    expect(b.maxY).toBeCloseTo(25 + r, 6);
    expect(pathGlyphBounds(applyTextPath(layoutText('  ', { fontSize: 20 }, measure, { boxWidth: 0 }), { table, firstMargin: 0, reversed: false, perpendicular: true }))).toBeNull();
  });
});
