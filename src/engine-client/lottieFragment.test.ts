/**
 * The Lottie import as an engine client (lottieFragment.ts) builds the SAME
 * fragment the off-document build of the legacy importer does
 * (offDocument.ts buildLayerFragment over lottieLibrary's buildLottieItem):
 * every bundled Lottie, compared row by row, component by component, track by
 * track — scratch ids, component ids and the random ids of stops and path
 * operators normalised by order of appearance. And the fragment pastes into
 * the engine as one undoable entry.
 */

import { unwrap } from '@motion/engine-api';
import { useCompositionStore } from '@stores/compositionStore';
import { LOTTIE_DESIGN_CENTER, LOTTIE_ITEMS, buildLottieFile, buildLottieItem } from '@core/library/lottieLibrary';
import { planLottieImport, type LottieJson } from '@core/lottie/lottieImport';
import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { decodeFragmentLayers, type FragmentLayer } from './fragmentBuilder';
import { buildLottieFragment } from './lottieFragment';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

/** Ids that are not the layers' own: stops, opacity stops, path operators — by first appearance. */
function normalize(layers: FragmentLayer[]): unknown {
  const rowIds = layers.map((l) => l.row.id);
  const map = new Map<string, string>(rowIds.map((id, i) => [id, `L${i}`]));
  const other = new Map<string, string>();
  const collect = (v: unknown, inFx: boolean): void => {
    if (Array.isArray(v)) {
      v.forEach((x) => collect(x, inFx));
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (inFx && typeof o.id === 'string' && !map.has(o.id) && !other.has(o.id)) other.set(o.id, `X${other.size}`);
    for (const x of Object.values(o)) collect(x, inFx);
  };
  for (const l of layers) {
    for (const c of l.row.components) if (c.type === 'fx') collect(c.props, true);
  }
  const rewrite = (s: string): string => {
    const exact = map.get(s) ?? other.get(s);
    if (exact) return exact;
    let out = s;
    for (const [from, to] of other) if (out.includes(from)) out = out.split(from).join(to);
    for (const [from, to] of map) if (out.startsWith(`${from}_`)) out = to + out.slice(from.length);
    return out;
  };
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') return rewrite(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[rewrite(k)] = walk(x, k);
    return out;
  };
  return layers.map((l) => ({
    row: {
      ...(walk(l.row, 'row') as Record<string, unknown>),
      // A parent outside the fragment (the comp root) is the same as none: top level.
      parent: l.row.parent && map.has(l.row.parent) ? map.get(l.row.parent) : null,
      // `solo: false` is the absent flag.
      solo: l.row.solo === true,
      // Component ids are re-derived by the engine on paste (`<layer>_<type>`).
      components: l.row.components.map((c) => ({ type: c.type, props: walk(c.props, 'props') })),
    },
    anim: walk(l.anim, 'anim'),
    bars: l.bars,
  }));
}

describe('Lottie import as an engine client', () => {
  it.each(LOTTIE_ITEMS.map((i) => [i.id]))('%s: the same fragment as the off-document build', (lottieId) => {
    const item = LOTTIE_ITEMS.find((i) => i.id === lottieId)!;
    const comp = useCompositionStore.getState().comp();
    const legacy = buildLayerFragment('comp_root', () => buildLottieItem(lottieId));
    const mine = buildLottieFragment(planLottieImport(item.doc), {
      offset: { x: comp.width / 2 - LOTTIE_DESIGN_CENTER, y: comp.height / 2 - LOTTIE_DESIGN_CENTER },
      compFps: comp.fps,
      compDurationSeconds: comp.durationSeconds,
    });
    expect(legacy).not.toBeNull();
    expect(mine.built).not.toBeNull();
    expect(normalize(decodeFragmentLayers(mine.built!.fragment))).toEqual(normalize(decodeFragmentLayers(legacy!.fragment)));
  });

  it('trim paths, a stroke, a track matte and a layer window: the same fragment', () => {
    type L = NonNullable<LottieJson['layers']>[number];
    const ks = { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } };
    const rect = (ind: number, nm: string, extra: Record<string, unknown>): L => ({
      ty: 4, ind, nm, ip: 0, op: 60, ks,
      shapes: [{ ty: 'gr', it: [
        { ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [120, 80] }, r: { a: 0, k: 8 } },
        { ty: 'fl', c: { a: 0, k: [0.2, 0.6, 1, 1] }, o: { a: 0, k: 100 } },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ] }],
      ...extra,
    } as unknown as L);
    const line: L = {
      ty: 4, ind: 1, nm: 'line', ip: 10, op: 40, ks,
      shapes: [{ ty: 'gr', it: [
        { ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: [[-100, 0], [100, 0]], c: false } } },
        { ty: 'st', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 1, k: [{ t: 0, s: [2] }, { t: 30, s: [8] }] } },
        { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0] }, { t: 60, s: [100] }] }, o: { a: 0, k: 90 }, m: 1 },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ] }],
    } as unknown as L;
    const json: LottieJson = {
      fr: 30, op: 60, w: 400, h: 400,
      layers: [line, rect(2, 'matte', { td: 1 }), rect(3, 'masked', { tt: 1 })],
    };
    const plan = planLottieImport(json);
    const comp = useCompositionStore.getState().comp();
    const legacy = buildLayerFragment('comp_root', () => buildLottieFile({ plan, offset: { x: 5, y: 7 }, warnings: [] }));
    const mine = buildLottieFragment(planLottieImport(json), { offset: { x: 5, y: 7 }, compFps: comp.fps, compDurationSeconds: comp.durationSeconds });
    const decoded = decodeFragmentLayers(mine.built!.fragment);
    expect(decoded.some((l) => JSON.stringify(l.row).includes('"pathOps"'))).toBe(true);
    expect(decoded.some((l) => JSON.stringify(l.row).includes('"matte"'))).toBe(true);
    expect(normalize(decoded)).toEqual(normalize(decodeFragmentLayers(legacy!.fragment)));
  });

  it('pastes as ONE undoable entry', async () => {
    const item = LOTTIE_ITEMS[0]!;
    const comp = useCompositionStore.getState().comp();
    const { built } = buildLottieFragment(planLottieImport(item.doc), { compFps: comp.fps, compDurationSeconds: comp.durationSeconds });
    const entries = historyLabels().length;
    const before = h.doc();
    const ids = unwrap(await h.engine.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment })).layers;
    expect(ids).toHaveLength(built!.scratchIds.length);
    expect(historyLabels().length).toBe(entries + 1);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
  });
});
