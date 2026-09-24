/**
 * Paint in the timeline: Effects ▸ Paint ▸ Brush N rows, their labels and
 * units, and the static values a stopwatch keys from / a value field writes.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildStaticPropertyTree, groupForProp } from '@core/timeline/propertyTree';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import {
  canWriteStaticPropertyValue,
  readStaticPropertyValue,
  writeStaticPropertyValue,
} from '@core/inspector/propertyValue';
import type { SceneNode } from '@core/types';
import { getNodePaint, normalizeStroke, type PaintStroke } from './paintStrokes';
import { paintColorPath, paintPathProp, paintPropPath, parsePaintPropPath } from './paintProps';
import { paintStrokePatch, readPaintStrokeValue } from './paintValues';

const ID = 'paint_tl_layer';

// Fixtures written straight into the document (the edits themselves are engine
// commands — src/core/engine/__tests__/paintStrokes.test.ts).
let seq = 0;
function addPaintStroke(nodeId: string, raw: Partial<PaintStroke> & { points: ReadonlyArray<{ x: number; y: number }> }): string {
  const id = `pstroke_${(seq += 1)}`;
  defaultSceneGraph.setPaint(nodeId, { strokes: [...(getNodePaint(nodeId)?.strokes ?? []), normalizeStroke(raw, id)] });
  return id;
}
function keyPath(nodeId: string, id: string, t: number): void {
  const s = getNodePaint(nodeId)!.strokes.find((x) => x.id === id)!;
  defaultAnimation.setDataKeyframe(nodeId, paintPathProp(id), 'points', t, s.points.map((p) => ({ x: p.x, y: p.y })));
}

beforeEach(() => {
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${ID}_fx`, type: 'fx', props: {} }],
  } as unknown as SceneNode);
});

describe('paint prop paths', () => {
  test('parse only the numeric keys', () => {
    expect(parsePaintPropPath('paint.s1.opacity')).toEqual({ strokeId: 's1', key: 'opacity' });
    expect(parsePaintPropPath('paint.s1.path')).toBeNull();
    expect(parsePaintPropPath('paint.s1.color_r')).toBeNull();
    expect(groupForProp('paint.s1.opacity')).toBe('effects');
  });
});

describe('rows', () => {
  test('a brush, an eraser and a clone, in AE order and naming', () => {
    const b = addPaintStroke(ID, { points: [{ x: 0, y: 0 }], mode: 'paint' });
    const e = addPaintStroke(ID, { points: [{ x: 0, y: 0 }], mode: 'erase' });
    const c = addPaintStroke(ID, { points: [{ x: 0, y: 0 }], mode: 'clone' });
    const rows = buildStaticPropertyTree(ID).filter((r) => r.prop.startsWith('paint.'));
    const labels = rows.map((r) => r.label);
    expect(labels.slice(0, 4)).toEqual(['Brush 1 Path', 'Brush 1 Start', 'Brush 1 End', 'Brush 1 Color']);
    expect(labels).toContain('Eraser 1 Flow');
    expect(labels).not.toContain('Eraser 1 Color');
    expect(labels).toContain('Clone 1 Clone Time Shift');
    expect(labels).toContain('Brush 1 Rotation');
    expect(rows.every((r) => r.group === 'effects')).toBe(true);
    expect(rows.find((r) => r.prop === paintColorPath(b))!.members).toHaveLength(4);
    expect(rows.some((r) => r.prop === paintPropPath(e, 'opacity'))).toBe(true);
    expect(rows.some((r) => r.prop === paintPropPath(c, 'clonePositionX'))).toBe(true);
  });

  test('Path has no stopwatch until its data track exists', () => {
    const id = addPaintStroke(ID, { points: [{ x: 0, y: 0 }] });
    const pathRow = (): { members: ReadonlyArray<string> } =>
      buildStaticPropertyTree(ID).find((r) => r.prop === paintPathProp(id))!;
    expect(pathRow().members).toEqual([]);
    keyPath(ID, id, 0);
    expect(pathRow().members).toEqual([paintPathProp(id)]);
  });

  test('labels and units come from the registry', () => {
    const id = addPaintStroke(ID, { points: [{ x: 0, y: 0 }] });
    expect(resolvePropertyMeta(paintPropPath(id, 'hardness'), ID)).toMatchObject({ label: 'Brush 1 Hardness', unit: '%', type: 'percent' });
    expect(resolvePropertyMeta(paintPropPath(id, 'diameter'), ID)).toMatchObject({ unit: 'px' });
    expect(resolvePropertyMeta(`${paintColorPath(id)}_g`, ID).label).toBe('Brush 1 Color G');
  });
});

describe('static values', () => {
  test('read in timeline units, write back through the model', () => {
    const id = addPaintStroke(ID, { points: [{ x: 4, y: 6 }], opacity: 0.6, size: 20, color: '#ff8000' });
    expect(readStaticPropertyValue(ID, paintPropPath(id, 'opacity'))).toBeCloseTo(60);
    expect(readStaticPropertyValue(ID, paintPropPath(id, 'end'))).toBe(100);
    expect(readStaticPropertyValue(ID, paintPropPath(id, 'spacing'))).toBe(25);
    expect(readStaticPropertyValue(ID, paintPropPath(id, 'positionX'))).toBe(4);
    expect(readStaticPropertyValue(ID, `${paintColorPath(id)}_g`)).toBeCloseTo(128 / 255);
    expect(canWriteStaticPropertyValue(ID, paintPropPath(id, 'flow'))).toBe(true);
    expect(canWriteStaticPropertyValue(ID, `${paintColorPath(id)}_r`)).toBe(false);

    expect(writeStaticPropertyValue(ID, paintPropPath(id, 'end'), 40)).toBe(true);
    expect(writeStaticPropertyValue(ID, paintPropPath(id, 'rotation'), 90)).toBe(true);
    const s = getNodePaint(ID)!.strokes[0]!;
    expect(s.end).toBeCloseTo(0.4);
    expect(s.transform).toEqual({ anchorX: 4, anchorY: 6, x: 4, y: 6, scale: 100, rotation: 90 });
  });

  test('every key round-trips through read/patch', () => {
    const base = { id: 'x', points: [{ x: 1, y: 2 }], color: '#fff', size: 10, opacity: 1, hardness: 1, mode: 'clone' as const };
    const keys = ['start', 'end', 'diameter', 'angle', 'hardness', 'roundness', 'spacing', 'opacity', 'flow',
      'clonePositionX', 'clonePositionY', 'cloneTime', 'cloneTimeShift', 'anchorX', 'anchorY', 'positionX', 'positionY', 'scale', 'rotation'] as const;
    for (const key of keys) {
      const next = { ...base, ...paintStrokePatch(base, key, 37) };
      expect([key, readPaintStrokeValue(next, key)]).toEqual([key, 37]);
    }
  });
});
