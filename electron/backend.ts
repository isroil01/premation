/**
 * Backend lifecycle manager — the desktop app owns its server (the After Effects
 * model: launch the app, the server comes up behind it; quit the app, it goes
 * down). The renderer always talks to a local motion-back on:4000; this module
 * makes sure one is running without the user starting it by hand.
 *
 * Resolution order for the server entry (`motion-back/dist/main.js`):
 *   1. MOTION_BACKEND_ENTRY env override (explicit path)
 *   2. packaged build: <resources>/backend/dist/main.js  (bundled sidecar)
 *   3. dev checkout:../motion-back/dist/main.js          (sibling repo)
 * If none is found, or a server is already listening, we just use whatever is
 * on:4000 (so an externally-run backend still works).
 */

import { app, net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const BACKEND_PORT = Number(process.env.MOTION_BACKEND_PORT || 4000);
const HEALTH_URL = `http://localhost:${BACKEND_PORT}/api/health`;

let child: ChildProcess | null = null;

function resolveEntry(): string | null {
  const override = process.env.MOTION_BACKEND_ENTRY;
  if (override && existsSync(override)) return override;

  const packaged = path.join(process.resourcesPath ?? '', 'backend', 'dist', 'main.js');
  if (existsSync(packaged)) return packaged;

  // dev: dist-electron/ is two levels under motion-editor/, motion-back is a sibling.
  const sibling = path.resolve(__dirname, '..', '..', 'motion-back', 'dist', 'main.js');
  if (existsSync(sibling)) return sibling;

  return null;
}

async function isHealthy(): Promise<boolean> {
  try {
    const res = await net.fetch(HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Ensure a backend is running. Returns true once:4000 is healthy. Reuses an
 * already-running server; otherwise forks the bundled/sibling one in Electron's
 * Node runtime (no system Node needed) with its own directory as cwd so it loads
 * its `.env`, `uploads/`, and Prisma client correctly.
 */
export async function startBackend(): Promise<boolean> {
  if (await isHealthy()) {
    console.log('[backend] reusing server already listening on', BACKEND_PORT);
    return true;
  }

  const entry = resolveEntry();
  if (!entry) {
    console.warn('[backend] no bundled/sibling server found — waiting for an external one');
    return waitForHealth(4000);
  }

  const cwd = path.dirname(path.dirname(entry)); // …/motion-back
  console.log('[backend] launching server:', entry);
  // Run the server with Electron's bundled Node (ELECTRON_RUN_AS_NODE) so no
  // system Node install is required in a packaged app. cwd = motion-back so it
  // loads its own.env / uploads / Prisma engine.
  child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(BACKEND_PORT),
      NODE_ENV: app.isPackaged ? 'production' : (process.env.NODE_ENV || 'development'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[backend] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[backend:err] ${d}`));
  child.on('error', (err) => console.error('[backend] spawn error:', err));
  child.on('exit', (code) => {
    console.log('[backend] server exited with code', code);
    child = null;
  });

  const ok = await waitForHealth(30000);
  if (!ok) console.error('[backend] server did not become healthy in time');
  return ok;
}

/** Stop the managed server (no-op if we reused an external one). */
export function stopBackend(): void {
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
  }
}
