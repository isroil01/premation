/**
 * The Cache & Memory panel's reading of the engine's memory (`getRenderStats`).
 *
 * The engine reports what each cache tier holds and may hold, its own process
 * memory and the machine's. This turns that into the three things the panel
 * and the transport bar's meter say:
 *
 *   • the tiers: VRAM frame cache, RAM tier, disk tier — used and budget;
 *   • "outside the caches": engine memory the RAM tier does not account for
 *     (scene, rasters, decoders, fonts, plugins — and anything leaked);
 *   • graphics memory as the OS sees it: what it lets the engine hold on the
 *     card (shrinking as other apps take memory) against what the engine holds;
 *   • a health verdict: `healthy`, `pressure` (the RAM tier is at its budget,
 *     the machine is short of memory, or the engine is near its share of the
 *     graphics card) or `growing` (memory outside the caches has climbed
 *     steadily for many minutes — the leak signal).
 *
 * Pure functions over plain numbers, so the verdict is tested without an engine.
 */

import type { RenderStats } from '@motion/engine-api';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** One point of the panel's 30-minute memory chart. */
export interface MemorySample {
  /** Wall clock, ms. */
  at: number;
  /** The engine process's memory, bytes. */
  engineBytes: number;
  /** What the RAM tier holds, bytes. */
  ramTierBytes: number;
}

export interface MemoryReadout {
  /** The VRAM frame cache. */
  vramBytes: number;
  vramBudget: number | null;
  /** The RAM tier (the engine's ramCacheBytes is VRAM + RAM together; this is RAM alone). */
  ramBytes: number;
  ramBudget: number | null;
  diskBytes: number;
  /** 0 = the disk tier is off. */
  diskBudget: number | null;
  diskReadMsPerMp: number | null;
  engineBytes: number | null;
  physicalBytes: number | null;
  availableBytes: number | null;
  /** Engine memory the RAM tier does not account for, bytes (null without engineBytes). */
  outsideCachesBytes: number | null;
  idleRenderAhead: boolean | null;
  /** Graphics memory (null where the OS does not say): the engine's share of the card, what it holds, the card's size. */
  gpuBudget: number | null;
  gpuUsed: number | null;
  gpuTotal: number | null;
  /** Graphics memory the engine gave back under pressure this session (cached frames moved to RAM, idle buffers freed). */
  gpuTrimmed: number;
  /** SDK 1.4: plugin simulation states kept in RAM and on disk (null without a plugin host). */
  simBytes: number | null;
  simDiskBytes: number | null;
}

export function readMemory(s: RenderStats): MemoryReadout {
  const vramBytes = s.vramCacheBytes ?? 0;
  // ramCacheBytes = the VRAM frame cache + the RAM tier (what the green bar holds).
  const ramBytes = Math.max(0, s.ramCacheBytes - vramBytes);
  const engineBytes = s.engineMemoryBytes ?? null;
  return {
    vramBytes,
    vramBudget: s.vramCacheBudget ?? null,
    ramBytes,
    ramBudget: s.ramCacheBudget ?? null,
    diskBytes: s.diskCacheBytes,
    diskBudget: s.diskCacheBudget ?? null,
    diskReadMsPerMp: s.diskReadMsPerMp ?? null,
    engineBytes,
    physicalBytes: s.physicalMemoryBytes ?? null,
    availableBytes: s.availableMemoryBytes ?? null,
    outsideCachesBytes: engineBytes === null ? null : Math.max(0, engineBytes - ramBytes),
    idleRenderAhead: s.idleRenderAhead ?? null,
    gpuBudget: s.gpuMemoryBudget ?? null,
    gpuUsed: s.gpuMemoryUsed ?? null,
    gpuTotal: s.gpuMemoryTotal ?? null,
    gpuTrimmed: s.gpuMemoryTrimmed ?? 0,
    simBytes: s.simStateBytes ?? null,
    simDiskBytes: s.simStateDiskBytes ?? null,
  };
}

export type MemoryHealthKind = 'healthy' | 'pressure' | 'growing';

export interface MemoryHealth {
  kind: MemoryHealthKind;
  /** For `growing`: how fast memory outside the caches climbs, bytes per minute. */
  growthPerMin?: number;
  /** For `pressure`: which kind. */
  pressure?: 'ramBudget' | 'machine' | 'gpu';
}

