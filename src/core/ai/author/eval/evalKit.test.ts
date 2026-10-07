/**
 * The eval harness's pure parts, which must work before the harness can be
 * trusted: replay serves what was recorded in order and notices when the
 * requests changed; the recorder keeps every chunk; the contact sheet tiles
 * frames; a judge's verdict is valid whatever came back; the compare script
 * reads artifacts and prints the table.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TransportRequest } from '../../aiTransport';
import { anthropicStream } from '../../__testHelpers__/scriptedTransport';
import { contactSheet, decodePng, sampleTimes } from './contactSheet';
import { EVAL_CASES } from './evalPrompts';
import { coerceVerdict } from './judges';
import { emptyFixture, recordingTransport, replayTransport, requestKey } from './recordReplay';

const req = (user: string, system = 'sys', images = 0): TransportRequest => ({
  provider: 'anthropic',
  model: 'm',
  body: {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }, ...Array.from({ length: images }, () => ({ type: 'image', source: { data: 'x' } }))] }],
  },
});

async function drain(g: AsyncGenerator<string, void, undefined>): Promise<string> {
  let s = '';
  for await (const c of g) s += c;
  return s;
}

describe('record / replay', () => {
  it('records every chunk in order and replays them back', async () => {
    const fixture = emptyFixture('anthropic', 'm');
    const send = async function* () { yield* anthropicStream({ text: '{"a":1}' }); };
    const rec = recordingTransport(fixture, send);
    const first = await drain(rec(req('one'), new AbortController().signal));
    await drain(rec(req('two'), new AbortController().signal));
    expect(fixture.entries.map((e) => e.hint)).toEqual(['user: one', 'user: two']);

    const r = replayTransport(fixture, true);
    expect(await drain(r.transport(req('one'), new AbortController().signal))).toBe(first);
    await drain(r.transport(req('two'), new AbortController().signal));
    expect(r.served()).toBe(2);
    expect(r.mismatches).toEqual([]);
  });

  it('keys on text, not images — a re-render does not invalidate a fixture', () => {
    expect(requestKey(req('look', 'critic', 1))).toBe(requestKey(req('look', 'critic', 3)));
    expect(requestKey(req('look', 'critic'))).not.toBe(requestKey(req('look!', 'critic')));
  });

  it('strict replay refuses a changed request and one past the end; lenient replay warns and serves', async () => {
    const fixture = emptyFixture('anthropic', 'm');
    fixture.entries.push({ key: requestKey(req('one')), hint: 'one', chunks: ['x'] });
    const strict = replayTransport(fixture, true);
    await expect(drain(strict.transport(req('changed'), new AbortController().signal))).rejects.toThrow(/changed since it was recorded/);
    await expect(drain(strict.transport(req('more'), new AbortController().signal))).rejects.toThrow(/past the end/);
    const lenient = replayTransport(fixture, false);
    expect(await drain(lenient.transport(req('changed'), new AbortController().signal))).toBe('x');
    expect(lenient.mismatches).toHaveLength(1);
  });
});

describe('contact sheet', () => {
  const { PNG } = require('pngjs') as { PNG: { new (o: { width: number; height: number }): { data: Buffer }; sync: { write(p: unknown): Buffer } } };
  const solid = (w: number, h: number, rgb: [number, number, number]): Uint8Array => {
    const p = new PNG({ width: w, height: h }) as unknown as { data: Buffer; width: number; height: number };
    for (let i = 0; i < w * h; i++) p.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    return new Uint8Array(PNG.sync.write(p));
  };

  it('tiles frames in reading order at their aspect, with a time bar under each', () => {
    const frames = [solid(16, 9, [255, 0, 0]), solid(16, 9, [0, 255, 0]), solid(16, 9, [0, 0, 255]), solid(16, 9, [255, 255, 0]), solid(16, 9, [0, 255, 255])]
      .map((png, i) => ({ png, t: i }));
    const sheet = decodePng(contactSheet(frames, 5, 4, 160));
    // 4 columns of 160 + padding; two rows of 90-high cells.
    expect(sheet.width).toBe(4 * (160 + 6) + 6);
    const at = (x: number, y: number) => Array.from(sheet.data.slice((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 3));
    expect(at(6 + 10, 6 + 10)).toEqual([255, 0, 0]);
    expect(at(6 + 166 + 10, 6 + 10)).toEqual([0, 255, 0]);
    // The fifth frame wraps to the second row.
    expect(at(6 + 10, 6 + 90 + 4 + 12 + 6 + 10)).toEqual([0, 255, 255]);
  });

  it('samples evenly and stays a frame short of the end', () => {
    expect(sampleTimes(4, 25, 5)).toEqual([0, 0.99, 1.98, 2.97, 3.96]);
  });
});

describe('judges', () => {
  it('clamps scores, drops junk, and averages what is present', () => {
    const v = coerceVerdict('craft', { scores: { typography: 12, layout: '6', colour: 'great', motion: 0 }, biggestProblem: 'flat' });
    expect(v.scores).toEqual({ typography: 10, layout: 6, motion: 1 });
    expect(v.mean).toBe(5.67);
    expect(Number.isNaN(coerceVerdict('fit', null).mean)).toBe(true);
  });
});

describe('eval cases', () => {
  it('has fifteen uniquely named cases with real frames and durations', () => {
    expect(EVAL_CASES).toHaveLength(15);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(15);
    for (const c of EVAL_CASES) expect(c.width > 0 && c.height > 0 && c.durationSec > 0 && c.fps > 0).toBe(true);
  });
});

describe('scripts/ai-eval/compare.mjs', () => {
  const script = path.resolve(__dirname, '../../../../../scripts/ai-eval/compare.mjs');
  const artifact = (c: string, mode: string, craft: number, fit: number, calls: number) => ({
    case: c, mode, toolCalls: calls, pathFailures: mode === 'library' ? ['caster: x'] : [],
    judges: [{ judge: 'craft', mean: craft }, { judge: 'fit', mean: fit }],
  });

  it('compares the two modes of one run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-'));
    fs.writeFileSync(path.join(dir, 'a.author.json'), JSON.stringify(artifact('a', 'author', 8, 7, 120)));
    fs.writeFileSync(path.join(dir, 'a.library.json'), JSON.stringify(artifact('a', 'library', 5, 4, 60)));
    fs.writeFileSync(path.join(dir, 'b.author.json'), JSON.stringify(artifact('b', 'author', 5, 5, 90)));
    fs.writeFileSync(path.join(dir, 'b.library.json'), JSON.stringify(artifact('b', 'library', 6, 6, 70)));
    const r = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout) as { wins: Record<string, number>; means: Record<string, number> };
    expect(s.wins).toEqual({ a: 1, b: 1, tie: 0 });
    expect(s.means.aCraft).toBe(6.5);
    expect(s.means.bFailures).toBe(1);
    const table = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' }).stdout;
    expect(table).toContain('| a | 8 | 5 | 7 | 4 | 120 | 60 | 0 | 1 |');
    expect(table).toContain('Wins on mean judge score: author 1, library 1, ties 0.');
  });
});
