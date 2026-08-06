/**
 * Plugin effects at runtime: compiling them, and surviving them.
 *
 * ── The failure this module exists for ───────────────────────────────────────
 *
 * A GPU cannot be preempted. A fragment shader that takes too long is not slow —
 * it is a hang, and the operating system's answer is to reset the device. On
 * Windows that is TDR, and it destroys every GPU context in the process. So one
 * plugin's shader can black out the viewport for a document that has nothing
 * else wrong with it.
 *
 * `wgslValidation` refuses the unbounded shapes before compilation, which stops
 * the obvious cases. This handles the rest, in three layers:
 *
 *   1. **Compilation is bounded.** A driver that has not answered within
 *      `COMPILE_TIMEOUT_MS` is not waited on further — the effect goes to
 *      passthrough and the user gets a working document rather than a hung one.
 *   2. **Failure is passthrough, never a broken frame.** An effect that cannot
 *      compile renders its input unchanged. The alternative — a missing or
 *      black layer — reads as "my project is corrupted".
 *   3. **Device loss is ATTRIBUTED.** The effect being drawn when the device
 *      died is disabled by name, and the user is told which plugin. Without
 *      this the user sees a viewport that dies every few seconds with nothing
 *      to act on, and their only recourse is uninstalling plugins one at a time.
 *
 * ── Attribution is a suspicion, and is treated as one ────────────────────────
 *
 * A device can also be lost because a driver updated, another application hung
 * the GPU, or the machine went to sleep. Blaming a plugin for that would be
 * worse than not attributing at all: the user disables something innocent and
 * still has the problem.
 *
 * So a plugin is only blamed when one of its effects was actually mid-draw, the
 * accusation is phrased as one, and disabling is REVERSIBLE from the plugin's
 * page. What is not negotiable is that the suspect stops running immediately:
 * a second reset costs the user their session, and being wrong costs them one
 * effect they can switch back on.
 */

import { useUIStore } from '@stores/uiStore';
import { composeEffectShader, namespacedEffect, type EffectContribution } from './effectSchema';

/**
 * How long to wait for a shader to compile.
 *
 * Generous — a cold pipeline compile on a slow integrated GPU is genuinely slow,
 * and a limit that fired on real hardware would disable working effects on
 * exactly the machines least able to spare them. It exists for the driver that
 * never answers at all, which is a real thing and otherwise hangs the load.
 */
export const COMPILE_TIMEOUT_MS = 5000;

export type EffectState =
  /** Declared, not compiled yet. */
  | 'pending'
  /** Compiled and drawing. */
  | 'ready'
  /** Compilation failed or timed out. Renders passthrough. */
  | 'failed'
  /** Turned off after a device loss it was implicated in. Re-enableable. */
  | 'disabled';

export interface RegisteredEffect {
  /** `<pluginId>.<effectId>`. */
  id: string;
  pluginId: string;
  pluginName: string;
  contribution: EffectContribution;
  state: EffectState;
  /** Why it is not running, in words a user can read. Empty when `ready`. */
  reason: string;
  layout: ReturnType<typeof composeEffectShader>['layout'];
  wgsl: string;
}

/** What the host needs from a backend to compile one of these. */
export interface EffectCompiler {
  /** Resolves when the shader is usable, rejects with the driver's complaint. */
  compile(id: string, wgsl: string): Promise<void>;
}

const effects = new Map<string, RegisteredEffect>();
const listeners = new Set<() => void>();

/**
 * The effect currently mid-draw, if any.
 *
 * Module-level rather than passed around, because the thing that observes a
 * device loss (a backend event handler) has no connection to the thing that
 * issued the draw. This is the only channel between them.
 */
let inFlight: string | null = null;

function changed(): void {
  for (const fn of listeners) fn();
}

