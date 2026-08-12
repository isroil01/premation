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
// The single owner of the pass → registry-name rule. Imported rather than
// re-derived; see the note in `registerEffects`.
import { passShaderName } from './pluginEffectMaterial';

/**
 * How long to wait for a shader to compile.
 *
 * Generous — a cold pipeline compile on a slow integrated GPU is genuinely slow,
 * and a limit that fired on real hardware would disable working effects on
 * exactly the machines least able to spare them. It exists for the driver that
 * never answers at all, which is a real thing and otherwise hangs the load.
 */
export const COMPILE_TIMEOUT_MS = 5000;
/**
 * The bound on a whole chain, which the per-pass one cannot express.
 *
 * Four passes at four seconds each are individually inside the per-pass limit
 * and together are sixteen seconds of frozen boot — and to the user that is
 * the editor hanging on startup, not one plugin being slow.
 */
export const CHAIN_COMPILE_TIMEOUT_MS = 10_000;

export type EffectState =
  /** Declared, not compiled yet. */
  | 'pending'
  /** Compiled and drawing. */
  | 'ready'
  /** Compilation failed or timed out. Renders passthrough. */
  | 'failed'
  /** Turned off after a device loss it was implicated in. Re-enableable. */
  | 'disabled';

/**
 * One pass's composed shader.
 *
 * A single-pass effect has exactly one, and its `shaderId` is the effect's own
 * bare id — unchanged from before chains existed, which is what keeps every
 * already-published effect resolving to the same registry key.
 *
 * Note that `shaderId` is a SHADER REGISTRY key, not the effect's type. What a
 * document stores is `RegisteredEffect.id`, which is bare for every effect
 * however many passes it has. Conflating the two is what let two different
 * naming rules exist here and in `passShaderName` for as long as nothing
 * connected them.
 */
export interface RegisteredPass {
  index: number;
  /**
   * What the renderer draws with. Always `passShaderName`, never a second copy
   * of its rule — see the note at the assignment.
   */
  shaderId: string;
  wgsl: string;
  /** Linear downsample of this pass's target. 1 unless declared otherwise. */
  scale: number;
  /** Whether this pass samples the chain's pass-0 input at binding 4. */
  readsOrigin: boolean;
}

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
  /**
   * Pass 0's composed WGSL.
   *
   * Kept beside `passes` because everything written before chains reads it, and
   * because one pass is the overwhelming majority — `passes[0].wgsl` is the
   * same string with an indirection in front of it.
   */
  wgsl: string;
  /**
   * Every pass, in execution order. Length 1 for a single-pass effect.
   *
   * State lives on the EFFECT, not per pass, and that is deliberate: a chain is
   * all-or-nothing. If any pass fails to compile the whole effect renders
   * passthrough, because half a separable blur is not a softer blur — it is a
   * smeared image the author never wrote, which reads as their kernel being
   * wrong rather than as the platform failing.
   */
  passes: RegisteredPass[];
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

/**
 * Bumped on every change to the registered set.
 *
 * `useSyncExternalStore` needs a snapshot that is stable between changes and
 * different after one. Returning the array itself would allocate a fresh
 * identity on every render and loop forever; a counter satisfies both halves
 * and costs nothing.
 */
let revision = 0;
export function pluginEffectRevision(): number {
  return revision;
}

