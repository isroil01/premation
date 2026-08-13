/**
 * `scene.apply` — many mutations, one round trip, one undo entry.
 *
 * ── What was wrong with doing it one call at a time ─────────────────────────
 *
 * `animation.setKeyframes` was the only bulk call in the API. Everything else
 * cost one `postMessage`, one host-side revalidation and one change
 * notification each — so a generative plugin building a few thousand layers was
 * unusably slow, and it also produced a few thousand undo entries. A user who
 * ran it and did not like the result had to hold Ctrl+Z.
 *
 * ── Forward references are the load-bearing part ────────────────────────────
 *
 * `{ ref: n }` resolves to the layer created by op `n`, which must precede it.
 * Without that, a batch cannot build a hierarchy — the plugin would have to
 * create the parents, wait for their ids, and send a second batch, which is the
 * round trip the whole thing exists to avoid. The generative case IS the
 * hierarchy case, so a batch without forward refs would be a bulk API that
 * cannot do the one job bulk is for.
 *
 * ── Validate all, then apply all ────────────────────────────────────────────
 *
 * Nothing is applied until every op has been checked. A batch that failed
 * halfway would leave the document in a state no one asked for and the plugin
 * unable to describe: it knows which call it made, not which ops landed. Since
 * a partial batch cannot be reported honestly, it is not produced.
 *
 * That costs a full validation pass over ops that were going to succeed, which
 * is cheap next to what it prevents. Validation cannot be complete — whether a
 * layer id still exists is knowable, whether a `setProperty` will be refused by
 * a component that does not have that prop is not — so the apply pass can still
 * fail. When it does it throws, and `runDocumentEdit`'s snapshot rolls the
 * document back.
 *
 * ── Explicitly rejected: begin/end ──────────────────────────────────────────
 *
 * `beginBatch()` / `endBatch()` reads better and is wrong here. An open
 * transaction can be orphaned by a worker that crashes or is terminated at the
 * 8-second boot bound, leaving the document half-applied with no owner and
 * nothing to close it. An array has no such state: it either arrives whole or
 * does not arrive.
 */

import type { PluginPermission } from './manifest';

/** A reference to the layer created by an earlier op in the same batch. */
export interface OpRef { ref: number }

export type BatchOp =
  | { op: 'createLayer'; kind?: string; name?: string; props?: Record<string, unknown>; parent?: string | OpRef }
  | { op: 'setProperty'; layer: string | OpRef; path: string; value: unknown }
  | { op: 'setParent'; layer: string | OpRef; parent: string | OpRef | null }
  | { op: 'rename'; layer: string | OpRef; name: string }
  | { op: 'delete'; layer: string | OpRef }
  | { op: 'setVisible'; layer: string | OpRef; visible: boolean }
  | { op: 'setLocked'; layer: string | OpRef; locked: boolean }
  | { op: 'effects.add'; layer: string | OpRef; type: string }
  | { op: 'effects.remove'; layer: string | OpRef; effect: string }
  | { op: 'effects.setParam'; layer: string | OpRef; effect: string; key: string; value: unknown }
  | { op: 'animation.setKeyframes'; layer: string | OpRef; path: string; keyframes: unknown[] }
  | { op: 'animation.setExpression'; layer: string | OpRef; path: string; expression: string | null };

/**
 * Caps.
 *
 * Ten thousand ops is a genuinely large generative run and still bounded; the
 * byte cap is the one that actually protects the main thread, because a batch
 * is cloned across `postMessage` before anything here sees it. Both REFUSE
 * rather than truncate — a plugin told "8,000 of your 10,000 ops were applied"
 * has no way to work out which, and a silent truncation is worse still.
 */
export const MAX_OPS = 10_000;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/** Which permission each op needs. The union is what the batch requires. */
export const OP_PERMISSIONS: Readonly<Record<BatchOp['op'], PluginPermission>> = {
  createLayer: 'scene:write',
  setProperty: 'scene:write',
  setParent: 'scene:write',
  rename: 'scene:write',
  delete: 'scene:write',
  setVisible: 'scene:write',
  setLocked: 'scene:write',
  'effects.add': 'scene:write',
  'effects.remove': 'scene:write',
  'effects.setParam': 'scene:write',
  'animation.setKeyframes': 'animation:write',
  'animation.setExpression': 'animation:write',
};

const OP_NAMES = new Set(Object.keys(OP_PERMISSIONS));

export class BatchError extends Error {
  constructor(readonly index: number, message: string) {
    // The INDEX, always. A plugin sending ten thousand ops and told only "a
    // layer id was invalid" has nothing to act on; told "op 4,317", it can
    // print the op it built.
    super(index >= 0 ? `ops[${index}]: ${message}` : message);
    this.name = 'BatchError';
  }
}

/**
 * Check the shape of every op and work out which permissions the batch needs.
 *
 * Deliberately separate from applying, and returns the resolved permission set
 * rather than checking it: the caller holds the grant, and a validator that
 * also enforced would be two responsibilities in a function whose whole value
 * is being run before anything happens.
 */
