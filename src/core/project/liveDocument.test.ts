/**
 * F2 — callers of the live document go to its OWNER: the page's capture /
 * restore with the flag off (unchanged), engine requests with the engine as
 * owner (exportDocument, restoreDocument as one entry, saveProject).
 */

import type { Command, EngineClient, Query } from '@motion/engine-api';

type Request = Command | Query;
import { liveDocument, replaceLiveDocument, saveLiveDocument, setLiveDocumentSource, LiveDocumentError } from './liveDocument';

const mockCaptured = { version: '1.1.0', scene: { version: '1.0.0', nodes: [] }, animation: { tracks: {}, expressions: {} }, from: 'page' };
const mockRestored: unknown[] = [];

jest.mock('@core/api/cloudDocument', () => ({
  captureDocument: () => mockCaptured,
  restoreDocument: (d: unknown) => { mockRestored.push(d); },
}));
jest.mock('@core/engine/engineInstance', () => ({ engine: () => { throw new Error('the app engine is not used in this test'); } }));

const ownerDoc = { version: '1.8.0', scene: { version: '1.0.0', nodes: [] }, animation: { tracks: {}, expressions: {} }, from: 'engine' };

function fakeEngine(refuse = false): { client: EngineClient; sent: Request[] } {
  const sent: Request[] = [];
  const answer = async (r: Request): Promise<unknown> => {
    sent.push(r);
    if (refuse) return { ok: false, revision: 0, error: { code: 'io', message: 'disk full' } };
    if (r.type === 'exportDocument') return { ok: true, revision: 3, value: { type: 'exportDocument', document: new TextEncoder().encode(JSON.stringify(ownerDoc)) } };
    if (r.type === 'saveProject') return { ok: true, revision: 3, value: { path: (r as unknown as { path: string }).path, bytes: 10 } };
    return { ok: true, revision: 4, value: {} };
  };
  const client = { query: answer, execute: answer } as unknown as EngineClient;
  return { client, sent };
}

afterEach(() => {
  setLiveDocumentSource(null);
  mockRestored.length = 0;
});

describe('liveDocument — flag off: the page path, unchanged', () => {
  it('captures and restores in the page, no engine request', async () => {
    const e = fakeEngine();
    setLiveDocumentSource({ engine: () => e.client, owned: () => false });
    expect(await liveDocument()).toBe(mockCaptured);
    await replaceLiveDocument(ownerDoc as never, 'X');
    expect(mockRestored).toEqual([ownerDoc]);
    await expect(saveLiveDocument('/p.motion', { copy: true })).rejects.toBeInstanceOf(LiveDocumentError);
    expect(e.sent).toEqual([]);
  });
});

describe('liveDocument — the engine owns the document', () => {
  it('reads exportDocument, replaces with ONE restoreDocument entry, saves through saveProject', async () => {
    const e = fakeEngine();
    setLiveDocumentSource({ engine: () => e.client, owned: () => true });
    expect(await liveDocument()).toEqual(ownerDoc);
    await replaceLiveDocument(mockCaptured as never, 'Pre-compose');
    const restore = e.sent.find((r) => r.type === 'restoreDocument') as { label: string; document: Uint8Array } | undefined;
    expect(restore?.label).toBe('Pre-compose');
    expect(JSON.parse(new TextDecoder().decode(restore!.document))).toEqual(mockCaptured);
    expect(await saveLiveDocument('/p.motion', { copy: false, format: 'bundle' })).toEqual({ path: '/p.motion', bytes: 10 });
    expect(e.sent.find((r) => r.type === 'saveProject')).toMatchObject({ path: '/p.motion', copy: false, format: 'bundle' });
    expect(mockRestored).toEqual([]); // the page never mockRestored
  });

  it('an engine refusal is an error, never a silent page fallback', async () => {
    const e = fakeEngine(true);
    setLiveDocumentSource({ engine: () => e.client, owned: () => true });
    await expect(liveDocument()).rejects.toThrow('exportDocument: disk full');
    await expect(replaceLiveDocument(mockCaptured as never, 'X')).rejects.toThrow('restoreDocument: disk full');
    expect(mockRestored).toEqual([]);
  });
});
