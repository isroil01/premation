/**
 * Does the C++ engine own the document in this window, and draw the viewport
 * (NATIVE_CORE_PLAN §5 D5 + F2)?
 *
 * The C++ engine is the only engine (docs/TS_ENGINE_REMOVAL.md): wherever the
 * page has an engine bridge it owns the document and its frames ARE the
 * viewport. The owner flag, the preference file and the fall-back to the
 * TypeScript engine are gone. It is false only where there is no engine host:
 * the jest harness (no bridge) and the headless CLI's hidden window (no
 * `engine:status` handler in that process), where the LocalEngine answers.
 *
 *   engineOwnsDocumentNow()     set once at boot (Providers) from the bridge
 *   engineViewportActive()      the engine's frames are the viewport (same answer)
 *   subscribeEngineOwnership(l) told when it changes (boot)
 *
 * Plain module state, not a store: it is read on hot paths (the viewport's
 * render tick, the transport) and changes at most once per session.
 *
 * No React here (src/core). The hook over this is src/hooks/useEngineViewport.ts.
 */

type Listener = () => void;

interface OwnershipState {
  ownsDocument: boolean;
  listeners: Set<Listener>;
}

// On the window, not in module variables, for the reason processEngine.ts
// gives: a second evaluation of this module (HMR, a second import URL) must
// see the same answer.
type W = { __premationEngineOwnership?: OwnershipState };
let local: OwnershipState | null = null;

function state(): OwnershipState {
  const fresh = (): OwnershipState => ({ ownsDocument: false, listeners: new Set() });
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

/** The engine owns the document in this window (see the file header). */
export function engineOwnsDocumentNow(): boolean {
  return state().ownsDocument;
}

/** The engine's frames are the viewport (wherever it owns the document). */
export function engineViewportActive(): boolean {
  return state().ownsDocument;
}

/** Boot (Providers): record whether this window has the engine. */
export function setEngineOwnsDocument(owns: boolean): void {
  const s = state();
  if (s.ownsDocument === owns) return;
  s.ownsDocument = owns;
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
  notify();
}
