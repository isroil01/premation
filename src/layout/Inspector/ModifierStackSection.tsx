/**
 * MODIFIER STACK — the panel.
 *
 * The section is arranged as the sentence a person is trying to say: WHICH
 * property, then WHAT HAPPENS TO IT, in order, top to bottom, with the running
 * value falling down the list. That order is the feature. A stack is not a set
 * of options — swapping two rows changes the number — so the list is presented
 * as a sequence with explicit up/down controls rather than as a settings form
 * that happens to be vertical.
 *
 * ## THE COMPILED EXPRESSION IS SHOWN, NOT HIDDEN
 *
 * At the bottom of the section is the exact text that is attached to the
 * property. It is there because the stack's whole claim is that it is not a
 * black box: a user who outgrows the rows can read what they add up to, copy
 * it, and take it over in the expression editor. Hiding it would make the stack
 * a nicer-looking version of the opaque behaviour preset it replaces.
 *
 * ## EVERY EDIT LANDS IMMEDIATELY
 *
 * There is no Apply button, unlike Audio Driver next door — and the difference
 * is not inconsistency, it is that the two cost different things. Applying a
 * driver runs an FFT over the work area and writes a keyframe per frame;
 * applying a stack recompiles a string. So a stack edit can be live, which is
 * what makes dragging a wiggle's amplitude feel like a slider instead of like a
 * form submission. `applyModifierStack` passes a merge key, so a drag is one
 * undo step rather than forty.
 */

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import {
  resolvePropertyMeta,
  propertyLabel,
  GROUP_PLACEHOLDER_PREFIX,
} from '@core/inspector/propertyMeta';
import { BAKE_REFUSAL_TEXT } from '@core/animation/convertExpressionToKeyframes';
import {
  AUDIO_BANDS,
  BEHAVIOR_RECIPES,
  LOOP_MODES,
  MODIFIER_HINTS,
  MODIFIER_KINDS,
  MODIFIER_LABELS,
  applyBehaviorRecipe,
  applyModifierStack,
  bakeModifierStack,
  defaultModifier,
  describeModifier,
  moveModifier,
  patchModifier,
  readModifierStacks,
  removeModifier,
  removeModifierStack,
  type AudioBandName,
  type LoopModeName,
  type Modifier,
  type ModifierKind,
} from '@core/animation/modifierStack';
import { compileModifierStack, modifierCompileError, modifierWarning } from '@core/animation/modifierCompile';
import styles from './ModifierStackSection.module.css';

/** Property value types a numeric modifier chain can sensibly drive. */
const NUMERIC_TYPES = new Set(['number', 'percent', 'angle', 'multiplier']);

interface PropOption {
  path: string;
  label: string;
}

/**
 * Every numeric property of this layer that can hold a keyframe.
 *
 * Derived from `buildStaticPropertyTree`, not from a hand-written list — which
 * is what makes effect parameters, expression-control sliders and plugin
 * layer-kind properties appear here without this file knowing they exist.
 *
 * The same derivation lives in `AudioDriverSection`. It is duplicated rather
 * than shared because the two sections are the only callers and neither owns
 * the other; if a third appears, this is the moment to lift it into
 * `propertyMeta` — where the definition of "numeric and animatable" belongs —
 * rather than have one panel import the other.
 */
function numericProps(nodeId: string): PropOption[] {
  const out: PropOption[] = [];
  const seen = new Set<string>();
  for (const row of buildStaticPropertyTree(nodeId)) {
    for (const path of row.members) {
      if (seen.has(path)) continue;
      if (path.startsWith(GROUP_PLACEHOLDER_PREFIX)) continue;
      const meta = resolvePropertyMeta(path, nodeId);
      if (!NUMERIC_TYPES.has(meta.type)) continue;
      seen.add(path);
      const own = propertyLabel(path, nodeId);
      out.push({
        path,
        label: row.members.length > 1 && own !== row.label ? `${row.label} · ${own}` : row.label,
      });
    }
  }
  return out;
}

/**
 * Whether this layer has anything a stack could modify.
 *
 * Exported so the Inspector can decide whether to emit the accordion HEADER at
 * all: a section that renders null still leaves its twirl-down title behind,
 * and a heading that opens onto nothing reads as a broken panel rather than as
 * an inapplicable one.
 */
export function hasModifierStackSection(nodeId: string): boolean {
  return numericProps(nodeId).length > 0;
}

// ── Parameter rows ──────────────────────────────────────────────────

/**
 * The raw-expression row's text field.
 *
 * Local draft, committed on blur or Enter — NOT on every keystroke. Committing
 * per character would attach `value +` to the property mid-word, which parses
 * as an error, drops the property to its base value, and makes the viewport
 * flicker while someone types.
 */
function ExpressionInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  return (
    <input
      className={styles.text}
      value={shown}
      aria-label="Expression source"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** A labelled number, the width of the panel's gutter. */
function Field({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}): JSX.Element {
  return (
    <span className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <ValueField
        value={value}
        onChange={(v) => onChange(Number(v))}
        min={min}
        max={max}
        step={step}
        unit={unit}
        aria-label={label}
      />
    </span>
  );
}

/** The parameters for one row — a switch, so each kind names its own numbers. */
function ModifierParams({
  modifier,
  list,
  onPatch,
}: {
  modifier: Modifier;
  /** The whole stack, because a patch produces a new LIST, not a new row. */
  list: readonly Modifier[];
  onPatch: (next: Modifier[]) => void;
}): JSX.Element | null {
  const m = modifier;
  // `patchModifier` is given the ROW, so `patch` is checked against this
  // kind's own parameters — `{ freq }` on an offset row is a compile error.
  const set = <M extends Modifier>(row: M, patch: Partial<Omit<M, 'id' | 'kind'>>): void => {
    onPatch(patchModifier(list, row, patch));
  };

  switch (m.kind) {
    case 'offset':
      return <div className={styles.params}><Field label="Amount" value={m.amount} onChange={(v) => set(m, { amount: v })} /></div>;
    case 'multiply':
      return <div className={styles.params}><Field label="Factor" value={m.factor} step={0.1} onChange={(v) => set(m, { factor: v })} /></div>;
    case 'clamp':
      return (
        <div className={styles.params}>
          <Field label="Min" value={m.min} onChange={(v) => set(m, { min: v })} />
          <Field label="Max" value={m.max} onChange={(v) => set(m, { max: v })} />
        </div>
      );
    case 'wiggle':
      return (
        <div className={styles.params}>
          <Field label="Frequency" value={m.freq} min={0} step={0.1} unit="Hz" onChange={(v) => set(m, { freq: v })} />
          <Field label="Amplitude" value={m.amp} onChange={(v) => set(m, { amp: v })} />
          <Field label="Octaves" value={m.octaves} min={1} max={8} step={1} onChange={(v) => set(m, { octaves: Math.max(1, Math.round(v)) })} />
          <Field label="Seed" value={m.seed} step={1} onChange={(v) => set(m, { seed: Math.round(v) })} />
        </div>
      );
    case 'oscillate':
      return (
        <div className={styles.params}>
          <Field label="Rate" value={m.freq} min={0} step={0.05} unit="Hz" onChange={(v) => set(m, { freq: v })} />
          <Field label="Amplitude" value={m.amp} onChange={(v) => set(m, { amp: v })} />
          <Field label="Phase" value={m.phase} step={0.1} onChange={(v) => set(m, { phase: v })} />
        </div>
      );
    case 'spring':
      return (
        <div className={styles.params}>
          <Field label="Frequency" value={m.frequency} min={0} step={0.1} unit="Hz" onChange={(v) => set(m, { frequency: v })} />
          <Field label="Decay" value={m.decay} min={0} step={0.5} onChange={(v) => set(m, { decay: v })} />
        </div>
      );
    case 'smooth':
      return <div className={styles.params}><Field label="Window" value={m.windowSec} min={0} step={0.01} unit="s" onChange={(v) => set(m, { windowSec: v })} /></div>;
    case 'delay':
      return <div className={styles.params}><Field label="Seconds" value={m.seconds} step={0.05} unit="s" onChange={(v) => set(m, { seconds: v })} /></div>;
    case 'loop':
      return (
        <div className={styles.params}>
          <select
            className={styles.select}
            value={m.mode}
            aria-label="Loop mode"
            onChange={(e) => set(m, { mode: e.target.value as LoopModeName })}
          >
            {LOOP_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </div>
      );
    case 'audio':
      return (
        <div className={styles.params}>
          <select
            className={styles.select}
            value={m.band}
            aria-label="Audio band"
            onChange={(e) => set(m, { band: e.target.value as AudioBandName })}
          >
            {AUDIO_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <Field label="Min" value={m.min} onChange={(v) => set(m, { min: v })} />
          <Field label="Max" value={m.max} onChange={(v) => set(m, { max: v })} />
        </div>
      );
    case 'expression':
      return (
        <div className={styles.params}>
          <ExpressionInput value={m.src} onCommit={(src) => set(m, { src })} />
        </div>
      );
  }
}

// ── The section ─────────────────────────────────────────────────────

export function ModifierStackSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const rev = useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  // No early return above this line: every hook below runs on every render,
  // including for a node that has just been deleted.
  const options = useMemo(() => (node ? numericProps(nodeId) : []), [nodeId, rev, node]);
  const stacks = useMemo(() => (node ? readModifierStacks(node) : {}), [node, rev]);

  const [prop, setProp] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // The chosen property follows the layer: a stack already on it wins, else the
  // first animatable numeric property. Re-derived when the options change, so
  // switching layers never leaves a path belonging to the previous one.
  const activePath = prop && options.some((o) => o.path === prop)
    ? prop
    : (Object.keys(stacks)[0] ?? options[0]?.path ?? '');

  const modifiers = useMemo(() => stacks[activePath]?.modifiers ?? [], [stacks, activePath]);

  const commit = useCallback((next: Modifier[]): void => {
    if (!activePath) return;
    applyModifierStack(nodeId, activePath, next);
    setNote(null);
  }, [nodeId, activePath]);

  const compiled = useMemo(() => compileModifierStack(modifiers), [modifiers]);
  const error = useMemo(() => modifierCompileError(modifiers), [modifiers]);

  if (!node || options.length === 0 || !activePath) return null;

  const hasStack = stacks[activePath] !== undefined;

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        An ordered pipeline on one property. Each row takes the value from the row
        above — starting at the keyframed value — so the ORDER changes the result.
        The whole stack compiles to one expression.
      </p>

      <div className={styles.row}>
        <span className={styles.label}>Property</span>
        <select
          className={styles.select}
          value={activePath}
          onChange={(e) => { setProp(e.target.value); setNote(null); }}
          aria-label="Modified property"
        >
          {options.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}{stacks[o.path] ? ' ●' : ''}
            </option>
          ))}
        </select>
      </div>

      {modifiers.length === 0 && (
        <p className={styles.empty}>No modifiers yet — add one below.</p>
      )}

      <ol className={styles.list}>
        {modifiers.map((m, i) => {
          const label = MODIFIER_LABELS[m.kind];
          const warning = modifierWarning(m);
          return (
            <li
              key={m.id}
              className={m.enabled ? styles.item : `${styles.item} ${styles.itemOff}`}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null && dragFrom !== i) commit(moveModifier(modifiers, dragFrom, i));
                setDragFrom(null);
              }}
            >
              <div className={styles.head}>
                <span className={styles.ordinal} aria-hidden="true">{i + 1}</span>
                <span className={styles.grip} aria-hidden="true">⠿</span>
                <input
                  type="checkbox"
                  checked={m.enabled}
                  aria-label={`Enable ${label}`}
                  onChange={(e) => commit(patchModifier(modifiers, m, { enabled: e.target.checked }))}
                />
                <span className={styles.kind}>{label}</span>
                <span className={styles.summary}>{describeModifier(m)}</span>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${label} up`}
                  disabled={i === 0}
                  onClick={() => commit(moveModifier(modifiers, i, i - 1))}
                >▲</button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${label} down`}
                  disabled={i === modifiers.length - 1}
                  onClick={() => commit(moveModifier(modifiers, i, i + 1))}
                >▼</button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Remove ${label}`}
                  onClick={() => commit(removeModifier(modifiers, m.id))}
                >✕</button>
              </div>
              <ModifierParams modifier={m} list={modifiers} onPatch={commit} />
              <p className={styles.rowHint}>{MODIFIER_HINTS[m.kind]}</p>
              {warning && <p className={styles.warn}>Note — {warning}.</p>}
            </li>
          );
        })}
      </ol>

      <div className={styles.row}>
        <span className={styles.label}>Add</span>
        <select
          className={styles.select}
          value=""
          aria-label="Add modifier"
          onChange={(e) => {
            const kind = e.target.value as ModifierKind;
            if (!kind) return;
            commit([...modifiers, defaultModifier(kind)]);
          }}
        >
          <option value="">Add modifier…</option>
          {MODIFIER_KINDS.map((k) => (
            <option key={k} value={k}>{MODIFIER_LABELS[k]}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Behaviour</span>
        <select
          className={styles.select}
          value=""
          aria-label="Add behaviour"
          onChange={(e) => {
            const recipe = BEHAVIOR_RECIPES.find((r) => r.preset === e.target.value);
            if (!recipe) return;
            const done = applyBehaviorRecipe(nodeId, recipe);
            setProp(done[0] ?? activePath);
            setNote(`${recipe.label} added as an editable stack on ${done.join(', ')}.`);
          }}
        >
          <option value="">Add behaviour…</option>
          {BEHAVIOR_RECIPES.map((r) => (
            <option key={r.preset} value={r.preset} title={r.description}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* The stack's output, in full. See the module header: a stack that hides
          what it compiles to is the opaque behaviour it replaces. */}
      <div className={styles.compiled}>
        <span className={styles.compiledLabel}>Compiles to</span>
        <code className={styles.code} aria-label="Compiled expression">{compiled}</code>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasStack}
          onClick={() => {
            const result = bakeModifierStack(nodeId, activePath);
            setNote(
              result.refusal
                ? BAKE_REFUSAL_TEXT[result.refusal]
                : `Baked ${result.written.get(activePath) ?? 0} keyframes — the expression is now off, the rows are kept.`,
            );
          }}
        >
          Bake to keyframes
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasStack}
          onClick={() => {
            removeModifierStack(nodeId, activePath);
            setNote('Stack removed — any expression that was there first is back.');
          }}
        >
          Remove stack
        </Button>
      </div>

      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}

export default ModifierStackSection;
