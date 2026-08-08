/**
 * A row's status must follow the host WITHOUT a remount.
 *
 * Reported as "it says Starting… forever, then shows the right thing if I leave
 * the page and come back" — the signature of a stale memo, not a missing
 * subscription. `PluginsList` did subscribe to the host and did re-render; but
 * the memo that builds the rows called `pluginHost.info()` while listing only
 * the STORE's plugin array among its dependencies. A plugin finishing its boot
 * moves the host and not the store, so every dependency was identical, the memo
 * handed back the rows it built before, and the status stayed stale until a
 * remount rebuilt it from scratch.
 *
 * ── Why this is a source assertion ───────────────────────────────────────────
 *
 * The behavioural version needs a real worker to boot and then finish, inside a
 * jsdom render, and its failure mode is a timing race rather than a wrong
 * answer. Worse, the obvious shape of it — render, change the host, re-render,
 * compare — passes with the bug PRESENT, because re-rendering a fresh tree is
 * exactly what used to hide it. A first attempt here did that and asserted the
 * status had not changed, which is true either way and proves nothing.
 *
 * So this pins the wiring instead: reading `pluginHost.info()` inside a memo is
 * correct only if the host's revision is one of that memo's dependencies. That
 * is the whole fix, it is checkable, and it cannot pass by coincidence.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'PluginsList.tsx'), 'utf-8');

it('reads the host revision through useSyncExternalStore', () => {
  // Subscribing without keeping the value is the state the bug shipped in.
  expect(src).toMatch(/const\s+hostRevision\s*=\s*useSyncExternalStore/);
});

it('★ feeds that revision to the memo that reads pluginHost.info()', () => {
  const memo = /\}, \[installedPlugins[^\]]*\]\);/.exec(src)?.[0];
  expect(memo).toBeDefined();
  expect(memo).toContain('hostRevision');
});

it('the rows memo is in fact the thing that reads the host', () => {
  // Guards the assertion above from going vacuous: if `info()` moved out of
  // this memo, the dependency would stop being the thing that matters and this
  // file would be pinning a rule about nothing.
  const memoBody = /const rows = useMemo<Row\[\]>\(\(\) => \{[\s\S]*?\}, \[installedPlugins[^\]]*\]\);/.exec(src)?.[0];
  expect(memoBody).toBeDefined();
  expect(memoBody).toContain('pluginHost.info(');
});
