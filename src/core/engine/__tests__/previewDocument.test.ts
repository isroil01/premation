/**
 * The preview still queue and the preview document's shape. What the engine
 * DRAWS from such a document is pinned on the real binary
 * (previewDocumentNative.test.ts); here the engine is a stub that records what
 * it was asked, in what order, and how many at a time.
 */

import type { SceneNode } from '@core/types';

interface Asked { document: string; comp?: string; time: number; maxSize: number }
const asked: Asked[] = [];
let inFlight = 0;
let maxInFlight = 0;
let reply: (q: Asked) => { ok: true; value: { format: string; data: Uint8Array } } | { ok: false; error: { code: string; message: string } } =
  () => ({ ok: true, value: { format: 'png', data: new Uint8Array([1, 2, 3]) } });

jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({
    query: async (q: Asked & { type: string }) => {
      expect(q.type).toBe('renderDocumentStill');
      asked.push(q);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return reply(q);
    },
  }),
}));

import { secondsToFlicks } from '@motion/engine-api';
import { isTransparentColor, pendingPreviewStills, previewDocumentOf, previewStill } from '../previewDocument';
import { CURRENT_DOCUMENT_VERSION } from '@core/project/migrations';

const root: SceneNode = {
  id: 'r', name: 'Root', parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [],
} as unknown as SceneNode;
const doc = (id = 'r') => previewDocumentOf([{ ...root, id }], null, { rootId: id, width: 320, height: 180, background: '#101016' });

beforeEach(() => {
  asked.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  reply = () => ({ ok: true, value: { format: 'png', data: new Uint8Array([1, 2, 3]) } });
});

describe('previewDocumentOf', () => {
  it('writes the current document version, one composition keyed by its root, and no timelines or project items', () => {
    const d = doc();
    const json = JSON.parse(d.json) as Record<string, unknown> & { comps: Record<string, Record<string, unknown>> };
    expect(json.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(Object.keys(json.comps)).toEqual(['r']);
    expect(json.comps.r).toMatchObject({ id: 'r', width: 320, height: 180, fps: 30, background: '#101016', transparent: false, startFrame: 0 });
    expect(json.animation).toEqual({ tracks: {}, expressions: {}, data: {} });
    expect(json.timelines).toBeUndefined();
    expect(json.projectItems).toBeUndefined();
    expect(json.motionBlur).toMatchObject({ enabled: false });
    expect([d.compId, d.width, d.height]).toEqual(['r', 320, 180]);
  });

  it('a background that draws nothing is a transparent composition', () => {
    for (const css of [undefined, 'transparent', 'rgba(0,0,0,0)', 'rgba(20, 20, 25, 0)', 'hsla(0, 0%, 0%, 0)', '#00000000', '#0000']) {
      expect(isTransparentColor(css)).toBe(true);
    }
    for (const css of ['#101016', '#fff', 'rgba(0,0,0,0.5)', 'rgb(0, 0, 0)', 'black', '#000000ff']) {
      expect(isTransparentColor(css)).toBe(false);
    }
    const json = JSON.parse(previewDocumentOf([root], null, { rootId: 'r', width: 10, height: 10, background: 'rgba(0,0,0,0)' }).json) as { comps: Record<string, { transparent: boolean }> };
    expect(json.comps.r!.transparent).toBe(true);
  });
});

describe('previewStill', () => {
  it('asks the engine for the document\'s composition at the time, as a PNG blob', async () => {
    const d = doc();
    const blob = await previewStill(d, 1.5, 320);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe('image/png');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ document: d.json, comp: 'r', time: secondsToFlicks(1.5), maxSize: 320 });
  });

  it('clamps the time and the size to what the engine takes', async () => {
    await previewStill(doc(), -3, 99999);
    await previewStill(doc(), 0, 0.2);
    expect(asked.map((a) => [a.time, a.maxSize])).toEqual([[0, 4096], [0, 1]]);
  });

  it('one still at a time, posters ahead of flipbook frames', async () => {
    const order: string[] = [];
    const ask = (name: string, priority: 'poster' | 'frame') =>
      previewStill(doc(name), 0, 64, { priority }).then(() => { order.push(name); });
    // The first is already running when the rest queue up.
    const all = [ask('frame1', 'frame'), ask('frame2', 'frame'), ask('posterA', 'poster'), ask('frame3', 'frame'), ask('posterB', 'poster')];
    expect(pendingPreviewStills()).toBe(4);
    await Promise.all(all);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['frame1', 'posterA', 'posterB', 'frame2', 'frame3']);
    expect(pendingPreviewStills()).toBe(0);
  });

  it('a still nobody wants any more is dropped unasked', async () => {
    let wanted = true;
    const first = previewStill(doc('a'), 0, 64);
    const dropped = previewStill(doc('b'), 0, 64, { wanted: () => wanted });
    wanted = false;
    expect(await dropped).toBeNull();
    await first;
    expect(asked.map((a) => a.comp)).toEqual(['a']);
  });

  it('answers null when the engine cannot draw it, and keeps serving the queue', async () => {
    reply = (q) => (q.comp === 'bad'
      ? { ok: false, error: { code: 'unsupported', message: 'no renderer' } }
      : { ok: true, value: { format: 'png', data: new Uint8Array([1]) } });
    const bad = previewStill(doc('bad'), 0, 64);
    const good = previewStill(doc('good'), 0, 64);
    expect(await bad).toBeNull();
    expect(await good).toBeInstanceOf(Blob);
  });

  it('an empty picture is no picture', async () => {
    reply = () => ({ ok: true, value: { format: 'png', data: new Uint8Array(0) } });
    expect(await previewStill(doc(), 0, 64)).toBeNull();
  });
});
