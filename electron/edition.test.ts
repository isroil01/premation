/**
 * The main process's edition gate, and the thing that keeps it agreeing with the
 * renderer's.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 *
 * The local edition hides the assistant. Hiding it in the RENDERER while
 * `ai:stream` stays registered in main is not a gate — the renderer is the
 * untrusted side of that boundary, and a plugin panel, an imported document or
 * the DevTools console of a packaged build can invoke any channel this process
 * registers regardless of what the UI draws. So the gate is "the channel does not
 * exist", and this file asserts that.
 *
 * ── The §2·0 half ───────────────────────────────────────────────────────────
 *
 * There are now two independent answers to "which edition is this": this file's
 * subject (`electron/edition.ts`, reading MOTION_EDITION / baked package.json)
 * and the renderer's (`src/core/config/edition.ts`, reading VITE_EDITION). They
 * are separate because a Vite define does not exist in the main process — but
 * separate readers with nothing forcing agreement is exactly the shape that keeps
 * producing bugs on this project. Two assertions below force it: the parsers must
 * agree on a shared table, and every npm script setting one env var must set the
 * other.
 */

jest.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent-app-path' } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiEnabled,
  getEdition,
  isLocalEdition,
  parseEdition,
  assertRendererEditionMatches,
  __setEditionForTests,
} from './edition';
import { parseEdition as parseRendererEdition } from '../src/core/config/edition';

describe('the main process resolves its own edition', () => {
  const savedEnv = process.env.MOTION_EDITION;
  afterEach(() => {
    __setEditionForTests(null);
    if (savedEnv === undefined) delete process.env.MOTION_EDITION;
    else process.env.MOTION_EDITION = savedEnv;
  });

  it('defaults to server when nothing says otherwise', () => {
    // The same default as the renderer, for the same reason: a typo in a deploy
    // env must not silently ship a paying customer a build with no assistant.
    delete process.env.MOTION_EDITION;
    __setEditionForTests(null);
    expect(getEdition()).toBe('server');
    expect(aiEnabled()).toBe(true);
  });

  it('reads MOTION_EDITION', () => {
    process.env.MOTION_EDITION = 'local';
    __setEditionForTests(null);
    expect(getEdition()).toBe('local');
    expect(isLocalEdition()).toBe(true);
  });

  it('turns the assistant off in the local edition', () => {
    process.env.MOTION_EDITION = 'local';
    __setEditionForTests(null);
    // What this actually controls: main.ts calls registerAiKeyIpc and
    // registerAiProxyIpc only when this is true, so `aiKeys:*`, `ai:stream` and
    // `ai:cancel` are never registered. An invoke against them rejects with "no
    // handler", which is the honest answer — not a soft refusal a caller could
    // mistake for a transient failure and retry.
    expect(aiEnabled()).toBe(false);
  });

  it('survives an unreadable packaged manifest', () => {
    // app.getAppPath() is mocked to a path that does not exist. An unreadable
    // manifest must fall through to the default, not throw during app boot.
    delete process.env.MOTION_EDITION;
    __setEditionForTests(null);
    expect(() => getEdition()).not.toThrow();
    expect(getEdition()).toBe('server');
  });
});

describe('the two edition readers cannot drift apart', () => {
  /**
   * Inputs where a disagreement would actually ship something wrong. The `oss`
   * alias and the trim/case handling are the parts most likely to be "fixed" in
   * one file and not the other.
   */
  const CASES = ['local', 'oss', 'LOCAL', ' local ', 'server', '', ' ', 'lokal', 'production', undefined, null];

  it.each(CASES.map((c) => [JSON.stringify(c) ?? 'undefined', c]))(
    'main and renderer parse %s identically',
    (_label, input) => {
      expect(parseEdition(input as string | undefined | null))
        .toBe(parseRendererEdition(input as string | undefined | null));
    },
  );

  describe('the npm scripts set both halves', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    const localScripts = Object.entries(pkg.scripts).filter(([, cmd]) =>
      cmd.includes('VITE_EDITION=local'),
    );

    it('finds the :local scripts it is meant to be checking', () => {
      // Guards the guard: a rename would otherwise make every case below vacuous.
      expect(localScripts.length).toBeGreaterThanOrEqual(4);
    });

    it.each(localScripts)(
      '%s sets MOTION_EDITION alongside VITE_EDITION',
      (_name, cmd) => {
        // The realistic failure: someone adds a `:local` variant and sets only
        // the Vite half, producing a build whose UI hides the assistant while its
        // main process still serves AI IPC.
        expect(cmd).toContain('MOTION_EDITION=local');
      },
    );

    it.each(['pack:local', 'dist:local'])(
      '%s bakes the edition into the packaged manifest',
      (name) => {
        // Env vars do not survive into a shipped .exe/.app. electron-builder's
        // extraMetadata writes `edition` into the packaged package.json, which is
        // the only signal `getEdition()` can read there.
        expect(pkg.scripts[name]).toContain('--config.extraMetadata.edition=local');
      },
    );
  });

  describe('the runtime handshake', () => {
    afterEach(() => __setEditionForTests(null));

    it('accepts a renderer that agrees', () => {
      __setEditionForTests('local');
      expect(assertRendererEditionMatches('local').ok).toBe(true);
    });

    it('reports a renderer that disagrees, without throwing', () => {
      // Deliberately not fatal: killing the app over a misconfigured build turns
      // it into an unlaunchable one, and the user can fix neither.
      __setEditionForTests('local');
      const result = assertRendererEditionMatches('server');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('EDITION MISMATCH');
    });
  });
});
