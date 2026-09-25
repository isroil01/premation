/**
 * The app's handle on the C++ engine process backend (NATIVE_CORE_PLAN §5 C3).
 *
 *   processEngineBridge()        the preload's `motionEditor.engine`, or null (browser build)
 *   processEngineEnabled()       is the process backend switched on (PREMATION_ENGINE=process
 *                                / <userData>/engine.json)? Asks main; false when unknown.
 *   createAppProcessEngine(o)    the ONE ProcessEngineClient of this window (idempotent: a
 *                                second call returns the same client and updates its
 *                                fallback / notice hooks)
 *   processEngine()              that client, or null when none was created
 *   subscribeProcessEngine(l)    told when the client appears or a notice arrives
 *   lastProcessEngineNotice()    the last restart / fallback notice (the surface shows it)
 *
 * The client itself (@motion/engine-api `ProcessEngineClient`) needs nothing
 * from src/: this module only binds it to the window's bridge and keeps the
 * fallback — the TypeScript engine — pluggable, because engineInstance.ts
 * owns (and rebuilds) that one.
 *
 * ONE client per window, even when this module is evaluated twice (Vite HMR,
 * or a second import URL): two clients over one engine would BOTH replay their
 * logs into a restarted engine. So the state lives on the window, not in
 * module variables.
 *
 * No React here (src/core). The surface that shows its frames is
 * src/components/EngineSurface.
 */

import {
  createProcessEngineClient,
  type EngineBridge,
  type EngineClient,
  type ProcessEngineClient,
  type ProcessEngineNotice,
} from '@motion/engine-api';
import { isDevBuild } from '@core/config/devBuild';

export interface AppProcessEngineOptions {
  /** The TypeScript engine to fall back to (engineInstance's current engine). */
  fallback?: () => EngineClient;
  /** Restart / fallback notices (a toast). The fallback notice comes once. */
  onNotice?: (notice: ProcessEngineNotice) => void;
}

interface State {
  instance: ProcessEngineClient | null;
  fallbackProvider: (() => EngineClient) | null;
  noticeHook: ((n: ProcessEngineNotice) => void) | null;
  lastNotice: ProcessEngineNotice | null;
  listeners: Set<() => void>;
}

type WindowWithEngine = {
  motionEditor?: { engine?: EngineBridge };
  __premationProcessEngineState?: State;
  __premationProcessEngine?: ProcessEngineClient;
};

const fresh = (): State => ({ instance: null, fallbackProvider: null, noticeHook: null, lastNotice: null, listeners: new Set() });
let local: State | null = null;

function state(): State {
  if (typeof window === 'undefined') return (local ??= fresh());
  const w = window as unknown as WindowWithEngine;
  return (w.__premationProcessEngineState ??= fresh());
}

function notify(): void {
  for (const l of [...state().listeners]) {
    try {
      l();
    } catch {
      // a listener's failure is its own
    }
  }
}

export function processEngineBridge(): EngineBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as WindowWithEngine).motionEditor?.engine ?? null;
}

export async function processEngineEnabled(): Promise<boolean> {
  const bridge = processEngineBridge();
  if (!bridge) return false;
  try {
    return (await bridge.status()).enabled === true;
  } catch {
    return false;
  }
}

/**
 * F2: does the ENGINE own the document (`PREMATION_ENGINE=process` +
 * `PREMATION_ENGINE_OWNER=engine`, or `{ "backend": "process", "owner":
 * "engine" }`)? Then New / Open / Save / Revert / autosave / recovery go
 * through engine requests (core/project/engineDocumentSession.ts). False when
 * unknown — the TypeScript engine stays the owner.
 */
export async function processEngineOwnsDocument(): Promise<boolean> {
  const bridge = processEngineBridge();
  if (!bridge) return false;
  try {
    const s = await bridge.status();
    return s.enabled === true && s.ownsDocument === true;
  } catch {
    return false;
  }
}

/**
 * Create (once) the window's process-backend client. Call only when
 * `processEngineEnabled()` said yes — the client falls back at once otherwise.
 * Returns null without a bridge (browser build, tests).
 */
export function createAppProcessEngine(options: AppProcessEngineOptions = {}): ProcessEngineClient | null {
  const s = state();
  if (options.fallback) s.fallbackProvider = options.fallback;
  if (options.onNotice) s.noticeHook = options.onNotice;
  if (s.instance) return s.instance;
  const bridge = processEngineBridge();
  if (!bridge) return null;
  s.instance = createProcessEngineClient(bridge, {
    fallback: () => {
      const f = state().fallbackProvider?.();
      if (!f) throw new Error('no fallback engine attached');
      return f;
    },
    onNotice: (n) => {
      const st = state();
      st.lastNotice = n;
      if (n.kind === 'fallback') console.warn(`[engine] the C++ engine is unavailable — using the TypeScript engine: ${n.reason}`);
      else console.info(`[engine] premation-engine restarted (${n.cause}); ${n.replayed} requests replayed in ${n.ms} ms, ${n.mismatches} mismatches`);
      st.noticeHook?.(n);
      notify();
    },
  });
  if (isDevBuild()) {
    // The real-app harness drives the process backend through this (dev only).
    (window as unknown as WindowWithEngine).__premationProcessEngine = s.instance;
  }
  notify();
  return s.instance;
}

export function processEngine(): ProcessEngineClient | null {
  return state().instance;
}

export function lastProcessEngineNotice(): ProcessEngineNotice | null {
  return state().lastNotice;
}

export function subscribeProcessEngine(listener: () => void): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/** Tests / teardown. */
export async function resetProcessEngine(): Promise<void> {
  const s = state();
  const i = s.instance;
  const listeners = s.listeners;
  Object.assign(s, fresh(), { listeners });
  await i?.close();
  notify();
}
