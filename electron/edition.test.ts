/**
 * The main process's edition gate, and the thing that keeps it agreeing with the
 * renderer's.
 *
 * Plugins (and any future capability that contacts a host we do not control)
 * must be gated HERE by not registering IPC when the matching predicate is
 * false — hiding a button in the renderer is not a gate. The assistant is on in
 * both editions; its IPC is always registered.
 *
 * There are two independent answers to "which edition is this": this file's
 * subject (`electron/edition.ts`, reading MOTION_EDITION / baked package.json)
 * and the renderer's (`src/core/config/edition.ts`, reading VITE_EDITION). The
 * parsers must agree on a shared table, and every npm script setting one env
 * var must set the other.
 */

jest.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent-app-path' } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiEnabled,
  pluginsEnabled,
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

  it('leaves the assistant on in the local edition', () => {
    process.env.MOTION_EDITION = 'local';
    __setEditionForTests(null);
    // main.ts registers AI IPC when this is true — keys, stream, cancel, image.
    // Local spends keys from the OS keystore; that is intentional BYOK, not a
    // leak of cloud-only channels.
    expect(aiEnabled()).toBe(true);
  });

  it('turns plugins off in the local edition', () => {
    process.env.MOTION_EDITION = 'local';
    __setEditionForTests(null);
    /*
      What this controls: main.ts calls `registerPluginNetIpc` and
      `installPluginPublishIpc` only when it is true, so `pluginNet:*` and the
      publish channels do not exist. Renderer-side hiding is not a gate here —
      this is the privileged end of the boundary, and `pluginNet` is one of only
      two channels in this process that reach a host we do not control. Unlike
      the assistant's, that host is chosen by a third party's manifest.
    */
    expect(pluginsEnabled()).toBe(false);
  });

  it('leaves plugins on by default, like every other capability', () => {
    // An unconfigured build behaves as it always did. A typo in a deploy env
    // must not silently ship a paying customer a build with no plugins.
    delete process.env.MOTION_EDITION;
    __setEditionForTests(null);
    expect(pluginsEnabled()).toBe(true);
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