export function validateBatch(raw: unknown): {
  ops: BatchOp[];
  permissions: Set<PluginPermission>;
} {
  if (!Array.isArray(raw)) throw new BatchError(-1, '`ops` must be an array.');
  if (raw.length === 0) throw new BatchError(-1, '`ops` is empty.');
  if (raw.length > MAX_OPS) {
    throw new BatchError(-1, `A batch is limited to ${MAX_OPS} operations; this one has ${raw.length}.`);
  }

  let bytes: number;
  try {
    bytes = JSON.stringify(raw).length;
  } catch {
    throw new BatchError(-1, 'The batch could not be read — it contains something not serialisable.');
  }
  if (bytes > MAX_BATCH_BYTES) {
    throw new BatchError(-1, `A batch is limited to ${MAX_BATCH_BYTES / 1024 / 1024} MB; this one is larger.`);
  }

  const permissions = new Set<PluginPermission>();
  const ops: BatchOp[] = [];
  /** Op indexes that create a layer, so a `{ ref }` can be checked against them. */
  const creates = new Set<number>();

  for (let i = 0; i < raw.length; i++) {
    const op = raw[i] as Partial<BatchOp> | null;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw new BatchError(i, 'each operation must be an object.');
    }
    const name = (op as { op?: unknown }).op;
    if (typeof name !== 'string' || !OP_NAMES.has(name)) {
      throw new BatchError(i, `"${String(name)}" is not a batch operation. Valid: ${[...OP_NAMES].join(', ')}.`);
    }

    permissions.add(OP_PERMISSIONS[name as BatchOp['op']]);
    validateOp(op as BatchOp, i, creates);
    if (name === 'createLayer') creates.add(i);
    ops.push(op as BatchOp);
  }

  return { ops, permissions };
}

/**
 * A layer target: an id string, or a forward reference to an earlier create.
 *
 * The reference is checked HERE, during validation, against the set of earlier
 * creating ops — not at apply time against a map that happens to be populated.
 * A `{ ref: 900 }` in op 5 is a bug in the plugin's own code, and finding it
 * before anything is written is the difference between an error message and a
 * half-built subtree.
 */
function validateTarget(value: unknown, index: number, creates: Set<number>, what: string): void {
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as OpRef).ref;
    if (typeof ref !== 'number' || !Number.isInteger(ref)) {
      throw new BatchError(index, `${what} must be a layer id or { ref: <index> }.`);
    }
    if (ref >= index) {
      // FORWARD only. A reference to a later op could not resolve without two
      // passes, and a reference to itself is a loop with no useful reading.
      throw new BatchError(index, `${what} refers to op ${ref}, which does not come before this one.`);
    }
    if (!creates.has(ref)) {
      throw new BatchError(index, `${what} refers to op ${ref}, which does not create a layer.`);
    }
    return;
  }
  throw new BatchError(index, `${what} must be a layer id or { ref: <index> }.`);
}

function str(value: unknown, index: number, what: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new BatchError(index, `${what} must be a string of 1–500 characters.`);
  }
}

function validateOp(op: BatchOp, i: number, creates: Set<number>): void {
  switch (op.op) {
    case 'createLayer':
      if (op.kind !== undefined) str(op.kind, i, '`kind`');
      if (op.name !== undefined) str(op.name, i, '`name`');
      if (op.parent !== undefined && op.parent !== null) validateTarget(op.parent, i, creates, '`parent`');
      if (op.props !== undefined && (typeof op.props !== 'object' || op.props === null || Array.isArray(op.props))) {
        throw new BatchError(i, '`props` must be an object.');
      }
      return;

    case 'setProperty':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.path, i, '`path`');
      return;

    case 'setParent':
      validateTarget(op.layer, i, creates, '`layer`');
      if (op.parent !== null) validateTarget(op.parent, i, creates, '`parent`');
      return;

    case 'rename':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.name, i, '`name`');
      return;

    case 'delete':
      validateTarget(op.layer, i, creates, '`layer`');
      return;

    case 'setVisible':
      validateTarget(op.layer, i, creates, '`layer`');
      if (typeof op.visible !== 'boolean') throw new BatchError(i, '`visible` must be a boolean.');
      return;

    case 'setLocked':
      validateTarget(op.layer, i, creates, '`layer`');
      if (typeof op.locked !== 'boolean') throw new BatchError(i, '`locked` must be a boolean.');
      return;

    case 'effects.add':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.type, i, '`type`');
      return;

    case 'effects.remove':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.effect, i, '`effect`');
      return;

    case 'effects.setParam':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.effect, i, '`effect`');
      str(op.key, i, '`key`');
      return;

    case 'animation.setKeyframes':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.path, i, '`path`');
      if (!Array.isArray(op.keyframes)) throw new BatchError(i, '`keyframes` must be an array.');
      return;

    case 'animation.setExpression':
      validateTarget(op.layer, i, creates, '`layer`');
      str(op.path, i, '`path`');
      if (op.expression !== null) str(op.expression, i, '`expression`');
      return;

    default: {
      // Unreachable: `validateBatch` checked the name against `OP_NAMES` first.
      // Present so adding a member to `BatchOp` without a case is a type error
      // rather than an op that validates by falling through.
      const exhaustive: never = op;
      throw new BatchError(i, `unhandled operation ${JSON.stringify(exhaustive)}.`);
    }
  }
}
