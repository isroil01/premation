/**
 * `contributes.presets` — animation presets and behaviours a plugin ships.
 *
 * ── What this is INSTEAD of, and why ────────────────────────────────────────
 *
 * The obvious request is "let a plugin register an expression function", so an
 * author can write `myPlugin.bounce(t)` in an expression. It cannot be done,
 * and the reason is two independent walls rather than one:
 *
 *   1. **Per-frame JS.** An expression is evaluated inside the render, once per
 *      property per frame. Plugin code lives in a Worker, so reaching it means
 *      an async hop the renderer cannot wait for — the same wall that makes
 *      effects WGSL-only. See `effectSchema.ts`.
 *
 *   2. **The interpreter is a closed vocabulary, deliberately.** Expressions
 *      are PARSED AND INTERPRETED, never `eval`'d: `new Function` is refused by
 *      the app's CSP, and relaxing that would let any shared project run
 *      arbitrary code in a renderer holding the user's auth token. The
 *      interpreter can only reach the names bound in `expressions.ts`. Adding a
 *      plugin-supplied name would mean either running plugin code (wall 1) or
 *      re-opening that hole.
 *
 * So a plugin contributes DATA the existing machinery already runs: keyframe
 * tracks, and expression SOURCE that goes through the same interpreter a
 * user-typed expression does, reaching nothing extra. That is the whole of
 * what a preset is, and `AnimationPreset` was already data-first for exactly
 * this reason — its own doc says behaviours are "data, not a callback… it can
 * be inspected, previewed, and round-tripped without executing anything".
 *
 * ── `applyFn` is refused, loudly ────────────────────────────────────────────
 *
 * `AnimationPreset` has an `applyFn` escape hatch "for rigs that genuinely need
 * code". A manifest is JSON, so a function cannot survive the trip — but a
 * STRING under that key would arrive truthy and non-callable, and the apply
 * path would call it. Refusing by name turns a crash at apply time into a
 * publish error the author sees.
 */

/** Presets are the largest contribution by bytes, so the cap is on both axes. */
export const MAX_PRESETS_PER_PLUGIN = 32;
export const MAX_TRACKS_PER_PRESET = 64;
export const MAX_KEYFRAMES_PER_TRACK = 512;
export const MAX_EXPRESSION_LENGTH = 4096;

/**
 * A plugin's preset, kept deliberately loose in TYPE and strict in CHECKS.
 *
 * Not typed as `AnimationPreset`: this module must not import the animation
 * package, because manifest parsing runs during install, in a test with no
 * engine, and on the registry. The shape is validated field by field here and
 * the app widens it where it is consumed.
 */
export interface PresetContribution {
  name: string;
  description?: string;
  folder?: string;
  requires?: 'text' | 'any';
  tracks: unknown[];
  expressions?: Array<{ prop: string; expr: string }>;
  animators?: unknown[];
  effects?: unknown[];
  timeUnit?: string;
}

/** Keys a plugin may not set, and why refusing beats ignoring. */
const FORBIDDEN: Readonly<Record<string, string>> = Object.freeze({
  // A string here is truthy and not callable; the apply path would call it.
  applyFn: 'is code, and a manifest cannot carry code. Express the preset as tracks and expressions.',
  // `builtin` decides whether the preset is exported in a user bundle and how
  // it is foldered. A plugin claiming it would file itself among the app's own.
  builtin: 'marks a preset as one the app ships. A plugin preset is filed under its plugin.',
});

class Invalid extends Error {}
const bad = (msg: string): never => { throw new Invalid(msg); };

function str(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    bad(`"${at}" must be a non-empty string of at most ${max} characters.`);
  }
  return (v as string).trim();
}

