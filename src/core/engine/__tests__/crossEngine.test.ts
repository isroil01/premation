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
  COMMANDS,
  encodeEngineMessage,
  IdMap,
  commandKind,
  ProcessEngineClient,
  type EngineClient,
  type EventBatch,
  type Keyframe,
  type LayerInfo,
  type PropertyInfo,
  type Request,
  type Response,
  type Value,
} from '@motion/engine-api';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS as B2_CORPUS, CORPUS_FIXTURES, FAMILY_CORPUS, GENERATED_CORPUS } from '../__testHelpers__/corpus';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';
// Both TS engines evaluate expressions with the app's providers, as the C++ engine does.
import { installAppExpressionProviders } from './crossEngineProviders.test';

// B2's replay corpus, the D1b family sessions and the D1b generated sessions.
const CORPUS = { ...B2_CORPUS, ...FAMILY_CORPUS, ...GENERATED_CORPUS };
/** Every command type the recorded sessions sent (batch members included) — the coverage report. */
const ISSUED = new Set<string>();
/**
 * PREMATION_DUMP_REPLAY=<file>: write every request each session sent to the C++
 * engine — the native stress test's and the fuzzer's seed corpus
 * (native/engine/tests/data/replay_corpus.bin). Format, little-endian: u32
 * session count; per session u32 request count; per request u32 byte length +
 * an encoded EngineMessage{request}.
 */
const DUMP: Uint8Array[][] = [];

// The TS harness runs under fake timers (the 700 ms recorder must not fire on
// its own); the engine supervisor keeps REAL timers (nativeEngine.ts captures them).
jest.useFakeTimers();

const exe = nativeEngineExe();
const describeNative = exe ? describe : describe.skip;
if (!exe) console.warn('[C3 cross-engine] premation-engine is not built — `node scripts/native.mjs build --engine`; skipping.');

const TRANSFORM = ['transform/anchorPoint', 'transform/position', 'transform/scale', 'transform/rotation', 'transform/opacity'];
const TIMES = [0, sec(0.5), sec(1), sec(1.5)];
/**
 * Queries whose answers are facts about the engine, not the document.
 * (copyLayers is compared: both engines write the fragment in one canonical
 * key order, so its BYTES must be identical — G2.)
 */
const QUERY_EXEMPT = new Set(['getCapabilities', 'getRenderStats', 'getCommandLog', 'getJobs', 'listFonts']);
/**
 * What each engine SAVED must agree on these document keys (G2 #7: the stores
 * no command edits — they ride through open → save; byte-identical JSON).
 */
const SAVED_KEYS = ['guides', 'swatches', 'materials', 'transitions', 'pluginStorage'] as const;
/** The C++ engine's `--test-ports-dir` file for a project path (engine_ctx.cpp FakePorts). */
const portsFile = (dir: string, path: string): string => join(dir, `${Buffer.from(path, 'utf8').toString('hex')}.json`);
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
  /** Event-mirror gaps both engines show identically (also counted in mismatches since G2). */
  sharedEventGaps: string[];
  finalLayers: number;
  finalValues: number;
  finalKeys: number;
  /** Layers whose whole property tree was compared. */
  finalTrees: number;
  /** Saved project files compared (SAVED_KEYS). */
  savedDocs: number;
}

function numbers(v: Value | undefined): number[] {
  if (!v) return [];
  switch (v.kind) {
    case 'scalar': case 'int': return [v.value];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    default: return [];
  }
}

const close = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= 1e-6 * Math.max(1, Math.abs(x)));

/**
 * Where two query results differ (paths, capped): strings and booleans exact,
 * numbers within 1e-9 relative (bit-exact is the goal; the tolerance only
 * keeps a last-ulp formatting difference from hiding the real ones), absent
 * and `undefined` equal.
 */
