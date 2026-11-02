/**
 * McpCallHost with stand-in deps: the plan gate, render results as MCP images,
 * and the ways an open group closes itself (idle, client gone, Stop). The undo
 * behaviour on the real engine is mcpHost.native.test.ts.
 */

import type { ToolContext, ToolResult } from '@motion/ai-tools';
import { GROUP_IDLE_MS, McpCallHost, type McpHostDeps, type McpResult } from './mcpHost';
import type { AiTransaction } from '../aiTransaction';

interface FakeTx {
  label: string;
  state: 'open' | 'committed' | 'rolledBack';
}

function setup(over: Partial<McpHostDeps> = {}) {
  const txs: FakeTx[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const executed: string[] = [];
  const deps: McpHostDeps = {
    registry: () => ({
      has: (n: string) => ['describe_scene', 'create_layer', 'export_video', 'generate_video'].includes(n),
      get: (n: string) => (n === 'describe_scene' ? { name: n, kind: 'read', description: '', inputSchema: {} }
        : n === 'create_layer' ? { name: n, kind: 'write', description: '', inputSchema: {} } : undefined),
      execute: async (n: string): Promise<ToolResult> => {
        executed.push(n);
        return { ok: true, content: `did ${n}` };
      },
    }),
    beginTransaction: async (label: string) => {
      const t: FakeTx = { label, state: 'open' };
      txs.push(t);
      return {
        label,
        session: {} as AiTransaction['session'],
        commit: async () => { t.state = 'committed'; return { kind: 'engine' as const, gaps: [] }; },
        rollback: async () => { t.state = 'rolledBack'; },
      };
    },
    context: () => ({ signal: new AbortController().signal } as unknown as ToolContext),
    freshRun: () => undefined,
    renderStill: async () => ({ mimeType: 'image/png', data: 'PNGDATA' }),
    renderStrip: async () => null,
    access: async () => ({ ok: true }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    ...over,
  };
  const host = new McpCallHost(deps);
  const call = (name: string, args: unknown = {}, clientId = 1): Promise<McpResult> => host.handle({ clientId, name, args });
  const fireIdle = async (): Promise<void> => {
    const live = timers.filter((t) => !t.cleared);
    expect(live.at(-1)?.ms).toBe(GROUP_IDLE_MS);
    live.at(-1)?.fn();
    await call('describe_scene');
  };
  return { host, call, txs, executed, fireIdle };
}

const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : `[${c.mimeType}]`)).join(' ');

