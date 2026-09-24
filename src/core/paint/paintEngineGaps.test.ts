/**
 * B3 — why the Paint sites (PaintPanel, the Layer panel / comp viewer stroke
 * commit, Tool Options ▸ Undo last stroke) still use the legacy writers.
 *
 * Each `// B3-gap:` comment at those sites names one of the engine answers
 * pinned here. When one of these expectations starts failing, the engine has
 * grown the missing piece: migrate the matching site onto the API and update
 * this file.
 */

import type { BezierPath, Command } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { catalogFor } from '@core/engine/props';
import { addPaintStroke, getNodePaint } from './paintStrokes';

let h: Harness & { engine: LocalEngine };
let L: string;
let SID: string;

beforeEach(async () => {
  h = await setupAppEngine();
  L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as Command) as { layer: string }).layer;
  SID = addPaintStroke(L, { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], mode: 'paint' });
});
afterEach(async () => {
  await h.dispose();
});

async function errorCode(cmd: Command): Promise<string | null> {
  const r = await h.engine.execute(cmd);
  return r.ok ? null : r.error.code;
}

const PATH: BezierPath = { closed: false, vertices: [1, 1, 9, 2], inTangents: [0, 0, 0, 0], outTangents: [0, 0, 0, 0], featherPoints: [] };

describe('paint strokes through the engine API (B3 gaps)', () => {
  it('a new stroke has no command: addPropertyGroup answers unsupported', async () => {
    expect(await errorCode({ type: 'addPropertyGroup', layer: L, parent: 'paint', matchName: 'ADBE Paint Stroke', init: [] } as Command)).toBe('unsupported');
  });

  it('a stroke is not an addressable group: remove / enable answer notFound', async () => {
    const group = { layer: L, path: `paint/${SID}` };
    expect(await errorCode({ type: 'removePropertyGroups', groups: [group] } as Command)).toBe('notFound');
    expect(await errorCode({ type: 'setGroupEnabled', groups: [group], enabled: false } as Command)).toBe('notFound');
    expect(getNodePaint(L)?.strokes.map((s) => s.id)).toEqual([SID]);
  });

  it('a static Path has no value: setProperty paint/<id>/path answers unsupported', async () => {
    expect(await errorCode({ type: 'setProperty', prop: { layer: L, path: `paint/${SID}/path` }, value: { kind: 'path', value: PATH } } as Command)).toBe('unsupported');
  });

  it('visibility and Paint on Transparent have no property', () => {
    const paths = catalogFor(L).props.map((b) => b.path);
    expect(paths).toContain(`paint/${SID}/path`);
    expect(paths).not.toContain(`paint/${SID}/visible`);
    expect(paths.some((p) => p.startsWith('paint/onTransparent'))).toBe(false);
  });

  it('what the API DOES address: a numeric stroke param, one entry, exact undo', async () => {
    const before = h.doc();
    await h.batch('Set End', [{ type: 'setProperty', prop: { layer: L, path: `paint/${SID}/end` }, value: { kind: 'scalar', value: 50 } } as Command]);
    expect(getNodePaint(L)?.strokes[0]?.end).toBeCloseTo(0.5);
    expect(historyLabels().at(-1)).toBe('Set End');
    await h.run({ type: 'undo' } as Command);
    expect(h.doc()).toBe(before);
  });
});
