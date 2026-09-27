/**
 * Session blob footage becomes a cache file before an engine job.
 * The TypeScript owner never takes this path (engineJobs gates it).
 */

import type { EngineClient, JobSpec } from '@motion/engine-api';
import { engineCanReadFootage, materializeSessionFootage, materializeUnreadableFootage, type SessionFootageDeps } from '../sessionFootage';
import { startEngineJob } from '../engineJobs';
import { resetEngineOwnership, setEngineOwnsDocument } from '../engineOwnership';

const BYTES = new Uint8Array([1, 2, 3, 4]);

interface Item {
  id: string;
  path: string;
  source?: string;
}

function harness(items: Item[]) {
  const relinks: { item: string; path: string; keepInterpretation: boolean }[] = [];
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const queries: string[] = [];
  const client = {
    async query(q: { type: string; layers?: string[]; items?: string[] }) {
      queries.push(q.type);
      if (q.type === 'getLayers') {
        const id = q.layers?.[0];
        const found = items.find((i) => i.id === id);
        return { ok: true, value: { layers: found ? [{ id, source: found.source }] : [] }, revision: 1 };
      }
      if (q.type === 'getItems') {
        const id = q.items?.[0];
        const found = items.find((i) => i.id === id);
        return { ok: true, value: { items: found ? [{ id: found.id, path: found.path }] : [] }, revision: 1 };
      }
      return { ok: false, error: { code: 'unsupported', message: q.type }, revision: 1 };
    },
    async execute(cmd: { type: string; item?: string; path?: string; keepInterpretation?: boolean }) {
      if (cmd.type === 'relinkItem') {
        relinks.push({ item: cmd.item!, path: cmd.path!, keepInterpretation: cmd.keepInterpretation! });
        const row = items.find((i) => i.id === cmd.item);
        if (row) row.path = cmd.path!;
        return { ok: true, value: {}, revision: 2 };
      }
      if (cmd.type === 'startJob') {
        return { ok: false, error: { code: 'unsupported', message: 'no jobs' }, revision: 1 };
      }
      return { ok: false, error: { code: 'unsupported', message: cmd.type }, revision: 1 };
    },
    subscribe: () => () => {},
  } as unknown as EngineClient;

  const deps: SessionFootageDeps = {
    lookup: (id) => {
      if (id === 'plate') return { src: 'blob:live/plate', name: 'plate.mp4', path: undefined };
      if (id === 'on-disk') return { src: 'blob:live/disk', name: 'disk.mov', path: 'C:\\clips\\disk.mov' };
      if (id === 'inline') return { src: 'data:image/png;base64,AA==', name: 'swatch.png' };
      return null;
    },
    cacheDir: async () => 'C:\\cache\\session-footage',
    writeBytes: async (path, bytes) => { writes.push({ path, bytes }); },
    readUrl: async (url) => (url.startsWith('blob:') || url.startsWith('data:')) ? BYTES : null,
  };
  return { client, deps, relinks, writes, queries };
}

const trace = { kind: 'autoTrace', value: { layer: 'L1' } } as JobSpec;
const proxy = { kind: 'proxy', value: { item: 'plate' } } as JobSpec;

describe('engineCanReadFootage', () => {
  test('a disk path and a bundle blob are readable; session URLs are not', () => {
    expect(engineCanReadFootage('C:\\clips\\a.mp4')).toBe(true);
    expect(engineCanReadFootage('motion-blob:abc')).toBe(true);
    expect(engineCanReadFootage('')).toBe(false);
    expect(engineCanReadFootage('blob:live/a')).toBe(false);
    expect(engineCanReadFootage('data:image/png;base64,AA==')).toBe(false);
    expect(engineCanReadFootage('https://cdn.example/a.mp4')).toBe(false);
  });
});

