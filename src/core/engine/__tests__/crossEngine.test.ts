/**
 * C3's exit criterion (NATIVE_CORE_PLAN §5): the same command replay passes
 * against BOTH engines.
 *
 * Every session of the replay corpus (__testHelpers__/corpus.ts — the one
 * replay.test.ts proves byte-exact TS → TS) is recorded on the TypeScript
 * engine, then its command log is replayed in lockstep into
 *   - a fresh TypeScript engine (seeded with the log's header document), and
 *   - the real C++ engine process, through `ProcessEngineClient` over the
 *     same `EngineSupervisor` and `EngineBridge` the app uses,
 * translating ids as they are minted (`IdMap`: `layer_3` ⇄ `L3`).
 *
 * Per request: both outcomes agree (ok / the same error code), the revision
 * moves by the same amount, each engine sends at most ONE event batch caused
 * by it, and its document event kinds agree. Requests the C++ engine answers
 * `unsupported` (C2 implements a subset) are skipped and COUNTED, and so is
 * every later request that references something only the TS engine created
 * (dependents); what those touched is left out of the final comparison. At the
 * end: stack order, names, and the five transform properties (values at four
 * times, and keyframes) of every layer both engines have.
 *
 * The C++ engine must have been built (`node scripts/native.mjs build
 * --engine`); without it this suite states that and skips.
 */

import {
  IdMap,
  commandKind,
  ProcessEngineClient,
  type EngineClient,
  type EventBatch,
  type Keyframe,
  type LayerInfo,
  type PropertyInfo,
  type LogRecord,
    type Request,
  type Response,
  type Value,
} from '@motion/engine-api';
import { CORPUS } from '../__testHelpers__/corpus';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

// The TS harness runs under fake timers (the 700 ms recorder must not fire on
// its own); the engine supervisor keeps REAL timers (nativeEngine.ts captures them).
jest.useFakeTimers();

const exe = nativeEngineExe();
const describeNative = exe ? describe : describe.skip;
if (!exe) console.warn('[C3 cross-engine] premation-engine is not built — `node scripts/native.mjs build --engine`; skipping.');

const TRANSFORM = ['transform/anchorPoint', 'transform/position', 'transform/scale', 'transform/rotation', 'transform/opacity'];
const TIMES = [0, sec(0.5), sec(1), sec(1.5)];
/** Document events (§8.1): the kinds both engines must agree on per request. */
const DOC_EVENTS = new Set(['documentReset', 'itemsChanged', 'itemsRemoved', 'compositionChanged', 'layersChanged', 'layersRemoved', 'layerOrderChanged', 'propertiesChanged', 'keyframesChanged']);

interface SessionReport {
  records: number;
  compared: number;
  unsupported: Record<string, number>;
  dependent: number;
  mismatches: string[];
  eventKindDiffs: string[];
  /** Properties only one engine's catalog has (reported, not failed). */
  catalogDiffs: string[];
  /** Undo/redo/jumps over entries only the TS engine has (not sent). */
  tsOnlyHistory: number;
  finalLayers: number;
  finalValues: number;
  finalKeys: number;
}

function numbers(v: Value | undefined): number[] {
  if (!v) return [];
  switch (v.kind) {
    case 'scalar': case 'int': return [v.value];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y];  // C2's engine is 2D: compare x, y
    default: return [];
  }
}

const close = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= 1e-6 * Math.max(1, Math.abs(x)));

/** Layer ids a request references (`layer`, `layers`, PropRef.layer…). */
function layerRefs(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return key === 'layer' || key === 'layers' || key === 'left' || key === 'right' || key === 'group' ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => layerRefs(v, key));
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => layerRefs(v, k));
  }
  return [];
}

function commandType(req: Request): string {
  return req.body.kind === 'batch' ? `batch(${req.body.value.commands.map((c) => c.type).join(',')})` : req.body.value.type;
}