/** The RAM tier counts as full from this share of its budget. */
export const RAM_PRESSURE_SHARE = 0.95;
/** The machine counts as short of memory below this share of it free (and below MACHINE_LOW_FLOOR). */
export const MACHINE_LOW_SHARE = 0.08;
const MACHINE_LOW_FLOOR = 1 * GiB;
/**
 * The engine counts as short of graphics memory from this share of what the
 * OS lets it hold — the line where the engine starts giving memory back
 * (render_thread.cpp relieve_gpu_pressure), a little before the OS pages.
 */
export const GPU_PRESSURE_SHARE = 0.9;

/** The engine's use of its graphics-memory budget (0..1+), or null where the OS does not say. */
export function gpuShare(m: MemoryReadout): number | null {
  return m.gpuBudget && m.gpuBudget > 0 && m.gpuUsed !== null ? m.gpuUsed / m.gpuBudget : null;
}

/** Graphics memory other apps (and the OS) hold: the card less the engine's budget. */
export function gpuHeldElsewhere(m: MemoryReadout): number | null {
  return m.gpuTotal && m.gpuBudget !== null ? Math.max(0, m.gpuTotal - m.gpuBudget) : null;
}
/** Growth needs this much history to be judged at all. */
export const GROWTH_MIN_SPAN_MS = 10 * 60_000;
/** …and only the last GROWTH_WINDOW_MS of it counts. */
export const GROWTH_WINDOW_MS = 20 * 60_000;
/** A steady climb of at least this, and this much in total, is `growing`. */
export const GROWTH_MIN_PER_MIN = 30 * MiB;
export const GROWTH_MIN_TOTAL = 1 * GiB;
/** Most of the steps must go up: a sawtooth that only drifts is not a leak. */
const GROWTH_RISING_SHARE = 0.7;

/**
 * The least-squares slope of memory outside the caches over the window, bytes
 * per minute, and how much it rose — or null when the history is too short.
 */
export function outsideCachesGrowth(history: readonly MemorySample[], now: number): { perMin: number; total: number; risingShare: number } | null {
  const pts = history.filter((p) => now - p.at <= GROWTH_WINDOW_MS);
  if (pts.length < 6) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (last.at - first.at < GROWTH_MIN_SPAN_MS) return null;
  const xs = pts.map((p) => (p.at - first.at) / 60_000);
  const ys = pts.map((p) => Math.max(0, p.engineBytes - p.ramTierBytes));
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (!(den > 0)) return null;
  let rising = 0;
  for (let i = 1; i < n; i++) if (ys[i]! > ys[i - 1]!) rising++;
  return { perMin: num / den, total: ys[n - 1]! - ys[0]!, risingShare: rising / (n - 1) };
}

export function memoryHealth(m: MemoryReadout, history: readonly MemorySample[], now: number): MemoryHealth {
  const growth = outsideCachesGrowth(history, now);
  if (growth && growth.perMin >= GROWTH_MIN_PER_MIN && growth.total >= GROWTH_MIN_TOTAL && growth.risingShare >= GROWTH_RISING_SHARE) {
    return { kind: 'growing', growthPerMin: growth.perMin };
  }
  if (m.physicalBytes !== null && m.availableBytes !== null
    && m.availableBytes < Math.max(MACHINE_LOW_FLOOR, m.physicalBytes * MACHINE_LOW_SHARE)) {
    return { kind: 'pressure', pressure: 'machine' };
  }
  const share = gpuShare(m);
  if (share !== null && share >= GPU_PRESSURE_SHARE) {
    return { kind: 'pressure', pressure: 'gpu' };
  }
  if (m.ramBudget !== null && m.ramBudget > 0 && m.ramBytes >= m.ramBudget * RAM_PRESSURE_SHARE) {
    return { kind: 'pressure', pressure: 'ramBudget' };
  }
  return { kind: 'healthy' };
}

/** Bytes as the panel prints them: "820 MB", "6.1 GB", "1.2 TB". */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 MB';
  if (bytes < GiB) return `${Math.max(1, Math.round(bytes / MiB))} MB`;
  const gb = bytes / GiB;
  if (gb < 1024) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}
