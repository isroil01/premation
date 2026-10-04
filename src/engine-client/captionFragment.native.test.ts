/**
 * Captions as an engine client (core/captions/captionFragment.ts): the cues
 * laid into a fragment the ENGINE takes — one text layer per cue with a span,
 * each on its own bar — including overlapping cues, multi-line wraps and a cue
 * past the composition's end.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildCaptionFragment } from '@core/captions/captionFragment';
import { useCompositionStore } from '@stores/compositionStore';

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

it('pastes one caption layer per cue with a span, each on the cue\'s bar', async () => {
  const c = useCompositionStore.getState().comp();
  const target = { rootId: 'comp_root', width: c.width, height: c.height };
  const mine = buildCaptionFragment(CUES, target, c.fps);
  const r = await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: mine.built!.fragment } as Command);
  expect(r.ok ? 'ok' : r.error.message).toBe('ok');
  const ids = r.ok ? ((r.value as { layers?: string[] }).layers ?? []) : [];
  // The empty span builds nothing.
  expect(mine.skipped).toBe(1);
  expect(ids).toHaveLength(3);
  const v = await docView();
  // Front-most first: the last cue on top. A long caption keeps its first wrapped line as the name.
  expect(ids.map((id) => v.getNode(id)?.name)).toEqual(['Past the end of the comp', 'A much longer caption that has to wrap', 'Hello there']);
  // Frames at 30 fps: a cue the next one overlaps ends where it starts (1.9 s, not 2.0 s);
  // a cue past the comp's end keeps its own span.
  expect(ids.map((id) => v.getLayersForNode(id).map((b) => [b.clip.start, b.clip.duration]))).toEqual([
    [[240, 135]],
    [[57, 71]],
    [[15, 42]],
  ]);
  await h.run({ type: 'undo' });
  expect((await docView()).layerIdsOfComp('comp_root')).toEqual([]);
});