function docKinds(batches: EventBatch[]): string[] {
  return [...new Set(batches.flatMap((b) => b.events.map((e) => e.type)).filter((t) => DOC_EVENTS.has(t)))].sort();
}

/**
 * A dumb mirror fed ONLY by one engine's events (§8.2: applying is assignment).
 * At the end it must agree with that engine's own queries — the check that the
 * events are complete, whatever kinds each engine chooses to send.
 */
class Mirror {
  readonly layers = new Map<string, LayerInfo>();
  readonly order = new Map<string, string[]>();
  readonly props = new Map<string, PropertyInfo>();
  readonly keys = new Map<string, Keyframe[]>();
  resets = 0;

  apply(b: EventBatch): void {
    for (const e of b.events) {
      switch (e.type) {
        case 'documentReset':
          this.resets += 1;
          break;
        case 'layersChanged':
          for (const l of e.layers) this.layers.set(l.id, l);
          break;
        case 'layersRemoved':
          for (const id of e.layers) this.layers.delete(id);
          break;
        case 'layerOrderChanged':
          this.order.set(e.comp, [...e.layers]);
          break;
        case 'propertiesChanged':
          for (const p of e.properties) this.props.set(`${e.layer}|${p.path}`, p);
          break;
        case 'keyframesChanged':
          for (const s of e.sets) this.keys.set(`${s.prop.layer}|${s.prop.path}`, s.keyframes);
          break;
        default:
          break;
      }
    }
  }
}

/** Where `mirror` disagrees with `client`'s own answers about `layers` of `comps`. */
async function mirrorMismatches(label: string, mirror: Mirror, client: EngineClient, comps: string[], layers: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const comp of comps) {
    const r = await client.query({ type: 'getComposition', comp });
    const m = mirror.order.get(comp);
    if (r.ok && m && m.join(',') !== r.value.comp.layers.join(',')) out.push(`${label} mirror: order of ${comp} ${m.join(',')} ≠ ${r.value.comp.layers.join(',')}`);
  }
  for (const layer of layers) {
    const r = await client.query({ type: 'getLayers', layers: [layer] });
    if (!r.ok) continue;
    const ml = mirror.layers.get(layer);
    if (!ml) out.push(`${label} mirror: never told about layer ${layer}`);
    else if (ml.name !== r.value.layers[0]!.name) out.push(`${label} mirror: name of ${layer} '${ml.name}' ≠ '${r.value.layers[0]!.name}'`);
    for (const path of TRANSFORM) {
      const k = await client.query({ type: 'getKeyframes', props: [{ layer, path }] });
      if (!k.ok) continue;
      const keys = k.value.sets[0]?.keyframes ?? [];
      const mk = mirror.keys.get(`${layer}|${path}`) ?? [];
      const f = (ks: Keyframe[]): string => ks.map((x) => `${x.id}@${x.time}=${numbers(x.value).join('/')}`).join(' ');
      if (f(keys) !== f(mk)) out.push(`${label} mirror: keys of ${layer} ${path} [${f(mk)}] ≠ [${f(keys)}]`);
      if (keys.length === 0) {
        const v = await client.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false });
        const mp = mirror.props.get(`${layer}|${path}`);
        if (v.ok && mp?.value && !close(numbers(mp.value), numbers(v.value.values[0]!.value))) {
          out.push(`${label} mirror: ${layer} ${path} ${JSON.stringify(numbers(mp.value))} ≠ ${JSON.stringify(numbers(v.value.values[0]!.value))}`);
        }
      }
    }
  }
  return out;
}