export function parsePresets(raw: unknown, at: string, errors: string[]): PresetContribution[] {
  if (!Array.isArray(raw)) {
    errors.push(`"${at}" must be an array.`);
    return [];
  }
  if (raw.length > MAX_PRESETS_PER_PLUGIN) {
    errors.push(`"${at}" declares ${raw.length} presets; the limit is ${MAX_PRESETS_PER_PLUGIN}.`);
    return [];
  }

  const out: PresetContribution[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        bad(`"${where}" must be an object.`);
      }
      const p = entry as Record<string, unknown>;

      for (const [key, why] of Object.entries(FORBIDDEN)) {
        if (Object.prototype.hasOwnProperty.call(p, key)) bad(`"${where}.${key}" ${why}`);
      }

      const name = str(p.name, `${where}.name`, 80);
      if (seen.has(name)) bad(`"${at}" declares two presets called "${name}".`);

      if (!Array.isArray(p.tracks)) bad(`"${where}.tracks" must be an array.`);
      const tracks = p.tracks as unknown[];
      if (tracks.length > MAX_TRACKS_PER_PRESET) {
        bad(`"${where}.tracks" has ${tracks.length} entries; the limit is ${MAX_TRACKS_PER_PRESET}.`);
      }
      tracks.forEach((t, ti) => {
        const where2 = `${where}.tracks[${ti}]`;
        if (!t || typeof t !== 'object' || Array.isArray(t)) bad(`"${where2}" must be an object.`);
        const tr = t as Record<string, unknown>;
        str(tr.prop, `${where2}.prop`, 200);
        if (!Array.isArray(tr.keyframes)) bad(`"${where2}.keyframes" must be an array.`);
        if ((tr.keyframes as unknown[]).length > MAX_KEYFRAMES_PER_TRACK) {
          bad(`"${where2}.keyframes" has more than ${MAX_KEYFRAMES_PER_TRACK} entries.`);
        }
      });

      let expressions: PresetContribution['expressions'];
      if (p.expressions !== undefined) {
        if (!Array.isArray(p.expressions)) bad(`"${where}.expressions" must be an array.`);
        expressions = (p.expressions as unknown[]).map((e, ei) => {
          const where2 = `${where}.expressions[${ei}]`;
          if (!e || typeof e !== 'object' || Array.isArray(e)) bad(`"${where2}" must be an object.`);
          const ex = e as Record<string, unknown>;
          return {
            prop: str(ex.prop, `${where2}.prop`, 200),
            /*
              NOT parsed here, on purpose. Parsing needs the expression engine,
              which this module cannot import (see the interface note) and the
              registry does not have at all — so a syntax check here would make
              the two validators disagree, and in the worse direction: a preset
              that publishes and then refuses to install. A broken expression
              instead surfaces where a user's own broken expression does, inline
              and editable, which is the behaviour the engine already promises.
            */
            expr: str(ex.expr, `${where2}.expr`, MAX_EXPRESSION_LENGTH),
          };
        });
      }

      if (p.animators !== undefined && !Array.isArray(p.animators)) {
        bad(`"${where}.animators" must be an array.`);
      }
      if (p.effects !== undefined && !Array.isArray(p.effects)) {
        bad(`"${where}.effects" must be an array.`);
      }

      seen.add(name);
      out.push({
        name,
        tracks,
        ...(p.description !== undefined ? { description: str(p.description, `${where}.description`, 200) } : {}),
        ...(p.folder !== undefined ? { folder: str(p.folder, `${where}.folder`, 120) } : {}),
        ...(p.requires === 'text' || p.requires === 'any' ? { requires: p.requires } : {}),
        ...(expressions ? { expressions } : {}),
        ...(p.animators !== undefined ? { animators: p.animators as unknown[] } : {}),
        ...(p.effects !== undefined ? { effects: p.effects as unknown[] } : {}),
        ...(typeof p.timeUnit === 'string' ? { timeUnit: p.timeUnit } : {}),
      });
    } catch (e) {
      if (e instanceof Invalid) errors.push(e.message);
      else throw e;
    }
  });

  return out;
}
