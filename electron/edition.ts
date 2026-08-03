/**
 * Which edition the MAIN process is running as.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * The renderer already knows its edition: `src/core/config/edition.ts` holds it,
 * and `src/main.tsx` sets it at boot from `import.meta.env.VITE_EDITION`. That is
 * a Vite define — it is substituted into the RENDERER bundle at build time and
 * does not exist in this process. `npm run electron:build:local` and
 * `npm run electron:build` compile main with the same `tsc` invocation and
 * produce byte-identical main bundles, so nothing here could tell the two apart.
 *
 * That was fine while the two editions had the same IPC surface. It stopped
 * being fine when the local edition stopped shipping the assistant: hiding the
 * AI panel in the renderer while `ai:stream` stays registered in main is not a
 * gate, it is a curtain. The renderer is the untrusted side of this boundary —
 * a plugin panel, an imported document, or someone typing in DevTools can invoke
 * any channel this process registers, whatever the UI chooses to render. So the
 * gate has to be enforced HERE, by not registering the channels at all.
 *
 * ── The two-readers problem, and what forces them to agree ──────────────────
 *
 * There are now two independent answers to "which edition is this" — this file
 * and the renderer's. Nothing in the type system makes them agree, and a build
 * where they disagree is exactly the bug this gate is meant to prevent: a
 * renderer that hides the AI panel over a main process that still serves it.
 *
 * Two things hold them together, deliberately at different layers:
 *
 *  • `editionScripts.test.ts` asserts that every package.json script setting
 *    `VITE_EDITION=local` also sets `MOTION_EDITION=local`, and that the
 *    packaging scripts bake the same value. That catches the realistic failure —
 *    someone adds a `dist:local:foo` script and sets only the Vite half.
 *
 *  • `assertRendererEditionMatches` below is invoked over IPC on first paint. If
 *    the renderer reports an edition this process disagrees with, the build is
 *    misconfigured in a way no test caught, and it says so loudly rather than
 *    silently serving AI IPC to a UI that thinks it is offline.
 *
 * ── Resolution order ────────────────────────────────────────────────────────
 *
 *  1. `MOTION_EDITION` env — set by the `:local` npm scripts, and by CI.
 *  2. The packaged app's own package.json `edition` field, written by
 *     electron-builder's `extraMetadata` in `pack:local` / `dist:local`. This is
 *     the one that survives into a shipped .exe/.app, where no env var does.
 *  3. Default `'server'` — same default as the renderer, for the same reason: an
 *     unconfigured build must behave as it always did, and a typo in a deploy
 *     env must not silently ship a paying customer a build with no assistant.
 */

import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Edition = 'server' | 'local';

/**
 * Parse an env string into an edition.
 *
 * Intentionally identical to `parseEdition` in `src/core/config/edition.ts`,
 * including the `oss` alias and the trim/lowercase. `editionParity.test.ts`
 * asserts the two agree on a shared table of inputs — this is duplicated rather
 * than imported because `electron/tsconfig.json` compiles this directory alone,
 * and reaching into `src/` would drag the renderer's module graph into main.
 */
export function parseEdition(raw: string | undefined | null): Edition {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'local' || v === 'oss' ? 'local' : 'server';
}

let cached: Edition | null = null;

/** The packaged app's package.json `edition`, or undefined outside a package. */
function bakedEdition(): string | undefined {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { edition?: unknown };
    return typeof pkg.edition === 'string' ? pkg.edition : undefined;
  } catch {
    // No package.json, unreadable, or malformed. Fall through to the default;
    // an unreadable manifest must not be the thing that decides an edition.
    return undefined;
  }
}

export function getEdition(): Edition {
  if (cached === null) {
    cached = process.env.MOTION_EDITION
      ? parseEdition(process.env.MOTION_EDITION)
      : parseEdition(bakedEdition());
  }
  return cached;
}

export function isLocalEdition(): boolean {
  return getEdition() === 'local';
}

export function isServerEdition(): boolean {
  return getEdition() === 'server';
}

/** Test seam. Not called by app code — `getEdition` resolves once and caches. */
export function __setEditionForTests(next: Edition | null): void {
  cached = next;
}

/**
 * The assistant, in this process.
 *
 * Mirrors `aiEnabled()` on the renderer side, and gates the same thing from the
 * privileged end: when this is false, `registerAiKeyIpc` and `registerAiProxyIpc`
 * are never called, so `aiKeys:*`, `ai:stream` and `ai:cancel` do not exist as
 * channels. An `ipcRenderer.invoke` against them rejects with "No handler
 * registered", which is the correct answer — not a soft refusal that a caller
 * could mistake for a transient failure and retry.
 *
 * This is also what preserves the local edition's network story: `aiProxy` is the
 * only code in this app that contacts a third-party host, and it is unreachable
 * when this is false.
 */
export const aiEnabled = (): boolean => isServerEdition();

/**
 * Shout if the renderer's edition disagrees with this process's.
 *
 * Returns the mismatch rather than throwing: killing the app over this would
 * turn a misconfigured build into an unlaunchable one, and the user cannot fix
 * either. Logging loudly and letting the (stricter) main-process gate stand is
 * the safer failure — the renderer may show an AI panel whose IPC is absent,
 * which is visible and reportable, rather than the reverse.
 */
export function assertRendererEditionMatches(reported: unknown): { ok: boolean; message?: string } {
  const rendererEdition = parseEdition(typeof reported === 'string' ? reported : undefined);
  const mainEdition = getEdition();
  if (rendererEdition === mainEdition) return { ok: true };
  const message =
    `EDITION MISMATCH: the renderer reports '${rendererEdition}' but the main process ` +
    `resolved '${mainEdition}'. The build is misconfigured — a :local script probably set ` +
    `VITE_EDITION without MOTION_EDITION (see electron/edition.ts). Main-process gates win, ` +
    `so AI IPC is ${aiEnabled() ? 'REGISTERED' : 'ABSENT'} regardless of what the UI shows.`;
  return { ok: false, message };
}