function diffDeep(a: unknown, b: unknown, path: string, out: string[] = []): string[] {
  if (out.length > 16) return out;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    // Bytes (a copyLayers fragment): identical, or where they first part.
    const ta = new TextDecoder().decode(a);
    const tb = new TextDecoder().decode(b);
    if (ta !== tb) {
      let i = 0;
      while (i < ta.length && ta[i] === tb[i]) i++;
      out.push(`final: ${path}: bytes differ at ${i}: ts …${ta.slice(Math.max(0, i - 80), i + 120)}… c++ …${tb.slice(Math.max(0, i - 80), i + 120)}…`);
    }
    return out;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    const same = a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    if (!same) out.push(`final: ${path}: ts ${a} c++ ${b}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`final: ${path}: ts length ${a.length} c++ length ${b.length} (ts ${JSON.stringify(a).slice(0, 300)} | c++ ${JSON.stringify(b).slice(0, 300)})`);
      return out;
    }
    a.forEach((x, i) => diffDeep(x, b[i], `${path}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !(a instanceof Uint8Array)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    const label = (x: unknown): string => (x && typeof x === 'object' && 'path' in (x as object) ? `(${String((x as { path: unknown }).path)})` : '');
    for (const k of keys) diffDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}${label(a)}.${k}`, out);
    return out;
  }
  if (a === undefined && b === undefined) return out;
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`final: ${path}: ts ${JSON.stringify(a)?.slice(0, 200)} c++ ${JSON.stringify(b)?.slice(0, 200)}`);
  return out;
}

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
          // A client re-reads the whole document after a reset (§8.2); what it
          // knew before is gone, so the mirror only vouches for later events.
          this.resets += 1;
          this.layers.clear();
          this.order.clear();
          this.props.clear();
          this.keys.clear();
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
    if (!ml) {
      if (mirror.resets === 0) out.push(`${label} mirror: never told about layer ${layer}`);
    }
    else if (ml.name !== r.value.layers[0]!.name) out.push(`${label} mirror: name of ${layer} '${ml.name}' ≠ '${r.value.layers[0]!.name}'`);
    for (const path of TRANSFORM) {
      const k = await client.query({ type: 'getKeyframes', props: [{ layer, path }] });
      if (!k.ok) continue;
      const keys = k.value.sets[0]?.keyframes ?? [];
      const told = mirror.keys.get(`${layer}|${path}`);
      // After a reset the client re-read everything; only later events are checked.
      if (!told && mirror.resets > 0) continue;
      const mk = told ?? [];
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
  // 1. Record the session on the TypeScript engine. EVERY request is captured
  //    (D1b): queries and failed commands too — the command log only keeps
  //    commands that succeeded, and parity of the refusals and of every query
  //    answer is half of what this test is for.
  const rec: Harness = await setupEngine();
  installAppExpressionProviders();
  let log: { header: ReturnType<Harness['engine']['commandLog']>['header']; records: Array<{ request: Request }> };
  try {
    const captured: Array<{ request: Request }> = [];
    const original = rec.engine.request.bind(rec.engine);
    rec.engine.request = (req: Request): Promise<Response> => {
      // ArrayBuffer.isView, not instanceof: a fragment's bytes may come from another
      // realm (TextEncoder under jsdom), and were then cloned as a plain object.
      captured.push({ request: JSON.parse(JSON.stringify(req, (_k, v: unknown) => (ArrayBuffer.isView(v) ? { __bytes: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] } : v)), (_k, v: unknown) => (v && typeof v === 'object' && '__bytes' in (v as object) ? Uint8Array.from((v as { __bytes: number[] }).__bytes) : v)) as Request });
      return original(req);
    };
    const header = rec.engine.commandLog().header;
    await CORPUS[name]!(rec);
    for (const { request: r } of captured) {
      if (r.body.kind === 'command') ISSUED.add(r.body.value.type);
      else if (r.body.kind === 'batch') for (const c of r.body.value.commands) ISSUED.add(c.type);
    }
    log = { header, records: captured };
  } finally {
    await rec.dispose();
  }

  // 2. A fresh TS engine at the log's header, and a fresh C++ engine process.
  const ts = await setupEngine();
  installAppExpressionProviders();
  ts.engine.loadDocument(log.header.document, { ids: log.header.ids, revision: log.header.revision, reason: 'resync', resetWorkspace: true });
  let native: NativeEngine | null = null;
  let cxx: ProcessEngineClient | null = null;
  // Project files: fixtures seeded into both engines; the C++ engine mirrors
  // what it saves into `portsDir`, so the saved documents can be compared.
  const portsDir = mkdtempSync(join(tmpdir(), 'premation-ce-'));
  for (const [path, make] of Object.entries(CORPUS_FIXTURES)) {
    const doc = make();
    ts.files.set(path, structuredClone(doc));
    writeFileSync(portsFile(portsDir, path), JSON.stringify(doc));
  }
  const report: SessionReport = { records: log.records.length, compared: 0, unsupported: {}, dependent: 0, mismatches: [], eventKindDiffs: [], catalogDiffs: [], tsOnlyHistory: 0, sharedEventGaps: [], finalLayers: 0, finalValues: 0, finalKeys: 0, finalTrees: 0, savedDocs: 0 };
  try {
    // --test-ports: the C++ twin of the harness's fakePorts (in-memory project
    // files, deterministic fake media), so io commands replay too.
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--test-ports-dir', portsDir] });
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

    // 3. Seed the header's compositions into the C++ engine. New Project gives
    //    both engines the same `comp_root` (the header is taken right after the
    //    harness's newProject); any other header comp is created.
    const tsDoc = await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    map.noteIds(tsDoc.comps.map((c) => c.id));
    map.noteIds(tsDoc.layers.map((l) => l.id));
    const fresh = await cxx.execute({ type: 'newProject' });
    if (!fresh.ok) throw new Error(`newProject on the C++ engine: ${fresh.error.message}`);
    for (const c of tsDoc.comps) {
      if (c.id === 'comp_root') {
        map.pair('comp_root', 'comp_root');
        continue;
      }
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
    const sentToCxx: Uint8Array[] = [];
    DUMP.push(sentToCxx);
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
      // An edit can push a history entry without moving the revision (a
      // no-op insertGap / extract): both engines do, so the model counts it.
      const historyPos = async (c: EngineClient): Promise<number> => {
        const r = await c.query({ type: 'getHistory' });
        return r.ok ? r.value.position : -1;
      };
      const tsPosBefore = isEdit ? await historyPos(ts.engine) : 0;
      const tsRes: Response = await ts.engine.request(req);
      const tsPushed = isEdit && (await historyPos(ts.engine)) > tsPosBefore;
      const tsMine = ts.batches.slice(tsBefore).filter((b) => b.causedBy === req.seq);
      const dTs = tsRes.revision - tsRev;
      tsRev = tsRes.revision;
      const where = `#${i} ${type}`;

      // An edit only the TS engine applied: a TS-only history entry.
      const tsOnlyEdit = (): void => {
        if (!isEdit || (dTs === 0 && !tsPushed)) return;
        if (gesture) gesture.ts = true;
        else pushEntry(false);
      };
      const skipDependent = (): void => {
        report.dependent += 1;
        for (const id of map.unmapped(req.body)) tainted.add(id);
        // The layers it edited changed on the TS side only, too.
        for (const id of layerRefs(req.body)) tainted.add(id);
        map.noteSource(tsRes.outcome);
        tsOnlyEdit();
      };

      // History moves over TS-only entries are not sent.
      let cxxReq: Request;
      if (cmd?.type === 'undo' || cmd?.type === 'redo') {
        const entry = cmd.type === 'undo' ? stack[pos - 1] : stack[pos];
        if (!entry) {
          // Nothing to move over: both engines must refuse it (nothingToUndo/Redo).
          if (tsRes.outcome.kind !== 'error') report.mismatches.push(`${where}: the history model has no entry to ${cmd.type}`);
          cxxReq = req;
        } else {
          pos += cmd.type === 'undo' ? -1 : 1;
          if (!entry.cxx) {
            report.tsOnlyHistory += 1;
            continue;
          }
          cxxReq = req;
        }
      } else if (cmd?.type === 'jumpToHistory') {
        const from = cxxPos(pos);
        const to = cxxPos(cmd.position);
        // A jump to where the TS engine already is: both engines answer it.
        const noop = pos === cmd.position;
        pos = cmd.position;
        if (from === to && !noop) {
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

      sentToCxx.push(encodeEngineMessage({ kind: 'request', value: cxxReq }));
      const cxxBefore = cxxBatches.length;
      const cxxPosBefore = isEdit ? await historyPos(cxx) : 0;
      const cxxRes: Response = await cxx.request(cxxReq);
      const cxxPushed = isEdit && (await historyPos(cxx)) > cxxPosBefore;
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
      // A query's ANSWER must agree too, once both documents are the same
      // document (nothing skipped yet); engine-specific facts are exempt.
      if (req.body.kind === 'query' && !tsErr && !cxxErr && !QUERY_EXEMPT.has(type) && tainted.size === 0 && report.dependent === 0 && Object.keys(report.unsupported).length === 0) {
        report.mismatches.push(...diffDeep(map.translate((tsRes.outcome as { value: unknown }).value), (cxxRes.outcome as { value: unknown }).value, where).slice(0, 8));
      }

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
      } else if (isEdit && (dTs > 0 || tsPushed)) {
        if (gesture) {
          gesture.ts = true;
          if (dCxx > 0 || cxxPushed) gesture.cxx = true;
        } else pushEntry(dCxx > 0 || cxxPushed);
      }
      if (revisionComparable && dTs !== dCxx) report.mismatches.push(`${where}: revision +${dTs} (ts) vs +${dCxx} (c++)`);
      // ONE batch per request, in both engines (§8.1), and a revision change always arrives as events.
      if (tsMine.length > 1) report.mismatches.push(`${where}: ts sent ${tsMine.length} batches`);
      if (cxxMine.length > 1) report.mismatches.push(`${where}: c++ sent ${cxxMine.length} batches`);
      if (dTs > 0 && !tsMine.some((b) => b.toRevision === tsRes.revision)) report.mismatches.push(`${where}: ts moved the revision without a batch`);
      if (dCxx > 0 && !cxxMine.some((b) => b.toRevision === cxxRes.revision)) report.mismatches.push(`${where}: c++ moved the revision without a batch`);
      const kTs = docKinds(tsMine).join(',');
      const kCxx = docKinds(cxxMine).join(',');
      if (kTs !== kCxx) {
        const detail = (bs: EventBatch[]): string => JSON.stringify(bs.flatMap((b) => b.events).filter((e) => DOC_EVENTS.has(e.type)).map((e) => (e.type === 'layersRemoved' ? { removed: e.layers } : e.type === 'layersChanged' ? { changed: e.layers.map((l) => l.id) } : e.type)));
        report.eventKindDiffs.push(`${where}: ts [${kTs}] c++ [${kCxx}] — ts ${detail(tsMine).slice(0, 400)} c++ ${detail(cxxMine).slice(0, 400)}`);
      }
      // CE_TRACE=1: one line per replayed request (debugging a divergence).
      if (process.env.CE_TRACE) console.log(`${where} ts +${dTs}${tsErr ? ` ${tsErr}` : ''} c++ +${dCxx}${cxxErr ? ` ${cxxErr}` : ''} [${kTs}|${kCxx}] ${JSON.stringify(req.body.value).slice(0, 160)}`);
    }

    // Ids no result ever named (layers inside a duplicated, assembled or
    // imported composition): both engines mint in the same order, so an
    // unpaired id both documents hold is the same entity.
    {
      const tsAll = await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      const cxxAll = await cxx.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      if (cxxAll.ok) {
        const cxxIds = new Set([...cxxAll.value.layers.map((l) => l.id), ...cxxAll.value.comps.map((c) => c.id), ...cxxAll.value.items.map((i) => i.id)]);
        for (const id of [...tsAll.layers.map((l) => l.id), ...tsAll.comps.map((c) => c.id), ...tsAll.items.map((i) => i.id)]) {
          if (!map.get(id) && cxxIds.has(id) && !map.sourceOf(id)) map.pair(id, id);
        }
      }
    }

    // 5. Each engine's events rebuilt its document (a mirror per engine).
    for (const b of ts.batches.slice(tsMirrorFrom)) tsMirror.apply(b);
    const tsFinal = await ts.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const sharedLayers = tsFinal.layers.map((l) => l.id).filter((id) => !tainted.has(id) && map.get(id));
    const sharedComps = tsFinal.comps.map((c) => c.id).filter((id) => map.get(id));
    // Every gap fails, including one BOTH mirrors show (G2 fixed the reference's
    // own gaps; `sharedEventGaps` only labels which ones both engines share).
    const tsGaps = await mirrorMismatches('ts', tsMirror, ts.engine, sharedComps, sharedLayers);
    const cxxGaps = await mirrorMismatches('c++', cxxMirror, cxx, sharedComps.map((c) => map.get(c)!), sharedLayers.map((l) => map.get(l)!));
    const body = (s: string): string => s.replace(/^(ts|c\+\+) mirror: /, '');
    const cxxBodies = new Set(cxxGaps.map(body));
    report.sharedEventGaps = tsGaps.filter((s) => cxxBodies.has(body(s))).map(body);
    report.mismatches.push(...tsGaps, ...cxxGaps);

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

        // D1b: the WHOLE layer, not just its transform — the header, the
        // property catalog (every group and property record), every
        // property's keyframes and every numeric property's evaluated value.
        if (cxl.ok) {
          const d = diffDeep(map.translate(tl.layers[0]!), cxl.value.layers[0]!, `layer ${layer}`);
          report.mismatches.push(...d.slice(0, 8));
        }
        const tt = await ts.engine.query({ type: 'getPropertyTree', layer, path: '', depth: 0 });
        const ct = await cxx.query({ type: 'getPropertyTree', layer: cl, path: '', depth: 0 });
        if (tt.ok !== ct.ok) {
          report.mismatches.push(`final: property tree of ${layer}: ts ${tt.ok ? 'ok' : 'error'} c++ ${ct.ok ? 'ok' : ct.error.message}`);
        } else if (tt.ok && ct.ok) {
          report.finalTrees += 1;
          report.mismatches.push(...diffDeep(map.translate(tt.value.nodes), ct.value.nodes, `tree ${layer}`).slice(0, 8));
          const props = tt.value.nodes.filter((n) => n.kind === 'property').map((n) => n.path);
          const tk = await ts.engine.query({ type: 'getKeyframes', props: props.map((path) => ({ layer, path })) });
          const ck = await cxx.query({ type: 'getKeyframes', props: props.map((path) => ({ layer: cl, path: map.translate(path) })) });
          if (tk.ok && ck.ok) {
            tk.value.sets.forEach((s, i) => {
              const c = ck.value.sets[i]?.keyframes ?? [];
              s.keyframes.forEach((k, j) => {
                if (map.get(k.id) === undefined && c[j] && c[j]!.time === k.time) map.pair(k.id, c[j]!.id);
              });
            });
            report.mismatches.push(...diffDeep(map.translate(tk.value.sets), ck.value.sets, `keys ${layer}`).slice(0, 8));
          }
          const numeric = tt.value.nodes.filter((n) => n.kind === 'property' && n.dimensions > 0 && ['scalar', 'vec2', 'vec3', 'vec4', 'color'].includes(n.valueType)).map((n) => n.path);
          for (const time of TIMES) {
            const tv = await ts.engine.query({ type: 'getPropertyValues', props: numeric.map((path) => ({ layer, path })), time, evaluated: true });
            const cv = await cxx.query({ type: 'getPropertyValues', props: numeric.map((path) => ({ layer: cl, path: map.translate(path) })), time, evaluated: true });
            if (tv.ok && cv.ok) {
              report.finalValues += numeric.length;
              report.mismatches.push(...diffDeep(map.translate(tv.value.values), cv.value.values, `values ${layer} @${time / sec(1)}s`).slice(0, 8));
            } else if (tv.ok !== cv.ok) {
              report.mismatches.push(`final: values of ${layer}: ts ${tv.ok ? 'ok' : tv.error.message} c++ ${cv.ok ? 'ok' : cv.error.message}`);
            }
          }
        }
      }
      // The composition record itself.
      report.mismatches.push(...diffDeep(map.translate(comp.settings), cxxInfo.value.comp.settings, `comp ${comp.id}`).slice(0, 8));
      report.mismatches.push(...diffDeep(map.translate(comp.markers), cxxInfo.value.comp.markers, `comp markers ${comp.id}`).slice(0, 8));
    }
    // Items both engines hold, project settings, the render queue.
    const cxxDoc = await cxx.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    if (cxxDoc.ok) {
      const tsItems = tsFinal.items.filter((i) => map.get(i.id) !== undefined || i.id === 'comp_root');
      const cxxItems = cxxDoc.value.items.filter((i) => tsItems.some((t) => (map.get(t.id) ?? t.id) === i.id));
      report.mismatches.push(...diffDeep(map.translate(tsItems), cxxItems, 'items').slice(0, 8));
      report.mismatches.push(...diffDeep(tsFinal.settings, cxxDoc.value.settings, 'project settings').slice(0, 8));
      report.mismatches.push(...diffDeep(map.translate(tsFinal.renderQueue), cxxDoc.value.renderQueue, 'render queue').slice(0, 8));
    }
    // The saved documents (every project file the TS replay wrote that the C++ engine wrote too).
    for (const [path, tsSaved] of ts.files) {
      if (path in CORPUS_FIXTURES) continue;
      const file = portsFile(portsDir, path);
      if (!existsSync(file)) continue;
      const cxxSaved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const tsDoc = tsSaved as unknown as Record<string, unknown>;
      for (const key of SAVED_KEYS) {
        const a = JSON.stringify(tsDoc[key]);
        const b = JSON.stringify(cxxSaved[key]);
        if (a !== b) report.mismatches.push(`saved ${path} .${key}: ts ${a?.slice(0, 300)} c++ ${b?.slice(0, 300)}`);
      }
      // Every SVG component both saved documents hold (G2 #12), byte for byte.
      const svgs = (d: Record<string, unknown>): Map<string, string> => new Map(((d.scene as { nodes?: Array<{ id: string; components?: Array<{ type: string; props: unknown }> }> } | undefined)?.nodes ?? [])
        .flatMap((n) => (n.components ?? []).filter((c) => c.type === 'svg').map((c) => [n.id, JSON.stringify(c.props)] as [string, string])));
      const cxxSvgs = svgs(cxxSaved);
      for (const [id, props] of svgs(tsDoc)) {
        const other = cxxSvgs.get(map.get(id) ?? id);
        if (other !== undefined && other !== props) report.mismatches.push(`saved ${path} svg of ${id}: ts ${props.slice(0, 400)} c++ ${other.slice(0, 400)}`);
      }
      report.savedDocs += 1;
    }
    return report;
  } finally {
    await cxx?.close();
    await native?.stop();
    await ts.dispose();
    rmSync(portsDir, { recursive: true, force: true });
  }
}