async function replaySession(name: string): Promise<SessionReport> {
  // 1. Record the session on the TypeScript engine.
  const rec: Harness = await setupEngine();
  let log: { header: ReturnType<Harness['engine']['commandLog']>['header']; records: LogRecord[] };
  try {
    await CORPUS[name]!(rec);
    log = rec.engine.commandLog();
  } finally {
    await rec.dispose();
  }

  // 2. A fresh TS engine at the log's header, and a fresh C++ engine process.
  const ts = await setupEngine();
  ts.engine.loadDocument(log.header.document, { ids: log.header.ids, revision: log.header.revision, reason: 'resync', resetWorkspace: true });
  let native: NativeEngine | null = null;
  let cxx: ProcessEngineClient | null = null;
  const report: SessionReport = { records: log.records.length, compared: 0, unsupported: {}, dependent: 0, mismatches: [], eventKindDiffs: [], catalogDiffs: [], tsOnlyHistory: 0, finalLayers: 0, finalValues: 0, finalKeys: 0 };
  try {
    native = await startNativeEngine();
    cxx = new ProcessEngineClient(native.bridge);
    await cxx.whenReady();
    const cxxBatches: EventBatch[] = [];
    const cxxMirror = new Mirror();
    cxx.subscribe((b) => {
      cxxBatches.push(b);
      cxxMirror.apply(b);
    });
    const tsMirror = new Mirror();
    const tsMirrorFrom = ts.batches.length;
    const map = new IdMap();
    const tainted = new Set<string>();

    // 3. Seed the header's compositions into the C++ engine (it starts empty).
    const tsDoc = await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    map.noteIds(tsDoc.comps.map((c) => c.id));
    map.noteIds(tsDoc.layers.map((l) => l.id));
    for (const c of tsDoc.comps) {
      const s = c.settings;
      const r = await cxx.execute({ type: 'createComposition', settings: { name: s.name, width: s.width, height: s.height, frameRate: s.frameRate, duration: s.duration, pixelAspect: s.pixelAspect }, fromItems: [] });
      if (!r.ok) throw new Error(`seeding comp ${c.id}: ${r.error.message}`);
      map.pair(c.id, r.value.item);
    }
    for (const l of tsDoc.layers) tainted.add(l.id);  // header layers are not seeded
    const cleared = await cxx.execute({ type: 'clearHistory' });
    if (!cleared.ok) throw new Error(cleared.error.message);

    // 4. Lockstep replay.
    //
    // History is modelled so undo/redo stay comparable when commands were
    // skipped: the C++ stack is the TS stack minus the TS-only entries, so an
    // undo/redo of a TS-only entry is not sent (the C++ document never had
    // that change), and a jump's position is translated to the C++ stack.
    const stack: Array<{ cxx: boolean }> = [];
    let pos = 0;
    let gesture: { ts: boolean; cxx: boolean } | null = null;
    const pushEntry = (cxx: boolean): void => {
      stack.length = pos;
      stack.push({ cxx });
      pos += 1;
    };
    const cxxPos = (p: number): number => stack.slice(0, p).filter((e) => e.cxx).length;
    let tsRev = ts.engine.documentRevision;
    let cxxRev = cxx.revision;
    for (let i = 0; i < log.records.length; i++) {
      const req = log.records[i]!.request;
      const type = commandType(req);
      const cmd = req.body.kind === 'command' ? req.body.value : null;
      const isEdit = req.body.kind === 'batch' || (cmd !== null && commandKind(cmd.type) === 'edit');
      const tsBefore = ts.batches.length;
      const tsRes: Response = await ts.engine.request(req);
      const tsMine = ts.batches.slice(tsBefore).filter((b) => b.causedBy === req.seq);
      const dTs = tsRes.revision - tsRev;
      tsRev = tsRes.revision;
      const where = `#${i} ${type}`;

      // An edit only the TS engine applied: a TS-only history entry.
      const tsOnlyEdit = (): void => {
        if (!isEdit || dTs === 0) return;
        if (gesture) gesture.ts = true;
        else pushEntry(false);
      };
      const skipDependent = (): void => {
        report.dependent += 1;
        for (const id of map.unmapped(req.body)) tainted.add(id);
        map.noteSource(tsRes.outcome);
        tsOnlyEdit();
      };

      // History moves over TS-only entries are not sent.
      let cxxReq: Request;
      if (cmd?.type === 'undo' || cmd?.type === 'redo') {
        const entry = cmd.type === 'undo' ? stack[pos - 1] : stack[pos];
        if (!entry) {
          report.mismatches.push(`${where}: the history model has no entry to ${cmd.type}`);
          continue;
        }
        pos += cmd.type === 'undo' ? -1 : 1;
        if (!entry.cxx) {
          report.tsOnlyHistory += 1;
          continue;
        }
        cxxReq = req;
      } else if (cmd?.type === 'jumpToHistory') {
        const from = cxxPos(pos);
        const to = cxxPos(cmd.position);
        pos = cmd.position;
        if (from === to) {
          report.tsOnlyHistory += 1;
          continue;
        }
        cxxReq = { ...req, body: { kind: 'command', value: { ...cmd, position: to } } };
      } else {
        if (map.unmapped(req.body).length > 0 || layerRefs(req.body).some((id) => tainted.has(id))) {
          skipDependent();
          continue;
        }
        cxxReq = map.translate(req);
      }

      const cxxBefore = cxxBatches.length;
      const cxxRes: Response = await cxx.request(cxxReq);
      const cxxMine = cxxBatches.slice(cxxBefore).filter((b) => b.causedBy === cxxReq.seq);
      const dCxx = cxxRes.revision - cxxRev;
      cxxRev = cxxRes.revision;
      if (cxxRes.outcome.kind === 'error' && cxxRes.outcome.value.code === 'unsupported' && tsRes.outcome.kind !== 'error') {
        report.unsupported[type] = (report.unsupported[type] ?? 0) + 1;
        // Whatever it touched on the TS side is TS-only from now on.
        // The LAYERS it touched on the TS side are TS-only from now on (a comp
        // an unsupported command touched — work area, markers — still compares).
        for (const id of layerRefs(req.body)) tainted.add(id);
        for (const id of map.unmapped(req.body)) tainted.add(id);
        map.noteSource(tsRes.outcome);
        tsOnlyEdit();
        continue;
      }
      report.compared += 1;
      const tsErr = tsRes.outcome.kind === 'error' ? tsRes.outcome.value.code : null;
      const cxxErr = cxxRes.outcome.kind === 'error' ? cxxRes.outcome.value.code : null;
      if (tsErr !== cxxErr) report.mismatches.push(`${where}: outcome ts=${tsErr ?? 'ok'} c++=${cxxErr ?? 'ok'}${cxxRes.outcome.kind === 'error' ? ` (${cxxRes.outcome.value.message})` : ''}`);
      else if (!tsErr) map.learn((tsRes.outcome as { value: unknown }).value, (cxxRes.outcome as { value: unknown }).value);

      // History bookkeeping for what both applied.
      let revisionComparable = true;
      if (cmd?.type === 'beginGesture') gesture = { ts: false, cxx: false };
      else if (cmd?.type === 'endGesture') {
        const g = gesture;
        gesture = null;
        if (g && g.ts !== g.cxx) revisionComparable = false;  // a skipped command changed only the TS side
        if (g && cmd.commit && (g.ts || g.cxx)) pushEntry(g.cxx);
      } else if (cmd?.type === 'clearHistory' || cmd?.type === 'newProject') {
        stack.length = 0;
        pos = 0;
      } else if (isEdit && dTs > 0) {
        if (gesture) {
          gesture.ts = true;
          if (dCxx > 0) gesture.cxx = true;
        } else pushEntry(dCxx > 0);
      }
      if (revisionComparable && dTs !== dCxx) report.mismatches.push(`${where}: revision +${dTs} (ts) vs +${dCxx} (c++)`);
      // ONE batch per request, in both engines (§8.1), and a revision change always arrives as events.
      if (tsMine.length > 1) report.mismatches.push(`${where}: ts sent ${tsMine.length} batches`);
      if (cxxMine.length > 1) report.mismatches.push(`${where}: c++ sent ${cxxMine.length} batches`);
      if (dTs > 0 && !tsMine.some((b) => b.toRevision === tsRes.revision)) report.mismatches.push(`${where}: ts moved the revision without a batch`);
      if (dCxx > 0 && !cxxMine.some((b) => b.toRevision === cxxRes.revision)) report.mismatches.push(`${where}: c++ moved the revision without a batch`);
      const kTs = docKinds(tsMine).join(',');
      const kCxx = docKinds(cxxMine).join(',');
      if (kTs !== kCxx) report.eventKindDiffs.push(`${where}: ts [${kTs}] c++ [${kCxx}]`);
    }

    // 5. Each engine's events rebuilt its document (a mirror per engine).
    for (const b of ts.batches.slice(tsMirrorFrom)) tsMirror.apply(b);
    const tsFinal = await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const sharedLayers = tsFinal.layers.map((l) => l.id).filter((id) => !tainted.has(id) && map.get(id));
    const sharedComps = tsFinal.comps.map((c) => c.id).filter((id) => map.get(id));
    report.mismatches.push(
      ...(await mirrorMismatches('ts', tsMirror, ts.engine, sharedComps, sharedLayers)),
      ...(await mirrorMismatches('c++', cxxMirror, cxx, sharedComps.map((c) => map.get(c)!), sharedLayers.map((l) => map.get(l)!))),
    );

    // 6. The documents: every comp both have, every layer neither side tainted.
    const tsComps = (await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false })).comps;
    for (const comp of tsComps) {
      const cxxComp = map.get(comp.id);
      if (!cxxComp) continue;
      const cxxInfo = await cxx.query({ type: 'getComposition', comp: cxxComp });
      if (!cxxInfo.ok) {
        report.mismatches.push(`final: comp ${comp.id} missing in c++ (${cxxInfo.error.message})`);
        continue;
      }
      const tsOrder = comp.layers.filter((l) => !tainted.has(l) && map.get(l));
      const cxxOrder = cxxInfo.value.comp.layers.filter((l) => tsOrder.some((t) => map.get(t) === l));
      if (tsOrder.map((l) => map.get(l)).join(',') !== cxxOrder.join(',')) {
        report.mismatches.push(`final: stack order of ${comp.id}: ts ${tsOrder.map((l) => map.get(l)).join(',')} c++ ${cxxOrder.join(',')}`);
      }
      const orphans = cxxInfo.value.comp.layers.filter((l) => ![...tsOrder].some((t) => map.get(t) === l));
      for (const o of orphans) {
        // A C++ layer without an untainted TS twin is only fine when its twin is tainted.
        const twin = map.sourceOf(o);
        if (!twin || !tainted.has(twin)) report.mismatches.push(`final: c++ layer ${o} has no TS twin`);
      }
      for (const layer of tsOrder) {
        const cl = map.get(layer)!;
        report.finalLayers += 1;
        const tl = await ts.query({ type: 'getLayers', layers: [layer] });
        const cxl = await cxx.query({ type: 'getLayers', layers: [cl] });
        if (cxl.ok && tl.layers[0]!.name !== cxl.value.layers[0]!.name) {
          report.mismatches.push(`final: name of ${layer}: '${tl.layers[0]!.name}' vs '${cxl.value.layers[0]!.name}'`);
        }
        for (const p of TRANSFORM) {
          // A property only one engine's catalog has is a catalog difference,
          // reported, not a replay mismatch (e.g. AE nulls have Opacity; TS nulls do not).
          const tsHas = (await ts.engine.query({ type: 'getKeyframes', props: [{ layer, path: p }] })).ok;
          const cxxHas = (await cxx.query({ type: 'getKeyframes', props: [{ layer: cl, path: p }] })).ok;
          if (tsHas !== cxxHas) {
            report.catalogDiffs.push(`${layer} ${p}: ${tsHas ? 'ts only' : 'c++ only'}`);
            continue;
          }
          if (!tsHas) continue;
          for (const time of TIMES) {
            const tv = await ts.query({ type: 'getPropertyValues', props: [{ layer, path: p }], time, evaluated: true });
            const cv = await cxx.query({ type: 'getPropertyValues', props: [{ layer: cl, path: p }], time, evaluated: true });
            if (!cv.ok) {
              report.mismatches.push(`final: ${layer} ${p}: ${cv.error.message}`);
              continue;
            }
            const a = numbers(tv.values[0]!.value);
            const b = numbers(cv.value.values[0]!.value);
            report.finalValues += 1;
            if (!close(a, b)) report.mismatches.push(`final: ${layer} ${p} @${time / sec(1)}s: ts ${JSON.stringify(a)} c++ ${JSON.stringify(b)}`);
          }
          const tk = await ts.query({ type: 'getKeyframes', props: [{ layer, path: p }] });
          const ck = await cxx.query({ type: 'getKeyframes', props: [{ layer: cl, path: p }] });
          if (!ck.ok) continue;
          const a = tk.sets[0]?.keyframes ?? [];
          const b = ck.value.sets[0]?.keyframes ?? [];
          report.finalKeys += a.length;
          // Keys minted without an id in any result (setAnimated's first key) pair up by position.
          a.forEach((k, j) => {
            if (map.get(k.id) === undefined && b[j] && b[j]!.time === k.time) map.pair(k.id, b[j]!.id);
          });
          const fa = a.map((k) => `${k.time}:${numbers(k.value).map((x) => x.toFixed(6)).join('/')}:${map.get(k.id) ?? '?'}`).join(' ');
          const fb = b.map((k) => `${k.time}:${numbers(k.value).map((x) => x.toFixed(6)).join('/')}:${k.id}`).join(' ');
          if (fa !== fb) report.mismatches.push(`final: keys of ${layer} ${p}: ts ${fa} | c++ ${fb}`);
        }
      }
    }
    return report;
  } finally {
    await cxx?.close();
    await native?.stop();
    await ts.dispose();
  }
}

