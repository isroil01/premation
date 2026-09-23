/**
 * Route C spike (NATIVE_CORE_PLAN C4 exit: "route C runs inside the real app").
 *
 * DEV ONLY, OFF unless `PREMATION_ROUTE_C_SPIKE` names a C1 prototype engine
 * binary (`premation-engine --route C`, docs/VIEWPORT_ROUTE.md). Not wired to
 * any feature: it proves that the app's own window — sandboxed, context
 * isolated, the real preload — can receive a GPU texture rendered by another
 * process and sample it with WebGPU. C2's EngineSupervisor replaces this.
 *
 * What it does, and nothing more:
 *  1. registers a SECOND preload on the session (routeCSpikePreload.ts) — the
 *     app's preload.ts is untouched — that owns the sharedTexture receiver;
 *  2. once the page has loaded, spawns the engine on Chromium's GPU (matched
 *     by PCI vendor id: a mismatch made every transfer time out in C1);
 *  3. per `frame ready in slot N`: importSharedTexture → sendSharedTexture to
 *     the main frame → `free N` back to the engine once every process has
 *     released it (`allReferencesReleased`).
 * Pixels never pass through this process; each message is a 64-byte header.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { app, sharedTexture, type BrowserWindow } from 'electron';

const HEADER_BYTES = 64;
const MAGIC = 0x4d524650;
const TYPE_JSON = 2;
const TYPE_SHARED = 3;

interface FrameHeader {
  type: number;
  payloadBytes: number;
  frameIndex: number;
  width: number;
  height: number;
  slot: number;
  tRenderStartUs: number;
  tRenderDoneUs: number;
}

/** The engine binary to run, or null when the spike is off (always, outside dev). */
export function routeCSpikeEngine(isDev: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = env.PREMATION_ROUTE_C_SPIKE;
  return isDev && exe && path.isAbsolute(exe) ? exe : null;
}

/** Register the spike's preload. Must run before the window loads. */
export function registerRouteCSpikePreload(ses: Electron.Session): void {
  ses.registerPreloadScript({
    type: 'frame',
    id: 'premation-route-c-spike',
    filePath: path.join(__dirname, 'routeCSpikePreload.js'),
  });
}

/** Incremental parser for the C1 engine's stdout framing (64-byte header + payload). */
function makeParser(onMessage: (h: FrameHeader, payload: Buffer | null) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER_BYTES) {
      if (pending.readUInt32LE(0) !== MAGIC) throw new Error('route C spike: bad frame magic');
      const h: FrameHeader = {
        type: pending.readUInt32LE(4),
        payloadBytes: pending.readUInt32LE(8),
        frameIndex: pending.readUInt32LE(12),
        width: pending.readUInt32LE(16),
        height: pending.readUInt32LE(20),
        slot: pending.readUInt32LE(24),
        tRenderStartUs: pending.readDoubleLE(32),
        tRenderDoneUs: pending.readDoubleLE(40),
      };
      if (pending.length < HEADER_BYTES + h.payloadBytes) return;
      const payload = h.payloadBytes ? pending.subarray(HEADER_BYTES, HEADER_BYTES + h.payloadBytes) : null;
      pending = pending.subarray(HEADER_BYTES + h.payloadBytes);
      onMessage(h, payload);
    }
  };
}

async function chromiumGpuVendor(): Promise<number | null> {
  try {
    const info = (await app.getGPUInfo('complete')) as { gpuDevice?: Array<{ active?: boolean; vendorId?: number }> };
    return info.gpuDevice?.find((d) => d.active)?.vendorId ?? null;
  } catch {
    return null;
  }
}

/** Start the engine and relay its frames into `win`. Returns a stop function. */
export function startRouteCSpike(win: BrowserWindow, exe: string, size = { width: 1920, height: 1080 }): () => void {
  let engine: ChildProcessWithoutNullStreams | null = null;
  let handles: Buffer[] = [];
  let sending = false;
  const stats = { forwarded: 0, dropped: 0, errors: [] as string[] };

  const free = (slot: number): void => {
    if (engine?.stdin.writable) engine.stdin.write(`free ${slot}\n`);
  };

  const forward = async (h: FrameHeader): Promise<void> => {
    // One transfer in flight; a frame that arrives meanwhile goes straight back
    // to the ring (drop, never block — VIEWPORT_ROUTE.md "Implications for C2").
    if (sending || !handles[h.slot] || win.isDestroyed()) {
      stats.dropped++;
      free(h.slot);
      return;
    }
    sending = true;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'rgba',
          codedSize: { width: h.width, height: h.height },
          handle: { ntHandle: handles[h.slot] },
        },
        allReferencesReleased: () => free(h.slot),
      });
      await sharedTexture.sendSharedTexture(
        { frame: win.webContents.mainFrame, importedSharedTexture: imported },
        { frameIndex: h.frameIndex, width: h.width, height: h.height, tRenderStartUs: h.tRenderStartUs, tRenderDoneUs: h.tRenderDoneUs },
      );
      imported.release();
      stats.forwarded++;
    } catch (e) {
      stats.errors.push(String((e as Error).message ?? e));
      if (stats.errors.length > 20) stats.errors.shift();
      free(h.slot);
    } finally {
      sending = false;
    }
  };

  const onMessage = (h: FrameHeader, payload: Buffer | null): void => {
    if (h.type === TYPE_SHARED) {
      void forward(h);
      return;
    }
    if (h.type !== TYPE_JSON || !payload) return;
    const msg = JSON.parse(payload.toString('utf8')) as { type: string; handles?: string[]; adapter?: string; message?: string };
    if (msg.type === 'hello') {
      handles = (msg.handles ?? []).map((s) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(s));
        return b;
      });
      console.log(`[route-c-spike] engine on ${msg.adapter}, ${handles.length} slots`);
    } else if (msg.type === 'error') {
      stats.errors.push(String(msg.message));
      console.warn('[route-c-spike] engine error:', msg.message);
    }
  };

  void (async () => {
    const vendor = await chromiumGpuVendor();
    const args = [
      '--route', 'C',
      '--width', String(size.width),
      '--height', String(size.height),
      '--fps', '60',
      '--power', 'high',
      '--host-pid', String(process.pid),
      '--slots', '3',
      ...(vendor ? ['--gpu-vendor', String(vendor)] : []),
    ];
    console.log(`[route-c-spike] spawn ${exe} ${args.join(' ')}`);
    engine = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const parse = makeParser(onMessage);
    engine.stdout.on('data', (c: Buffer) => {
      try {
        parse(c);
      } catch (e) {
        stats.errors.push(String(e));
      }
    });
    engine.stderr.on('data', (c: Buffer) => process.stderr.write(`[route-c-spike engine] ${c.toString()}`));
    engine.on('exit', (code) => {
      console.log(`[route-c-spike] engine exited ${code}`);
      engine = null;
    });
  })();

  // Readable from the main-process inspector: `globalThis.__routeCSpike`.
  (globalThis as { __routeCSpike?: unknown }).__routeCSpike = stats;

  const stop = (): void => {
    engine?.kill();
    engine = null;
  };
  win.on('closed', stop);
  app.on('before-quit', stop);
  return stop;
}