describe('materializeSessionFootage', () => {
  test('writes a blob to the cache and relinks once', async () => {
    const h = harness([{ id: 'L1', path: '', source: 'plate' }, { id: 'plate', path: '' }]);
    await materializeSessionFootage(h.client, trace, h.deps);
    expect(h.writes).toEqual([{ path: 'C:\\cache\\session-footage\\plate.mp4', bytes: BYTES }]);
    expect(h.relinks).toEqual([{ item: 'plate', path: 'C:\\cache\\session-footage\\plate.mp4', keepInterpretation: true }]);
    h.writes.length = 0;
    h.relinks.length = 0;
    await materializeSessionFootage(h.client, trace, h.deps);
    expect(h.writes).toEqual([]);
    expect(h.relinks).toEqual([]);
  });

  test('relinks a page path that is already a file, without copying bytes', async () => {
    const h = harness([{ id: 'L1', path: '', source: 'on-disk' }, { id: 'on-disk', path: 'blob:live/disk' }]);
    await materializeSessionFootage(h.client, trace, h.deps);
    expect(h.writes).toEqual([]);
    expect(h.relinks).toEqual([{ item: 'on-disk', path: 'C:\\clips\\disk.mov', keepInterpretation: true }]);
  });

  test('leaves a file the engine can already open', async () => {
    const h = harness([{ id: 'L1', path: '', source: 'plate' }, { id: 'plate', path: 'D:\\already.mp4' }]);
    await materializeSessionFootage(h.client, trace, h.deps);
    expect(h.writes).toEqual([]);
    expect(h.relinks).toEqual([]);
  });

  test('a proxy job names the item directly', async () => {
    const h = harness([{ id: 'plate', path: '' }]);
    await materializeSessionFootage(h.client, proxy, h.deps);
    expect(h.queries).toEqual(['getItems']);
    expect(h.relinks[0]?.path).toBe('C:\\cache\\session-footage\\plate.mp4');
  });

  test('a data URL is cached; an http URL is left alone', async () => {
    const data = harness([{ id: 'inline', path: '' }]);
    await materializeSessionFootage(data.client, { kind: 'proxy', value: { item: 'inline' } } as JobSpec, data.deps);
    expect(data.writes[0]?.path).toBe('C:\\cache\\session-footage\\inline.png');

    const remote = harness([{ id: 'remote', path: 'https://cdn.example/a.mp4' }]);
    await materializeSessionFootage(remote.client, { kind: 'proxy', value: { item: 'remote' } } as JobSpec, remote.deps);
    expect(remote.writes).toEqual([]);
    expect(remote.relinks).toEqual([]);
  });

  test('a document scan rewrites only the footage the engine cannot open', async () => {
    const h = harness([
      { id: 'plate', path: '' },
      { id: 'kept', path: 'D:\\kept.mp4' },
    ]);
    await materializeUnreadableFootage(h.client, ['plate', 'kept'], h.deps);
    expect(h.relinks.map((r) => r.item)).toEqual(['plate']);
    expect(h.writes).toHaveLength(1);
  });

  test('a render job has no footage to rewrite', async () => {
    const h = harness([]);
    await materializeSessionFootage(h.client, { kind: 'render', value: { items: [] } } as unknown as JobSpec, h.deps);
    expect(h.queries).toEqual([]);
  });
});

describe('startEngineJob owner gate', () => {
  afterEach(() => resetEngineOwnership());

  test('does not touch footage while the TypeScript engine owns the document', async () => {
    const h = harness([{ id: 'L1', path: '', source: 'plate' }, { id: 'plate', path: '' }]);
    await startEngineJob(trace, { client: h.client });
    expect(h.queries).toEqual([]);
    expect(h.relinks).toEqual([]);
  });

  test('rewrites session footage before the job when the engine owns the document', async () => {
    setEngineOwnsDocument(true);
    const h = harness([{ id: 'L1', path: '', source: 'plate' }, { id: 'plate', path: 'D:\\already.mp4' }]);
    await startEngineJob(trace, { client: h.client });
    expect(h.queries).toContain('getLayers');
    expect(h.relinks).toEqual([]);
  });
});
