/**
 * The one door into the main process.
 *
 * Every privileged operation this app can perform — read a file, write a blob,
 * spend an API key, hold a session — is reachable through `ipcMain`. Which
 * means the question "who is allowed to invoke this?" has to be answered once,
 * structurally, for all of them. It was previously answered nowhere: all ~54
 * handlers accepted an invocation from any frame in any of our windows.
 *
 * That mattered here more than it does in most Electron apps, because this app
 * deliberately embeds hostile code. A plugin panel is an iframe running a
 * third-party author's markup and script. It is sandboxed
 * (`allow-scripts` without `allow-same-origin`, so an opaque origin) and the
 * preload does not currently run in subframes — but "currently" is the problem.
 * `nodeIntegrationInSubFrames`, a preload change, or an Electron default moving
 * would each turn a configuration detail into the whole IPC surface, silently.
 *
 * So the control is not a flag elsewhere. It is here, in the wrapper, and it
 * cannot be forgotten by the next handler anyone adds because there is no other
 * way to add one — `ipcRegistration.test.ts` fails the build if `ipcMain.handle`
 * or `ipcMain.on` is called anywhere but this file.
 *
 * Two conditions, both required:
 *
 *   1. **The sender is the top frame.** A plugin panel, an embedded document,
 *      anything in an iframe, is a child frame and is refused. This is the
 *      check that does the real work.
 *   2. **The frame's URL is one of ours.** The dev server, or a `file://` URL
 *      out of the packaged app. A window that has navigated somewhere else has
 *      stopped being our renderer, whatever it was when it opened.
 */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

/** Channels registered through this module. Read by the registration test. */
const registered = new Set<string>();

/** Refusals, for a diagnostic — the count is a signal on its own. */
let refusedCount = 0;

/**
 * Where our own renderer can legitimately be loaded from.
 *
 * `file:` covers the packaged build. The localhost origins cover `npm run dev`
 * and `dev:local`, which pick their own port when the default is taken — hence
 * a host/protocol test rather than a fixed origin string.
 */
function isAppUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    // An opaque origin serialises to "null" and does not parse. That is exactly
    // the sandboxed plugin panel, and exactly what must not get through.
    return false;
  }
}

export interface FrameCheck {
  ok: boolean;
  reason?: 'no-frame' | 'subframe' | 'foreign-url';
}

/**
 * Is this invocation from our own top-level renderer?
 *
 * Exported so it can be tested directly against a stub event, which is how the
 * decision table is covered. The WIRING — that these are the objects Electron
 * really passes, and that identity really distinguishes a subframe — is covered
 * by `e2e/ipcFrameGuard.spec.ts`, which drives a real main process with
 * `nodeIntegrationInSubFrames` deliberately ON so that a subframe HAS a working
 * bridge and has to be refused on the merits. Confirmed to fail when this
 * function is neutered.
 */
export function checkFrame(event: { senderFrame?: unknown; sender?: unknown }): FrameCheck {
  const frame = event.senderFrame as { url?: string } | null | undefined;
  // `senderFrame` is null when the frame was destroyed between send and
  // dispatch — a window closing mid-call. Nothing to serve, and nothing to
  // trust either.
  if (!frame) return { ok: false, reason: 'no-frame' };

  const sender = event.sender as { mainFrame?: unknown } | undefined;
  const mainFrame = sender?.mainFrame;
  // Identity, not URL comparison: a subframe on the same origin has the same
  // URL prefix and must still be refused.
  if (mainFrame && frame !== mainFrame) return { ok: false, reason: 'subframe' };

  if (!isAppUrl(frame.url ?? '')) return { ok: false, reason: 'foreign-url' };

  return { ok: true };
}

function refuse(channel: string, reason: string): Error {
  refusedCount += 1;
  // Named, not silent. A refusal here is either an attack or a bug in our own
  // window management, and both need to be visible in a log.
  console.warn(`[ipc] refused ${channel} from a ${reason}`);
  return new Error(`IPC channel "${channel}" is not available from this frame.`);
}

/**
 * Register an invocable handler. Use instead of `ipcMain.handle`, always.
 *
 * A refused call REJECTS rather than resolving to a sentinel: a caller that is
 * not allowed to be here should not receive something it can mistake for an
 * answer, and every legitimate caller is already handling rejection.
 */
export function handle<T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: never[]) => T | Promise<T>,
): void {
  registered.add(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    const check = checkFrame(event);
    if (!check.ok) throw refuse(channel, check.reason ?? 'disallowed frame');
    return fn(event, ...(args as never[]));
  });
}

/**
 * Register a fire-and-forget listener. Use instead of `ipcMain.on`.
 *
 * There is no channel back to the sender, so a refusal is dropped after being
 * logged — which is the correct outcome: these carry diagnostics, and a caller
 * that should not be sending them does not need to be told it failed.
 */
export function on(
  channel: string,
  fn: (event: IpcMainEvent, ...args: never[]) => void,
): void {
  registered.add(channel);
  ipcMain.on(channel, (event, ...args) => {
    const check = checkFrame(event);
    if (!check.ok) { refuse(channel, check.reason ?? 'disallowed frame'); return; }
    fn(event, ...(args as never[]));
  });
}

/** Every channel registered so far. For diagnostics and the registration test. */
export function registeredChannels(): string[] {
  return [...registered].sort();
}

/** How many invocations have been refused this session. */
export function refusedInvocations(): number {
  return refusedCount;
}
