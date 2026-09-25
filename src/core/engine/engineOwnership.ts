/**
 * Who owns the document in this window, and who draws the viewport
 * (NATIVE_CORE_PLAN §5 D5 + F2).
 *
 *   engineOwnsDocumentNow()     the F2 owner flag, decided once at boot
 *                               (PREMATION_ENGINE=process + PREMATION_ENGINE_OWNER=engine,
 *                               or `{ "backend": "process", "owner": "engine" }` in
 *                               <userData>/engine.json). Default false: the TypeScript
 *                               engine owns the document, exactly as before.
 *   engineViewportActive()      the C++ engine's frames ARE the viewport: the engine owns
 *                               the document AND the process backend has not fallen back.
 *                               The TypeScript renderer does not run while this is true.
 *   subscribeEngineOwnership(l) told when either changes (boot, a fallback to the
 *                               TypeScript engine).
 *
 * Plain module state, not a store: it is read on hot paths (the viewport's
 * render tick, the transport) and changes at most twice per session.
 *
 * No React here (src/core). The hook over this is src/hooks/useEngineViewport.ts.
 */

type Listener = () => void;

interface OwnershipState {
  ownsDocument: boolean;
  fellBack: boolean;
  listeners: Set<Listener>;
}

// On the window, not in module variables, for the reason processEngine.ts
// gives: a second evaluation of this module (HMR, a second import URL) must
// see the same answer.
type W = { __premationEngineOwnership?: OwnershipState };
let local: OwnershipState | null = null;

function state(): OwnershipState {
  const fresh = (): OwnershipState => ({ ownsDocument: false, fellBack: false, listeners: new Set() });
  if (typeof window === 'undefined') return (local ??= fresh());
  const w = window as unknown as W;
  return (w.__premationEngineOwnership ??= fresh());
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

/** The F2 owner flag (see the file header). */
export function engineOwnsDocumentNow(): boolean {
  return state().ownsDocument;
}

/** The engine's frames are the viewport (owner flag on, process backend healthy). */
export function engineViewportActive(): boolean {
  const s = state();
  return s.ownsDocument && !s.fellBack;
}

/** Boot (Providers): record the owner flag the main process reported. */
export function setEngineOwnsDocument(owns: boolean): void {
  const s = state();
  if (s.ownsDocument === owns) return;
  s.ownsDocument = owns;
  s.fellBack = false;
  notify();
}

/**
 * The process backend gave up (crash loop, no GPU): the TypeScript engine
 * answers from here on, so the TypeScript renderer must draw again.
 */
export function noteEngineFellBack(): void {
  const s = state();
  if (s.fellBack) return;
  s.fellBack = true;
  notify();
}

export function subscribeEngineOwnership(listener: Listener): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/** Tests. */
export function resetEngineOwnership(): void {
  const s = state();
  s.ownsDocument = false;
  s.fellBack = false;
  notify();
}
