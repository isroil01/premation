/**
 * The link between a registered plugin effect and a renderer that can draw it.
 *
 * ── What was missing ─────────────────────────────────────────────────────────
 *
 * Everything on either side of this file was built and tested. Enabling a
 * plugin registered its effects; the browser listed them; adding one wrote it
 * to the layer; `snapshotToFrameScene` emitted a scene entry per pass; the
 * composition pass knew how to draw one. And nothing rendered, because two
 * steps between those halves had no caller anywhere in the app:
 *
 *   1. the composed WGSL was never put into the renderer's `ShaderRegistry`,
 *      so the material referred to a shader name the registry had never heard
 *      of; and
 *   2. `compileEffect` was never called, so every effect stayed `pending` —
 *      and `snapshotToFrameScene` deliberately emits only `ready` ones.
 *
 * Either alone is enough to make a plugin effect do nothing at all. Together
 * they made the whole effect surface inert while every unit test passed, which
 * is the failure mode unit tests are worst at: each side was correct about its
 * own half of a conversation neither was having.
 *
 * ── Why a subscription and not a one-shot ────────────────────────────────────
 *
 * The set of effects is not known when the renderer comes up. A plugin can be
 * enabled, disabled, updated or installed at any point in a session, and each
 * of those bumps the effect registry. So this attaches once and re-syncs on
 * every change — and syncing has to be idempotent, because most of those bumps
 * concern one plugin and leave the rest already registered and compiled.
 */

import {
  registeredEffects,
  compileEffect,
  subscribeToEffects,
  type EffectCompiler,
} from '@core/plugins/pluginEffects';
import { registerPluginShaders, type ShaderRegistryLike } from '@core/plugins/pluginEffectMaterial';

/**
 * What this needs from a backend: the ability to tell whether a source
 * compiles. Structural, and optional, so a backend that cannot say degrades to
 * "no complaints" rather than blocking every effect.
 */
export interface ShaderValidator {
  shaderDiagnostics?(label: string, wgsl: string): Promise<string[]>;
}

/** What this needs from a renderer. Narrow on purpose — it is a seam. */
export interface PluginEffectTarget {
  shaders: ShaderRegistryLike;
}

/**
 * An `EffectCompiler` backed by a real device.
 *
 * `compileEffect` treats a rejection as "this effect failed" and records the
 * message, so throwing here is how a bad shader ends up reported against the
 * plugin that shipped it instead of surfacing as a broken frame with no
 * attribution.
 */
export function backendCompiler(backend: ShaderValidator): EffectCompiler {
  return {
    async compile(id, wgsl) {
      const errors = await backend.shaderDiagnostics?.(id, wgsl);
      // `undefined` is "this backend cannot check", which is not a failure.
      // An empty array is "checked, and clean". They must not be conflated:
      // treating the first as a failure would make every plugin effect fail on
      // WebGL2, where they are inert but not broken.
      if (errors && errors.length > 0) throw new Error(errors.join('; '));
    },
  };
}

/**
 * Register and compile everything currently declared, then keep doing it.
 *
 * Returns a teardown that stops listening. Call it when the renderer goes away:
 * a sync against a disposed device would compile into nothing, and worse, would
 * mark effects `ready` against a registry that no longer exists.
 */
export function attachPluginEffects(
  target: PluginEffectTarget,
  backend: ShaderValidator,
): () => void {
  const compiler = backendCompiler(backend);
  let detached = false;
  /** Effects whose compile is in flight, so a burst of changes starts one each. */
  const inFlight = new Set<string>();

  const sync = (): void => {
    if (detached) return;
    for (const effect of registeredEffects()) {
      /*
        Registration first, and unconditionally.

        `register` is a keyed map write, so repeating it is free — and it must
        repeat, because a plugin UPDATE re-registers the same effect id with
        new source. Skipping when the name is already present would leave the
        old version's shader drawing after an update, which is the kind of bug
        that looks like a caching problem in the plugin.
      */
      registerPluginShaders(target.shaders, effect.pluginId, [effect.contribution]);

      // Only `pending` is compiled here. `ready` is done; `failed` is not
      // retried on a whim; `disabled` was turned off after a device loss and
      // recompiling it would quietly undo the user's protection.
      if (effect.state !== 'pending' || inFlight.has(effect.id)) continue;
      inFlight.add(effect.id);
      void compileEffect(effect.id, compiler).finally(() => inFlight.delete(effect.id));
    }
  };

  sync();
  const unsubscribe = subscribeToEffects(sync);
  return () => {
    detached = true;
    unsubscribe();
  };
}
