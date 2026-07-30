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
import { existsSync, readFileSync } from 'node:fs';

const BACKEND_PORT = Number(process.env.MOTION_BACKEND_PORT || 4000);
const HEALTH_URL = `http://localhost:${BACKEND_PORT}/api/health`;

let child: ChildProcess | null = null;

function packagedEntry(): string {
  return path.join(process.resourcesPath ?? '', 'backend', 'dist', 'main.js');
}

function resolveEntry(): string | null {
  const override = process.env.MOTION_BACKEND_ENTRY;
  if (override && existsSync(override)) return override;

  const packaged = packagedEntry();
  if (existsSync(packaged)) return packaged;

  // dev: dist-electron/ is two levels under motion-editor/, motion-back is a sibling.
  const sibling = path.resolve(__dirname, '..', '..', 'motion-back', 'dist', 'main.js');
  if (existsSync(sibling)) return sibling;

  return null;
}

/**
 * Where the operator of a self-hosted install puts the server's configuration.
 *
 * The installer deliberately carries no `.env`: one that did would hand its
 * DATABASE_URL, JWT_SECRET and AI_KEY_SECRET to everybody who ran the installer.
 * This file lives in the user's own app-data directory instead, is written once
 * on the target machine, and is never part of a distributable.
 */
export function backendEnvPath(): string {
  return path.join(app.getPath('userData'), 'backend.env');
}

/**
 * Minimal KEY=VALUE reader for <userData>/backend.env.
 *
 * Not dotenv: this runs in the Electron main process, which must not depend on
 * the server's node_modules. Handles comments, blank lines, `export` prefixes
 * and quoted values — enough for a file of connection strings and secrets.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    out[key] = value;
  }
  return out;
}

function loadBackendEnv(): Record<string, string> {
  const file = backendEnvPath();
  if (!existsSync(file)) return {};
  try {
    return parseEnvFile(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error('[backend] could not read', file, err);
    return {};
  }
}

/**
 * Should this app manage its own server?
 *
 * Yes when explicitly asked (MOTION_LOCAL_BACKEND=1), and yes when a server was
 * bundled into this build — packaging the sidecar IS the intent to run it, and a
 * packaged user has no shell in which to set an env var. A plain client build
 * has no bundled server and so answers no, unchanged.
 */
export function shouldStartBackend(): boolean {
  if (process.env.MOTION_LOCAL_BACKEND === '1') return true;
  return app.isPackaged && existsSync(packagedEntry());
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

  // Configuration for a packaged sidecar comes from the user's own app-data
  // directory, because the installer ships no .env. The server's dotenv call
  // does not override variables that already exist in the environment, so these
  // win over any .env that happens to sit next to a dev checkout — and a dev
  // checkout with no backend.env keeps behaving exactly as before.
  const fileEnv = loadBackendEnv();
  if (Object.keys(fileEnv).length) {
    console.log(`[backend] configuration loaded from ${backendEnvPath()}`);
  } else if (app.isPackaged) {
    console.warn(
      `[backend] no configuration found. Create ${backendEnvPath()} ` +
        '(start from resources/backend/.env.example) — the server needs at least ' +
        'DATABASE_URL, JWT_SECRET and AI_KEY_SECRET, and refuses to start without them.',
    );
  }

  // Run the server with Electron's bundled Node (ELECTRON_RUN_AS_NODE) so no
  // system Node install is required in a packaged app. cwd = motion-back so it
  // loads its own uploads/ and Prisma engine.
  child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ...fileEnv,
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
