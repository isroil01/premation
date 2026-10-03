/**
 * Captions as an engine client (core/captions/captionFragment.ts) build the
 * SAME layers and bars as `buildCaptionLayers` run off-document over the page
 * replica — including overlapping cues, multi-line wraps and a cue past the
 * composition's end.
 */

import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildCaptionLayers } from '@core/captions/captionLayers';
import { buildCaptionFragment } from '@core/captions/captionFragment';
import { useCompositionStore } from '@stores/compositionStore';
import { normalizeFragment } from './__testHelpers__/fragmentParity';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

const CUES = [
  { start: 0.5, end: 2.0, text: 'Hello there' },
  { start: 1.9, end: 4.25, text: 'A much longer caption that has to wrap onto a second line because it is long' },
  { start: 4.3, end: 4.3, text: 'empty span' },
  { start: 8.0, end: 12.5, text: 'Past the end of the comp' },
];

it('builds the same caption layers and bars as the off-document build', async () => {
  const c = useCompositionStore.getState().comp();
  const frames = Math.round(c.durationSeconds * c.fps);
  const target = { rootId: 'comp_root', width: c.width, height: c.height };
  let legacySkipped = 0;
  const legacy = buildLayerFragment('comp_root', () => { legacySkipped = buildCaptionLayers(CUES, undefined, target).skipped; });
  const mine = buildCaptionFragment(CUES, target, c.fps);
  expect(mine.skipped).toBe(legacySkipped);
  expect(normalizeFragment(mine.built!.fragment, frames)).toEqual(normalizeFragment(legacy!.fragment, frames));
});
