/**
 * The renderer does not hold the session token, and nothing may quietly give it
 * one back.
 *
 * This is the architectural guard for Track A, written in the same pass as the
 * deletion it protects — deliberately, because a convenience getter reappears
 * within a month otherwise, and it reappears for a good local reason every
 * time. "Just for the upload progress." "Only in dev." Each one is individually
 * reasonable and each one restores the exact hole: a renderer that can ask for
 * the credential is a renderer that holds the credential, and every compromised
 * dependency in this bundle holds it too.
 *
 * Same shape as `noHostRealmEval.test.ts`: the file list is DERIVED from
 * directories rather than listed, with a floor assertion, so a rename cannot
 * empty the sweep into a vacuous pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const ELECTRON = join(__dirname, '..', '..', '..', 'electron');

/** Renderer-realm source, minus tests and type declarations. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue;
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    if (entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const rendererFiles = walk(SRC);
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const rel = (p: string): string => p.slice(SRC.length + 1).replace(/\\/g, '/');

/**
 * The one renderer file allowed to name a credential storage key.
 *
 * It is the browser build's session, which has nowhere else to live — there is
 * no main process in a browser. Everything about that is stated in the file and
 * in `docs/PLUGINS.md` §3; what this test enforces is that it stays ONE file.
 */
const WEB_SESSION_FILE = 'core/api/session.ts';

/**
 * The purge, which has to name the keys it deletes.
 *
 * Allowed to mention them, and asserted separately never to READ one — a file
 * that removes a credential and a file that holds one are different things,
 * and the difference is exactly `getItem`.
 */
const PURGE_FILE = 'core/api/purgeLocalKeys.ts';

describe('no renderer file holds a credential', () => {
  it('found the renderer tree', () => {
    // Without this, a moved directory would empty `rendererFiles` and every
    // assertion below would pass having read nothing.
    expect(rendererFiles.length).toBeGreaterThan(300);
  });

  it('names a token storage key in exactly one place', () => {
    const offenders = rendererFiles.filter((file) => {
      if (rel(file) === WEB_SESSION_FILE || rel(file) === PURGE_FILE) return false;
      const src = code(readFileSync(file, 'utf8'));
      // The literal key strings. A file that reads or writes one is a file
      // holding a credential, whatever it calls the variable.
      return /['"`]motion-editor\.(auth-token|refresh-token)['"`]/.test(src)
        || /motion_editor_local_ai_key/.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('lets the purge name keys, but never read one', () => {
    const src = code(readFileSync(join(SRC, PURGE_FILE), 'utf8'));
    // It enumerates `localStorage.key(i)` and removes; it must never fetch a
    // value. A purge that reads is a purge that could log or upload.
    expect({ reads: /localStorage\.getItem/.test(src) }).toEqual({ reads: false });
    expect({ removes: /localStorage\.removeItem/.test(src) }).toEqual({ removes: true });
  });

  it('never reads a provider key from storage', () => {
    // The AI vault is write-only in main and has no read-back verb. A renderer
    // file that reads one from anywhere has either found a second copy or
    // reintroduced the verb; both are the same defect.
    const offenders = rendererFiles.filter((file) => {
      const src = code(readFileSync(file, 'utf8'));
      return /\bai\??\.keys\??\.get\b/.test(src) || /\bgetKeyForProvider\b/.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('builds no Authorization header outside the one browser-build path', () => {
    /*
      The header is attached in MAIN on desktop. A renderer file constructing
      one has a bearer in hand, which means it got it from somewhere — and the
      only place left to get it is the browser fallback.
    */
    const allowed = new Set([WEB_SESSION_FILE, 'core/api/transport.ts', 'core/api/streamRequest.ts']);
    const offenders = rendererFiles.filter((file) => {
      if (allowed.has(rel(file))) return false;
      const src = code(readFileSync(file, 'utf8'));
      return /Authorization\s*:\s*[`'"]Bearer/.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('the bridge exposes no credential-returning verb', () => {
  // Comments stripped: this file and the contract both DISCUSS the verbs that
  // must not exist, and a guard that its own explanation trips is a guard
  // people delete rather than satisfy.
  const preload = code(readFileSync(join(ELECTRON, 'preload.ts'), 'utf8'));
  const contract = code(readFileSync(join(SRC, 'types', 'motionEditor.d.ts'), 'utf8'));

  it('has no credentials channel at all', () => {
    // Deleted, not deprecated. A channel that still exists is a channel someone
    // can call, and a deprecation comment stops nobody.
    expect(preload).not.toMatch(/credentials\s*:/);
    expect(preload).not.toContain("'credentials:get'");
    expect(contract).not.toMatch(/^\s*credentials\?:/m);
  });

  it('exposes no getToken-shaped verb under any name', () => {
    const suspicious = /\b(getToken|getAccessToken|getRefreshToken|getCredentials|readToken)\b/;
    expect({ preload: suspicious.test(preload) }).toEqual({ preload: false });
    expect({ contract: suspicious.test(contract) }).toEqual({ contract: false });
  });

  it('declares auth verbs that return a status rather than a token', () => {
    // The positive half. Without it, a bridge that lost `auth` entirely — and
    // therefore signed nobody in — would also pass the assertions above.
    expect(preload).toContain("'auth:status'");
    expect(preload).toContain("'auth:signIn'");
    expect(preload).toContain("'auth:signOut'");
    expect(contract).toMatch(/status\?\(\):\s*Promise<AuthStatus>/);
  });

  it('keeps the session token out of the AuthStatus shape', () => {
    const shape = contract.slice(contract.indexOf('export interface AuthStatus'));
    const body = shape.slice(0, shape.indexOf('}'));
    expect(/token|secret|credential/i.test(body)).toBe(false);
  });
});

describe('main is the only realm that holds a token', () => {
  const session = readFileSync(join(ELECTRON, 'apiSession.ts'), 'utf8');
  const proxy = readFileSync(join(ELECTRON, 'apiProxy.ts'), 'utf8');

  it('never returns the access token from an IPC handler', () => {
    // `currentAccessToken` is the accessor `apiProxy` uses to build a header.
    // It must appear inside `sendWithAuth` and nowhere near a handler's return.
    const handlers = proxy.slice(proxy.indexOf('export function registerApiProxyIpc'));
    expect(handlers).not.toContain('currentAccessToken');
  });

  it('keeps the refresh token out of every exported signature', () => {
    // A function that returns it is a function an IPC handler can be pointed
    // at tomorrow. The store's own read is internal (`readStoredCredentials`
    // lives in credentialStore and is not re-exported here).
    expect(session).not.toMatch(/export\s+function\s+\w*[Rr]efreshToken\s*\(/);
    expect(session).not.toMatch(/export\s+const\s+\w*[Rr]efreshToken\b/);
  });

  it('has a credential store with no IPC surface of its own', () => {
    const store = readFileSync(join(ELECTRON, 'credentialStore.ts'), 'utf8');
    expect(store).not.toContain('ipcMain');
  });
});
