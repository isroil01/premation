/**
 * Which path a prompt takes.
 *
 * F9: this was a `class Router` whose constructor took a `RouterOptions` and
 * immediately discarded it (`constructor(_options)`). It held no state, made no
 * model call, and used none of the provider, dialect, model or signal it was
 * handed — so every call site paid the ceremony of constructing a classifier
 * that was, in fact, one regex.
 *
 * Under the caster the decision matters less than it used to: a generative
 * prompt goes to a pipeline whose quality floor is deterministic, and a trivial
 * edit goes to the direct tool loop. Both are cheap, and neither is wrong in a
 * way a smarter classifier would fix. So it collapses to what it always was — a
 * pure function with no dependencies — rather than growing into a model call
 * that would add a round trip to decide something a regex gets right.
 */

export type PromptClass = 'trivial_edit' | 'generative';

/** Imperatives that start a direct edit rather than a piece. */
const TRIVIAL_VERB = /^(make|change|set|delete|remove|move|hide|show|rename|update|align|resize|rotate)\b/;

/**
 * A reference to something that already exists.
 *
 * This is the load-bearing half. "make it blue" is an edit; "make a launch
 * video" is not, and the only difference is whether the prompt points at
 * something already on the canvas.
 */
const TARGETS_EXISTING =
  /\b(this|that|it|selection|selected|layer|layers|the (colou?r|title|text|background|opacity|font))\b/;

/** Nouns that mean a whole piece, whatever verb precedes them. */
const GENERATIVE_NOUN =
  /\b(video|animation|intro|teaser|promo|explainer|reel|sequence|scene|ad|trailer|opener|montage)\b/;

/** Longer than this and it is a brief, not an instruction. */
const TRIVIAL_MAX_CHARS = 60;

/**
 * Classify a prompt.
 *
 * Biased toward `generative` on purpose. Sending a piece-sized brief to the
 * direct loop produces exactly the hand-assembled output this re-architecture
 * exists to remove, whereas sending a small edit through the caster costs two
 * extra model calls and still does the right thing. The asymmetry in the cost of
 * being wrong is what sets the default.
 */
export function classifyPrompt(prompt: string): PromptClass {
  const normalized = prompt.trim().toLowerCase();

  // A noun meaning "a whole piece" outranks any verb. "change the intro video"
  // is not a trivial edit however imperatively it is phrased.
  if (GENERATIVE_NOUN.test(normalized)) return 'generative';

  if (
    TRIVIAL_VERB.test(normalized) &&
    normalized.length < TRIVIAL_MAX_CHARS &&
    TARGETS_EXISTING.test(normalized)
  ) {
    return 'trivial_edit';
  }

  return 'generative';
}
