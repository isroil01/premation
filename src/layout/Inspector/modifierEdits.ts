/**
 * modifierEdits — the modifier-stack writes as engine-API commands (B3z).
 *
 * A modifier stack is two things the engine addresses separately:
 *
 *   • the RECORD — `layer/modifiers` (json field, Transform.__modifiers):
 *     `{ <track>: { modifiers, previous } }`, where `previous` is the expression
 *     the property carried before its stack existed (captured once);
 *   • the COMPILED EXPRESSION on the property itself — `setExpression` on the
 *     track's API property (`member` for one dimension of an unseparated vector:
 *     a stack on X Position drives only X).
 *
 * One user action is ONE batch of both (a client macro, ENGINE_API.md §1 rule
 * 7): setting a stack, removing it (the previous expression — or none — comes
 * back), a behaviour recipe over several properties. Bake is the API's
 * `convertExpressionToKeyframes` (which disables the expression, AE) on that
 * one member; the record is kept.
 *
 * Pure command builders: reads the live document to decide what to send,
 * never writes it.
 */

import type { Command, PropRef } from '@motion/engine-api';
import type { ExpressionState } from '@motion/animation';
import { documentMirror } from '@stores/documentMirror';
import { compileModifierStack } from '@core/animation/modifierCompile';
import { mirrorModifierStacks } from '@core/mirror/modifierStacks';
import { memberExpressionOf } from '@core/mirror/memberExpressions';
import { trackRef } from '@core/mirror/selection';
import {
  instantiateRecipe,
  type BehaviorRecipe,
  type Modifier,
  type ModifierStack,
} from '@core/animation/modifierStack';
import { propRefForTrack } from '@core/engine/propRefs';
import { jsonFieldCommands, hasLayerField } from './layerFieldEdits';

const MODIFIERS_PATH = 'layer/modifiers';

/** Where a track's expression lives in the API: its property, plus the member for one dimension of a vector. */
export interface ExpressionTarget {
  prop: PropRef;
  member?: number;
}

export function expressionTarget(nodeId: string, track: string): ExpressionTarget | null {
  let r;
  try {
    r = propRefForTrack(nodeId, track);
  } catch {
    return null;
  }
  if (!r || !r.animatable || r.members.length === 0 || !r.members.includes(track)) return null;
  return r.members.length > 1 ? { prop: r.ref, member: r.member } : { prop: r.ref };
}

/** The track's current expression, or null — what a new stack records as `previous`. */
function currentExpressionState(nodeId: string, track: string): ExpressionState | null {
  // The mirror's record at call time: the property's expression, or — one
  // dimension of an unseparated vector — that member's own.
  const r = trackRef(documentMirror(), nodeId, track);
  const e = r ? memberExpressionOf(r.info, r.member) : null;
  if (!e || e.source.trim() === '') return null;
  return { src: e.source, enabled: e.enabled };
}

function setExpression(t: ExpressionTarget, source: string, enabled: boolean): Command {
  return { type: 'setExpression', prop: t.prop, source, enabled, ...(t.member !== undefined ? { member: t.member } : {}) };
}

function recordCommands(nodeId: string, next: Record<string, ModifierStack>): Command[] {
  return jsonFieldCommands(nodeId, MODIFIERS_PATH, Object.keys(next).length > 0 ? next : null);
}

/**
 * Install or update the stacks of several tracks (a behaviour recipe: X and Y)
 * as ONE batch. `null` removes that track's stack (an empty list keeps an
 * empty stack, as the Modifiers section does). [] when the layer or
 * a track is not addressable.
 */
export function modifierStacksCommands(nodeId: string, changes: ReadonlyArray<{ track: string; modifiers: readonly Modifier[] | null }>): Command[] {
  const m = documentMirror();
  if (!m.layer(nodeId) || !hasLayerField(nodeId, MODIFIERS_PATH)) return [];
  const stacks = mirrorModifierStacks(m, nodeId);
  const next: Record<string, ModifierStack> = { ...stacks };
  const exprs: Command[] = [];
  for (const { track, modifiers } of changes) {
    const t = expressionTarget(nodeId, track);
    if (!t) return [];
    const existing = stacks[track];
    if (modifiers === null) {
      if (!existing) continue;
      // The previous expression (or none) comes back.
      delete next[track];
      exprs.push(setExpression(t, existing.previous?.src ?? '', existing.previous?.enabled ?? true));
      continue;
    }
    // `previous` is captured ONCE, when the stack is born — re-capturing would
    // record the stack's own output and make Remove a no-op.
    const previous = existing ? existing.previous : currentExpressionState(nodeId, track);
    next[track] = { modifiers: [...modifiers], previous };
    // Explicitly enabled: a stack on a property whose old expression was
    // switched off must not be born switched off.
    exprs.push(setExpression(t, compileModifierStack(modifiers), true));
  }
  if (exprs.length === 0) return [];
  return [...recordCommands(nodeId, next), ...exprs];
}

/**
 * The rows after a drag / ▲▼ reorder: row `from` moved to `to` (clamped to the
 * list). Pure list arithmetic — the result goes out through
 * `modifierStackCommands` like every other stack change. It lives here rather
 * than being imported from `@core/animation/modifierStack` (`moveModifier`,
 * identical) because the B3 write rule counts a `move…` helper imported from a
 * document module as a document write by its name alone.
 */
export function modifiersMoved(list: readonly Modifier[], from: number, to: number): Modifier[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (!moved) return [...list];
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/** The rows without the one whose id is `id` (pure; see `modifiersMoved` for why it lives here). */
export function modifiersWithout(list: readonly Modifier[], id: string): Modifier[] {
  return list.filter((m) => m.id !== id);
}

/** One track's stack := `modifiers` (`null` = remove the stack). */
export function modifierStackCommands(nodeId: string, track: string, modifiers: readonly Modifier[] | null): Command[] {
  return modifierStacksCommands(nodeId, [{ track, modifiers }]);
}

/** Every stack a behaviour recipe defines, as one batch; `tracks` = the ones it touches. */
export function behaviorRecipeCommands(nodeId: string, recipe: BehaviorRecipe): { commands: Command[]; tracks: string[] } {
  const changes = recipe.props
    .filter((e) => expressionTarget(nodeId, e.prop) !== null)
    .map((e) => ({ track: e.prop, modifiers: instantiateRecipe(e) }));
  const commands = modifierStacksCommands(nodeId, changes);
  return { commands, tracks: commands.length > 0 ? changes.map((c) => c.track) : [] };
}

/**
 * Bake the compiled stack of one track to keyframes (AE Convert Expression to
 * Keyframes over the layer's extent, every frame): the expression is disabled,
 * the stack record kept. Null when the track is not addressable.
 */
export function bakeModifierStackCommands(nodeId: string, track: string): Command[] | null {
  const t = expressionTarget(nodeId, track);
  if (!t) return null;
  return [{ type: 'convertExpressionToKeyframes', prop: t.prop, step: 0, ...(t.member !== undefined ? { member: t.member } : {}) }];
}