function changed(): void {
  revision += 1;
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
    /*
      One composed shader per declared pass.

      `composeEffectShader(contribution, i)` prepends the same generated
      bindings and vertex stage to pass i's source, so each pass is an ordinary
      effect material as far as everything downstream is concerned. The chain
      is then N entries in the renderer's existing spatial-effects list, which
      already ping-pongs between offscreen targets — the host sequences it and
      the plugin never sees a target, exactly as promised.

      ★ The registry name comes from `passShaderName` and NOWHERE else.

      It used to be computed here as well, with a different rule — bare for
      pass 0, suffixed after it — while `passShaderName` suffixed every pass of
      a chain. Both were tested, and both tests passed, because nothing
      compared them: the shaders were never actually put into the renderer's
      registry. The day that wiring landed, pass 0 of every multi-pass effect
      would have been registered under one name and requested under another,
      and the chain would have drawn nothing.

      The rule itself is unchanged for the case it was written to protect: a
      SINGLE-pass effect keeps its bare `<pluginId>.<effectId>`, so every effect
      published before chains existed resolves to the same key it always did.
      What a document stores is `RegisteredEffect.id` — bare regardless — so
      the name a pass registers under was never the compatibility hinge.
    */
    const count = contribution.passes?.length ?? 1;
    const passes: RegisteredPass[] = [];
    for (let i = 0; i < count; i++) {
      const declared = contribution.passes?.[i];
      passes.push({
        index: i,
        shaderId: passShaderName(pluginId, contribution, i),
        wgsl: composeEffectShader(contribution, i).wgsl,
        scale: declared?.scale ?? 1,
        readsOrigin: declared?.reads === 'origin' || declared?.reads === 'both',
      });
    }

    effects.set(id, {
      id,
      pluginId,
      pluginName,
      contribution,
      state: 'pending',
      reason: '',
      layout: composeEffectShader(contribution, 0).layout,
      wgsl: passes[0]!.wgsl,
      passes,
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

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const startedAt = Date.now();
  try {
    /*
      Sequential, and bounded twice.

      Sequential because a chain is all-or-nothing: the first failure decides
      the effect, and compiling the rest afterwards would spend a driver's time
      producing errors nobody will read.

      Two bounds because they catch different things. The per-pass one catches
      a single pathological shader. The whole-chain one catches four passes
      that are each individually fine and together freeze a boot for sixteen
      seconds — which no per-pass limit can see, and which presents to the user
      as the editor hanging on startup rather than as one plugin being slow.
    */
    for (const pass of effect.passes) {
      const remaining = CHAIN_COMPILE_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(
          `The whole chain took longer than ${CHAIN_COMPILE_TIMEOUT_MS} ms to compile.`,
        );
      }
      const budget = Math.min(COMPILE_TIMEOUT_MS, remaining);
      await Promise.race([
        compiler.compile(pass.shaderId, pass.wgsl),
        new Promise<never>((_, reject) => {
          timers.push(setTimeout(
            () => reject(new Error(
              effect.passes.length > 1
                ? `Pass "${pass.shaderId.split('#')[1] ?? String(pass.index)}" took longer than ${budget} ms to compile.`
                : `Compiling took longer than ${budget} ms.`,
            )),
            budget,
          ));
        }),
      ]);
    }
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
    for (const t of timers) clearTimeout(t);
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
/**
 * Return every compiled effect to `pending`, so it recompiles on the new device.
 *
 * `ready` means "a pipeline for this shader exists on the GPU". After a device
 * loss that is false for ALL of them, and this state is the only thing that
 * says otherwise: `snapshotToFrameScene` emits a pass for any `ready` effect,
 * and `pluginMaterial` then asks the NEW device for a shader it never compiled.
 * Pipeline creation fails, nothing is drawn into the ping-pong target, and the
 * target stays cleared — which reads as **the plugin effect erased the layer**.
 *
 * That is precisely what `plugin-identity` reproduces: blank, and byte-identical
 * to `plugin-visible`, because the shader's contents never get as far as
 * mattering. The control renders fine because it emits no plugin pass at all.
 *
 * `pending` rather than `failed`, for the reason `reenableEffect` gives:
 * recompiling is a retry, not an exemption — it goes through every gate again.
 *
 * Returns how many were invalidated, so the caller only notifies on a change.
 */
function invalidateCompiledEffects(): number {
  let n = 0;
  for (const effect of effects.values()) {
    if (effect.state !== 'ready') continue;
    effect.state = 'pending';
    effect.reason = '';
    n++;
  }
  return n;
}

export function noteDeviceLoss(reason: string): RegisteredEffect | null {
  const suspectId = inFlight;
  inFlight = null;

  // Every pipeline died with the device, whoever was to blame. Done BEFORE the
  // attribution branch so an unattributable loss — the common case, and the one
  // the render-test harness hits between scenes — still invalidates.
  const invalidated = invalidateCompiledEffects();

  if (!suspectId) {
    /*
      No plugin effect was drawing. A driver update, another application, or a
      machine waking from sleep all land here — and blaming a plugin for one of
      those is worse than saying nothing, because the user disables something
      innocent and still has the problem.
    */
    console.warn(`[plugins] GPU device lost, not attributable to a plugin effect: ${reason}`);
    if (invalidated > 0) changed();
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

/**
 * Told the user, once, that plugin effects cannot draw on this machine.
 *
 * Per SESSION, not per effect and not per plugin. A generative plugin adding
 * forty effects would otherwise produce forty identical toasts, and a user
 * buried in them learns to dismiss the notice without reading — which is the
 * same outcome as never showing it, at more cost.
 */
let toldAboutWebgl2 = false;

/**
 * A plugin effect was added on a tier that cannot render it.
 *
 * The effect is in the document and will draw when the file is opened on a
 * WebGPU machine. What must not happen is the silent version: an effect that
 * appears in the stack, shows its parameters, and does nothing, which reads as
 * a broken plugin and sends the user to uninstall something that is fine.
 */
export function noteInertPluginEffect(pluginName: string): void {
  if (toldAboutWebgl2) return;
  toldAboutWebgl2 = true;
  useUIStore.getState().notify({
    level: 'warning',
    message:
      `Effects from ${pluginName} need WebGPU, and this machine is running on the WebGL2 `
      + 'fallback. They are saved with your project and will render on a machine that has it.',
    durationMs: 12000,
  });
}

/** Test seam. Never called by the app. */
export function resetEffectsForTests(): void {
  toldAboutWebgl2 = false;
  effects.clear();
  revision = 0;
  inFlight = null;
  listeners.clear();
}
