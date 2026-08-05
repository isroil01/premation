/**
 * 1.5.0 → 1.6.0 — an expression gains an ENABLED bit.
 *
 * (No `no-restricted-syntax` suppression here, unlike its neighbours: the rule
 * did not fire, and a disable comment that suppresses nothing is a claim about
 * the code that is false. What it would have said is still true — everything
 * below mutates a `structuredClone(doc)`, never the caller's document.)
 *
 * Before: `animation.expressions[nodeId][prop]` was the source STRING, and its
 *         presence was the whole model — an expression either existed and drove
 *         the property, or did not exist.
 * After:  `{ src, enabled }`. "Disabled" becomes a state the document can hold,
 *         so a user can switch a formula off and keep it, and so Convert
 *         Expression to Keyframes has somewhere to put the expression it bakes
 *         instead of deleting it.
 *
 * ── WHAT THIS MIGRATION CLAIMS ──────────────────────────────────────────────
 *
 * Every 1.5.0 document renders IDENTICALLY. That claim is strong here, unlike
 * 1.5.0's, and the reason is that the old model had no way to express the new
 * state: an expression that existed was, by construction, an expression that
 * ran. `enabled: true` for every one of them is therefore a translation rather
 * than a guess. There is no lossy direction to disclose.
 *
 * ── NO DUAL-SHAPE READS ─────────────────────────────────────────────────────
 *
 * `AnimationEngine.restore` reads `{ src, enabled }` and nothing else — a bare
 * string is not understood there and never reaches it, because this step runs
 * first at the single point where a foreign document becomes live state. Same
 * precedent as `fx.pathOp` (1.3.0), `fx.trim` (1.4.0) and `fx.repeater`
 * (1.5.0): a reader that quietly accepted both shapes would let documents stay
 * un-migrated indefinitely, so the migration would never be exercised and the
 * two shapes would drift.
 *
 * ── IDEMPOTENT BY CONSTRUCTION, AND IT HAS TO BE ────────────────────────────
 *
 * Only a `string` value is converted; an object is passed through untouched.
 * That is not defensive tidiness, it is load-bearing: `captureDocument` stamps
 * every document it writes `version: '1.1.0'` (a hardcoded literal — see F31),
 * so a project saved by THIS build carries the NEW expression shape under an
 * OLD version number and is walked through this step on every load. If it
 * rewrote unconditionally it would clobber `enabled: false` back to `true` on
 * the first reopen, and the feature would appear to work until you saved.
 *
 * ── VERSION BUMP IS EXCLUSIVELY THIS CHANGE ─────────────────────────────────
 *
 * Nothing else rides on 1.6.0. A failed migration has to be bisectable to one
 * transformation.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

/** The pre-1.6.0 shape: node id → prop path → source string (or, post-1.6.0,
 *  the object this step produces — see the idempotence note above). */
type LegacyExpressions = Record<string, Record<string, unknown>>;

export const v1_5_0_to_v1_6_0: DocumentMigration = {
  from: '1.5.0',
  to: '1.6.0',
  description:
    'Expressions: a bare source string → { src, enabled }, so an expression can ' +
    'be disabled without being deleted. Renders identically.',
  migrate(doc: EditorDocument): EditorDocument {
    const expressions = (doc.animation as { expressions?: LegacyExpressions } | undefined)
      ?.expressions;
    if (!expressions || typeof expressions !== 'object') return doc;

    // Only clone when there is something to change: `migrateDocument` returns
    // the same object for an already-current document and callers rely on that
    // to skip a structuredClone, so a step that clones unconditionally would
    // quietly reintroduce the cost for every document in the chain.
    let needed = false;
    for (const byProp of Object.values(expressions)) {
      if (byProp && Object.values(byProp).some((v) => typeof v === 'string')) {
        needed = true;
        break;
      }
    }
    if (!needed) return doc;

    const cloned = structuredClone(doc);
    const target = (cloned.animation as { expressions?: LegacyExpressions }).expressions ?? {};
    for (const byProp of Object.values(target)) {
      if (!byProp) continue;
      for (const [prop, value] of Object.entries(byProp)) {
        // An empty source was never a valid attached expression (setExpression
        // treats it as a removal), so it is dropped rather than promoted into a
        // valid-looking entry that compiles to nothing.
        if (typeof value !== 'string') continue;
        if (value.trim() === '') delete byProp[prop];
        else byProp[prop] = { src: value, enabled: true };
      }
    }
    return cloned;
  },
};
