/**
 * The editor must not send users to routes that its edition does not register.
 *
 * WHY THIS EXISTS. The assistant panel's "Connect an AI provider to start"
 * banner linked to `#/dashboard?tab=settings`. `AppRouter` registers
 * `/dashboard` only under `cloudProjectsEnabled()`, which is FALSE in the local
 * (OSS) edition — so the link fell through the router's catch-all to `/`, which
 * that edition redirects straight back to `/editor`. Clicking it returned you
 * to where you already were.
 *
 * The cost was not cosmetic: `AiSettingsSection` was mounted only on the
 * dashboard, so it was the sole place to enter an API key, and the OSS
 * edition's headline is "the full editor, with your own API key". The feature
 * was unreachable in the build it mattered most to.
 *
 * `src/layout` is the editor shell — it renders in BOTH editions. Anything it
 * links to must exist in both. Account-only pages (`src/pages/AuthPage`,
 * `OAuthCallbackPage`, `VerifyEmailPage`) are exempt by construction: they are
 * themselves registered only when accounts are on, so they may reference
 * sibling account routes freely.
 *
 * IF THIS FAILS, you have linked the editor at a page that half your users
 * cannot reach. Open an in-app surface instead — see `openAiSettings()` in
 * CustomizeDialog, which is what replaced this exact link.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const LAYOUT_ROOT = resolve(__dirname, '..');

/** Routes AppRouter registers conditionally, and the flag that gates each. */
const EDITION_GATED_ROUTES: ReadonlyArray<{ route: string; gate: string }> = [
  { route: '/dashboard', gate: 'cloudProjectsEnabled()' },
  { route: '/login', gate: 'cloudAccountsEnabled()' },
  { route: '/register', gate: 'cloudAccountsEnabled()' },
  { route: '/verify-email', gate: 'cloudAccountsEnabled()' },
  { route: '/oauth', gate: 'cloudAccountsEnabled()' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Strip comments before matching.
 *
 * The fix for the original bug left a comment quoting the dead link, which is
 * exactly the context a future reader needs — and would otherwise trip this
 * test and get deleted to make it pass.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the editor shell only links to routes every edition has', () => {
  const files = sourceFiles(LAYOUT_ROOT);

  it('finds the layout sources it is meant to be scanning', () => {
    // Guards the guard: an empty scan would pass every assertion below.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(EDITION_GATED_ROUTES.map((r) => [r.route, r.gate]))(
    'no src/layout file navigates to %s (registered only under %s)',
    (route) => {
      const offenders = files.filter((f) => {
        const code = stripComments(readFileSync(f, 'utf8'));
        // Both forms AppRouter can be reached by: a hash href, and a
        // react-router path passed to navigate()/<Navigate to=…>.
        return code.includes(`#${route}`) || new RegExp(`['"\`]${route}(['"\`?])`).test(code);
      });
      expect(offenders.map((f) => f.slice(LAYOUT_ROOT.length + 1))).toEqual([]);
    },
  );
});
