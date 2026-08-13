/**
 * The frame guard, against real frames.
 *
 * `electron/ipcRegistration.test.ts` asserts the DECISION against synthetic
 * events, and asserts structurally that no handler can be registered outside
 * `ipcGuard`. Neither of those can tell you that the decision is reached with
 * the objects Electron actually passes at runtime — `senderFrame`,
 * `sender.mainFrame`, and the identity relationship between them. That claim
 * needed a real main process, and until now it was stated as unproven.
 *
 * The harness this drives is configured deliberately WORSE than the app: it
 * turns on `nodeIntegrationInSubFrames` and gives every frame a working invoke
 * bridge. In the shipping configuration a subframe has no `ipcRenderer` at all,
 * so a test against the real app would pass with the guard deleted. Here the
 * bridge is present everywhere, and anything refused is the guard refusing it.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Frame } from '@playwright/test';
import { join } from 'node:path';

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, 'harness', 'main.cjs')],
    // Keep the harness out of the developer's real Electron profile.
    env: { ...process.env, NODE_ENV: 'test' },
  });
});

test.afterAll(async () => {
  await app?.close();
});

/** Resolve a frame by its `name`, once it has loaded. */
async function frameByName(name: string): Promise<Frame> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect
    .poll(() => page.frames().some((f) => f.name() === name), { timeout: 10_000 })
    .toBe(true);
  const frame = page.frames().find((f) => f.name() === name);
  if (!frame) throw new Error(`frame ${name} never appeared`);
  return frame;
}

type PingResult = { resolved?: { ok: boolean; url: string | null }; rejected?: string };

const ping = (target: { evaluate: Frame['evaluate'] }): Promise<PingResult> =>
  target.evaluate(() => (window as unknown as { harness: { ping(): Promise<PingResult> } }).harness.ping());

test('the top-level renderer is served', async () => {
  /*
    The control. Without it a guard that refused EVERYTHING would pass every
    other assertion in this file, and the app would simply not work.
  */
  const page = await app.firstWindow();
  const result = await ping(page);

  expect(result.rejected).toBeUndefined();
  expect(result.resolved?.ok).toBe(true);
});

test('★ a SAME-ORIGIN subframe is refused', async () => {
  /*
    The assertion that only a real frame can make.

    This child's URL shares the top frame's `file://` prefix, so every check
    based on comparing URLs — the obvious implementation, and the one that looks
    correct in review — lets it straight through. Only comparing
    `event.senderFrame` against `event.sender.mainFrame` by IDENTITY refuses it.

    It has a working `ipcRenderer` here, because the harness gave it one. In
    production it would not, and that is precisely why this test exists: the
    protection has to be the guard, not the preload's reach.
  */
  const frame = await frameByName('same-origin');
  const result = await ping(frame);

  expect(result.resolved).toBeUndefined();
  expect(result.rejected).toContain('is not available from this frame');
});

test('★ a SANDBOXED subframe is refused', async () => {
  /*
    The plugin panel exactly as the app creates it — `allow-scripts` without
    `allow-same-origin`, so an opaque origin. This is the frame third-party
    plugin markup runs in, and the one the whole control exists for.
  */
  const frame = await frameByName('sandboxed');
  const result = await ping(frame);

  expect(result.resolved).toBeUndefined();
  expect(result.rejected).toContain('is not available from this frame');
});

test('a refused frame gets no answer it could mistake for one', async () => {
  /*
    A refusal REJECTS; it does not resolve to a sentinel. A caller that is not
    allowed to be here must not receive a value at all — an `{ok: false}` would
    be something a plugin could branch on, and something a future refactor could
    accidentally start treating as data.
  */
  const frame = await frameByName('sandboxed');
  const result = await ping(frame);

  expect(result).not.toHaveProperty('resolved');
  expect(typeof result.rejected).toBe('string');
});
