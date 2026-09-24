/**
 * The composition-settings conversions the timeline's fit / range commands
 * read (core/mirror/compFacts.ts), and a track's expression through the mirror
 * (memberExpressions.trackExpressionFacts) on the app engine.
 */

import { defaultAnimation } from '@motion/animation';
import { secondsToFlicks } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror, resetDocumentMirror } from '@stores/documentMirror';
import { settingsHasWorkArea, settingsSetWorkArea } from './compFacts';
import { trackExpressionFacts } from './memberExpressions';

const s10 = secondsToFlicks(10);

describe('settingsHasWorkArea', () => {
  it('reads the whole composition as "no work area"', () => {
    const settings = { duration: s10, workArea: { start: 0, duration: s10 } };
    expect(settingsHasWorkArea(settings)).toBe(false);
    expect(settingsSetWorkArea(settings)).toBeNull();
    expect(settingsHasWorkArea(undefined)).toBe(false);
  });

  it('reads any narrower range as set, in seconds', () => {
    const settings = { duration: s10, workArea: { start: secondsToFlicks(2), duration: secondsToFlicks(4) } };
    expect(settingsHasWorkArea(settings)).toBe(true);
    expect(settingsSetWorkArea(settings)).toEqual({ start: 2, end: 6 });
    // A range starting at 0 but shorter than the comp is set too.
    expect(settingsHasWorkArea({ duration: s10, workArea: { start: 0, duration: secondsToFlicks(3) } })).toBe(true);
  });
});

describe('trackExpressionFacts', () => {
  jest.useFakeTimers();
  let h: Harness & { engine: LocalEngine };
  let s: Scene;
  beforeEach(async () => {
    h = await setupAppEngine();
    s = await buildScene(h);
    resetDocumentMirror();
  });
  afterEach(async () => {
    await h.dispose();
    defaultAnimation.clear();
  });

  it('answers per member of an unseparated vector, and for a scalar', async () => {
    const m = documentMirror();
    m.tree(s.B);
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/position' }, source: 'wiggle(1, 5)', enabled: true, member: 1 });
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/opacity' }, source: 'value', enabled: false });
    await engineIdle();
    await m.whenIdle();
    m.tree(s.B);
    expect(trackExpressionFacts(m, s.B, 'x')).toBeNull();
    expect(trackExpressionFacts(m, s.B, 'y')).toMatchObject({ source: 'wiggle(1, 5)', enabled: true });
    expect(trackExpressionFacts(m, s.B, 'opacity')).toMatchObject({ source: 'value', enabled: false });
    expect(trackExpressionFacts(m, s.B, 'rotation')).toBeNull();
    expect(trackExpressionFacts(m, 'no-such-layer', 'x')).toBeNull();
  });

  it('carries the placeholder composition mark (CompSettings.pristine)', async () => {
    const m = documentMirror();
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { pristine: false } });
    await engineIdle();
    await m.whenIdle();
    expect(m.comp(s.comp)?.settings.pristine).toBeUndefined();
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { pristine: true } });
    await engineIdle();
    await m.whenIdle();
    expect(m.comp(s.comp)?.settings.pristine).toBe(true);
    // Any other settings change clears it.
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { name: 'Renamed' } });
    await engineIdle();
    await m.whenIdle();
    expect(m.comp(s.comp)?.settings.name).toBe('Renamed');
    expect(m.comp(s.comp)?.settings.pristine).toBeUndefined();
  });
});