describeNative('C3: the replay corpus against both engines', () => {
  const reports: Record<string, SessionReport> = {};

  afterAll(() => {
    const rows = Object.entries(reports).map(([n, r]) => {
      const unsupported = Object.values(r.unsupported).reduce((a, b) => a + b, 0);
      return `${n.slice(0, 48).padEnd(48)} records ${String(r.records).padStart(3)} · compared ${String(r.compared).padStart(3)} · unsupported ${String(unsupported).padStart(3)} · dependent ${String(r.dependent).padStart(3)} · final layers ${r.finalLayers}, values ${r.finalValues}, keys ${r.finalKeys} · ts-only history ${r.tsOnlyHistory} · catalog diffs ${r.catalogDiffs.length} · mismatches ${r.mismatches.length} · event-kind diffs ${r.eventKindDiffs.length}`;
    });
    const unsupportedByType: Record<string, number> = {};
    for (const r of Object.values(reports)) for (const [t, n] of Object.entries(r.unsupported)) unsupportedByType[t] = (unsupportedByType[t] ?? 0) + n;
    console.log(`[C3 cross-engine]\n${rows.join('\n')}\nunsupported by command: ${JSON.stringify(unsupportedByType)}`);
  });

  test.each(Object.keys(CORPUS))('%s', async (name) => {
    const r = await replaySession(name);
    reports[name] = r;
    expect(r.mismatches).toEqual([]);
    if (name.startsWith('native subset')) {
      // Built from C2's command set: every request must be compared.
      expect(r.unsupported).toEqual({});
      expect(r.dependent).toBe(0);
      expect(r.compared).toBe(r.records);
      expect(r.finalLayers).toBeGreaterThanOrEqual(3);
    }
  }, 120_000);
});
