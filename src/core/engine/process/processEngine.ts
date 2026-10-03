/**
 * The app's handle on the C++ engine process backend (NATIVE_CORE_PLAN §5 C3).
 *
 *   processEngineBridge()        the preload's `motionEditor.engine`, or null (browser build)
 *   processEngineEnabled()       is there an engine in this window (a preload bridge)?
 *                                The C++ engine is the only one: true in the app, false only
 *                                in a test harness without a bridge.
 *   createAppProcessEngine(o)    the ONE ProcessEngineClient of this window (idempotent: a
 *                                second call returns the same client and updates its
 *                                notice hooks)
 *   processEngine()              that client, or null when none was created
 *   subscribeProcessEngine(l)    told when the client appears or a notice arrives
 *   lastProcessEngineNotice()    the last restart / unavailable notice (the surface shows it)
 *
 * The client itself (@motion/engine-api `ProcessEngineClient`) needs nothing
 * from src/: this module only binds it to the window's bridge.
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
  type ProcessEngineClient,
  type ProcessEngineNotice,
} from '@motion/engine-api';
import { isDevBuild } from '@core/config/devBuild';

export interface AppProcessEngineOptions {
  /** Restart / unavailable notices (a toast). The unavailable notice comes once per outage. */
  onNotice?: (notice: ProcessEngineNotice) => void;
}

interface State {
  instance: ProcessEngineClient | null;
  noticeHook: ((n: ProcessEngineNotice) => void) | null;
  lastNotice: ProcessEngineNotice | null;
  listeners: Set<() => void>;
}

type WindowWithEngine = {
  motionEditor?: { engine?: EngineBridge };
  __premationProcessEngineState?: State;
  __premationProcessEngine?: ProcessEngineClient;
};

const fresh = (): State => ({ instance: null, noticeHook: null, lastNotice: null, listeners: new Set() });
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

/**
 * Is there an engine in this window? The C++ engine is the only engine and
 * always owns the document (docs/TS_ENGINE_REMOVAL.md): main's
 * `engine:status` always answers `enabled: true, ownsDocument: true`. False
 * only where there is no engine host — the jest harness (no bridge) and the
 * headless CLI's hidden window (no handler in that process), which still run
 * on the TypeScript engine until phase 4 deletes them.
 */
export async function processEngineEnabled(): Promise<boolean> {
  const bridge = processEngineBridge();
  if (!bridge) return false;
  try {
    return (await bridge.status()).enabled === true;
  } catch {
    return false;
  }
}

/** The engine owns the document wherever there is one (the owner flag is gone). */
export function processEngineOwnsDocument(): Promise<boolean> {
  return processEngineEnabled();
}

/**
 * Create (once) the window's engine client.
 * Returns null without a bridge (browser build, tests).
 */
export function createAppProcessEngine(options: AppProcessEngineOptions = {}): ProcessEngineClient | null {
  const s = state();
  if (options.onNotice) s.noticeHook = options.onNotice;
  if (s.instance) return s.instance;
  const bridge = processEngineBridge();
  if (!bridge) return null;
  s.instance = createProcessEngineClient(bridge, {
    onNotice: (n) => {
      const st = state();
      st.lastNotice = n;
      if (n.kind === 'unavailable') console.error(`[engine] the engine is unavailable: ${n.reason}`);
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