describeNative('C3: the replay corpus against both engines', () => {
  const reports: Record<string, SessionReport> = {};

  afterAll(() => {
    const dumpTo = process.env.PREMATION_DUMP_REPLAY;
    if (dumpTo) {
      const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
      const parts: Uint8Array[] = [u32(DUMP.length)];
      for (const session of DUMP) {
        parts.push(u32(session.length));
        for (const m of session) parts.push(u32(m.length), m);
      }
      writeFileSync(dumpTo, Buffer.concat(parts));
    }
    const rows = Object.entries(reports).map(([n, r]) => {
      const unsupported = Object.values(r.unsupported).reduce((a, b) => a + b, 0);
      return `${n.slice(0, 48).padEnd(48)} records ${String(r.records).padStart(3)} · compared ${String(r.compared).padStart(3)} · unsupported ${String(unsupported).padStart(3)} · dependent ${String(r.dependent).padStart(3)} · final layers ${r.finalLayers}, trees ${r.finalTrees}, values ${r.finalValues}, keys ${r.finalKeys}, saved docs ${r.savedDocs} · ts-only history ${r.tsOnlyHistory} · shared event gaps ${r.sharedEventGaps.length} · catalog diffs ${r.catalogDiffs.length} · mismatches ${r.mismatches.length} · event-kind diffs ${r.eventKindDiffs.length}`;
    });
    const unsupportedByType: Record<string, number> = {};
    for (const r of Object.values(reports)) for (const [t, n] of Object.entries(r.unsupported)) unsupportedByType[t] = (unsupportedByType[t] ?? 0) + n;
    const edits = Object.entries(COMMANDS).filter(([, c]) => c.kind === 'edit').map(([t]) => t);
    const never = edits.filter((t) => !ISSUED.has(t));
    const totals = Object.values(reports).reduce((a, r) => ({ records: a.records + r.records, compared: a.compared + r.compared, dependent: a.dependent + r.dependent, mismatches: a.mismatches + r.mismatches.length }), { records: 0, compared: 0, dependent: 0, mismatches: 0 });
    const gaps = Object.entries(reports).flatMap(([n, r]) => [...r.sharedEventGaps, ...r.eventKindDiffs].map((g) => `  ${n}: ${g}`));
    console.log(`[C3 cross-engine]\n${rows.join('\n')}\nunsupported by command: ${JSON.stringify(unsupportedByType)}\ntotals: ${JSON.stringify(totals)}\nedit commands issued ${edits.length - never.length}/${edits.length}; never issued: ${JSON.stringify(never)}${gaps.length ? `\nevent gaps (both engines) and event-kind diffs:\n${gaps.join('\n')}` : ''}`);
  });

  test.each(Object.keys(CORPUS))('%s', async (name) => {
    const r = await replaySession(name);
    reports[name] = r;
    expect(r.mismatches).toEqual([]);
    // Per request, both engines send the same document event kinds (§8.1).
    expect(r.eventKindDiffs).toEqual([]);
    if (name.startsWith('native subset')) {
      // Built from C2's command set: every request must be compared.
      expect(r.unsupported).toEqual({});
      expect(r.dependent).toBe(0);
      expect(r.compared).toBe(r.records);
      expect(r.finalLayers).toBeGreaterThanOrEqual(3);
    }
  }, 600_000);  // the property sessions replay ~3 000 requests each, with a history query per edit
});
