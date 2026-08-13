/**
 * Every IPC handler goes through the validating wrapper.
 *
 * Adding a `senderFrame` check to each of ~54 handlers by hand would have been
 * correct on the day it was written and wrong within a month — the 55th handler
 * is added by someone who has never read this file, and nothing would have told
 * them. So the check lives in one wrapper, and this is what makes the wrapper
 * unavoidable: `ipcMain.handle` and `ipcMain.on` may appear in exactly one
 * file, and it is the one that validates.
 *
 * The floor assertions matter as much as the sweep. A rename of the electron
 * directory, or of the call, would otherwise empty the search and every
 * assertion here would pass having checked nothing.
 */

/*
  ★ `electron` is mocked because IMPORTING it is what breaks, not calling it.

  This suite reads the main-process sources as TEXT; the only runtime thing it
  needs is `checkFrame`, a pure function. But `ipcGuard.ts` imports `ipcMain`
  at module scope, and the `electron` npm package's entry point resolves the
  binary through a `path.txt` written by its POSTINSTALL script. CI installs
  with `npm ci --ignore-scripts` — deliberately, since building native modules
  is the slowest and flakiest step and nothing here needs them — so that file
  is absent and the import throws "Electron failed to install correctly".

  It passed locally and failed only on CI, which is the worst shape a failure
  can have: a developer machine has run the postinstall, so the difference is
  invisible until it is a red pipeline. Note the real module would not have
  helped anyway — required from plain Node, `electron` exports the PATH STRING
  to the binary, so `ipcMain` is `undefined` here regardless. This suite passed
  only because it never touches it.

  The five sibling electron suites already mock it exactly like this; this one
  was the only file reaching the real package.
*/
jest.mock('electron', () => ({
  // Enough for `ipcGuard.ts` to load. Registering through the mock is not
  // asserted anywhere — the guarantee this file makes is about the SOURCE, and
  // stubbing more would invite someone to believe it was checked at runtime.
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFrame } from './ipcGuard';

const DIR = __dirname;

const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, src: readFileSync(join(DIR, f), 'utf8') }));

/** Strip comments — several of these files DISCUSS the calls being banned. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('IPC registration goes through one door', () => {
  it('found the main-process sources', () => {
    expect(sources.length).toBeGreaterThan(8);
  });

  it('registers every channel through the wrapper, in real numbers', () => {
    // The positive floor: if this dropped to a handful, the sweep below would
    // be passing over an app that had stopped using IPC the way it does.
    const total = sources.reduce(
      (n, { src }) => n + (code(src).match(/(?<![\w.])handle\(\s*['"]/g)?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(40);
  });

  it('calls ipcMain.handle in ipcGuard.ts and nowhere else', () => {
    const offenders = sources
      .filter(({ src }) => /\bipcMain\s*\.\s*handle\s*\(/.test(code(src)))
      .map(({ file }) => file);
    expect(offenders).toEqual(['ipcGuard.ts']);
  });

  it('calls ipcMain.on in ipcGuard.ts and nowhere else', () => {
    const offenders = sources
      .filter(({ src }) => /\bipcMain\s*\.\s*on\s*\(/.test(code(src)))
      .map(({ file }) => file);
    expect(offenders).toEqual(['ipcGuard.ts']);
  });

  it('validates inside the wrapper rather than after it', () => {
    // The wrapper must refuse BEFORE the handler body runs. A wrapper that
    // called `fn` first and checked afterwards would pass every other
    // assertion here and protect nothing.
    const guard = readFileSync(join(DIR, 'ipcGuard.ts'), 'utf8');
    const handleBody = guard.slice(guard.indexOf('export function handle'));
    const checkAt = handleBody.indexOf('checkFrame(event)');
    const callAt = handleBody.indexOf('fn(event');
    expect(checkAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(checkAt);
  });
});

/**
 * The decision itself.
 *
 * The live test — a real sandboxed child frame attempting an invoke — covers
 * the wiring. This covers what the wiring asks: a plugin panel is a CHILD
 * frame, and identity is the only reliable way to say so, because a same-origin
 * subframe has the same URL prefix as the document that embedded it.
 */
describe('who is allowed to invoke', () => {
  const mainFrame = { url: 'file:///C:/app/dist/index.html' };

  it('accepts our own top-level renderer', () => {
    expect(checkFrame({ senderFrame: mainFrame, sender: { mainFrame } })).toEqual({ ok: true });
  });

  it('accepts the dev server', () => {
    const frame = { url: 'http://localhost:5180/#/editor' };
    expect(checkFrame({ senderFrame: frame, sender: { mainFrame: frame } })).toEqual({ ok: true });
  });

  it('refuses a subframe on the SAME url', () => {
    // The plugin panel case, and the one a URL comparison would wave through.
    const child = { url: mainFrame.url };
    expect(checkFrame({ senderFrame: child, sender: { mainFrame } }))
      .toEqual({ ok: false, reason: 'subframe' });
  });

  it('refuses an opaque origin', () => {
    // A sandboxed frame without `allow-same-origin` serialises to "null" and
    // does not parse as a URL — exactly the plugin panel's frame.
    const frame = { url: 'null' };
    expect(checkFrame({ senderFrame: frame, sender: { mainFrame: frame } }))
      .toEqual({ ok: false, reason: 'foreign-url' });
  });

  it('refuses a window that has navigated somewhere else', () => {
    const frame = { url: 'https://evil.test/page' };
    expect(checkFrame({ senderFrame: frame, sender: { mainFrame: frame } }))
      .toEqual({ ok: false, reason: 'foreign-url' });
  });

  it('refuses a frame that is already gone', () => {
    // `senderFrame` is null when the frame was destroyed between send and
    // dispatch. Nothing to serve, and nothing to trust either.
    expect(checkFrame({ senderFrame: null, sender: { mainFrame } }))
      .toEqual({ ok: false, reason: 'no-frame' });
  });
});