describe('McpCallHost', () => {
  it('refuses every call, with the reason, when the plan gate says no', async () => {
    const { call, executed } = setup({ access: async () => ({ ok: false, message: 'needs Pro' }) });
    const r = await call('describe_scene');
    expect(r).toEqual({ content: [{ type: 'text', text: 'needs Pro' }], isError: true });
    expect(executed).toEqual([]);
  });

  it('refuses an excluded tool before running anything', async () => {
    const { call, executed } = setup();
    expect((await call('generate_video')).isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('returns render_frame as an MCP image and clamps its size', async () => {
    let asked = 0;
    const { call } = setup({ renderStill: async (_t, size) => { asked = size; return { mimeType: 'image/png', data: 'PNGDATA' }; } });
    const r = await call('render_frame', { time: 1.5, maxSize: 99999 });
    expect(r.content[0]).toEqual({ type: 'image', data: 'PNGDATA', mimeType: 'image/png' });
    expect(asked).toBe(2048);
  });

  it('says so when the renderer could not draw', async () => {
    const { call } = setup({ renderStill: async () => null });
    expect((await call('render_frame', { time: 0 })).isError).toBe(true);
    const strip = await setup().call('render_filmstrip', { startSec: 2, endSec: 1 });
    expect(textOf(strip)).toMatch(/after startSec/);
  });

  it('passes render_frame\'s composition, solo, crop, zoom and asset options to the renderer, and refuses bad ones', async () => {
    const seen: unknown[] = [];
    const { call } = setup({ renderStill: async (_t, _s, opts) => { seen.push(opts); return { mimeType: 'image/png', data: 'PNGDATA' }; } });
    const r = await call('render_frame', { time: 2, compId: 'comp_b', layerIds: ['l1', 'l2'], region: { x: 10, y: 20, w: 300, h: 200 }, zoom: 2 });
    expect(r.content[0]!.type).toBe('image');
    expect(seen[0]).toEqual({ compId: 'comp_b', layerIds: ['l1', 'l2'], region: { x: 10, y: 20, w: 300, h: 200 }, zoom: 2 });
    expect(textOf(r)).toMatch(/solo/);
    await call('render_frame', { time: 1, assetId: 'asset_9' });
    expect(seen[1]).toEqual({ assetId: 'asset_9' });
    expect(textOf(await call('render_frame', { time: 1, assetId: 'a', layerIds: ['x'] }))).toMatch(/assetId renders an imported asset/);
    expect(textOf(await call('render_frame', { time: 1, zoom: 40 }))).toMatch(/zoom must be/);
    expect(textOf(await call('render_frame', { time: 1, region: { x: 0, y: 0, w: -1, h: 2 } }))).toMatch(/region needs/);
  });

  it('relays the renderer\'s refusal of an option as the error', async () => {
    const { call } = setup({ renderStill: async () => ({ error: 'No composition \'nope\'.' }) });
    const r = await call('render_frame', { time: 0, compId: 'nope' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No composition 'nope'/);
  });

  it('attaches the subject preview to select_subject and drops the geometry from the text', async () => {
    const views: unknown[] = [];
    const { call, txs } = setup({
      registry: () => ({
        has: (n: string) => n === 'select_subject',
        get: (n: string) => (n === 'select_subject' ? { name: n, kind: 'write', description: '', inputSchema: {} } : undefined),
        execute: async (): Promise<ToolResult> => ({ ok: true, content: 'Selected subject s1', data: { subject: 's1', view: { layer: 'v', time: 0, outlines: [], crop: {}, affine: {}, box: {} } } }),
      }),
      renderSubjectView: async (view) => { views.push(view); return { mimeType: 'image/png', data: 'MATTE' }; },
    });
    const r = await call('select_subject', { layerId: 'v', points: [{ x: 1, y: 2 }] });
    expect(r.content[0]).toEqual({ type: 'image', data: 'MATTE', mimeType: 'image/png' });
    expect(textOf(r)).toMatch(/"subject": "s1"/);
    expect(textOf(r)).not.toMatch(/outlines/);
    expect(views).toHaveLength(1);
    expect(txs).toEqual([{ label: 'Claude: select subject', state: 'committed' }]);
  });

  it('asks the user before transcribing and refuses without Allow', async () => {
    const asked: string[] = [];
    const { call, executed } = setup({
      registry: () => ({ has: (n: string) => n === 'transcribe', get: () => undefined, execute: async (n: string): Promise<ToolResult> => { executed.push(n); return { ok: true, content: 'ok' }; } }),
      approve: async (req) => { asked.push(req.title); return false; },
    });
    const r = await call('transcribe', { createCaptions: true });
    expect(r.isError).toBe(true);
    expect(asked[0]).toMatch(/Transcribe/);
    expect(executed).toEqual([]);
  });

  it('attaches describe_asset\'s contact sheet for footage, not for audio', async () => {
    let data: Record<string, unknown> = { itemId: 'item_1', type: 'video', durationSec: 4, cells: 3 };
    const sheets: unknown[] = [];
    const { call } = setup({
      registry: () => ({ has: (n: string) => n === 'describe_asset', get: () => ({ name: 'describe_asset', kind: 'read', description: '', inputSchema: {} }), execute: async (): Promise<ToolResult> => ({ ok: true, content: 'clip.mp4', data }) }),
      renderAssetSheet: async (itemId, durationSec, cells) => { sheets.push([itemId, durationSec, cells]); return { mimeType: 'image/png', data: 'SHEET' }; },
    });
    const r = await call('describe_asset', { assetId: 'a' });
    expect(r.content[0]).toEqual({ type: 'image', data: 'SHEET', mimeType: 'image/png' });
    expect(sheets).toEqual([['item_1', 4, 3]]);
    data = { itemId: 'item_2', type: 'audio', durationSec: 4, cells: 3 };
    expect((await call('describe_asset', { assetId: 'b' })).content[0]!.type).toBe('text');
    expect(sheets).toHaveLength(1);
  });

  it('wraps a changing call in its own transaction, but not a read', async () => {
    const { call, txs } = setup();
    await call('describe_scene');
    await call('create_layer');
    expect(txs).toEqual([{ label: 'Claude: create layer', state: 'committed' }]);
  });

  it('refuses a second begin_edit while a group is open', async () => {
    const { call } = setup();
    await call('begin_edit', { label: 'one' });
    const r = await call('begin_edit', { label: 'two' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/already open \("one"\)/);
  });

  it('closes an idle group after GROUP_IDLE_MS, committing it', async () => {
    const { call, txs, host, fireIdle } = setup();
    await call('begin_edit', { label: 'idle' });
    await call('create_layer');
    await fireIdle();
    expect(txs).toEqual([{ label: 'Claude: idle', state: 'committed' }]);
    expect(host.getActivity().group).toBeNull();
  });

  it('commits a group whose client disconnected', async () => {
    const { call, txs, host } = setup();
    await call('begin_edit', { label: 'gone' }, 7);
    await host.clientsChanged([3]);
    expect(txs[0]!.state).toBe('committed');
  });

  it('throws the open group away on Stop', async () => {
    const { call, txs, host } = setup();
    await call('begin_edit', { label: 'stop me' });
    await host.stop();
    expect(txs[0]!.state).toBe('rolledBack');
  });

  it('reports what it is doing, for the badge', async () => {
    const { call, host } = setup();
    const seen: Array<string | null> = [];
    host.subscribe((a) => seen.push(a.busy ? a.tool : a.group));
    await call('begin_edit', { label: 'L' });
    expect(seen).toContain('begin_edit');
    expect(host.getActivity()).toEqual({ busy: false, tool: null, group: 'L' });
  });
});

describe('approvals and project operations', () => {
  const editor = () => {
    const calls: string[] = [];
    return {
      calls,
      ops: {
        listCompositions: async () => ({ active: 'c1', compositions: [{ id: 'c1' }] }),
        createComposition: async (o: { name: string }) => { calls.push(`create:${o.name}`); return { id: 'c2' }; },
        setActiveComposition: async (id: string) => (id === 'c1' ? { ok: true as const, name: 'Main' } : { error: 'No composition' }),
        deleteCompositions: async (ids: readonly string[]) => {
          calls.push(`delete:${ids.join(',')}`);
          return ids.includes('zz') ? { error: "No composition 'zz'." } : { ok: true as const, names: ids.map((i) => `Comp ${i}`), layersRemoved: 1 };
        },
        save: async () => ({ ok: true as const, message: 'Saved.' }),
        importMedia: async (paths: readonly string[]) => { calls.push(`import:${paths.join(',')}`); return { ok: true as const, message: 'Imported 1' }; },
        addSfx: async (id: string) => { calls.push(`sfx:${id}`); return { id: 'layer_9' }; },
        setAudioLevels: async () => ({ ok: true as const, message: 'Set.' }),
        duck: async () => ({ ok: true as const, message: 'Ducked.' }),
      },
    };
  };

  it('tells add_sfx when it runs inside an open group, so the insert joins the gesture (B2)', async () => {
    const seen: Array<boolean | undefined> = [];
    const ed = editor();
    const ops = { ...ed.ops, addSfx: async (_id: string, _at: number, _db: number | null, o?: { inGroup?: boolean }) => { seen.push(o?.inGroup); return { id: 'layer_9' }; } };
    const { call } = setup({ editor: ops });
    expect(textOf(await call('add_sfx', { id: 'sfx-click', atSec: 1 }))).toMatch(/audio layer layer_9/);
    await call('begin_edit', { label: 'sound' });
    expect(textOf(await call('add_sfx', { id: 'sfx-click', atSec: 2 }))).toMatch(/audio layer layer_9/);
    await call('end_edit');
    expect(seen).toEqual([false, true]);
  });

  it('imports only after the user allows it', async () => {
    const ed = editor();
    const denied = setup({ editor: ed.ops, approve: async () => false });
    const r = await denied.call('import_media', { paths: ['C:/a.png'] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/did not allow/);
    expect(ed.calls).toEqual([]);
    const allowed = setup({ editor: ed.ops, approve: async () => true });
    expect(textOf(await allowed.call('import_media', { paths: ['C:/a.png'] }))).toBe('Imported 1');
    expect(ed.calls).toEqual(['import:C:/a.png']);
  });

  it('places imported media at the time the call names, 0 by default — not at the user\'s playhead (The Last Blade)', async () => {
    const seen: Array<number | undefined> = [];
    const ed = editor();
    const ops = { ...ed.ops, importMedia: async (_p: readonly string[], _place: boolean, atSec?: number) => { seen.push(atSec); return { ok: true as const, message: 'Imported 1' }; } };
    const { call } = setup({ editor: ops, approve: async () => true });
    await call('import_media', { paths: ['C:/a.png'] });
    await call('import_media', { paths: ['C:/b.png'], atSec: 3.5 });
    expect(seen).toEqual([0, 3.5]);
  });

  it('never exports without an approver', async () => {
    const { call, executed } = setup();
    expect((await call('export_video', { format: 'mp4' })).isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('creates and switches compositions through the editor operations', async () => {
    const ed = editor();
    const { call } = setup({ editor: ed.ops });
    expect(textOf(await call('create_composition', { name: 'Vertical', width: 1080, height: 1920 }))).toMatch(/Created composition "Vertical" \(id c2\)/);
    expect(textOf(await call('set_active_composition', { compId: 'c1' }))).toMatch(/"Main" is now the active/);
    expect((await call('set_active_composition', { compId: 'zz' })).isError).toBe(true);
  });

  it('deletes compositions through the editor operations, as one call, and says what went', async () => {
    const ed = editor();
    const { call } = setup({ editor: ed.ops });
    expect(textOf(await call('delete_composition', { compIds: ['c2', 'c3', 'c2'] }))).toBe(
      'Deleted "Comp c2", "Comp c3" and 1 precomp layer showing them. One undo step brings them back.',
    );
    expect(ed.calls).toEqual(['delete:c2,c3']);
    expect((await call('delete_composition', { compIds: ['zz'] })).isError).toBe(true);
    expect((await call('delete_composition', { compIds: [] })).isError).toBe(true);
  });
});