export function subscribeToEffects(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registeredEffects(): RegisteredEffect[] {
  return [...effects.values()];
}

export function effectById(id: string): RegisteredEffect | undefined {
  return effects.get(id);
}

/**
 * Register a plugin's effects. Called on ENABLE, not on start.
 *
 * The same rule layer kinds follow, and for the same reason: an effect has to
 * be addable to a layer before the plugin's worker boots, or every plugin that
 * declares one would have to start at launch — which is exactly what lazy
 * activation exists to avoid. Nothing here runs plugin code; a compiled shader
 * needs no worker.
 */
export function registerEffects(
  pluginId: string,
  pluginName: string,
  contributions: readonly EffectContribution[],
): void {
  for (const contribution of contributions) {
    const id = namespacedEffect(pluginId, contribution.id);
    const composed = composeEffectShader(contribution);
    effects.set(id, {
      id,
      pluginId,
      pluginName,
      contribution,
      state: 'pending',
      reason: '',
      layout: composed.layout,
      wgsl: composed.wgsl,
    });
  }
  if (contributions.length) changed();
}

/** Drop a plugin's effects. Called on disable AND uninstall. */
export function unregisterEffects(pluginId: string): void {
  let removed = false;
  for (const [id, e] of effects) {
    if (e.pluginId === pluginId) { effects.delete(id); removed = true; }
  }
  if (removed) changed();
}

/**
 * Compile a registered effect, bounded by `COMPILE_TIMEOUT_MS`.
 *
 * Never throws. Every failure path ends in `failed`, which renders passthrough —
 * the caller is a render setup path, and an exception there is a frame that
 * does not happen.
 */
export async function compileEffect(id: string, compiler: EffectCompiler): Promise<EffectState> {
  const effect = effects.get(id);
  if (!effect) return 'failed';
  // A disabled effect is not retried on its own. It was turned off because it
  // was implicated in a device loss, and quietly recompiling it would undo the
  // user's protection without asking.
  if (effect.state === 'disabled') return 'disabled';

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      compiler.compile(id, effect.wgsl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Compiling took longer than ${COMPILE_TIMEOUT_MS} ms.`)),
          COMPILE_TIMEOUT_MS,
        );
      }),
    ]);
    effect.state = 'ready';
    effect.reason = '';
  } catch (err) {
    effect.state = 'failed';
    effect.reason = err instanceof Error ? err.message : 'The shader could not be compiled.';
    // Logged with the plugin named. A driver error message on its own is
    // unattributable, and this is the one place the mapping is known.
    console.warn(`[plugins] effect "${id}" (${effect.pluginName}) failed to compile: ${effect.reason}`);
  } finally {
    // Cleared on BOTH paths. A pending timer that outlives a successful compile
    // keeps the process awake and, under fake timers in a test, rejects into a
    // promise nobody is holding.
    if (timer !== undefined) clearTimeout(timer);
  }

  changed();
  return effect.state;
}

/**
 * Mark an effect as about to draw.
 *
 * Paired with `endEffectDraw`, and the pairing is what makes attribution
 * possible at all: a device loss is observed asynchronously, by something with
 * no idea what was being drawn.
 */
export function beginEffectDraw(id: string): void {
  inFlight = id;
}

export function endEffectDraw(): void {
  inFlight = null;
}

/** Only for tests and diagnostics. */
export function currentlyDrawing(): string | null {
  return inFlight;
}

/**
 * The GPU device was lost. Work out whether a plugin is implicated.
 *
 * Returns the effect that was disabled, or null when the loss could not be
 * attributed — which is the common case and must stay distinguishable, because
 * "we do not know" and "your plugin did it" are very different things to tell
 * someone.
 */
export function noteDeviceLoss(reason: string): RegisteredEffect | null {
  const suspectId = inFlight;
  inFlight = null;

  if (!suspectId) {
    /*
      No plugin effect was drawing. A driver update, another application, or a
      machine waking from sleep all land here — and blaming a plugin for one of
      those is worse than saying nothing, because the user disables something
      innocent and still has the problem.
    */
    console.warn(`[plugins] GPU device lost, not attributable to a plugin effect: ${reason}`);
    return null;
  }

  const effect = effects.get(suspectId);
  if (!effect) return null;

  effect.state = 'disabled';
  effect.reason =
    `The graphics device was reset while this effect was drawing. It has been turned off to stop it happening again — `
    + `you can turn it back on from ${effect.pluginName}'s page if you think something else was responsible.`;

  console.warn(`[plugins] GPU device lost while drawing "${suspectId}" (${effect.pluginName}): ${reason}`);
  useUIStore.getState().notify({
    level: 'error',
    // The plugin is NAMED. Without it the user sees a viewport that dies with
    // nothing to act on, and uninstalls plugins one at a time to find out.
    message: `“${effect.contribution.label}” from ${effect.pluginName} was turned off — it was drawing when the graphics device reset.`,
    durationMs: 12000,
  });

  changed();
  return effect;
}

/**
 * Turn a disabled effect back on, at the user's request.
 *
 * The other half of treating attribution as a suspicion. It returns to
 * `pending` rather than `ready`, so it recompiles and goes through every gate
 * again — re-enabling is a retry, not an exemption.
 */
export function reenableEffect(id: string): void {
  const effect = effects.get(id);
  if (!effect || effect.state !== 'disabled') return;
  effect.state = 'pending';
  effect.reason = '';
  changed();
}

/** Test seam. Never called by the app. */
export function resetEffectsForTests(): void {
  effects.clear();
  inFlight = null;
  listeners.clear();
}
