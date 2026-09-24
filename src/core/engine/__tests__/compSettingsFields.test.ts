/**
 * setCompositionSettings' JSON fields — Responsive Time, the template's
 * authored fields and the background paint — are STORED where the editor
 * reads them (the root's meta component; the comp record), read back through
 * CompSettings, cleared by '', validated, and undone exactly. They used to be
 * accepted and dropped (the command answered ok and changed nothing).
 */

import { setupEngine, type Harness } from '../__testHelpers__/harness';
import { useProjectStore } from '@stores/projectStore';
import { readResponsiveTime } from '@core/template/responsiveTimeStore';
import { readAuthoredFields } from '@core/template/templateAuthoring';

jest.useFakeTimers();

let h: Harness;
let comp: string;
beforeEach(async () => {
  h = await setupEngine();
  ({ item: comp } = await h.run({ type: 'createComposition', settings: { name: 'Tpl' }, fromItems: [] }));
});
afterEach(async () => { await h.dispose(); });

const RT = { authoredDurationSec: 6, protectedRegions: [{ start: 0, end: 1.5 }] };
const FIELDS = [{ id: 'title', label: 'Title', kind: 'text', group: '', default: 'Hi', target: { nodeId: 'x', prop: 'text' } }];
const PAINT = { type: 'linear', angle: 90, stops: [{ id: 's0', offset: 0, color: '#ff0000' }, { id: 's1', offset: 1, color: '#0000ff' }] };

test('the three fields are stored, read back, cleared and undone', async () => {
  const before = h.doc();
  await h.run({ type: 'setCompositionSettings', comp, patch: { responsiveTime: JSON.stringify(RT), templateFields: JSON.stringify(FIELDS), backgroundPaint: JSON.stringify(PAINT) } });
  expect(readResponsiveTime(comp)).toEqual(RT);
  expect(readAuthoredFields(comp)).toEqual(FIELDS);
  expect(useProjectStore.getState().comps[comp]?.backgroundPaint).toEqual(PAINT);
  const info = await h.query({ type: 'getComposition', comp });
  expect(JSON.parse(info.comp.settings.responsiveTime!)).toEqual(RT);
  expect(JSON.parse(info.comp.settings.templateFields!)).toEqual(FIELDS);
  expect(JSON.parse(info.comp.settings.backgroundPaint!)).toEqual(PAINT);

  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  expect(readResponsiveTime(comp)).toBeUndefined();
  await h.run({ type: 'redo' });
  expect(readAuthoredFields(comp)).toEqual(FIELDS);

  await h.run({ type: 'setCompositionSettings', comp, patch: { responsiveTime: '', templateFields: '', backgroundPaint: '' } });
  expect(readResponsiveTime(comp)).toBeUndefined();
  expect(readAuthoredFields(comp)).toEqual([]);
  expect(useProjectStore.getState().comps[comp]?.backgroundPaint).toBeUndefined();
  const cleared = (await h.query({ type: 'getComposition', comp })).comp.settings;
  expect(cleared.responsiveTime).toBeUndefined();
  expect(cleared.templateFields).toBeUndefined();
  expect(cleared.backgroundPaint).toBeUndefined();
});

test('malformed values are refused and change nothing', async () => {
  const before = h.doc();
  for (const patch of [
    { responsiveTime: '{nope' },
    { responsiveTime: JSON.stringify({ protectedRegions: [] }) },
    { templateFields: JSON.stringify({ not: 'an array' }) },
    { backgroundPaint: JSON.stringify({ type: 'conic' }) },
    { backgroundPaint: JSON.stringify({ type: 'linear' }) },
  ]) {
    const r = await h.engine.execute({ type: 'setCompositionSettings', comp, patch });
    expect(!r.ok && r.error.code).toBe('invalidArgument');
  }
  expect(h.doc()).toBe(before);
});
