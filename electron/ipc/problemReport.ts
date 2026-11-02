/**
 * Help ▸ Report a Problem — the main-process half.
 *
 * Two channels, both read-only:
 *
 *   `report:diagnostics` — the SAFE facts a report carries: build, OS, CPU and
 *     RAM, the GPU as Chromium sees it, the engine's state, and the last lines
 *     of engine.log with every absolute path and the user's name scrubbed.
 *     Unlike `diag:copyReport` this goes to our server, so it is structured
 *     (the console filters on it) and nothing in it can name a folder.
 *
 *   `report:captureViewport` — a PNG of one rectangle of the calling window
 *     (the viewer), via `webContents.capturePage`. The engine draws into the
 *     page, so this is what the user sees, overlays included. Returned as
 *     bytes; the renderer shows it before anything is sent and the user can
 *     drop it.
 *
 * Registered through `ipcGuard` like every other channel.
 */

import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { handle } from '../ipcGuard';

export interface ProblemReportDiagnostics {
  app: { version: string; packaged: boolean; electron: string; chromium: string; locale: string };
  os: { platform: string; release: string; arch: string; cpu: string; cores: number; ramGiB: number; freeRamGiB: number };
  gpu: { vendor?: string; renderer?: string; driver?: string; featureStatus?: Record<string, string> };
  engine: Record<string, unknown> | null;
  /** engine.log's last lines, paths scrubbed. */
  logTail: string[];
  capturedAt: string;
}

const PATH_PATTERNS: RegExp[] = [
  /\b[A-Za-z]:[\\/][^\s"'<>|*?]+/g,
  /\\\\[^\s"'<>|*?]+/g,
  /(?<![\w.:])\/(?:Users|home|var|tmp|private|mnt|Volumes|opt|media|run)\/[^\s"'<>|*?]+/g,
  /file:\/\/[^\s"'<>]+/g,
];

/** Pure: a log line with paths and the account name removed. Exported for the test. */
export function scrubLine(line: string, userName = os.userInfo().username): string {
  let out = line.slice(0, 400);
  for (const re of PATH_PATTERNS) out = out.replace(re, '<path>');
  if (userName && userName.length >= 3) out = out.split(userName).join('<user>');
  return out;
}

async function tail(file: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text.split(/\r?\n/).filter((l) => l.length > 0).slice(-lines).map((l) => scrubLine(l));
  } catch {
    return [];
  }
}

/** The fields of Chromium's basic GPU info worth a triage column. */
function gpuFrom(info: unknown): ProblemReportDiagnostics['gpu'] {
  const devices = (info as { gpuDevice?: Array<{ active?: boolean; vendorString?: string; deviceString?: string; driverVersion?: string }> })?.gpuDevice ?? [];
  const active = devices.find((d) => d.active) ?? devices[0];
  const aux = (info as { auxAttributes?: { glRenderer?: string; glVendor?: string } })?.auxAttributes;
  return {
    ...(active?.vendorString || aux?.glVendor ? { vendor: active?.vendorString || aux?.glVendor } : {}),
    ...(active?.deviceString || aux?.glRenderer ? { renderer: active?.deviceString || aux?.glRenderer } : {}),
    ...(active?.driverVersion ? { driver: active.driverVersion } : {}),
  };
}

export function registerProblemReportIpc(engineStatus: () => Record<string, unknown> | null): void {
  handle('report:diagnostics', async (): Promise<ProblemReportDiagnostics> => {
    let gpuInfo: unknown = null;
    try {
      gpuInfo = await app.getGPUInfo('basic');
    } catch {
      /* some drivers reject the query */
    }
    let engine: Record<string, unknown> | null = null;
    try {
      const s = engineStatus();
      // The recovery path is a file path; the rest is state and versions.
      if (s) {
        const { recoveryPath, ...rest } = s as Record<string, unknown> & { recoveryPath?: unknown };
        void recoveryPath;
        engine = rest;
      }
    } catch {
      engine = null;
    }
    const cpus = os.cpus();
    return {
      app: {
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron ?? '',
        chromium: process.versions.chrome ?? '',
        locale: app.getLocale(),
      },
      os: {
        platform: process.platform,
        release: os.release(),
        arch: os.arch(),
        cpu: cpus[0]?.model?.trim() ?? 'unknown',
        cores: cpus.length,
        ramGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
        freeRamGiB: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
      },
      gpu: { ...gpuFrom(gpuInfo), featureStatus: app.getGPUFeatureStatus() as unknown as Record<string, string> },
      engine,
      logTail: await tail(path.join(app.getPath('userData'), 'logs', 'engine.log'), 40),
      capturedAt: new Date().toISOString(),
    };
  });

  handle('report:captureViewport', async (event, rect: unknown): Promise<Uint8Array | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    const area = r ? { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) } : undefined;
    try {
      const image = await event.sender.capturePage(area && area.width > 8 && area.height > 8 ? area : undefined);
      if (image.isEmpty()) return null;
      // Big viewports on 4K panels make 10 MB PNGs; 1600 px wide is plenty to see a bug.
      const size = image.getSize();
      const scaled = size.width > 1600 ? image.resize({ width: 1600, quality: 'good' }) : image;
      return new Uint8Array(scaled.toPNG());
    } catch {
      return null;
    }
  });
}
