/**
 * User scripts (B5): a script run is ONE undo entry (`Script: <name>`, origin
 * `script`), a failing script leaves the document unchanged, permissions are
 * asked for and enforced, and control/io commands are never available.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { EngineHistoryEntry } from '@core/engine/LocalEngine';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { setupRecordingAppEngine, historyLabels } from '@core/automation/__testHelpers__/recordingAppEngine';
import { runScript, type RunScriptOptions } from './scriptHost';
import { declaredPermissions, type ScriptPermission } from './protocol';
import { InProcessScriptWorker } from './inProcessScriptWorker.testkit';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupRecordingAppEngine(); });
afterEach(async () => { await h.dispose(); });

const grantAll = (): boolean => true;
const run = (source: string, opts: RunScriptOptions = {}) =>
  runScript(source, { consent: grantAll, workerFactory: () => new InProcessScriptWorker(), ...opts });

const BUILD = `
// @permissions document.read, document.write
const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
const comp = doc.comps[0].id;
const made = [];
for (const name of ['One', 'Two', 'Three']) {
  const { layer } = await premation.execute({ type: 'createLayer', comp, kind: 'null', name, init: [] });
  made.push(layer);
}
await premation.execute({ type: 'addKeyframes', keys: [
  { prop: { layer: made[0], path: 'transform/rotation' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] },
  { prop: { layer: made[0], path: 'transform/rotation' }, time: premation.seconds(1), value: { kind: 'scalar', value: 180 }, spatialIn: [], spatialOut: [] },
] });
const names = (await premation.query({ type: 'getLayers', layers: made })).layers.map((l) => l.name);
premation.log('made', names);
return { made, names };
`;

describe('runScript', () => {
  it('runs a script as ONE undo entry with exact undo and redo', async () => {
    const before = h.doc();
    const r = await run(BUILD, { name: 'Build rig' });
    expect(r).toMatchObject({ ok: true, outcome: 'engine' });
    expect((r.value as { names: string[] }).names).toEqual(['One', 'Two', 'Three']);
    expect(r.logs).toEqual(['made ["One","Two","Three"]']);
    expect(historyLabels()).toEqual(['Script: Build rig']);
    const entry = getCommandSystem().getHistory().getEntries()[0];
    expect(entry).toBeInstanceOf(EngineHistoryEntry);
    expect((entry as EngineHistoryEntry).origin).toBe('script');
    const after = h.doc();
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(h.doc()).toBe(after);
  });

  it('a script that throws leaves the document unchanged and pushes nothing', async () => {
    const before = h.doc();
    const r = await run(`${BUILD.replace(/return[^]*$/, '')}\nthrow new Error('changed my mind');`, { name: 'Doomed' });
    expect(r).toMatchObject({ ok: false, outcome: 'rolledBack', error: 'changed my mind' });
    expect(h.doc()).toBe(before);
    expect(historyLabels()).toEqual([]);
  });

  it('an uncaught engine refusal fails the run and rolls back what came before it', async () => {
    const before = h.doc();
    const r = await run(`
      // @permissions document.read, document.write
      const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Kept?', init: [] });
      await premation.execute({ type: 'renameLayer', layer: 'no_such_layer', name: 'x' });
    `);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^notFound/);
    expect(h.doc()).toBe(before);
    expect(historyLabels()).toEqual([]);
  });

  it('a refusal the script CATCHES is just a value; the rest commits', async () => {
    const r = await run(`
      // @permissions document.read, document.write
      const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      let code = '';
      try { await premation.execute({ type: 'renameLayer', layer: 'nope', name: 'x' }); } catch (e) { code = e.code; }
      await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'After', init: [] });
      return code;
    `, { name: 'Tolerant' });
    expect(r).toMatchObject({ ok: true, value: 'notFound', outcome: 'engine' });
    expect(historyLabels()).toEqual(['Script: Tolerant']);
  });

  it('asks for exactly the declared permissions, and runs nothing when refused', async () => {
    const asked: ScriptPermission[][] = [];
    const before = h.doc();
    const r = await run(BUILD, { consent: (req) => { asked.push([...req.permissions]); return false; } });
    expect(asked).toEqual([['document.read', 'document.write']]);
    expect(r.outcome).toBe('refused');
    expect(h.doc()).toBe(before);
  });

  it('a read-only grant refuses writes (and the run rolls back)', async () => {
    const before = h.doc();
    const r = await run(BUILD, { permissions: ['document.read'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('document.write');
    expect(h.doc()).toBe(before);
  });

  it('never exposes control or io commands (undo, gestures, save)', async () => {
    for (const cmd of [
      "{ type: 'undo' }",
      "{ type: 'beginGesture', label: 'x' }",
      "{ type: 'saveProject', copy: false }",
    ]) {
      const r = await run(`// @permissions document.read, document.write\nawait premation.execute(${cmd});`);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('scripts send edit commands only');
    }
  });

  it('times out a script that never finishes, and rolls it back', async () => {
    const before = h.doc();
    const r = await run(`
      // @permissions document.read, document.write
      const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Hang', init: [] });
      await new Promise(() => {});
    `, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, outcome: 'rolledBack' });
    expect(r.error).toContain('ran longer');
    expect(h.doc()).toBe(before);
  });

  it('delivers change events to a read-permitted script', async () => {
    const r = await run(`
      // @permissions document.read, document.write
      const seen = [];
      premation.onEvents((b) => seen.push(...b.events.map((e) => e.type)));
      const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
      await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'E', init: [] });
      for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      return seen.length > 0;
    `);
    expect(r).toMatchObject({ ok: true, value: true });
  });
});

describe('the sandbox boundary', () => {
  it('only the worker (and the test worker) import the runtime that evaluates script source', () => {
    const root = join(__dirname, '..', '..');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) &&/scriptRuntime'/.test(readFileSync(p, 'utf8'))) {
          importers.push(relative(root, p).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(importers.sort()).toEqual(['core/scripting/inProcessScriptWorker.testkit.ts', 'core/scripting/scriptWorker.ts']);
  });
});

describe('declaredPermissions', () => {
  it('reads the header, ignores unknown words, defaults to read-only', () => {
    expect(declaredPermissions('// @permissions document.write, network\nx')).toEqual(['document.write']);
    expect(declaredPermissions('return 1;')).toEqual(['document.read']);
  });
});
